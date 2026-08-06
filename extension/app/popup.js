const runButton = document.getElementById('run');
const killButton = document.getElementById('kill');
const status = document.getElementById('status');

function setStatus(text) {
  status.textContent = text;
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  setStatus('starting…');
  const result = await chrome.runtime.sendMessage({ type: 'RUN_DEMO' });
  if (result?.started) {
    setStatus(
      'running 15s of operations.\n' +
        'then either wait ~30s for the pageload\n' +
        'transaction to flush, or click\n' +
        '"Kill service worker" to show span loss.',
    );
    setTimeout(() => {
      runButton.disabled = false;
      setStatus('done — node demo/print-trace-tree.js');
    }, 15000);
  } else {
    setStatus(`not started: ${result?.reason ?? 'unknown'}`);
    runButton.disabled = false;
  }
});

/**
 * One click = one import, exactly like the real modal handler. Double-clicking
 * therefore fires two overlapping invocations, which is the scenario that collides
 * on the shared `Import Item:default` key.
 */
const importButton = document.getElementById('import');
let importClicks = 0;

importButton.addEventListener('click', async () => {
  importClicks += 1;
  setStatus(
    `Import Item click ${importClicks} sent.\n` +
      'double-click for the collision, then:\n' +
      'node demo/print-trace-tree.js',
  );
  await chrome.runtime.sendMessage({ type: 'IMPORT_ITEM' });
});

/**
 * Temporary diagnostic: runs the three concurrency tests inside the real service
 * worker, so the result cannot be an artefact of bare Node's scheduling.
 */
document.getElementById('conc').addEventListener('click', async () => {
  setStatus('running concurrency diagnostic in the service worker…');
  const res = await chrome.runtime.sendMessage({ type: 'CONCURRENCY_TEST' });
  const t = res?.report?.tests ?? {};
  const lines = Object.entries(t).map(([k, v]) => {
    const s = v.summary;
    return `${k}\n  parent points at sibling: ${s.parent_span_id_points_at_sibling}\n  distinct trace ids: ${s.distinct_trace_ids}`;
  });
  setStatus(lines.join('\n') || 'no result');
});

/**
 * Temporary diagnostic: fires 4 traced operations and arms the 2000ms debounced
 * flush. Kill the worker within the window for the short-gap case, or wait it out
 * for the long-gap case, then reopen the popup to read the persisted counters.
 */
document.getElementById('flush').addEventListener('click', async () => {
  const prior = await chrome.runtime.sendMessage({ type: 'READ_FLUSH_DIAG' });
  if (prior) {
    setStatus(
      `previous run (${prior.pass}):\n` +
        `  ops completed:     ${prior.opsCompleted}\n` +
        `  envelopes sent:    ${prior.envelopesConfirmedSent}/${prior.envelopesAttempted}\n` +
        `  debounce fired:    ${prior.debounceFired}\n` +
        'starting a new run…',
    );
  }
  const res = await chrome.runtime.sendMessage({ type: 'FLUSH_RESCUE', pass: 'short' });
  setStatus(
    `flush-rescue armed (${res.debounceMs}ms).\n` +
      `${res.opsCompleted} ops completed.\n` +
      'kill the worker now, or wait it out.',
  );
});

killButton.addEventListener('click', async () => {
  setStatus('killing worker — anything still batched is lost');
  try {
    await chrome.runtime.sendMessage({ type: 'TERMINATE_WORKER' });
  } catch {
    /* the worker dies mid-reply; that is the point */
  }
});
