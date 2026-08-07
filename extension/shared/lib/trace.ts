import * as Sentry from '@sentry/browser';
import {
  getActiveSpan as sentryGetActiveSpan,
  startSpan as sentryStartSpan,
  startSpanManual as sentryStartSpanManual,
  withIsolationScope as sentryWithIsolationScope,
  continueTrace as sentryContinueTrace,
} from '@sentry/browser';
import {
  getCurrentScope,
  _INTERNAL_setSpanForScope as setSpanForScope,
} from '@sentry/core';

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

  /**
   * Real value from the upstream enum. Used with the manual start/end pattern and no
   * explicit `id`, which is what triggers the tracesByKey collision.
   */
  ImportItem = 'Import Item',
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
  /**
   * Opt in to inheriting the ambient active span when no explicit parent is given.
   *
   * BUG B.1's fix. Previously this behaviour was the silent default, so a call site
   * that wanted a real root and a call site that had simply forgotten to pass a
   * parent were indistinguishable. Making it an explicit, named option means every
   * call site that relies on it has to say so — which is exactly what would have
   * surfaced `Wallet Alignment` and the quote fetch as needing review.
   */
  allowActiveSpanFallback?: boolean;

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

/**
 * The tracesByKey collision — fix, part 1.
 *
 * `startTrace` now mints a unique id for every invocation that does not supply one, so
 * the key it writes is unique per invocation and `tracesByKey` can never collide. A
 * monotonic counter is used rather than `crypto.randomUUID()`: it is cheaper, it is
 * deterministic in tests, and uniqueness only has to hold within one worker lifetime,
 * which is the entire lifetime of the Map.
 *
 * The catch this has to solve: `endTrace({ name })` receives no id, so it cannot
 * recompute a generated key on its own. A second index maps each name to its
 * outstanding generated ids in start order, and `endTrace` takes the oldest. So
 * generation stays scoped to `startTrace` — zero call-site changes — while ends still
 * resolve.
 *
 * An explicit `id` from the caller bypasses all of this and pairs exactly; that
 * remains the precise option, and the warning below points callers at it.
 */
let traceSequence = 0;

function nextTraceId(): string {
  traceSequence += 1;
  return `auto-${traceSequence}`;
}

/** name -> generated ids still awaiting an endTrace, oldest first. */
const pendingAutoIdsByName: Map<string, string[]> = new Map();

/**
 * The tracesByKey collision — fix, part 2: keep a manually started span active
 * until it ends.
 *
 * `startSpanManual` only makes the span active for the synchronous duration of its
 * callback, so with the manual start/end pattern nothing that happens between
 * `trace()` and `endTrace()` nests inside the span: fetches issued in that window
 * attach to whatever is ambiently active instead (in a service worker, the pageload
 * span). Binding the span on the caller's scope for the whole window fixes that.
 *
 * A stack is needed rather than a single save/restore because same-name operations can
 * overlap and can end out of order. On end, the active span reverts to the innermost
 * manual span that is still open, or to the baseline that was active before the first
 * one started.
 */
type BoundSpan = { span: Sentry.Span; scope: Sentry.Scope };

const boundSpans: BoundSpan[] = [];
let baselineSpan: Sentry.Span | undefined;

function bindActive(scope: Sentry.Scope, span: Sentry.Span): void {
  if (boundSpans.length === 0) {
    baselineSpan = sentryGetActiveSpan();
  }
  boundSpans.push({ span, scope });
  setSpanForScope(scope, span);
}

function unbindActive(span: Sentry.Span): void {
  const index = boundSpans.findIndex((entry) => entry.span === span);
  if (index === -1) {
    return;
  }
  const [removed] = boundSpans.splice(index, 1);
  const innermost = boundSpans[boundSpans.length - 1];
  setSpanForScope(
    innermost?.scope ?? removed.scope,
    innermost?.span ?? baselineSpan,
  );
  if (boundSpans.length === 0) {
    baselineSpan = undefined;
  }
}

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

  // An explicit id pairs exactly. Without one, take the oldest outstanding generated
  // id for this name, so the Nth end pairs with the Nth start.
  let { id } = request;
  const outstanding = pendingAutoIdsByName.get(name);

  if (!id) {
    id = outstanding?.shift();
    if (outstanding && outstanding.length === 0) {
      pendingAutoIdsByName.delete(name);
    }
  }

  const key = id ? getTraceKey({ name, id }) : getTraceKey(request);
  const pendingTrace = tracesByKey.get(key);

  if (!pendingTrace) {
    log('No pending trace found', name, request.id);
    return;
  }

  tracesByKey.delete(key);
  pendingTrace.end(timestamp);
  log(
    'Ended trace',
    name,
    id,
    `(${pendingAutoIdsByName.get(name)?.length ?? 0} still pending)`,
  );
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

  // The caller's scope, captured BEFORE entering withIsolationScope/startSpanManual —
  // those fork, and a span bound on a fork disappears when the fork pops.
  const outerScope = getCurrentScope();

  const callback = (span: Sentry.Span | null) => {
    const end = (timestamp?: number) => {
      if (span) {
        unbindActive(span);
      }
      span?.end(timestamp);
    };

    // Unique per invocation unless the caller supplied an id, so the key cannot
    // collide with a concurrent call of the same name.
    const id = request.id ?? nextTraceId();
    const key = getTraceKey({ ...request, id });

    if (!request.id) {
      const outstanding = pendingAutoIdsByName.get(name) ?? [];
      if (outstanding.length > 0) {
        log(
          `WARNING: ${outstanding.length + 1} concurrent "${name}" traces have no ` +
            'explicit `id`. Each has its own span and key, and ends are paired FIFO, ' +
            'but pass an `id` to pair them exactly.',
        );
      }
      outstanding.push(id);
      pendingAutoIdsByName.set(name, outstanding);
    }

    tracesByKey.set(key, { end, request, startTime, span });

    // Keep the span active until endTrace, so work done in between nests inside it.
    if (span) {
      bindActive(outerScope, span);
    }

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
    const parentName = (parentContext as { _name: string })._name;
    const explicitId = (parentContext as { _id?: string })._id;
    // Generated ids mean `name:default` no longer exists, so without an explicit id
    // resolve to the most recently started outstanding trace of that name.
    const outstanding = pendingAutoIdsByName.get(parentName);
    const resolvedId =
      explicitId ?? (outstanding ? outstanding[outstanding.length - 1] : undefined);
    if (!resolvedId) {
      return null;
    }
    return tracesByKey.get(getTraceKey({ name: parentName, id: resolvedId }))?.span ?? null;
  }

  return null;
}

function startSpan<T>(
  request: TraceRequest,
  callback: (spanOptions: Sentry.StartSpanOptions) => T,
) {
  const {
    data: attributes,
    name,
    parentContext,
    startTime,
    op,
    allowActiveSpanFallback,
  } = request;
  let parentSpan = resolveParentSpan(parentContext);

  // Inherit from active span (e.g. browserTracingIntegration's pageload/navigation)
  // ONLY when the caller has explicitly opted in. Must capture before
  // withIsolationScope severs the active span context chain.
  //
  // BUG B.1's fix is the added `allowActiveSpanFallback` condition. Without it this
  // block ran for every call with no explicit parent, so timer- and poll-driven
  // operations silently adopted whatever unrelated long-lived root happened to be
  // active — in a service worker, the pageload idle span. They were then
  // force-promoted to transactions hanging off it, and orphaned outright whenever
  // that root was never flushed.
  //
  // Now a caller must either pass a real `parentContext` or say
  // `allowActiveSpanFallback: true`. Anything that does neither becomes its own root,
  // which for a poll is the correct answer.
  let forceTransaction: boolean | undefined;
  if (!parentSpan && !parentContext && allowActiveSpanFallback) {
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

/**
 * The `tracesByKey` collision.
 *
 * The key is derived from name + id, and `id` defaults to the literal `'default'`
 * when a caller omits it. Callers that follow the manual start/end pattern without
 * passing an `id` — which is the common case in UI code — therefore all share the
 * single key `<name>:default`.
 *
 * `tracesByKey` is a plain module-level Map with no per-call isolation, so two
 * overlapping operations of the same name collide:
 *
 *   startTrace #1  ->  Map['Import Item:default'] = span A
 *   startTrace #2  ->  Map['Import Item:default'] = span B   (span A is now
 *                      unreachable: nothing holds a reference to it any more)
 *   endTrace   #1  ->  reads the Map, finds span B, ends B with #1's timing,
 *                      deletes the key
 *   endTrace   #2  ->  Map is empty, logs "No pending trace found", returns
 *
 * Net effect: span B is stamped with the wrong operation's end time, and span A is
 * never ended at all — so it is never sent, and the second `endTrace()` is a silent
 * no-op. Two user actions produce one span, whose duration belongs to neither.
 */
function getTraceKey(request: TraceRequest | EndTraceRequest): string {
  return [request.name, request.id ?? 'default'].join(':');
}

function log(...args: unknown[]): void {
  console.log('[trace]', ...args);
}
