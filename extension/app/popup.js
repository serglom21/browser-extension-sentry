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

killButton.addEventListener('click', async () => {
  setStatus('killing worker — anything still batched is lost');
  try {
    await chrome.runtime.sendMessage({ type: 'TERMINATE_WORKER' });
  } catch {
    /* the worker dies mid-reply; that is the point */
  }
});
