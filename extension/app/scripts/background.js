import * as Sentry from '@sentry/browser';
import { spanToJSON } from '@sentry/core';
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
// Operation 4: Import Item — the manual start/end pattern, mirroring the real
// import-nfts-modal.js handler. Note there is no explicit `id`, matching the real
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
self.__terminateWorker = terminateWorker;

runBootFetches();
markBackgroundInitialized();

log('service worker ready — popup button or self.__runDemo()');
