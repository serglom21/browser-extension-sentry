import * as Sentry from '@sentry/browser';
import {
  getActiveSpan as sentryGetActiveSpan,
  startSpan as sentryStartSpan,
  startSpanManual as sentryStartSpanManual,
  withIsolationScope as sentryWithIsolationScope,
  continueTrace as sentryContinueTrace,
} from '@sentry/browser';

/**
 * Port of the upstream project's `shared/lib/trace.ts` (branch `main`).
 *
 * BUG B.1 lives in `startSpan` below: when no explicit parent is supplied it falls
 * back to `sentryGetActiveSpan()` and force-promotes the result to a transaction.
 *
 * Kept deliberately close to the real file — same public API (`trace`/`endTrace`),
 * same `TraceName` enum, same `resolveParentSpan` / `hasDistributedTraceIds` /
 * `withIsolationScope` / `continueTrace` structure — so the diff on the fix branch is
 * the same diff upstream would apply.
 */

export enum TraceName {
  // Real values from the upstream project's enum.
  Transaction = 'Transaction',
  SwapQuotesFetched = 'Swap Quotes Fetched',
  BackgroundConnect = 'Background Connect',

  /**
   * These two are not in the upstream enum — they are supplied by controllers in
   * the shared controller packages (a wallet controller and a bridge controller), which
   * receive `trace` via `config: { trace }` and call it with **no explicit parent**.
   * They are the two operations the investigation actually measured.
   */
  WalletAlignment = 'Wallet Alignment',
  BridgeQuotesFetched = 'BridgeQuotesFetched',
}

const OP_DEFAULT = 'custom';

export type TraceContext = unknown;

/** Serialized trace context for cross-boundary propagation. */
export type SerializedTraceContext = {
  _name?: string;
  _id?: string;
  _traceId?: string;
  _spanId?: string;
};

export type TraceCallback<T> = (context?: TraceContext) => T;

export type TraceRequest = {
  data?: Record<string, number | string | boolean>;
  id?: string;
  name: TraceName | `${'Background RPC' | 'Messenger Call'}: ${string}`;
  op?: string;
  parentContext?: TraceContext;
  startTime?: number;
  tags?: Record<string, number | string | boolean>;
};

export type EndTraceRequest = {
  name: TraceName | string;
  id?: string;
  timestamp?: number;
};

type PendingTrace = {
  end: (timestamp?: number) => void;
  request: TraceRequest;
  startTime: number;
  span: Sentry.Span | null;
};

const tracesByKey: Map<string, PendingTrace> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function trace<ResultType>(
  request: TraceRequest,
  fn: TraceCallback<ResultType>,
): ResultType;
export function trace(request: TraceRequest): TraceContext;

export function trace<T>(
  request: TraceRequest,
  fn?: TraceCallback<T>,
): T | TraceContext {
  if (!fn) {
    return startTrace(request);
  }
  return traceCallback(request, fn);
}

export function endTrace(request: EndTraceRequest): void {
  const { name, timestamp } = request;
  const key = getTraceKey(request);
  const pendingTrace = tracesByKey.get(key);

  if (!pendingTrace) {
    log('No pending trace found', name, request.id);
    return;
  }

  pendingTrace.end(timestamp);
  tracesByKey.delete(key);
  log('Ended trace', name, request.id);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function traceCallback<ResultType>(
  request: TraceRequest,
  fn: TraceCallback<ResultType>,
): ResultType {
  const { name } = request;

  const callback = (span: Sentry.Span | null) => {
    log('Starting trace', name, request);
    return fn(span) as ResultType;
  };

  return startSpan(request, (spanOptions) =>
    sentryStartSpan(spanOptions, callback),
  );
}

function startTrace(request: TraceRequest): TraceContext {
  const { name, startTime: requestStartTime } = request;
  const startTime = requestStartTime ?? Date.now();

  const callback = (span: Sentry.Span | null) => {
    const end = (timestamp?: number) => {
      span?.end(timestamp);
    };

    const pendingTrace = { end, request, startTime, span };
    tracesByKey.set(getTraceKey(request), pendingTrace);

    log('Started trace', name, request);
    return span;
  };

  return startSpan(request, (spanOptions) =>
    sentryStartSpanManual(spanOptions, callback),
  );
}

/** Check if value is a valid Sentry Span (has spanContext method). */
function isValidSentrySpan(value: unknown): value is Sentry.Span {
  return (
    typeof value === 'object' &&
    value !== null &&
    'spanContext' in value &&
    typeof (value as Sentry.Span).spanContext === 'function'
  );
}

function hasDistributedTraceIds(
  value: unknown,
): value is Required<Pick<SerializedTraceContext, '_traceId' | '_spanId'>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_traceId' in value &&
    '_spanId' in value &&
    typeof (value as SerializedTraceContext)._traceId === 'string' &&
    typeof (value as SerializedTraceContext)._spanId === 'string'
  );
}

function resolveParentSpan(parentContext: unknown): Sentry.Span | null {
  if (!parentContext) {
    return null;
  }

  if (isValidSentrySpan(parentContext)) {
    return parentContext;
  }

  // Same-process lookup by name/id, as the real implementation does.
  if (
    typeof parentContext === 'object' &&
    '_name' in parentContext &&
    typeof (parentContext as { _name?: unknown })._name === 'string'
  ) {
    const key = `${(parentContext as { _name: string })._name}:${
      (parentContext as { _id?: string })._id ?? 'default'
    }`;
    return tracesByKey.get(key)?.span ?? null;
  }

  return null;
}

function startSpan<T>(
  request: TraceRequest,
  callback: (spanOptions: Sentry.StartSpanOptions) => T,
) {
  const { data: attributes, name, parentContext, startTime, op } = request;
  let parentSpan = resolveParentSpan(parentContext);

  // Inherit from active span (e.g. browserTracingIntegration's pageload/navigation)
  // when no explicit parent is provided. Must capture before withIsolationScope
  // severs the active span context chain.
  // forceTransaction preserves transaction-level visibility for monitoring while
  // linking to the auto-instrumentation hierarchy.
  //
  // ^ That comment is the upstream, verbatim. It is also the bug: for anything
  // driven by a timer, a poll or a messenger call, "the active span" is an unrelated
  // long-lived root -- in a service worker, the pageload idle span -- so the
  // operation is force-promoted to a transaction hanging off something it has no
  // relationship to. When that root is never flushed, the operation is orphaned.
  let forceTransaction: boolean | undefined;
  if (!parentSpan && !parentContext) {
    const activeSpan = sentryGetActiveSpan();
    if (activeSpan) {
      parentSpan = activeSpan;
      forceTransaction = true;
    }
  }

  const spanOptions: Sentry.StartSpanOptions = {
    attributes,
    name,
    op: op ?? OP_DEFAULT,
    parentSpan,
    startTime,
    forceTransaction,
  };

  // Cross-process propagation via continueTrace when we have serialized
  // trace/span IDs but couldn't resolve a local parent span from the map.
  if (!parentSpan && hasDistributedTraceIds(parentContext)) {
    const sentryTrace = `${parentContext._traceId}-${parentContext._spanId}-1`;
    return sentryContinueTrace({ sentryTrace, baggage: undefined }, () =>
      sentryWithIsolationScope(() =>
        callback({ ...spanOptions, parentSpan: undefined }),
      ),
    );
  }

  return sentryWithIsolationScope(() => callback(spanOptions));
}

function getTraceKey(request: TraceRequest | EndTraceRequest): string {
  const { name } = request;
  const id = 'id' in request ? request.id ?? 'default' : 'default';
  return `${name}:${id}`;
}

function log(...args: unknown[]): void {
  console.log('[trace]', ...args);
}
