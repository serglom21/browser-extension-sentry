#!/usr/bin/env node
/**
 * Reads demo/captured-spans.jsonl and prints an ASCII parent/child tree per trace.
 *
 * For each node: name, op, span id, parent id, and whether that parent id actually
 * resolves to something in the captured set. Then a diagnostics section that names
 * the parent each demo operation ended up with, and flags mega-traces.
 *
 *   node demo/print-trace-tree.js
 *   node demo/print-trace-tree.js --file some/other.jsonl
 */

const fs = require('node:fs');
const path = require('node:path');

const DEMO_OPS = ['Transaction', 'Wallet Alignment', 'BridgeQuotesFetched'];

/**
 * Operations driven by a timer / poll. Nothing in the demo legitimately parents
 * these: they are not started by, and do not belong to, any other operation. Every
 * parent they end up with is therefore a parent the wrapper guessed.
 */
const POLL_DRIVEN = new Set(['Wallet Alignment', 'BridgeQuotesFetched']);

const fileArgIndex = process.argv.indexOf('--file');
const CAPTURE_FILE =
  fileArgIndex !== -1 && process.argv[fileArgIndex + 1]
    ? path.resolve(process.argv[fileArgIndex + 1])
    : path.join(__dirname, 'captured-spans.jsonl');

// --- ANSI (disabled when piped) ----------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (text) => (useColor ? `[${code}m${text}[0m` : text);
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const cyan = c('36');

// --- load --------------------------------------------------------------------

if (!fs.existsSync(CAPTURE_FILE)) {
  console.error(
    `No capture file at ${CAPTURE_FILE}\n` +
      'Start the backend (node backend/server.js), then run the demo from the popup.',
  );
  process.exit(1);
}

const lines = fs
  .readFileSync(CAPTURE_FILE, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0);

if (lines.length === 0) {
  console.error(
    `${CAPTURE_FILE} is empty.\n` +
      'Nothing was captured yet. Run the demo from the popup. On main, wait until\n' +
      '~30s after the service worker booted: the pageload transaction is the root of\n' +
      'the whole tree and only flushes at its finalTimeout.',
  );
  process.exit(1);
}

/** @type {Map<string, object>} spanId -> node */
const nodes = new Map();

function addNode(node) {
  const existing = nodes.get(node.id);
  // A transaction record is richer than the same span seen embedded elsewhere.
  if (!existing || (node.isTransaction && !existing.isTransaction)) {
    nodes.set(node.id, { ...existing, ...node, children: existing?.children ?? [] });
  }
}

let skipped = 0;

for (const line of lines) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    skipped += 1;
    continue;
  }
  const event = record.event ?? {};
  const traceCtx = event.contexts?.trace;
  if (!traceCtx?.span_id) {
    skipped += 1;
    continue;
  }

  addNode({
    id: traceCtx.span_id,
    parentId: traceCtx.parent_span_id ?? null,
    traceId: traceCtx.trace_id,
    name: event.transaction ?? traceCtx.op ?? '(unnamed transaction)',
    op: traceCtx.op ?? null,
    isTransaction: true,
    start: event.start_timestamp ?? null,
    end: event.timestamp ?? null,
    finishReason:
      traceCtx.data?.['sentry.idle_span_finish_reason'] ??
      event.measurements?.['sentry.idle_span_finish_reason'] ??
      null,
  });

  for (const span of event.spans ?? []) {
    if (!span.span_id) continue;
    addNode({
      id: span.span_id,
      parentId: span.parent_span_id ?? null,
      traceId: span.trace_id ?? traceCtx.trace_id,
      name: span.description ?? span.op ?? '(unnamed span)',
      op: span.op ?? null,
      isTransaction: false,
      start: span.start_timestamp ?? null,
      end: span.timestamp ?? null,
    });
  }
}

// --- link --------------------------------------------------------------------

for (const node of nodes.values()) {
  node.children = [];
}
const roots = [];

for (const node of nodes.values()) {
  const parent = node.parentId ? nodes.get(node.parentId) : null;
  node.parentResolved = Boolean(parent);
  node.parentName = parent ? parent.name : null;
  if (parent) {
    parent.children.push(node);
  } else {
    roots.push(node);
  }
}

for (const node of nodes.values()) {
  node.children.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}
roots.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

// --- render ------------------------------------------------------------------

function duration(node) {
  if (node.start == null || node.end == null) return '   ?  ';
  const ms = (node.end - node.start) * 1000;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function parentLabel(node) {
  if (!node.parentId) return green('<root>');
  if (node.parentResolved) {
    return `parent=${node.parentId} ${green('✓')} ${dim(`(${node.parentName})`)}`;
  }
  return `parent=${node.parentId} ${red('✗ unresolved')}`;
}

function label(node) {
  const kind = node.isTransaction ? cyan('[txn]') : dim('[span]');
  const op = node.op ? dim(` op=${node.op}`) : '';
  const flag = isMisattached(node)
    ? ` ${red(bold('⚠ MISATTACHED'))}`
    : isSiblingAttached(node)
      ? ` ${red(bold('⚠ SIBLING-ATTACHED'))}`
      : '';
  const reason = node.finishReason ? dim(` finish=${node.finishReason}`) : '';
  return (
    `${bold(node.name)} ${kind}${op} ` +
    `${dim(`span=${node.id}`)} ${parentLabel(node)} ` +
    `${yellow(duration(node))}${reason}${flag}`
  );
}

/**
 * A poll-driven op is misattached when it is not a root: either it hangs off some
 * other operation's span (an unrelated root the wrapper guessed), or it names a
 * parent id that resolves to nothing at all (a root that was never captured).
 */
function isMisattached(node) {
  if (!POLL_DRIVEN.has(node.name)) return false;
  if (!node.parentId) return false;
  if (!node.parentResolved) return true;
  const parent = nodes.get(node.parentId);
  return parent.op === 'pageload' || DEMO_OPS.includes(parent.name);
}

/**
 * BUG A — sibling attachment.
 *
 * A server span's correct parent is the `http.client` span for the request that
 * triggered it. When the client advertises an ambient span instead (the hand-rolled
 * traceparent naming whatever `getActiveSpan()` returned), the server span parents to
 * that ambient root and lands *beside* the client span rather than beneath it.
 */
function isSiblingAttached(node) {
  if (node.op !== 'http.server') return false;
  if (!node.parentId || !node.parentResolved) return true;
  return nodes.get(node.parentId).op !== 'http.client';
}

function printTree(node, prefix, isLast) {
  const connector = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
  console.log(`${prefix}${connector}${label(node)}`);
  const childPrefix =
    prefix === '' ? '   ' : `${prefix}${isLast ? '   ' : '│  '}`;
  node.children.forEach((child, index) => {
    printTree(child, childPrefix, index === node.children.length - 1);
  });
}

function descendants(node, acc = []) {
  for (const child of node.children) {
    acc.push(child);
    descendants(child, acc);
  }
  return acc;
}

// Group roots by trace.
const traces = new Map();
for (const root of roots) {
  if (!traces.has(root.traceId)) traces.set(root.traceId, []);
  traces.get(root.traceId).push(root);
}

console.log('');
console.log(bold(`Captured trace tree  ${dim(`(${CAPTURE_FILE})`)}`));
console.log(
  dim(
    `${nodes.size} nodes, ${traces.size} trace(s), ${lines.length} envelope record(s)` +
      (skipped > 0 ? `, ${skipped} skipped` : ''),
  ),
);
console.log('');

const traceEntries = [...traces.entries()].sort(
  (a, b) => (a[1][0].start ?? 0) - (b[1][0].start ?? 0),
);

for (const [traceId, traceRoots] of traceEntries) {
  const all = traceRoots.flatMap((root) => [root, ...descendants(root)]);
  const txns = all.filter((node) => node.isTransaction).length;
  const startTimes = all.map((n) => n.start).filter((v) => v != null);
  const endTimes = all.map((n) => n.end).filter((v) => v != null);
  const wall =
    startTimes.length && endTimes.length
      ? `${(Math.max(...endTimes) - Math.min(...startTimes)).toFixed(2)}s wall`
      : 'unknown wall';

  console.log(
    `${bold('trace')} ${traceId}  ${dim(`${txns} transaction(s), ${all.length} node(s), ${wall}`)}`,
  );
  traceRoots.forEach((root) => printTree(root, '', true));
  console.log('');
}

// --- diagnostics -------------------------------------------------------------

console.log(bold('Diagnostics'));
console.log(dim('─'.repeat(72)));

for (const opName of DEMO_OPS) {
  const instances = [...nodes.values()].filter((node) => node.name === opName);
  if (instances.length === 0) {
    console.log(`  ${opName}: ${dim('not captured')}`);
    continue;
  }
  const byParent = new Map();
  for (const instance of instances) {
    const key = instance.parentId
      ? `${instance.parentName ?? '(unresolved)'} [${instance.parentId}]`
      : '<root>';
    const entry = byParent.get(key) ?? { count: 0, bad: isMisattached(instance) };
    entry.count += 1;
    byParent.set(key, entry);
  }
  console.log(`  ${bold(opName)} ×${instances.length} — parents:`);
  for (const [parent, { count, bad }] of byParent) {
    const marker = bad
      ? red('MISATTACHED')
      : parent === '<root>'
        ? green('OK — own root')
        : yellow('nested — not a root');
    console.log(`      ${String(count).padStart(2)}× ${parent}  ${marker}`);
  }
}

console.log('');

/**
 * Mega-trace: ONE long-lived span acting as the root of many unrelated transactions.
 *
 * Detected on that shape, not merely on "this trace has several transactions" —
 * several independent roots that happen to share a trace id are siblings, not a
 * mega-trace, and must not be flagged. Two forms are recognised:
 *
 *   A. a captured span with N+ transaction descendants (the pageload span, usually)
 *   B. N+ transactions naming the same parent id that resolves to nothing — what a
 *      long-lived root that was never captured looks like from the outside
 */
const MEGA_TRACE_CHILD_THRESHOLD = 3;
const findings = [];

for (const node of nodes.values()) {
  // Roots only. A misattached operation also accumulates descendants (its own
  // children, plus whatever the backend adds downstream), but that is the
  // misattachment bug — already flagged per span — not a mega-trace. A mega-trace is
  // one *root* swallowing unrelated work.
  if (node.parentId) continue;

  const txnDescendants = descendants(node).filter((d) => d.isTransaction);
  if (txnDescendants.length >= MEGA_TRACE_CHILD_THRESHOLD) {
    const all = [node, ...descendants(node)];
    const starts = all.map((n) => n.start).filter((v) => v != null);
    const ends = all.map((n) => n.end).filter((v) => v != null);
    findings.push({
      traceId: node.traceId,
      label: `${node.op === 'pageload' ? 'pageload root' : `root "${node.name}"`} ${dim(
        `(${node.id}${node.finishReason ? `, finish=${node.finishReason}` : ''})`,
      )}`,
      txns: txnDescendants.length,
      wall: Math.max(...ends) - Math.min(...starts),
    });
  }
}

// Form B: orphaned children of an uncaptured root.
const byUnresolvedParent = new Map();
for (const node of nodes.values()) {
  if (!node.isTransaction || !node.parentId || node.parentResolved) continue;
  if (!byUnresolvedParent.has(node.parentId)) {
    byUnresolvedParent.set(node.parentId, []);
  }
  byUnresolvedParent.get(node.parentId).push(node);
}
for (const [parentId, group] of byUnresolvedParent) {
  if (group.length < MEGA_TRACE_CHILD_THRESHOLD) continue;
  const all = group.flatMap((n) => [n, ...descendants(n)]);
  const starts = all.map((n) => n.start).filter((v) => v != null);
  const ends = all.map((n) => n.end).filter((v) => v != null);
  findings.push({
    traceId: group[0].traceId,
    label: `${yellow('an uncaptured long-lived root')} ${dim(`(${parentId})`)}`,
    txns: group.length,
    wall: Math.max(...ends) - Math.min(...starts),
  });
}

/**
 * Phantom parents: a span naming a parent id that is not in the captured set at all.
 *
 * This is what a downstream service inherits when the extension propagates a parent
 * that never gets sent — the backend span is created and accepted, but its ancestor
 * does not exist, so the trace can never be assembled. On main the pageload root is
 * the usual culprit: it is not flushed until finalTimeout, and is lost entirely if
 * the service worker is terminated first.
 */
/**
 * The `tracesByKey` collision on the manual start/end pattern.
 *
 * `Import Item` is started with no explicit `id`, so every invocation shares the key
 * `Import Item:default` in a plain module-level Map. Two overlapping clicks collide:
 * the second `startTrace` overwrites the first's entry, the first `endTrace` ends the
 * *second* span with the wrong timing, and the second `endTrace` finds an empty Map
 * and silently returns.
 *
 * Two detectable signatures:
 *
 *   1. a captured span whose duration is materially off the work it actually did
 *      (it was stamped with the other invocation's end time)
 *   2. fewer captured spans than invocations — the orphaned span is never ended, so
 *      it is never sent at all
 *
 * Signature 2 cannot be inferred from the captured JSON alone, precisely because the
 * lost span produces no record. The demo double-clicks, so the expectation is two.
 */
const IMPORT_OP_NAME = 'Import Item';
const IMPORT_EXPECTED_MS = 800;
const IMPORT_TOLERANCE = 0.25;
const IMPORT_EXPECTED_COUNT = 2;

const imports = [...nodes.values()].filter((n) => n.name === IMPORT_OP_NAME);

if (imports.length > 0) {
  const durations = imports.map((n) => ({
    node: n,
    ms: n.start != null && n.end != null ? (n.end - n.start) * 1000 : null,
  }));
  const skewed = durations.filter(
    (d) =>
      d.ms != null &&
      Math.abs(d.ms - IMPORT_EXPECTED_MS) / IMPORT_EXPECTED_MS > IMPORT_TOLERANCE,
  );
  const lost = IMPORT_EXPECTED_COUNT - imports.length;

  if (skewed.length > 0 || lost > 0) {
    console.log(`  ${red(bold('tracesByKey collision'))}:`);
    console.log(
      `      ${imports.length} "${IMPORT_OP_NAME}" span(s) captured, ` +
        `${IMPORT_EXPECTED_COUNT} invocation(s) expected` +
        (lost > 0
          ? ` ${red(`-> ${lost} endTrace() silently lost, span never ended, never sent`)}`
          : ''),
    );
    for (const d of durations) {
      const off =
        d.ms == null
          ? 'unknown duration'
          : `${Math.round(d.ms)}ms vs ~${IMPORT_EXPECTED_MS}ms expected` +
            (skewed.includes(d)
              ? ` ${red(`(off by ${Math.round(d.ms - IMPORT_EXPECTED_MS)}ms — wrong end time)`)}`
              : ' (plausible)');
      console.log(`      ${d.node.id}  ${off}`);
    }
  } else {
    console.log(
      `  ${green('tracesByKey collision clear')} — ${imports.length} "${IMPORT_OP_NAME}" span(s), ` +
        `durations consistent with the work done.`,
    );
  }
}

// --- Bug A summary -----------------------------------------------------------
const serverSpans = [...nodes.values()].filter((n) => n.op === 'http.server');
const siblings = serverSpans.filter(isSiblingAttached);

if (serverSpans.length === 0) {
  console.log(`  ${dim('No backend spans captured — is the backend running?')}`);
} else if (siblings.length > 0) {
  console.log(
    `  ${red(bold(`BUG A — ${siblings.length}/${serverSpans.length} backend span(s) sibling-attached`))}:`,
  );
  for (const node of siblings.slice(0, 6)) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    console.log(
      `      ${node.name} -> parent is ${
        parent ? `${parent.name} (op=${parent.op ?? 'n/a'})` : 'MISSING'
      }, expected the triggering http.client span`,
    );
  }
} else {
  console.log(
    `  ${green(`BUG A clear`)} — all ${serverSpans.length} backend span(s) nested under ` +
      `their triggering http.client span.`,
  );
}

const phantoms = [...nodes.values()].filter(
  (node) => node.parentId && !node.parentResolved,
);

if (phantoms.length > 0) {
  console.log(
    `  ${red(bold(`${phantoms.length} phantom parent(s)`))} — span(s) naming a parent ` +
      `that is not in the captured set:`,
  );
  for (const node of phantoms.slice(0, 8)) {
    console.log(`      ${node.name} ${dim(`(${node.id})`)} -> ${red(node.parentId)}`);
  }
  if (phantoms.length > 8) {
    console.log(`      … and ${phantoms.length - 8} more`);
  }
} else {
  console.log(
    `  ${green('No phantom parents')} — every named parent resolves to a captured span.`,
  );
}

if (findings.length > 0) {
  for (const f of findings) {
    console.log(
      `  ${red(bold('MEGA-TRACE'))} ${f.traceId.slice(0, 16)}… — ${f.label} ` +
        `holding ${f.txns} transactions over ${f.wall.toFixed(1)}s`,
    );
  }
} else {
  console.log(
    `  ${green('No mega-trace')} — no single root is holding ` +
      `${MEGA_TRACE_CHILD_THRESHOLD}+ transactions.`,
  );
}

const misattachedCount = [...nodes.values()].filter(isMisattached).length;
const rootCount = roots.filter((node) => DEMO_OPS.includes(node.name)).length;
console.log(
  `  ${misattachedCount > 0 ? red(bold(`${misattachedCount} misattached span(s)`)) : green('0 misattached spans')}` +
    `, ${rootCount} demo operation(s) correctly emitted as their own root, ` +
    `${traces.size} distinct trace(s).`,
);
console.log('');
