/**
 * Tiny local backend for the tracing demo.
 *
 *   GET/POST /quote      the endpoint BridgeQuotesFetched polls. Stands in for the
 *                        OTel-instrumented production service: it logs the incoming
 *                        W3C `traceparent` / `sentry-trace` headers, reports which
 *                        parent span id the caller claimed, and emits a real server
 *                        span that continues that trace.
 *
 *   POST /__envelope     envelope sink for the extension's Sentry transport.
 *                        Parses each envelope and appends one JSON line per event to
 *                        demo/captured-spans.jsonl.
 *
 * Sentry must be initialised before express is required, so its instrumentation can
 * patch the framework.
 */

const Sentry = require('@sentry/node');

/**
 * Defaults to the same project as the extension, so the whole cross-service trace
 * lands in one place with no extra setup. Point SENTRY_BACKEND_DSN at a dedicated
 * Node project to show it as a separate service — distributed tracing links them by
 * trace id either way, a shared DSN is not what does the stitching.
 */
const BACKEND_DSN =
  process.env.SENTRY_BACKEND_DSN ||
  'https://313251b97bcd5e000df5727827b6f4e5@o4508236363464704.ingest.us.sentry.io/4510671419277312';

Sentry.init({
  dsn: BACKEND_DSN,
  tracesSampleRate: 1.0,
  // Keep the demo's span tree readable: only the spans this file creates.
  defaultIntegrations: false,
  registerEsmLoaderHooks: false,
});

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const PORT = 4000;
const CAPTURE_FILE = path.join(__dirname, '..', 'demo', 'captured-spans.jsonl');

const app = express();
app.use(express.text({ type: '*/*', limit: '20mb' }));

// --- CORS: the extension origin is chrome-extension://<id> --------------------
app.use((req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// --- helpers -----------------------------------------------------------------

const ts = () => new Date().toISOString().slice(11, 23);

/** Append one JSON line to the capture file the tree printer reads. */
function appendCapture(record) {
  fs.appendFileSync(
    CAPTURE_FILE,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), ...record })}\n`,
  );
}

/**
 * A Sentry envelope is newline-delimited: a header line, then alternating
 * item-header / item-payload lines.
 */
function parseEnvelope(body) {
  const lines = body.split('\n').filter((line) => line.length > 0);
  const items = [];
  let envelopeHeader = {};
  try {
    envelopeHeader = JSON.parse(lines[0] ?? '{}');
  } catch {
    return { envelopeHeader, items };
  }
  for (let i = 1; i < lines.length; i += 2) {
    let itemHeader;
    let payload;
    try {
      itemHeader = JSON.parse(lines[i]);
      payload = JSON.parse(lines[i + 1]);
    } catch {
      continue;
    }
    items.push({ itemHeader, payload });
  }
  return { envelopeHeader, items };
}

function parseTraceparent(value) {
  // version-traceid(32)-spanid(16)-flags
  const match = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i.exec(
    (value ?? '').trim(),
  );
  if (!match) return null;
  return { traceId: match[2], parentSpanId: match[3], flags: match[4] };
}

function parseSentryTrace(value) {
  const match = /^([\da-f]{32})-([\da-f]{16})(?:-([01]))?$/i.exec(
    (value ?? '').trim(),
  );
  if (!match) return null;
  return { traceId: match[1], parentSpanId: match[2], sampled: match[3] };
}

// --- /quote ------------------------------------------------------------------

let quoteCount = 0;

/**
 * The endpoints from the confirmed production example (trace
 * a confirmed production trace), where three backend spans sat as direct siblings
 * under the `pageload /service-worker.js` root instead of under their triggering
 * client requests.
 */
app.all(
  ['/quote', '/geolocation', '/v2/supportedNetworks', '/tokens/:chainId'],
  (req, res) => {
    handleTracedRequest(req, res);
  },
);

function handleTracedRequest(req, res) {
  quoteCount += 1;
  const traceparent = req.get('traceparent');
  const sentryTrace = req.get('sentry-trace');
  const baggage = req.get('baggage');

  const w3c = parseTraceparent(traceparent);
  const legacy = parseSentryTrace(sentryTrace);
  const resolved = w3c ?? legacy;

  console.log(`\n[${ts()}] ${req.method} ${req.path}  (#${quoteCount})`);
  console.log(`  traceparent : ${traceparent ?? '(absent)'}`);
  console.log(`  sentry-trace: ${sentryTrace ?? '(absent)'}`);
  if (baggage) {
    console.log(`  baggage     : ${baggage.slice(0, 120)}`);
  }
  if (resolved) {
    console.log(
      `  -> incoming trace ${resolved.traceId}\n` +
        `  -> names parent span id ${resolved.parentSpanId}` +
        `  ${w3c ? '(from traceparent)' : '(from sentry-trace)'}`,
    );
  } else {
    console.log('  -> NO distributed-trace header: this request would orphan.');
  }

  const respond = () => {
    res.status(200).json({
      ok: true,
      quote: { srcAmount: '1000000000000000000', destAmount: '998421' },
      received: {
        traceparent: traceparent ?? null,
        sentryTrace: sentryTrace ?? null,
      },
    });
  };

  if (!resolved) {
    // Nothing to continue from — emit a root server span so the orphan is visible.
    serveQuote(req, null, respond);
    return;
  }

  /**
   * Continue the incoming trace. `continueTrace` takes the sentry-trace format, so
   * a W3C traceparent is normalised into it first — this is the "OTel backend picks
   * up the W3C header" step, without pulling in the full OTel SDK.
   *
   * Whatever parent span id the extension propagated is used verbatim. That is the
   * point of the demo: if the extension guessed a bad parent, or named a span that
   * never gets sent, this span inherits that damage and the trace shows it.
   */
  Sentry.continueTrace(
    {
      sentryTrace: `${resolved.traceId}-${resolved.parentSpanId}-1`,
      baggage: baggage ?? undefined,
    },
    () => serveQuote(req, resolved, respond),
  );
}

/**
 * The server span for a /quote request, plus a copy written to the local capture
 * file so demo/print-trace-tree.js can show the cross-service tree offline.
 */
function serveQuote(req, resolved, respond) {
  Sentry.startSpan(
    {
      name: `${req.method} ${req.path}`,
      op: 'http.server',
      attributes: {
        'http.request.method': req.method,
        'url.path': req.path,
        'sentry.origin': 'auto.http.node',
        'demo.service': 'bridge-quote-backend',
      },
    },
    (span) => {
      const { traceId, spanId } = span.spanContext();
      const parentSpanId = resolved?.parentSpanId ?? null;

      console.log(
        `  -> backend span ${spanId} in trace ${traceId}` +
          (parentSpanId ? ` under parent ${parentSpanId}` : ' as its own ROOT (orphan)'),
      );

      appendCapture({
        itemType: 'transaction',
        service: 'backend',
        event: {
          transaction: `${req.method} ${req.path} (backend)`,
          start_timestamp: Date.now() / 1000,
          timestamp: Date.now() / 1000,
          contexts: {
            trace: {
              trace_id: traceId,
              span_id: spanId,
              parent_span_id: parentSpanId,
              op: 'http.server',
            },
          },
        },
      });

      respond();
      span.end();
    },
  );
}

// --- /__envelope -------------------------------------------------------------

app.post('/__envelope', (req, res) => {
  const { envelopeHeader, items } = parseEnvelope(
    typeof req.body === 'string' ? req.body : String(req.body ?? ''),
  );
  const written = [];

  for (const { itemHeader, payload } of items) {
    const type = itemHeader.type;
    if (type !== 'transaction' && type !== 'event' && type !== 'span') {
      continue;
    }
    appendCapture({
      itemType: type,
      service: 'extension',
      sentAt: envelopeHeader.sent_at ?? null,
      event: payload,
    });
    written.push(
      `${type}:${payload.transaction ?? payload.description ?? payload.message ?? '?'}`,
    );
  }

  if (written.length > 0) {
    console.log(`[${ts()}] envelope captured -> ${written.join(', ')}`);
  }
  res.sendStatus(200);
});

/**
 * Diagnostic sink for the service worker's concurrency test self-report. Kept in its
 * own file so captured-spans.jsonl stays purely span envelopes — the span envelopes
 * remain the authority, this is only for cross-checking.
 */
app.post('/__diag', (req, res) => {
  const file = path.join(__dirname, '..', 'demo', 'concurrency-report.jsonl');
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  fs.appendFileSync(file, `${body}\n`);
  console.log(`[${ts()}] concurrency diagnostic report received (${body.length} bytes)`);
  res.sendStatus(200);
});

// --- boot --------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.type('text').send('sentry tracing repro backend: /quote, /__envelope\n');
});

fs.mkdirSync(path.dirname(CAPTURE_FILE), { recursive: true });
// Fresh capture file per backend run, so each demo pass is read in isolation.
fs.writeFileSync(CAPTURE_FILE, '');

/**
 * Spans are batched, so a hard kill loses whatever has not been exported yet. Flush
 * on Ctrl-C — otherwise the last few /quote spans silently never reach Sentry and it
 * looks like a tracing bug.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} — flushing spans to Sentry…`);
    await Sentry.flush(5000);
    process.exit(0);
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`backend listening on http://localhost:${PORT}`);
  console.log(`  /quote      <- BridgeQuotesFetched polls this`);
  console.log(`  /__envelope <- Sentry envelopes, appended to ${CAPTURE_FILE}`);
  console.log(`capture file truncated. Run the demo from the extension popup.\n`);
});
