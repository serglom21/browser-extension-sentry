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

killButton.addEventListener('click', async () => {
  setStatus('killing worker — anything still batched is lost');
  try {
    await chrome.runtime.sendMessage({ type: 'TERMINATE_WORKER' });
  } catch {
    /* the worker dies mid-reply; that is the point */
  }
});
