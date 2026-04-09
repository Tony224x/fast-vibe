import { terminals, noPilot, workerCount, engine, trustMode, previewUrl, launched, unreadTerminals, setState } from './state';
import { postJson } from './utils';
import { createTerminal, setFocused, scheduleFitAll, termActivity, receivingTimers } from './terminal';
import { togglePreview, loadPreview } from './preview';
import { initSplitters } from './ui-helpers';
import { renderWelcomeProjects } from './bookmarks';

export async function launchSession(): Promise<void> {
  const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
  const cwd = cwdInput.value.trim();
  if (!cwd) {
    cwdInput.focus();
    cwdInput.style.borderColor = '#f85149';
    setTimeout(() => { cwdInput.style.borderColor = ''; }, 1500);
    return;
  }

  if (launched) {
    destroyTerminals();
    await postJson('/api/stop');
  }

  await postJson('/api/launch', { cwd, workers: workerCount });

  // Build worker panes dynamically
  buildWorkerPanes(workerCount);

  // Hide/show pilot pane based on noPilot mode
  const pilotPane = document.querySelector('.terminal-pane.pilot');
  const resizeHandle = document.getElementById('resize-handle');
  if (noPilot) {
    if (pilotPane) pilotPane.remove();
    if (resizeHandle) resizeHandle.classList.add('hidden');
  } else {
    if (resizeHandle) resizeHandle.classList.remove('hidden');
    // Re-add pilot pane if it was removed in a previous noPilot session
    const grid = document.getElementById('workers-grid')!;
    if (!document.querySelector('.terminal-pane.pilot')) {
      grid.insertAdjacentHTML('beforebegin', `
        <div class="terminal-pane pilot" data-index="0">
          <div class="pane-header">
            <span class="pane-title">Pilot<span class="unread-dot"></span></span>
            <span class="pane-status">
              <span class="status-dot"></span>
              <span class="status-text">--</span>
            </span>
            <span class="pane-actions">
              <button class="btn-pane-action" data-action="compact" data-index="0" title="Compact">&#8860;</button>
              <button class="btn-pane-action" data-action="clear" data-index="0" title="Clear">&#8855;</button>
              <button class="btn-pane-action" data-action="restart" data-index="0" title="Restart">&#8635;</button>
            </span>
            <button class="btn-expand" data-index="0" title="Expand / Collapse">&#9974;</button>
          </div>
          <div class="pane-body" id="term-0"></div>
        </div>`);
    }
  }

  document.getElementById('welcome')!.classList.add('hidden');
  document.getElementById('terminals')!.classList.remove('hidden');
  document.getElementById('btn-start')!.classList.add('hidden');
  document.getElementById('btn-stop')!.classList.remove('hidden');
  document.getElementById('session-info')!.textContent = `${cwd} (${engine}${noPilot ? ', no pilot' : ''}${trustMode ? ', trust' : ', safe'})`;

  // Show broadcast bar in sidebar
  document.getElementById('broadcast-bar')!.classList.remove('hidden');

  setState('launched', true);
  setState('launchTimestamp', Date.now());
  const totalTerminals = noPilot ? workerCount : 1 + workerCount;

  for (let i = 0; i < totalTerminals; i++) {
    createTerminal(i);
  }

  setFocused(noPilot ? 0 : 0);
  scheduleFitAll(100);

  // Auto-open preview if URL is set
  if (previewUrl) {
    (document.getElementById('preview-url') as HTMLInputElement).value = previewUrl;
    togglePreview(true);
    loadPreview();
  }
}

export async function stopSession(): Promise<void> {
  await postJson('/api/stop');
  destroyTerminals();

  document.getElementById('terminals')!.classList.add('hidden');
  document.getElementById('welcome')!.classList.remove('hidden');
  document.getElementById('btn-stop')!.classList.add('hidden');
  document.getElementById('btn-start')!.classList.remove('hidden');
  document.getElementById('session-info')!.textContent = '';
  document.getElementById('broadcast-bar')!.classList.add('hidden');

  setState('launched', false);
  setState('expandedIndex', -1);
  unreadTerminals.clear();
  renderWelcomeProjects();
}

export function destroyTerminals(): void {
  terminals.forEach((t) => {
    if (t) {
      if (t.ws) t.ws.close();
      t.term.dispose();
    }
  });
  terminals.length = 0;
  // Clean up auto-focus timers
  for (const key of Object.keys(termActivity)) {
    clearTimeout(termActivity[Number(key)].timer!);
    delete termActivity[Number(key)];
  }
  // Clean up receiving timers
  for (const key of Object.keys(receivingTimers)) {
    clearTimeout(receivingTimers[Number(key)]);
    delete receivingTimers[Number(key)];
  }
}

export function buildWorkerPanes(count: number): void {
  const grid = document.getElementById('workers-grid') as HTMLElement;
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = '';
  grid.className = 'workers-flex';

  const startIdx = noPilot ? 0 : 1;
  const cols = count <= 2 ? count : 2;
  const rows = Math.ceil(count / cols);

  for (let c = 0; c < cols; c++) {
    if (c > 0) grid.insertAdjacentHTML('beforeend', '<div class="split-v"></div>');
    const col = document.createElement('div');
    col.className = 'worker-col';
    for (let r = 0; r < rows; r++) {
      const idx = r * cols + c;
      if (idx >= count) break;
      if (r > 0) col.insertAdjacentHTML('beforeend', '<div class="split-h"></div>');
      const i = startIdx + idx;
      const label = noPilot ? `Worker ${i + 1}` : `Worker ${i}`;
      col.insertAdjacentHTML('beforeend', `
        <div class="terminal-pane worker" data-index="${i}" style="flex:1">
          <div class="pane-header">
            <span class="pane-title">${label}<span class="unread-dot"></span></span>
            <span class="pane-status">
              <span class="status-dot"></span>
              <span class="status-text">--</span>
            </span>
            <span class="pane-actions">
              <button class="btn-pane-action" data-action="compact" data-index="${i}" title="Compact">&#8860;</button>
              <button class="btn-pane-action" data-action="clear" data-index="${i}" title="Clear">&#8855;</button>
              <button class="btn-pane-action" data-action="restart" data-index="${i}" title="Restart">&#8635;</button>
            </span>
            <button class="btn-expand" data-index="${i}" title="Expand / Collapse">&#9974;</button>
          </div>
          <div class="pane-body" id="term-${i}"></div>
        </div>
      `);
    }
    grid.appendChild(col);
  }

  initSplitters(grid);
}
