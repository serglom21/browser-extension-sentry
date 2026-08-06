# Browser-extension trace orphaning — live repro

A Chrome MV3 extension that reproduces **both** trace-orphaning bugs from the
investigation write-up, against the real `@sentry/browser` package, and applies the
fixes across two branches so the demo can show that **the SDK upgrade fixes Bug A and
does nothing for Bug B**.

Layout mirrors the upstream repo (`shared/lib/trace.ts`,
`app/scripts/lib/setupSentry.js`, `app/scripts/background.js`, worker bundled to
`/service-worker.js`) so every diff here is a diff they could apply.

Envelopes go to the real Sentry project `snout-and-about/browser-extension` **and** to
a local file, so the demo works in the Sentry UI or fully offline via
`demo/print-trace-tree.js`.

## The three branches

| Branch | SDK | Bug A | Bug B |
| --- | --- | --- | --- |
| `main` | **8.33.1** (what production runs) | **broken** | **broken** |
| `fix/sentry-v10-upgrade` | 10.38.0 | **fixed** | **still broken** ← the money slide |
| `fix/centralized-parenting` | 10.38.0 | fixed | **fixed** |

Measured on identical 15s runs:

| | `main` | `fix/sentry-v10-upgrade` | `fix/centralized-parenting` |
| --- | --- | --- | --- |
| Backend spans sibling-attached | **8 / 8** | **0 / 8** | 0 / 8 |
| Misattached spans | **8** | **8** | **0** |
| Operations emitted as own root | **0 / 10** | **0 / 10** | **10 / 10** |
| Mega-trace | yes, 18 txns / 26.7s | yes | **none** |
| Phantom parents after worker kill | **8** | 8 | **3** |

---

## Before / after: captured traces

Three runs of the identical 15s workload, one per branch. Each produced **19
transactions**, so the counts are matched and the only differences are structural.

| Branch | Trace in Sentry | Offline fixture |
| --- | --- | --- |
| `main` — both bugs | [`c4c2dcad…`](https://snout-and-about.sentry.io/explore/traces/trace/c4c2dcada8a149e0b8c9238a0067924b) | `demo/fixtures/01-main-both-bugs.jsonl` |
| `fix/sentry-v10-upgrade` — Bug A fixed | [`c0446dc4…`](https://snout-and-about.sentry.io/explore/traces/trace/c0446dc4772c4ee49e8400a6d3f5db49) | `demo/fixtures/02-v10-upgrade-bugA-fixed.jsonl` |
| `fix/centralized-parenting` — both fixed | [`19e1a288…`](https://snout-and-about.sentry.io/explore/traces/trace/19e1a288d8814b2cbbad917a78eca147) | `demo/fixtures/03-fixed-both-bugs.jsonl` |
| `main` — Bug C, double-click only | [`4468269e…`](https://snout-and-about.sentry.io/explore/traces/trace/4468269e7692400486a9102af88536ad) | `demo/fixtures/04-tracesbykey-collision.jsonl` |

What each run measured:

| | `main` | `v10-upgrade` | `fixed` |
| --- | --- | --- | --- |
| Backend spans sibling-attached | **8 / 8** | 0 / 8 | 0 / 8 |
| Misattached spans | **8** | **8** | **0** |
| Operations as own root | **0 / 10** | **0 / 10** | **10 / 10** |
| Largest root subtree | 18 txns / 28.4s | 18 txns / 20.3s | 3 txns / 0.4s |

The fixtures are the durable copy — the Sentry links lose full fidelity after the 30-day
retention boundary, and re-running overwrites `demo/captured-spans.jsonl`. Read any
fixture without rebuilding or reloading anything:

```bash
node demo/print-trace-tree.js --file demo/fixtures/01-main-both-bugs.jsonl
node demo/print-trace-tree.js --file demo/fixtures/03-fixed-both-bugs.jsonl
```

That side-by-side is the fastest way to show the whole story, and it works with no
Chrome, no backend and no network.

One honest note on the last row: the `pageload` span itself is **not** addressed by
either Bug B fix, so it still runs to `finalTimeout` on all three branches and the
printer still labels its subtree a mega-trace on the fixed branch. What changes is what
it contains — 18 unrelated transactions over 28.4s, down to 3 boot fetches over 0.4s.
Bounding that span is separate work, tracked as the trace-id-persistence finding below.


## Bug C — the `tracesByKey` collision (unfixed)

A third defect, reproduced on `main` only. **No fix is implemented for it** — neither
Bug B change addresses it.

`shared/lib/trace.ts` keys pending manual traces in a plain module-level Map:

```js
getTraceKey(request) = [request.name, request.id ?? 'default'].join(':')
```

The `id` defaults to the literal `'default'`, so every caller that omits it — the common
case in UI code — shares the single key `<name>:default`. `Import Item` follows the real
modal pattern and passes no `id`:

```js
trace({ name: 'Import Item' });   // no explicit id, matching the real call site
// ...~800ms of async work...
endTrace({ name: 'Import Item' });
```

Double-click the popup's **Import Item** button and the second invocation starts before
the first finishes. What happens, straight from the worker console:

```
Import Item click #1 — startTrace
[trace] Started trace Import Item
Import Item click #2 — startTrace
[trace] Started trace Import Item          <- overwrites the Map entry; span A is now unreachable
Import Item click #1 — endTrace
[trace] Ended trace Import Item            <- ends span B, with click #1's timing
Import Item click #2 — endTrace
[trace] No pending trace found Import Item <- silently lost, span A never ends
```

Two failure modes at once, both confirmed in the captured JSON and in Sentry:

1. **The surviving span belongs to neither click.** It carries click #2's *start* and
   click #1's *end*. Captured at **561ms** against ~800ms of real work — short by
   239ms, which is the 250ms double-click gap. The faster the double-click, the smaller
   the error, which is what makes this hard to spot in aggregate.
2. **One `endTrace()` is a silent no-op.** Span A is never ended, so it is never sent.
   Two user actions produce **one** span.

The corroborating detail worth pointing at: the backend logged **two** `/tokens/0x1`
import fetches, so both clicks demonstrably did their work. Sentry shows one span.

Note that signature 2 cannot be detected from the captured data alone — the lost span
leaves no record at all. The printer flags it by comparing against the expected
invocation count, which the demo knows because it double-clicks deliberately.

## Setup

Node 18+ and Chrome. **Rebuild after every branch switch** — Chrome loads the bundle,
not the sources.

```bash
cd extension && npm install && npm run build && cd ..
cd backend && npm install && cd ..
node backend/server.js     # leave running; Ctrl-C to flush, never kill -9
```

Load in Chrome: `chrome://extensions` → enable **Developer mode** (unpacked extensions
are blocked without it) → **Load unpacked** → select `extension/`.

Run: click the toolbar icon → **Run 15s demo**. Then either wait ~30s for the pageload
transaction to flush, or click **Kill service worker** to demo span loss. Read results
with `node demo/print-trace-tree.js`.

---

## Bug A — sibling attachment

`app/scripts/lib/sentry-trace-propagation.ts` reproduces the `getCurrentTraceparent()`
that the SDK upgrade PR removed. It
resolves `getActiveSpan()` *ambiently*, so in a service worker every outgoing request
advertises the long-lived `pageload` span instead of its own.

**The single best artifact in the whole demo** is one line of the backend log on `main`.
The two headers disagree:

```
GET /geolocation
 traceparent : 00-746f1c48...-a4876f539b2d0697-01  <- hand-rolled: pageload
 sentry-trace: 746f1c48...-a716ad56cc4f3596-1    <- SDK: this request's own span
GET /v2/supportedNetworks
 traceparent : 00-746f1c48...-a4876f539b2d0697-01  <- same id again
 sentry-trace: 746f1c48...-b3999cce34ac4957-1    <- different id again
```

The hand-rolled header is identical for all three requests; the SDK's is unique per
request. The backend believes `traceparent`, so all three server spans parent to
pageload:

```
/service-worker.js [txn] op=pageload <root>
  ├─ GET .../geolocation     [span] op=http.client
  ├─ GET /geolocation (backend)  [txn] op=http.server  ⚠ SIBLING-ATTACHED
  ├─ GET .../v2/supportedNetworks [span] op=http.client
  ├─ GET /v2/supportedNetworks (backend) [txn]      ⚠ SIBLING-ATTACHED
  ├─ GET .../tokens/0x1      [span] op=http.client
  └─ GET /tokens/0x1 (backend)  [txn]          ⚠ SIBLING-ATTACHED
```

Same three endpoints, same shape as confirmed production trace
`a confirmed production trace`.

On `fix/sentry-v10-upgrade` the two headers become identical, and the printer reports
`BUG A clear — all 8 backend span(s) nested under their triggering http.client span`.

---

## Bug B — the dominant one

**B.1** `shared/lib/trace.ts` is ported from their live `main`, keeping
`resolveParentSpan`, `withIsolationScope`, the `continueTrace` path, and the fallback
with its comment verbatim. Their own comment names the mechanism:

> `// Inherit from active span (e.g. browserTracingIntegration's pageload/navigation)`
> `// when no explicit parent is provided.`

Result on `main` and on the upgrade branch: **8 misattached spans, 0 of 10 operations a
root**. `Wallet Alignment` lands under `Transaction`, under `BridgeQuotesFetched`, and
under `pageload` on different firings in the same run — the parent depends on what
happened to be in flight.

Fixed by gating the fallback:

```js
if (!parentSpan && !parentContext && allowActiveSpanFallback) {
```

→ **0 misattached, 10/10 roots, no mega-trace.**

**B.2** No `flush()` anywhere. Click **Kill service worker** mid-run on `main`: the
pageload transaction is never sent, and **8 spans are left citing parent
`8727f0ea97ce7120`, which does not exist in the captured set** — the same shape as
their their widely-cited missing parent id example (many citations, zero results org-wide).

---

## Three corrections to the write-up

These are measured, not inferred, and all three matter on the call.

### 1. `chrome.runtime.onSuspend` does not fire in MV3 — the specced B.2 fix will not run

`chrome.runtime.onSuspend` **exists** in MV3 and `addListener` succeeds, so the code
passes review and looks correct. But Chrome never delivers the event to a service
worker. Verified by persisting a marker inside the listener and reading it back after
Chrome terminated the worker on its own idle timeout:

```
[suspend] worker gone after ~30s idle
[suspend] chrome.storage.local -> {}
[suspend] VERDICT: onSuspend did NOT fire
```

`onSuspend` is an MV2 event-page signal; MV3 workers are killed without warning and
offer no teardown hook. The listener is kept here because it is harmless and is what
the write-up asks for, but **a debounced post-operation flush is what actually works**.
Recommend flushing when operations go quiet rather than at teardown.

Related: `flush()` cannot rescue the pageload transaction at all. An idle span that has
never *ended* is not in the transport, so there is nothing to flush. Only ending it —
or not depending on it, which the B.1 fix achieves — helps.

### 2. Every `develop` link in the write-up points at abandoned code

`develop` was last touched **2026-01-15**, and `shared/lib/trace.ts` there on
**2024-11-25**. That copy reads `const parentSpan = (parentContext ?? null)` — i.e. it
has **no fallback**. Anyone clicking the write-up's `trace.ts` link mid-call sees code
that appears already fixed.

The bug is live on **`main`** (`trace.ts:536-544`, `allowActiveSpanFallback` appears
zero times). Repoint all `develop` links to `main`.

### 3. The upgrade is merged, not "staged in develop"

the SDK upgrade PR merged into **`main` on 2026-07-17**. `main` is already on `10.38.0` with
`propagateTraceparent: true` at `setupSentry.js:139`, and
`shared/lib/sentry-trace-propagation.ts` returns **404**. "Not yet shipped to
production users" is still consistent with 100/100 spans on 8.33.1 — but the code
landed three weeks ago, so say *merged, pending release*, not *staged in develop*.

---

## What the fixes do not fix

Phantom parents drop from 8 to 3 — they do not reach zero. The three that remain are
the boot fetches: their `http.client` spans live *inside* the pageload transaction, so
when that is never flushed the backend spans are orphaned even though propagation was
correct.

That is precisely the scope of the upstream backlog ticket for *"rooting background
fetches in their own trace"* — the *"remaining orphan half."* Worth saying
out loud: the repro independently lands on the same residual their own ticket tracks,
and neither Bug B fix closes it.

Supporting, not one of the two bugs: the `pageload` span in a worker cannot auto-finish
(idle spans are created with `disableAutoFinish: true`, and the timeout is only enabled
from a `readystatechange` listener guarded on `WINDOW.document`, which a worker lacks),
so it lives to the 30s `finalTimeout`. Verified identical in 8.33.1 and 10.38.0. This is
the long-lived root both bugs latch onto, and the mechanism behind one trace id
absorbing weeks of activity.
