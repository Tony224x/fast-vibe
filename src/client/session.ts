import { terminals, workerCount, engine, trustMode, previewUrl, launched, unreadTerminals, setState, sessionTimerInterval, launchTimestamp } from './state';
import { postJson, debounce } from './utils';
import { createTerminal, setFocused, scheduleFitAll, fitAll, termActivity, receivingTimers, resetWsReconnectAttempts } from './terminal';
import { togglePreview, loadPreview, toggleZen } from './preview';
import { initSplitters } from './ui-helpers';
import { renderWelcomeProjects } from './bookmarks';
import { buildDefaultLayout, renderLayout, setLayout, getLayout, initLayoutDnd, collectPanes, captureSizes, LayoutNode } from './layout';

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

  document.getElementById('welcome')!.classList.add('hidden');
  document.getElementById('terminals')!.classList.remove('hidden');
  document.getElementById('btn-start')!.classList.add('hidden');
  document.getElementById('btn-stop')!.classList.remove('hidden');
  document.getElementById('session-info')!.textContent = `${cwd} (${engine}${trustMode ? ', trust' : ', safe'})`;

  // Show broadcast bar in sidebar
  document.getElementById('broadcast-bar')!.classList.remove('hidden');

  setState('launched', true);
  setState('launchTimestamp', Date.now());

  // Session timer
  const infoEl = document.getElementById('session-info')!;
  const infoBase = `${cwd} (${engine}${trustMode ? ', trust' : ', safe'})`;
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  setState('sessionTimerInterval', setInterval(() => {
    const sec = Math.floor((Date.now() - launchTimestamp) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    infoEl.textContent = `${infoBase} · ${m}m ${s}s`;
  }, 1000));

  for (let i = 0; i < workerCount; i++) {
    createTerminal(i);
  }

  setFocused(0);
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

// Auto-reconnect : si /api/status retourne une session active (browser fermé/
// rouvert, ou serveur redémarré avec restoreAll), on rebuild le grid sans
// repasser par /api/launch — les PTYs sont déjà spawnés côté serveur, on
// branche juste les xterm + WebSocket dessus.
export async function restoreSession(
  session: { cwd: string; engine: string; trustMode: boolean },
  indices: number[],
): Promise<void> {
  const { cwd, engine: e, trustMode: tm } = session;
  setState('engine', e);
  setState('trustMode', tm);

  const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
  if (cwdInput) cwdInput.value = cwd;

  const wc = indices.length;
  setState('workerCount', wc);

  await buildWorkerPanes(wc);

  document.getElementById('welcome')!.classList.add('hidden');
  document.getElementById('terminals')!.classList.remove('hidden');
  document.getElementById('btn-start')!.classList.add('hidden');
  document.getElementById('btn-stop')!.classList.remove('hidden');
  const infoBase = `${cwd} (${e}${tm ? ', trust' : ', safe'})`;
  document.getElementById('session-info')!.textContent = infoBase + ' · resumed';
  document.getElementById('broadcast-bar')!.classList.remove('hidden');

  setState('launched', true);
  setState('launchTimestamp', Date.now());

  const infoEl = document.getElementById('session-info')!;
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  setState('sessionTimerInterval', setInterval(() => {
    const sec = Math.floor((Date.now() - launchTimestamp) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    infoEl.textContent = `${infoBase} · ${m}m ${s}s`;
  }, 1000));

  for (const i of indices) {
    createTerminal(i);
  }

  setFocused(indices[0] ?? 0);
  scheduleFitAll(100);

  // Auto-zen comme launchSession (cohérence UX) — sauf si déjà appliqué
  const appEl = document.getElementById('app')!;
  if (!appEl.classList.contains('launchbar-hidden')) toggleZen();

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
      // Abort = ferme la WS courante + annule le reconnect en attente +
      // détache tous les addEventListener attachés via signal (mousedown
      // sur container, click sur scrollBtn). Pas de leak DOM.
      t.abortController.abort();
      if (t.ws) t.ws.close();
      t.term.dispose();
    }
  });
  terminals.length = 0;
  // Reset le backoff WS pour que le prochain launch démarre à 0 retry.
  resetWsReconnectAttempts();
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

  const indices = Array.from({ length: count }, (_, i) => i);
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
