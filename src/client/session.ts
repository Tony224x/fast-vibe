import { terminals, noPilot, workerCount, engine, trustMode, previewUrl, launched, unreadTerminals, setState, sessionTimerInterval, launchTimestamp } from './state';
import { postJson, debounce } from './utils';
import { createTerminal, setFocused, scheduleFitAll, fitAll, termActivity, receivingTimers } from './terminal';
import { togglePreview, loadPreview, toggleZen } from './preview';
import { initSplitters } from './ui-helpers';
import { renderWelcomeProjects } from './bookmarks';
import { ICONS } from './icons';
import { buildDefaultLayout, renderLayout, setLayout, getLayout, initLayoutDnd, collectPanes, captureSizes, LayoutNode } from './layout';

function paneHeader(label: string, index: number, isPilot: boolean): string {
  const deleteBtn = isPilot ? '' : `<button class="btn-pane-action btn-ctx-danger" data-action="delete" data-index="${index}" data-tooltip="Delete worker" title="Delete">${ICONS.trash}</button>`;
  return `
    <div class="terminal-pane ${isPilot ? 'pilot' : 'worker'}" data-index="${index}"${isPilot ? '' : ' style="flex:1"'}>
      <div class="pane-header">
        <span class="pane-title">${label}<span class="unread-dot"></span></span>
        <span class="pane-status">
          <span class="status-dot"></span>
          <span class="status-text">--</span>
        </span>
        <span class="pane-actions">
          <span class="pane-actions-overflow">
            <button class="btn-pane-action btn-verify" data-action="verify" data-index="${index}" data-tooltip="Verify (code review)" title="Verify">${ICONS.check}<span>Verify</span></button>
            <button class="btn-pane-action" data-action="copy" data-index="${index}" data-tooltip="Copy output" title="Copy">${ICONS.copy}</button>
            <button class="btn-pane-action" data-action="compact" data-index="${index}" data-tooltip="Compact context" title="Compact">${ICONS.layers}</button>
            <button class="btn-pane-action" data-action="clear" data-index="${index}" data-tooltip="Clear context" title="Clear">${ICONS.eraser}</button>
            <button class="btn-pane-action" data-action="restart" data-index="${index}" data-tooltip="Restart" title="Restart">${ICONS.refresh}</button>
          </span>
          <button class="btn-pane-action btn-overflow-toggle" data-action="overflow-toggle" data-index="${index}" data-tooltip="More actions" title="More">${ICONS.moreHorizontal}</button>
          ${deleteBtn}
        </span>
        <button class="btn-expand" data-index="${index}" data-tooltip="Expand / Collapse" title="Expand">${ICONS.expand}</button>
      </div>
      <div class="pane-body" id="term-${index}"></div>
    </div>`;
}

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

  // Build worker panes dynamically (loads persisted layout if compatible)
  await buildWorkerPanes(workerCount);

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
      grid.insertAdjacentHTML('beforebegin', paneHeader('Pilot', 0, true));
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

  // Session timer
  const infoEl = document.getElementById('session-info')!;
  const infoBase = `${cwd} (${engine}${noPilot ? ', no pilot' : ''}${trustMode ? ', trust' : ', safe'})`;
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  setState('sessionTimerInterval', setInterval(() => {
    const sec = Math.floor((Date.now() - launchTimestamp) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    infoEl.textContent = `${infoBase} · ${m}m ${s}s`;
  }, 1000));

  const totalTerminals = noPilot ? workerCount : 1 + workerCount;

  for (let i = 0; i < totalTerminals; i++) {
    createTerminal(i);
  }

  setFocused(noPilot ? 0 : 0);
  scheduleFitAll(100);

  // Default to zen mode on launch (hide launchbar + sidebar) if not already in zen
  const appEl = document.getElementById('app')!;
  if (!appEl.classList.contains('launchbar-hidden')) toggleZen();

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
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); setState('sessionTimerInterval', null); }
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

export async function buildWorkerPanes(count: number): Promise<void> {
  const grid = document.getElementById('workers-grid') as HTMLElement;
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = '';
  grid.className = 'workers-flex';

  const startIdx = noPilot ? 0 : 1;
  const indices = Array.from({ length: count }, (_, i) => startIdx + i);
  const wantSet = new Set(indices);

  let tree: LayoutNode | null = null;
  try {
    const r = await fetch('/api/layout');
    const data = await r.json();
    if (data.layout) {
      const have = collectPanes(data.layout);
      if (have.size === wantSet.size && Array.from(wantSet).every(i => have.has(i))) {
        tree = data.layout;
      }
    }
  } catch {}
  if (!tree) tree = buildDefaultLayout(indices);
  if (!tree) return;

  setLayout(tree);
  renderLayout(grid, tree);
  initSplitters(grid);

  const saveLayout = debounce(() => {
    const t = getLayout();
    if (!t) return;
    const captured = captureSizes(grid, t);
    postJson('/api/layout', { layout: captured });
  }, 600);

  initLayoutDnd(grid, () => {
    initSplitters(grid);
    requestAnimationFrame(() => fitAll());
    saveLayout();
  });
  // Hook for the "+ Worker" button: backend spawns the PTY, layout grafts the
  // new pane, then we wire up xterm + WS so it becomes interactive.
  (grid as HTMLElement & { __onPaneSpawned?: (i: number) => void }).__onPaneSpawned = (newIdx: number) => {
    createTerminal(newIdx);
    requestAnimationFrame(() => fitAll());
    saveLayout();
  };
}
