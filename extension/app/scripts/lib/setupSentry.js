import * as Sentry from '@sentry/browser';
import { createTransport } from '@sentry/core';

/**
 * Port of the upstream project's `app/scripts/lib/setupSentry.js` (branch `main`), on the
 * pre-upgrade SDK.
 *
 * BUG A is fixed on this branch, by upgrading the SDK — the same change the upstream project made
 * in the SDK upgrade PR. `propagateTraceparent` is a v10-only option; enabling it lets the SDK
 * emit the W3C header itself, naming each request's own span, which is why the
 * hand-rolled `sentry-trace-propagation.ts` could be deleted outright.
 *
 * BUG B is fixed on this branch too, by two changes in the upstream code — neither
 * of which required the SDK upgrade:
 *
 *   - B.1: `shared/lib/trace.ts` now gates the `getActiveSpan()` fallback behind an
 *     explicit `allowActiveSpanFallback` opt-in.
 *   - B.2: `app/scripts/background.js` now calls `Sentry.flush()` on teardown.
 */

export const ENVELOPE_SINK_URL = 'http://localhost:4000/__envelope';

const DSN =
  'https://313251b97bcd5e000df5727827b6f4e5@o4508236363464704.ingest.us.sentry.io/4510671419277312';

/**
 * Tee transport: envelopes go to the real Sentry project *and* to the local sink that
 * demo/print-trace-tree.js reads, so the demo works offline and in the Sentry UI.
 *
 * Built on `createTransport` rather than wrapping `makeFetchTransport`, because
 * `request.body` here is already the serialized envelope — the same shape both the
 * sink and Sentry's ingest endpoint want. That keeps this file identical across the
 * 8.33.1 and 10.38.0 branches.
 */
/**
 * Counters for the flush-rescue diagnostic.
 *
 * `confirmedSent` counts only envelopes whose upstream POST returned a status — i.e.
 * requests that demonstrably completed before the worker died. Envelopes still in
 * flight when the worker is terminated never reach this counter, which is exactly the
 * loss window being measured.
 */
export const transportStats = {
  marker: null,
  attempted: 0,
  confirmedSent: 0,
  onChange: null,
};

function makeTeeTransport(options) {
  return createTransport(options, async (request) => {
    const isDiagnostic =
      transportStats.marker &&
      typeof request.body === 'string' &&
      request.body.includes(transportStats.marker);

    if (isDiagnostic) {
      transportStats.attempted += 1;
      transportStats.onChange?.();
    }
    // Local copy. Deliberately not awaited: a stopped backend must not delay or
    // fail delivery to Sentry.
    fetch(ENVELOPE_SINK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body: request.body,
    }).catch((error) => {
      console.warn(
        '[repro] local sink unreachable — is `node backend/server.js` running?',
        error?.message ?? error,
      );
    });

    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          ...options.headers,
          'content-type': 'application/x-sentry-envelope',
        },
        body: request.body,
      });
      console.log(`[repro] envelope -> sentry.io HTTP ${response.status}`);
      if (isDiagnostic) {
        transportStats.confirmedSent += 1;
        transportStats.onChange?.();
      }
      return { statusCode: response.status };
    } catch (error) {
      console.warn(
        '[repro] envelope upload to sentry.io FAILED',
        error?.message ?? error,
      );
      return { statusCode: 0 };
    }
  });
}

export function setupSentry() {
  Sentry.init({
    dsn: DSN,
    transport: makeTeeTransport,
    tracesSampleRate: 1.0,
    tracePropagationTargets: ['localhost'],
    /**
     * BUG A's fix. v10-only. The SDK now emits the W3C `traceparent` itself, derived
     * from the span belonging to each individual request, so no hand-rolled header —
     * and no ambient `getActiveSpan()` lookup — is involved.
     */
    propagateTraceparent: true,
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.extraErrorDataIntegration(),
      /**
       * the upstream project registers this unconditionally in the background service worker.
       *
       * `self.location` exists in a worker, so the SDK starts a `pageload` idle span
       * for the worker script and binds it as the active span on the worker's shared
       * scope. It then cannot close on time: pageload idle spans are created with
       * `disableAutoFinish: true` and the idle timeout is only enabled from a
       * `readystatechange` listener guarded on `WINDOW.document`. A service worker has
       * no `document`, so that never fires and the span survives to the hard
       * `finalTimeout` (30s).
       *
       * Verified byte-for-byte identical in 8.33.1 and 10.38.0.
       *
       * That long-lived pageload span is the "active span" both bugs then latch onto:
       * BUG A advertises it as the traceparent for every outgoing request, and BUG B.1
       * adopts it as the parent for every untagged operation.
       */
      Sentry.browserTracingIntegration({
        // the upstream predicate, verbatim.
        shouldCreateSpanForRequest: (url) => {
          // Do not create spans for outgoing requests to a 'sentry.io' domain.
          return !url.match(/^https?:\/\/([\w\d.@-]+\.)?sentry\.io(\/|$)/u);
        },
      }),
    ],
  });

  console.log('[repro] Sentry initialised — @sentry/browser 10.38.0 (both bugs fixed)');
}

/**
 * Simulated BACKGROUND_INITIALIZED point. Records boot work as a child of whatever
 * root is active (the pageload span) and deliberately does not end it.
 */
export function markBackgroundInitialized() {
  Sentry.startInactiveSpan({
    name: 'background.bootstrap',
    op: 'function',
  })?.end();

  console.log('[repro] BACKGROUND_INITIALIZED — pageload transaction left open');
}
