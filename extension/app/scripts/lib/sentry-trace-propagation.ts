import { getActiveSpan } from '@sentry/browser';

/**
 * BUG A — "sibling attachment".
 *
 * Reproduction of the upstream hand-rolled W3C traceparent injection, removed by the
 * SDK upgrade. The file existed because `@sentry/browser@8.33.1`
 * has NO native way to emit a `traceparent` header — verified: the string
 * "traceparent" appears zero times anywhere in 8.33.1's `@sentry/core` build.
 * `propagateTraceparent` is a v10-only option.
 *
 * The defect is the ambient lookup on the first line of the function. It asks "what
 * span is active right now?" instead of being handed the span for *this specific
 * request*. In a service worker the ambient active span is the long-lived
 * browserTracing `pageload` span, so every outgoing request advertises the pageload
 * span as its parent. The backend then creates its server span as a direct child of
 * pageload — a SIBLING of the client request span that actually triggered it, rather
 * than its child.
 *
 * This is the same anti-pattern as Bug B in `shared/lib/trace.ts`: calling
 * `getActiveSpan()` ambiently rather than passing the span tied to the real operation.
 * One anti-pattern, two independent defects.
 *
 * By contrast the SDK's own fetch instrumentation — identical in 8.33.1 and 10.38.0 —
 * uses the request's own span for headers and never re-derives it from
 * `getActiveSpan()`.
 */
export function getCurrentTraceparent(): string | undefined {
  const activeSpan = getActiveSpan();

  if (activeSpan) {
    const { traceId, spanId, traceFlags } = activeSpan.spanContext();
    const flags = traceFlags === 1 ? '01' : '00';
    return `00-${traceId}-${spanId}-${flags}`;
  }

  return undefined;
}
