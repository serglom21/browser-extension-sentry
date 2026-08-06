import * as Sentry from '@sentry/browser';
import { spanToJSON } from '@sentry/core';
import { withIsolationScope as sentryWithIsolationScope } from '@sentry/browser';
import { setupSentry, markBackgroundInitialized } from './lib/setupSentry.js';
import { getCurrentTraceparent } from './lib/sentry-trace-propagation.ts';
import { trace, endTrace, TraceName } from '../../shared/lib/trace.ts';

setupSentry();

const API = 'http://localhost:4000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log('[repro]', ...args);
}

/** Human-readable description of the parent a span ended up with. */
function describeParent(span) {
  if (!span) return '<no span>';
  const json = spanToJSON(span);
  return json.parent_span_id
    ? `parent_span_id=${json.parent_span_id} (trace ${json.trace_id.slice(0, 8)})`
    : '<root, no parent>';
}

// ---------------------------------------------------------------------------
// BUG A — background boot fetches.
//
// These are plain background requests, not wrapped in trace(): exactly how
// the upstream boot-time calls work. The hand-rolled traceparent helper therefore
// resolves `getActiveSpan()` to the ambient pageload span, so each request advertises
// *pageload* as its parent. The backend then parents its server span to pageload —
// making it a direct SIBLING of the http.client span that triggered it.
//
// These are the three endpoints from the confirmed production example, trace
// a confirmed production trace.
// ---------------------------------------------------------------------------

const BOOT_ENDPOINTS = ['/geolocation', '/v2/supportedNetworks', '/tokens/0x1'];

async function runBootFetches() {
  for (const path of BOOT_ENDPOINTS) {
    const traceparent = getCurrentTraceparent();
    log(`boot fetch ${path} — hand-rolled traceparent names ${traceparent ?? 'nothing'}`);
    try {
      await fetch(`${API}${path}`, {
        headers: traceparent ? { traceparent } : {},
      });
    } catch (error) {
      log(`boot fetch ${path} failed — is the backend running?`, error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Operation 1: Transaction — a long (~2s) operation that is a real root.
// ---------------------------------------------------------------------------

async function runTransaction() {
  return trace({ name: TraceName.Transaction }, async (span) => {
    log('Transaction started —', describeParent(span));
    await sleep(2000);
    log('Transaction ended');
  });
}

// ---------------------------------------------------------------------------
// Operation 2: Wallet Alignment — interval-driven, 5s, no explicit parent.
// Supplied by a wallet controller in the shared controller packages in the real product.
// ---------------------------------------------------------------------------

async function runWalletAlignment() {
  return trace({ name: TraceName.WalletAlignment }, async (span) => {
    log('Wallet Alignment tick —', describeParent(span));
    await sleep(150);
  });
}

// ---------------------------------------------------------------------------
// Operation 3: BridgeQuotesFetched — polling-driven, 3s, no explicit parent,
// issues a real fetch. Supplied by a bridge controller in the shared controller packages.
// ---------------------------------------------------------------------------

async function runBridgeQuotesFetched() {
  return trace({ name: TraceName.BridgeQuotesFetched }, async (span) => {
    log('BridgeQuotesFetched tick —', describeParent(span));
    const traceparent = getCurrentTraceparent();
    try {
      const response = await fetch(`${API}/quote`, {
        headers: traceparent ? { traceparent } : {},
      });
      log('BridgeQuotesFetched ->', response.status);
    } catch (error) {
      log('BridgeQuotesFetched failed — is the backend running?', error.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Operation 4: Import Item — the manual start/end pattern, mirroring the real upstream
// import-asset modal handler. Note there is no explicit `id`, matching the real
// call site, which is what makes two overlapping invocations collide on the single
// `tracesByKey` key `Import Item:default`. See BUG C in shared/lib/trace.ts.
//
// One click = one handleImport(). Double-click the popup button and the second
// invocation starts before the first has finished its ~800ms of work.
// ---------------------------------------------------------------------------

let importAttempts = 0;

async function handleImport() {
  const attempt = ++importAttempts;
  log(`Import Item click #${attempt} — startTrace`);

  trace({ name: TraceName.ImportItem }); // no explicit id, matching real code

  // Simulated async work: fetch a fake asset.
  try {
    await fetch(`${API}/tokens/0x1`);
  } catch {
    /* backend down; the timing is what matters here */
  }
  await sleep(800);

  log(`Import Item click #${attempt} — endTrace`);
  endTrace({ name: TraceName.ImportItem });
  log(`Import Item click #${attempt} — done`);
}

// ===========================================================================
// TEMPORARY DIAGNOSTIC — concurrency behaviour of `parentSpan: null`
//
// Purpose: rule out any difference between bare Node's microtask/event-loop
// scheduling and a real MV3 service worker's behaviour under Chrome. Everything
// below runs in the actual loaded extension's worker, triggered from the popup.
//
// Each operation is started with an EXPLICIT `parentSpan: null` — not omitted —
// mirroring the validated fix, and wrapped in `withIsolationScope` exactly as the
// real `startSpan` does. It deliberately does NOT go through this branch's `trace()`,
// whose ambient `getActiveSpan()` fallback would inject a parent and defeat the test.
//
// `trace_id` and `parent_span_id` are captured and reported SEPARATELY:
//   - parent_span_id pointing at another operation's span_id would be misattachment
//   - trace_id being shared is expected and by design; every scope clone copies the
//     propagation context, so `parentSpan: null` does not (and should not) change it
// ===========================================================================

function traceWithNullParent(name, fn) {
  return sentryWithIsolationScope(() =>
    Sentry.startSpanManual({ name, op: 'custom', parentSpan: null }, fn),
  );
}

/** Snapshot of how a span was actually parented, taken at start time. */
function captureParenting(test, op, span) {
  const ctx = span.spanContext();
  const json = spanToJSON(span);
  return {
    test,
    op,
    name: json.description ?? null,
    span_id: ctx.spanId,
    trace_id: ctx.traceId,
    parent_span_id: json.parent_span_id ?? null,
  };
}

/** A promise with externally controlled resolution. */
function defer() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Test 1 — two-op overlap: B starts 5ms into A's 30ms in-flight window. */
async function concurrencyTest1() {
  const captured = [];

  const opA = traceWithNullParent('conc-t1-Op A', async (span) => {
    captured.push(captureParenting(1, 'A', span));
    await sleep(30);
    span.end();
  });

  await sleep(5); // A is still unresolved here
  const opB = traceWithNullParent('conc-t1-Op B', async (span) => {
    captured.push(captureParenting(1, 'B', span));
    await sleep(30);
    span.end();
  });

  await Promise.all([opA, opB]);
  return captured;
}

/** Test 2 — three-op overlap: C starts while both A and B are unresolved. */
async function concurrencyTest2() {
  const captured = [];

  const opA = traceWithNullParent('conc-t2-Op A', async (span) => {
    captured.push(captureParenting(2, 'A', span));
    await sleep(60);
    span.end();
  });

  await sleep(10);
  const opB = traceWithNullParent('conc-t2-Op B', async (span) => {
    captured.push(captureParenting(2, 'B', span));
    await sleep(60);
    span.end();
  });

  await sleep(10); // both A and B unresolved here
  const opC = traceWithNullParent('conc-t2-Op C', async (span) => {
    captured.push(captureParenting(2, 'C', span));
    await sleep(60);
    span.end();
  });

  await Promise.all([opA, opB, opC]);
  return captured;
}

/**
 * Test 3 — deterministic and timer-free. All three operations suspend on an
 * unresolved, hand-controlled promise before ANY of them resolves, then resolve out
 * of order: C, then A, then B. No setTimeout anywhere in the critical section, so
 * the result cannot be an artefact of timer coalescing or clamping.
 */
async function concurrencyTest3() {
  const captured = [];
  const gateA = defer();
  const gateB = defer();
  const gateC = defer();

  // Each call runs synchronously up to its first await, so after these three lines
  // all three spans are open and all three bodies are suspended.
  const opA = traceWithNullParent('conc-t3-Op A', async (span) => {
    captured.push(captureParenting(3, 'A', span));
    await gateA.promise;
    span.end();
  });
  const opB = traceWithNullParent('conc-t3-Op B', async (span) => {
    captured.push(captureParenting(3, 'B', span));
    await gateB.promise;
    span.end();
  });
  const opC = traceWithNullParent('conc-t3-Op C', async (span) => {
    captured.push(captureParenting(3, 'C', span));
    await gateC.promise;
    span.end();
  });

  gateC.resolve();
  await opC;
  gateA.resolve();
  await opA;
  gateB.resolve();
  await opB;

  return captured;
}

/** Analyse a test's captures: parent_span_id and trace_id reported separately. */
function analyse(rows) {
  const spanIds = new Set(rows.map((r) => r.span_id));
  const crossParented = rows.filter(
    (r) => r.parent_span_id && spanIds.has(r.parent_span_id),
  );
  const traceIds = [...new Set(rows.map((r) => r.trace_id))];

  return {
    ops: rows.length,
    // Question 1 — the one that would be a real defect.
    parent_span_id_points_at_sibling: crossParented.length > 0,
    cross_parented: crossParented.map((r) => `${r.op} -> ${r.parent_span_id}`),
    parent_span_ids: rows.map((r) => `${r.op}=${r.parent_span_id ?? 'null'}`),
    // Question 2 — sharing here is expected, by design.
    distinct_trace_ids: traceIds.length,
    all_share_one_trace_id: traceIds.length === 1,
    trace_ids: traceIds,
  };
}

async function runConcurrencyTest() {
  log('=== concurrency diagnostic starting (real MV3 service worker) ===');

  const t1 = await concurrencyTest1();
  const t2 = await concurrencyTest2();
  const t3 = await concurrencyTest3();

  const report = {
    context: 'mv3-service-worker',
    userAgent: navigator.userAgent,
    sdk: '8.33.1',
    capturedAt: new Date().toISOString(),
    tests: {
      test1_two_op_overlap: { rows: t1, summary: analyse(t1) },
      test2_three_op_overlap: { rows: t2, summary: analyse(t2) },
      test3_deterministic_promises: { rows: t3, summary: analyse(t3) },
    },
  };

  for (const [key, value] of Object.entries(report.tests)) {
    log(key, JSON.stringify(value.summary));
  }

  // Self-report to the local sink. The authority is still the span envelopes in
  // captured-spans.jsonl — this file exists so the two can be cross-checked.
  try {
    await fetch(`${API}/__diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (error) {
    log('could not post diagnostic report', error.message);
  }

  log('=== concurrency diagnostic complete ===');
  return report;
}

// ---------------------------------------------------------------------------
// Demo driver — a fixed 15s schedule.
//
// NOTE: there is deliberately no keep-alive here. Chrome terminating this worker is
// BUG B.2, not an inconvenience to be worked around: with no flush() the transport's
// batched envelopes die with the worker.
// ---------------------------------------------------------------------------

const DEMO_WINDOW_MS = 15000;
let demoRunning = false;

async function runDemo() {
  if (demoRunning) {
    log('demo already running');
    return { started: false, reason: 'already-running' };
  }
  demoRunning = true;
  log('=== demo run started (15s) ===');

  const quotesInterval = setInterval(runBridgeQuotesFetched, 3000);
  const alignmentInterval = setInterval(runWalletAlignment, 5000);
  const transactionTimers = [
    setTimeout(runTransaction, 4500),
    setTimeout(runTransaction, 8500),
  ];

  setTimeout(() => {
    clearInterval(quotesInterval);
    clearInterval(alignmentInterval);
    transactionTimers.forEach(clearTimeout);
    demoRunning = false;
    log('=== demo run finished ===');
  }, DEMO_WINDOW_MS);

  return { started: true, windowMs: DEMO_WINDOW_MS };
}

/**
 * Kill the service worker on demand, so BUG B.2 is demonstrable rather than a matter
 * of waiting for Chrome's ~30s idle timeout. Anything still batched in the transport
 * at this moment is what the missing flush() would have rescued.
 */
function terminateWorker() {
  log('=== terminating service worker (no flush) ===');
  chrome.runtime.reload();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'RUN_DEMO') {
    runDemo().then(sendResponse);
    return true;
  }
  if (message?.type === 'CONCURRENCY_TEST') {
    runConcurrencyTest().then((report) => sendResponse({ done: true, report }));
    return true;
  }
  if (message?.type === 'IMPORT_ITEM') {
    handleImport();
    sendResponse({ started: true });
    return false;
  }
  if (message?.type === 'TERMINATE_WORKER') {
    sendResponse({ terminating: true });
    setTimeout(terminateWorker, 50);
    return false;
  }
  if (message?.type === 'STATUS') {
    sendResponse({ running: demoRunning });
    return false;
  }
  return false;
});

// Exposed for driving the demo from the service worker console.
self.__runDemo = runDemo;
self.__importItem = handleImport;
self.__runConcurrencyTest = runConcurrencyTest;
self.__terminateWorker = terminateWorker;

runBootFetches();
markBackgroundInitialized();

log('service worker ready — popup button or self.__runDemo()');
