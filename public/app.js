let workerCount = 4;
let previewUrl = '';
let engine = 'claude';
let noPilot = false;
let trustMode = false;
let useWSL = false;
let autoFocus = true;
let theme = 'dark';
let suggestMode = 'off';
const terminals = [];
const textDecoder = new TextDecoder();
let expandedIndex = -1;
let focusedIndex = 0;
let launched = false;
let launchTimestamp = 0;
let previewVisible = false;
const unreadTerminals = new Set();
let lastUserInputAt = 0;
let sidebarWidth = 240;

const THEME_DARK = {
  background: '#1E1A17', foreground: '#F5EFE8', cursor: '#E8601A', cursorAccent: '#1E1A17',
  selectionBackground: 'rgba(232, 96, 26, 0.25)',
  black: '#3D3530', red: '#ff7b72', green: '#3fb950', yellow: '#E8601A',
  blue: '#F0843F', magenta: '#bc8cff', cyan: '#D4C9BD', white: '#F5EFE8',
  brightBlack: '#8A7E74', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#F0843F',
  brightBlue: '#E8601A', brightMagenta: '#d2a8ff', brightCyan: '#D4C9BD', brightWhite: '#FFFFFF',
};

const THEME_LIGHT = {
  background: '#F5EFE8', foreground: '#2A2420', cursor: '#E8601A', cursorAccent: '#F5EFE8',
  selectionBackground: 'rgba(232, 96, 26, 0.2)',
  black: '#2A2420', red: '#d1242f', green: '#1a7f37', yellow: '#C44A0E',
  blue: '#C44A0E', magenta: '#8250df', cyan: '#8A7E74', white: '#F5EFE8',
  brightBlack: '#8A7E74', brightRed: '#ff8182', brightGreen: '#3fb950', brightYellow: '#E8601A',
  brightBlue: '#F0843F', brightMagenta: '#bc8cff', brightCyan: '#D4C9BD', brightWhite: '#FFFFFF',
};

function getXtermTheme() {
  const resolved = resolveTheme();
  return resolved === 'light' ? THEME_LIGHT : THEME_DARK;
}

function resolveTheme() {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function applyTheme() {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  const xtermTheme = resolved === 'light' ? THEME_LIGHT : THEME_DARK;
  terminals.forEach(t => { if (t) t.term.options.theme = xtermTheme; });
}

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    workerCount = s.workers || 4;
    previewUrl = s.previewUrl || '';
    engine = s.engine || 'claude';
    noPilot = !!s.noPilot;
    trustMode = !!s.trustMode;
    useWSL = !!s.useWSL;
    if (s.lastCwd) document.getElementById('cwd-input').value = s.lastCwd;
    autoFocus = s.autoFocus !== false;
    suggestMode = s.suggestMode || 'off';
    theme = s.theme || 'dark';
    applyTheme();
  } catch {}

  document.getElementById('btn-start').addEventListener('click', () => launchSession());
  document.getElementById('btn-stop').addEventListener('click', (e) => {
    inlineConfirm(e.currentTarget, () => stopSession());
  });
  document.getElementById('btn-settings').addEventListener('click', () => openSettings());
  document.getElementById('btn-settings-save').addEventListener('click', () => saveSettings());
  document.getElementById('btn-settings-cancel').addEventListener('click', () => closeSettings());
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Bookmarks & browse
  document.getElementById('btn-bookmark').addEventListener('click', addBookmark);
  document.getElementById('btn-bookmarks').addEventListener('click', toggleBookmarks);
  document.getElementById('btn-browse').addEventListener('click', pickFolder);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bookmark-wrapper')) {
      document.getElementById('bookmarks-dropdown').classList.add('hidden');
    }
  });
  loadBookmarksUI();

  // Preview controls
  document.getElementById('btn-preview-toggle').addEventListener('click', () => togglePreview());
  document.getElementById('btn-preview-go').addEventListener('click', () => loadPreview());
  document.getElementById('btn-preview-refresh').addEventListener('click', () => refreshPreview());
  document.getElementById('btn-preview-close').addEventListener('click', () => togglePreview(false));
  document.getElementById('preview-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPreview();
  });

  // Autocomplete
  initAutocomplete(document.getElementById('cwd-input'));

  // Expand on double-click (delegated)
  document.getElementById('terminals').addEventListener('dblclick', (e) => {
    const header = e.target.closest('.pane-header');
    if (header) {
      const index = parseInt(header.parentElement.dataset.index, 10);
      toggleExpand(index);
    }
  });

  // Expand on button click (delegated)
  document.getElementById('terminals').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-expand');
    if (btn) {
      toggleExpand(parseInt(btn.dataset.index, 10));
    }
  });

  // Pane header actions (delegated)
  document.getElementById('terminals').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-pane-action');
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = parseInt(btn.dataset.index, 10);
    if (action === 'compact') compactTerminal(idx);
    else if (action === 'clear') inlineConfirm(btn, () => clearTerminal(idx));
    else if (action === 'restart') restartTerminal(idx);
  });

  // Broadcast
  document.getElementById('btn-broadcast-send').addEventListener('click', sendBroadcast);
  document.getElementById('broadcast-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBroadcast();
  });

  // Zen mode
  document.getElementById('btn-zen').addEventListener('click', toggleZen);

  // Sidebar hide/show
  document.getElementById('btn-sidebar-hide').addEventListener('click', toggleSidebar);
  document.getElementById('btn-sidebar-show').addEventListener('click', toggleSidebar);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);

  // Sidebar resize
  initSidebarResize();

  // System theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'system') applyTheme();
  });

  setInterval(pollStatus, 2000);
  // Mini-map: poll output snippets every 5s
  setInterval(pollMiniMap, 5000);
  window.addEventListener('resize', debounce(fitAll, 100));

  // Render welcome projects
  renderWelcomeProjects();
});

// ── Keyboard Shortcuts ──

function handleGlobalKeydown(e) {
  // Ctrl+Shift+F → toggle search in focused terminal (or zen if no terminals)
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    if (launched) toggleTerminalSearch(focusedIndex);
    else toggleZen();
    return;
  }
  // Ctrl+Shift+B → focus broadcast input in sidebar
  if (e.ctrlKey && e.shiftKey && e.key === 'B') {
    e.preventDefault();
    if (launched) document.getElementById('broadcast-input').focus();
    return;
  }
  // Escape → close expanded / close search
  if (e.key === 'Escape') {
    if (searchVisible >= 0) { closeTerminalSearch(); return; }
    if (expandedIndex >= 0) { toggleExpand(expandedIndex); return; }
    return;
  }
  // Ctrl+1-8 → switch terminal
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
    e.preventDefault();
    const idx = parseInt(e.key, 10) - 1;
    const totalTerminals = noPilot ? workerCount : 1 + workerCount;
    if (idx < totalTerminals && launched) setFocused(idx);
    return;
  }
  // Ctrl+] → next terminal, Ctrl+[ → prev terminal
  if (e.ctrlKey && !e.shiftKey && (e.key === ']' || e.key === '[')) {
    e.preventDefault();
    if (!launched) return;
    const totalTerminals = noPilot ? workerCount : 1 + workerCount;
    if (e.key === ']') setFocused((focusedIndex + 1) % totalTerminals);
    else setFocused((focusedIndex - 1 + totalTerminals) % totalTerminals);
    return;
  }
}

// ── Session ──

async function launchSession() {
  const cwdInput = document.getElementById('cwd-input');
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
    const grid = document.getElementById('workers-grid');
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

  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('terminals').classList.remove('hidden');
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
  document.getElementById('session-info').textContent = `${cwd} (${engine}${noPilot ? ', no pilot' : ''}${trustMode ? ', trust' : ', safe'})`;

  // Show broadcast bar in sidebar
  document.getElementById('broadcast-bar').classList.remove('hidden');

  launched = true;
  launchTimestamp = Date.now();
  const totalTerminals = noPilot ? workerCount : 1 + workerCount;

  for (let i = 0; i < totalTerminals; i++) {
    createTerminal(i);
  }

  setFocused(noPilot ? 0 : 0);
  scheduleFitAll(100);

  // Auto-open preview if URL is set
  if (previewUrl) {
    document.getElementById('preview-url').value = previewUrl;
    togglePreview(true);
    loadPreview();
  }
}

async function stopSession() {
  await postJson('/api/stop');
  destroyTerminals();

  document.getElementById('terminals').classList.add('hidden');
  document.getElementById('welcome').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('session-info').textContent = '';
  document.getElementById('broadcast-bar').classList.add('hidden');

  launched = false;
  expandedIndex = -1;
  unreadTerminals.clear();
  renderWelcomeProjects();
}

function destroyTerminals() {
  terminals.forEach((t) => {
    if (t) {
      if (t.ws) t.ws.close();
      t.term.dispose();
    }
  });
  terminals.length = 0;
  // Clean up auto-focus timers
  for (const key of Object.keys(termActivity)) {
    clearTimeout(termActivity[key].timer);
    delete termActivity[key];
  }
  // Clean up receiving timers
  for (const key of Object.keys(receivingTimers)) {
    clearTimeout(receivingTimers[key]);
    delete receivingTimers[key];
  }
}

function buildWorkerPanes(count) {
  const grid = document.getElementById('workers-grid');
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

// ── Terminal ──

function createTerminal(index) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    theme: getXtermTheme(), allowProposedApi: true, scrollback: 5000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // Search addon
  let searchAddon = null;
  if (typeof SearchAddon !== 'undefined') {
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
  }

  const container = document.getElementById(`term-${index}`);
  term.open(container);
  requestAnimationFrame(() => fitAddon.fit());

  const ws = connectWebSocket(index, term);

  term.onData((data) => {
    const t = terminals[index];
    if (t && t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(data);
    lastUserInputAt = Date.now();
  });

  container.addEventListener('mousedown', () => setFocused(index));
  terminals[index] = { term, fitAddon, searchAddon, ws, index };
}

function connectWebSocket(index, term) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?terminal=${index}`);

  ws.onmessage = (e) => {
    const data = typeof e.data === 'string' ? e.data : textDecoder.decode(e.data);
    term.write(data);

    // Activity indicator
    markReceiving(index, true);

    // Unread tracking
    if (index !== focusedIndex) {
      unreadTerminals.add(index);
      updateUnreadUI(index, true);
    }

    if (autoFocus && index !== focusedIndex) detectTaskDone(index, data);
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    updatePaneDot(index, true);
  };
  ws.onclose = () => {
    updatePaneDot(index, false);
    if (!launched) return;
    term.write('\r\n\x1b[90m[Reconnecting...]\x1b[0m\r\n');
    setTimeout(() => {
      const t = terminals[index];
      if (t && launched) t.ws = connectWebSocket(index, term);
    }, 1500);
  };
  ws.onerror = () => {};
  return ws;
}

// ── Activity Indicator ──

const receivingTimers = {};

function markReceiving(index, active) {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;
  const dot = pane.querySelector('.status-dot');
  if (active) {
    dot.classList.add('receiving');
    clearTimeout(receivingTimers[index]);
    receivingTimers[index] = setTimeout(() => {
      dot.classList.remove('receiving');
    }, 800);
  } else {
    dot.classList.remove('receiving');
  }
}

// ── Unread Tracking ──

function updateUnreadUI(index, hasUnread) {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (pane) {
    pane.querySelector('.pane-header').classList.toggle('has-unread', hasUnread);
  }
  const card = document.querySelector(`.status-card[data-index="${index}"]`);
  if (card) {
    card.classList.toggle('has-unread', hasUnread);
  }
}

// ── Focus & Expand ──

function setFocused(index) {
  focusedIndex = index;
  // Clear unread for this terminal
  if (unreadTerminals.has(index)) {
    unreadTerminals.delete(index);
    updateUnreadUI(index, false);
  }
  document.querySelectorAll('.terminal-pane').forEach((p) => {
    p.classList.toggle('focused', parseInt(p.dataset.index, 10) === index);
  });
  document.querySelectorAll('.status-card').forEach((c) => {
    c.classList.toggle('active', parseInt(c.dataset.index, 10) === index);
  });
  terminals[index]?.term.focus();
}

function toggleExpand(index) {
  const el = document.getElementById('terminals');
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (expandedIndex === index) {
    pane.classList.remove('expanded');
    el.classList.remove('has-expanded');
    expandedIndex = -1;
  } else {
    if (expandedIndex >= 0) document.querySelector(`.terminal-pane[data-index="${expandedIndex}"]`)?.classList.remove('expanded');
    pane.classList.add('expanded');
    el.classList.add('has-expanded');
    expandedIndex = index;
  }
  setFocused(index);
  scheduleFitAll();
}

function fitAll() {
  terminals.forEach((t) => {
    if (!t) return;
    const el = t.term.element;
    if (!el || el.offsetHeight === 0) return;
    const body = el.parentElement;
    if (body) {
      const w = body.clientWidth, h = body.clientHeight;
      if (w === t.lastBodyW && h === t.lastBodyH) return;
      t.lastBodyW = w;
      t.lastBodyH = h;
    }
    t.fitAddon.fit();
    const cols = t.term.cols, rows = t.term.rows;
    if (cols !== t.lastCols || rows !== t.lastRows) {
      t.lastCols = cols;
      t.lastRows = rows;
      if (t.ws && t.ws.readyState === WebSocket.OPEN) {
        t.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
  });
}

let fitAllRafPending = false;
function fitAllRAF() {
  if (fitAllRafPending) return;
  fitAllRafPending = true;
  requestAnimationFrame(() => { fitAllRafPending = false; fitAll(); });
}

let fitAllTimer = null;
function scheduleFitAll(ms = 50) {
  if (fitAllTimer) return;
  fitAllTimer = setTimeout(() => { fitAllTimer = null; fitAll(); }, ms);
}

// ── Terminal Search ──

let searchVisible = -1;

function toggleTerminalSearch(index) {
  if (searchVisible === index) {
    closeTerminalSearch();
    return;
  }
  closeTerminalSearch();
  const t = terminals[index];
  if (!t || !t.searchAddon) return;

  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;

  const header = pane.querySelector('.pane-header');
  const bar = document.createElement('div');
  bar.className = 'search-bar';
  bar.id = 'search-bar-active';
  bar.innerHTML = `<input type="text" placeholder="Search..." spellcheck="false" autocomplete="off">
    <button data-action="prev" title="Previous">&#9650;</button>
    <button data-action="next" title="Next">&#9660;</button>
    <button data-action="close" title="Close">&#10005;</button>`;
  header.after(bar);

  const input = bar.querySelector('input');
  input.focus();
  input.addEventListener('input', () => { t.searchAddon.findNext(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.shiftKey ? t.searchAddon.findPrevious(input.value) : t.searchAddon.findNext(input.value); }
    if (e.key === 'Escape') closeTerminalSearch();
  });
  bar.addEventListener('click', (e) => {
    const action = e.target.dataset?.action;
    if (action === 'next') t.searchAddon.findNext(input.value);
    else if (action === 'prev') t.searchAddon.findPrevious(input.value);
    else if (action === 'close') closeTerminalSearch();
  });

  searchVisible = index;
  scheduleFitAll();
}

function closeTerminalSearch() {
  const bar = document.getElementById('search-bar-active');
  if (bar) {
    const idx = searchVisible;
    bar.remove();
    if (terminals[idx]?.searchAddon) terminals[idx].searchAddon.clearDecorations();
    scheduleFitAll();
  }
  searchVisible = -1;
}

// ── Preview ──

function togglePreview(show) {
  previewVisible = (show !== undefined) ? show : !previewVisible;
  document.getElementById('preview').classList.toggle('hidden', !previewVisible);
  document.getElementById('app').classList.toggle('has-preview', previewVisible);
  scheduleFitAll();
}

function toggleZen() {
  const app = document.getElementById('app');
  app.classList.toggle('sidebar-hidden');
  app.classList.toggle('launchbar-hidden');
  document.getElementById('btn-sidebar-show').classList.toggle('hidden', !app.classList.contains('sidebar-hidden'));
  scheduleFitAll();
}

function toggleSidebar() {
  const app = document.getElementById('app');
  app.classList.toggle('sidebar-hidden');
  document.getElementById('btn-sidebar-show').classList.toggle('hidden', !app.classList.contains('sidebar-hidden'));
  scheduleFitAll();
}

function loadPreview() {
  const url = document.getElementById('preview-url').value.trim();
  if (url) {
    document.getElementById('preview-frame').src = url.startsWith('http') ? url : 'http://' + url;
  }
}

function refreshPreview() {
  const frame = document.getElementById('preview-frame');
  frame.src = frame.src;
}

// ── Toast System ──

function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

let notificationPermissionAsked = false;

function notifyTaskDone(label) {
  // Toast always
  showToast(`${label} ready`);

  // Browser notification if tab hidden
  if (document.hidden && typeof Notification !== 'undefined') {
    if (!notificationPermissionAsked) {
      notificationPermissionAsked = true;
      Notification.requestPermission();
    }
    if (Notification.permission === 'granted') {
      new Notification('fast-vibe', { body: `${label} ready`, icon: '/favicon.ico' });
    }
  }
}

// ── Inline Confirm ──

function inlineConfirm(btn, action) {
  if (btn.dataset.confirming) {
    action();
    delete btn.dataset.confirming;
    btn.innerHTML = btn.dataset.originalHtml;
    btn.classList.remove('confirming');
    return;
  }
  btn.dataset.originalHtml = btn.innerHTML;
  btn.dataset.confirming = 'true';
  btn.innerHTML = 'Confirm?';
  btn.classList.add('confirming');
  setTimeout(() => {
    if (btn.dataset.confirming) {
      delete btn.dataset.confirming;
      btn.innerHTML = btn.dataset.originalHtml;
      btn.classList.remove('confirming');
    }
  }, 2000);
}

// ── Settings ──

function openSettings() {
  document.getElementById('setting-workers').value = workerCount;
  document.getElementById('setting-preview-url').value = previewUrl;
  document.getElementById('setting-engine').value = engine;
  document.getElementById('setting-no-pilot').checked = noPilot;
  document.getElementById('setting-trust-mode').checked = trustMode;
  document.getElementById('setting-use-wsl').checked = useWSL;
  document.getElementById('setting-auto-focus').checked = autoFocus;
  document.getElementById('setting-suggest-mode').value = suggestMode;
  document.getElementById('setting-theme').value = theme;
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

async function saveSettings() {
  workerCount = Math.max(1, Math.min(8, parseInt(document.getElementById('setting-workers').value, 10) || 4));
  previewUrl = document.getElementById('setting-preview-url').value.trim();
  engine = document.getElementById('setting-engine').value;
  noPilot = document.getElementById('setting-no-pilot').checked;
  trustMode = document.getElementById('setting-trust-mode').checked;
  useWSL = document.getElementById('setting-use-wsl').checked;
  autoFocus = document.getElementById('setting-auto-focus').checked;
  suggestMode = document.getElementById('setting-suggest-mode').value;
  theme = document.getElementById('setting-theme').value;

  applyTheme();
  await postJson('/api/settings', { workers: workerCount, previewUrl, engine, noPilot, trustMode, useWSL, autoFocus, suggestMode, theme });

  closeSettings();
}

// ── Status Polling ──

let tabHidden = false;
document.addEventListener('visibilitychange', () => { tabHidden = document.hidden; });

async function pollStatus() {
  if (!launched || tabHidden) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateSidebar(data.terminals);
    data.terminals.forEach((s) => updatePaneDot(s.id, s.alive));
  } catch {}
}

function updatePaneDot(index, alive) {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;
  const dot = pane.querySelector('.status-dot');
  // Don't override receiving animation
  if (!dot.classList.contains('receiving')) {
    dot.className = `status-dot ${alive ? 'alive' : 'dead'}`;
  }
  pane.querySelector('.status-text').textContent = alive ? 'running' : 'stopped';
}

let sidebarConfirming = false;

function updateSidebar(statuses) {
  // Don't rebuild if an inline confirm is pending — it would wipe the "Confirm?" state
  if (sidebarConfirming) return;

  const html = statuses.map((s, i) => {
    const label = s.role === 'pilot' ? 'Pilot' : (noPilot ? `Worker ${i + 1}` : `Worker ${i}`);
    const pid = Number.isFinite(s.pid) ? s.pid : '-';
    const elapsedStr = s.alive ? escapeHtml(elapsed(s.startedAt)) : 'stopped';
    const isUnread = unreadTerminals.has(i) ? ' has-unread' : '';
    const miniPreview = miniMapData[i] ? `<div class="status-card-preview">${escapeHtml(miniMapData[i])}</div>` : '';
    return `
    <div class="status-card ${i === focusedIndex ? 'active' : ''} ${s.role === 'pilot' ? 'pilot-card' : ''}${isUnread}"
         data-index="${i}" draggable="true">
      <div class="status-card-header">
        <span class="status-dot ${s.alive ? 'alive' : 'dead'}"></span>
        <strong>${escapeHtml(label)}</strong>
      </div>
      <div class="status-card-info">
        PID: ${pid} &middot; ${elapsedStr}
      </div>
      ${miniPreview}
      ${s.alive ? `<div class="status-card-actions">
        <button class="btn-ctx" data-ctx-action="compact" data-index="${i}" title="Compact context">&#8860; compact</button>
        <button class="btn-ctx btn-ctx-danger" data-ctx-action="clear" data-index="${i}" title="Clear context">&#8855; clear</button>
      </div>` : ''}
      ${s.suggestion ? `<div class="suggest-bar${s.suggestion.pending ? ' pending' : ''}" data-worker="${i}">
        <div class="suggest-text" title="${escapeHtml(s.suggestion.text)}">${escapeHtml(s.suggestion.text)}</div>
        <div class="suggest-actions">
          <button class="btn-suggest-send" data-suggest-action="send" data-index="${i}">Send</button>
          <button class="btn-suggest-edit" data-suggest-action="edit" data-index="${i}">Edit</button>
          <button class="btn-suggest-dismiss" data-suggest-action="dismiss" data-index="${i}">&times;</button>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  const list = document.getElementById('status-list');
  list.innerHTML = html;
  initSidebarDragDrop(list);
}

// Event delegation for sidebar actions (survives innerHTML rebuilds)
document.getElementById('status-list').addEventListener('click', (e) => {
  const card = e.target.closest('.status-card');
  const btn = e.target.closest('[data-ctx-action]');
  const suggestBtn = e.target.closest('[data-suggest-action]');
  if (suggestBtn) {
    e.stopPropagation();
    const idx = parseInt(suggestBtn.dataset.index, 10);
    const action = suggestBtn.dataset.suggestAction;
    if (action === 'send') {
      const bar = suggestBtn.closest('.suggest-bar');
      const input = bar.querySelector('.suggest-input');
      const text = input ? input.value : bar.querySelector('.suggest-text')?.textContent;
      if (text) postJson(`/api/suggest/${idx}/send`, { text });
    } else if (action === 'edit') {
      const bar = suggestBtn.closest('.suggest-bar');
      const textEl = bar.querySelector('.suggest-text');
      if (textEl && !bar.querySelector('.suggest-input')) {
        const val = textEl.textContent;
        textEl.innerHTML = `<input class="suggest-input" type="text" value="${escapeHtml(val)}" spellcheck="false">`;
        const input = textEl.querySelector('.suggest-input');
        input.focus();
        input.select();
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            postJson(`/api/suggest/${idx}/send`, { text: input.value });
          } else if (ev.key === 'Escape') {
            postJson(`/api/suggest/${idx}/dismiss`);
          }
        });
      }
    } else if (action === 'dismiss') {
      postJson(`/api/suggest/${idx}/dismiss`);
    }
  } else if (btn) {
    e.stopPropagation();
    const idx = parseInt(btn.dataset.index, 10);
    const action = btn.dataset.ctxAction;
    if (action === 'compact') compactTerminal(idx);
    else if (action === 'clear') {
      sidebarConfirming = true;
      inlineConfirm(btn, () => { clearTerminal(idx); sidebarConfirming = false; });
      // Auto-reset if user doesn't confirm within timeout
      setTimeout(() => { sidebarConfirming = false; }, 2200);
    }
  } else if (card) {
    setFocused(parseInt(card.dataset.index, 10));
  }
});

// ── Mini-map ──

const miniMapData = {};

async function pollMiniMap() {
  if (!launched || tabHidden) return;
  const total = noPilot ? workerCount : 1 + workerCount;
  await Promise.all(Array.from({ length: total }, (_, i) =>
    fetch(`/api/terminal/${i}/output?last=200`)
      .then(r => r.json())
      .then(data => {
        const lines = data.output.trim().split('\n');
        miniMapData[i] = lines.slice(-3).join('\n').slice(0, 120);
      })
      .catch(() => { miniMapData[i] = ''; })
  ));
}

// ── Terminal Actions ──

async function compactTerminal(id) {
  await postJson(`/api/terminal/${id}/compact`);
  showToast(`Terminal ${id} compacted`);
}

async function clearTerminal(id) {
  await postJson(`/api/terminal/${id}/clear`);
  showToast(`Terminal ${id} cleared`);
}

async function restartTerminal(id) {
  // Send restart command via WebSocket
  const t = terminals[id];
  if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
    t.ws.send(JSON.stringify({ type: 'restart' }));
    showToast(`Terminal ${id} restarted`);
  }
}

// ── Broadcast (sidebar) ──

async function sendBroadcast() {
  const input = document.getElementById('broadcast-input');
  const text = input.value.trim();
  if (!text) return;
  const startIdx = noPilot ? 0 : 1;
  const total = noPilot ? workerCount : 1 + workerCount;
  const promises = [];
  for (let i = startIdx; i < total; i++) {
    promises.push(postJson(`/api/terminal/${i}/send`, { text }));
  }
  await Promise.all(promises);
  showToast(`Broadcast sent to ${total - startIdx} workers`);
  input.value = '';
}

// ── Splitter drag logic ──

function initSplitters(container) {
  container.querySelectorAll('.split-v').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const prev = handle.previousElementSibling;
      const next = handle.nextElementSibling;
      if (!prev || !next) return;
      const startX = e.clientX;
      const prevW = prev.offsetWidth;
      const nextW = next.offsetWidth;
      document.body.classList.add('resizing', 'resizing-col');
      handle.classList.add('dragging');

      function onMove(e) {
        const dx = e.clientX - startX;
        const newPrev = Math.max(80, prevW + dx);
        const newNext = Math.max(80, nextW - dx);
        const total = newPrev + newNext;
        prev.style.flex = `0 0 ${(newPrev / total * 100).toFixed(1)}%`;
        next.style.flex = `0 0 ${(newNext / total * 100).toFixed(1)}%`;
        fitAllRAF();
      }
      function onUp() {
        document.body.classList.remove('resizing', 'resizing-col');
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        fitAll();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  container.querySelectorAll('.split-h').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const prevRow = handle.previousElementSibling;
      const nextRow = handle.nextElementSibling;
      if (!prevRow || !nextRow) return;
      const startY = e.clientY;
      const prevH = prevRow.offsetHeight;
      const nextH = nextRow.offsetHeight;
      document.body.classList.add('resizing', 'resizing-row');
      handle.classList.add('dragging');

      function onMove(e) {
        const dy = e.clientY - startY;
        const newPrev = Math.max(60, prevH + dy);
        const newNext = Math.max(60, nextH - dy);
        const total = newPrev + newNext;
        prevRow.style.flex = `0 0 ${(newPrev / total * 100).toFixed(1)}%`;
        nextRow.style.flex = `0 0 ${(newNext / total * 100).toFixed(1)}%`;
        fitAllRAF();
      }
      function onUp() {
        document.body.classList.remove('resizing', 'resizing-row');
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        fitAll();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── Auto-focus on task completion ──

const DONE_PATTERNS = [
  /\u276f\s*$/m,          // Claude prompt
  /kiro>\s*$/im,          // Kiro prompt
  /\$\s*$/m,              // bash prompt
];

const termActivity = {};

function detectTaskDone(index, data) {
  if (!termActivity[index]) termActivity[index] = { timer: null, chunks: 0, buffer: '' };
  const act = termActivity[index];
  act.chunks++;
  act.buffer += data;
  if (act.buffer.length > 2000) act.buffer = act.buffer.slice(-2000);
  clearTimeout(act.timer);

  act.timer = setTimeout(() => {
    if (act.chunks < 5) { act.chunks = 0; act.buffer = ''; return; }
    const clean = stripAnsi(act.buffer).trim();
    act.chunks = 0;
    act.buffer = '';
    for (const pat of DONE_PATTERNS) {
      if (pat.test(clean)) {
        const label = (index === 0 && !noPilot) ? 'Pilot' : (noPilot ? `Worker ${index + 1}` : `Worker ${index}`);
        notifyTaskDone(label);
        // Don't steal focus if user typed in the last 3s
        if (Date.now() - lastUserInputAt > 3000) {
          setFocused(index);
        }
        const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
        if (pane) {
          pane.style.borderColor = 'var(--green)';
          setTimeout(() => { pane.style.borderColor = ''; }, 1500);
        }
        // Trigger auto-suggest (skip first 30s after launch — startup noise)
        if (suggestMode !== 'off' && Date.now() - launchTimestamp > 30000) {
          postJson(`/api/suggest/${index}`);
        }
        return;
      }
    }
  }, 1500);
}

// ── Sidebar Resize ──

function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const app = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'resizing-col');

    function onMove(e) {
      const dx = startX - e.clientX;
      sidebarWidth = Math.max(60, Math.min(500, startW + dx));
      const cols = app.classList.contains('has-preview')
        ? `1fr 1fr 5px ${sidebarWidth}px`
        : `1fr 5px ${sidebarWidth}px`;
      app.style.gridTemplateColumns = cols;
      fitAllRAF();
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-col');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      fitAll();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Resize Handle (pilot/workers) ──

(function initResize() {
  const handle = document.getElementById('resize-handle');
  if (!handle) return;

  let startY, startPilotH, container;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pilot = document.querySelector('.terminal-pane.pilot');
    if (!pilot || pilot.classList.contains('hidden')) return;
    container = document.getElementById('terminals');
    startY = e.clientY;
    startPilotH = pilot.offsetHeight;
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'resizing-row');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const pilot = document.querySelector('.terminal-pane.pilot');
    if (!pilot) return;
    const totalH = container.offsetHeight;
    const newH = Math.max(60, Math.min(totalH - 60, startPilotH + (e.clientY - startY)));
    const pct = (newH / totalH * 100).toFixed(1);
    pilot.style.flex = `0 0 ${pct}%`;
    fitAllRAF();
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-row');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fitAll();
  }
})();

// ── Drag & Drop Sidebar Cards ──

function initSidebarDragDrop(container) {
  const cards = container.querySelectorAll('.status-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.index);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      container.querySelectorAll('.status-card').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromIdx = e.dataTransfer.getData('text/plain');
      const fromCard = container.querySelector(`.status-card[data-index="${fromIdx}"]`);
      if (fromCard && fromCard !== card) {
        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          container.insertBefore(fromCard, card);
        } else {
          container.insertBefore(fromCard, card.nextSibling);
        }
      }
    });
  });
}

// ── Bookmarks ──

let bookmarks = [];

async function loadBookmarksUI() {
  try {
    const res = await fetch('/api/bookmarks');
    bookmarks = await res.json();
  } catch { bookmarks = []; }
  updateBookmarkStar();
  renderWelcomeProjects();
}

function updateBookmarkStar() {
  const p = document.getElementById('cwd-input').value.trim();
  const btn = document.getElementById('btn-bookmark');
  const saved = bookmarks.some(b => b.path === p);
  btn.innerHTML = saved ? '&#9733;' : '&#9734;';
  btn.classList.toggle('saved', saved);
}

async function addBookmark() {
  const p = document.getElementById('cwd-input').value.trim();
  if (!p) return;
  const exists = bookmarks.some(b => b.path === p);
  if (exists) {
    await deleteJson('/api/bookmarks', { path: p });
  } else {
    await postJson('/api/bookmarks', { path: p });
  }
  await loadBookmarksUI();
}

function toggleBookmarks() {
  const dd = document.getElementById('bookmarks-dropdown');
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) renderBookmarks();
}

function renderBookmarks() {
  const dd = document.getElementById('bookmarks-dropdown');
  if (!bookmarks.length) {
    dd.innerHTML = '<div class="bm-empty">No bookmarks yet</div>';
    return;
  }
  dd.innerHTML = bookmarks.map(b => `
    <div class="bm-item" data-path="${escapeHtml(b.path)}">
      <span class="bm-name">${escapeHtml(b.name)}</span>
      <span class="bm-path">${escapeHtml(b.path)}</span>
      <button class="bm-del" data-del="${escapeHtml(b.path)}" title="Remove">&#10005;</button>
    </div>`).join('');

  dd.querySelectorAll('.bm-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.bm-del')) return;
      document.getElementById('cwd-input').value = el.dataset.path;
      dd.classList.add('hidden');
      updateBookmarkStar();
    });
  });
  dd.querySelectorAll('.bm-del').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteJson('/api/bookmarks', { path: el.dataset.del });
      await loadBookmarksUI();
      renderBookmarks();
    });
  });
}

// ── Welcome Screen with Recent Projects ──

function renderWelcomeProjects() {
  const container = document.getElementById('welcome-projects');
  if (!container) return;

  // Get lastCwd from the input
  const lastCwd = document.getElementById('cwd-input').value.trim();
  const items = [];

  // Add lastCwd as first card if it exists and is not already a bookmark
  if (lastCwd && !bookmarks.some(b => b.path === lastCwd)) {
    items.push({ name: lastCwd.split(/[/\\]/).pop() || lastCwd, path: lastCwd, isLast: true });
  }

  // Add bookmarks
  bookmarks.forEach(b => {
    items.push({ name: b.name, path: b.path, isLast: b.path === lastCwd });
  });

  if (!items.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="welcome-card ${item.isLast ? 'last-used' : ''}" data-path="${escapeHtml(item.path)}">
      <div class="welcome-card-name">${escapeHtml(item.name)}</div>
      <div class="welcome-card-path">${escapeHtml(item.path)}</div>
    </div>
  `).join('');

  container.querySelectorAll('.welcome-card').forEach(card => {
    card.addEventListener('click', () => {
      document.getElementById('cwd-input').value = card.dataset.path;
      updateBookmarkStar();
      launchSession();
    });
  });
}

async function pickFolder() {
  const btn = document.getElementById('btn-browse');
  btn.disabled = true;
  try {
    const res = await postJson('/api/pick-folder');
    const data = await res.json();
    if (data.folder) {
      document.getElementById('cwd-input').value = data.folder;
      updateBookmarkStar();
    }
  } catch {}
  btn.disabled = false;
}

// Utils (debounce, escapeHtml, postJson, deleteJson) are defined in utils.js

// ── Directory Browser ──

function initAutocomplete(input) {
  const dropdown = document.getElementById('autocomplete');
  let selectedIdx = -1, items = [], currentDir = '';

  async function browse(pathVal) {
    const query = pathVal || input.value.trim() || '';
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(query)}`);
      const data = await res.json();
      items = data.suggestions || [];
      currentDir = data.dir || '';
      selectedIdx = -1;
      render();
      dropdown.classList.remove('hidden');
    } catch { hide(); }
  }

  const browseLazy = debounce(() => browse(), 150);

  function render() {
    const parentPath = currentDir ? currentDir.replace(/[/\\][^/\\]*$/, '') : '';
    let html = '';

    if (currentDir && parentPath && parentPath !== currentDir) {
      html += `<div class="ac-item ac-parent" data-action="parent" data-path="${escapeHtml(parentPath)}">
        <span class="ac-icon">&#8617;</span>
        <span class="ac-name">..</span>
        <span class="ac-path">${escapeHtml(parentPath)}</span>
      </div>`;
    }

    if (currentDir) {
      html += `<div class="ac-item ac-current" data-action="select" data-path="${escapeHtml(currentDir)}">
        <span class="ac-icon">&#10003;</span>
        <span class="ac-name">Select this folder</span>
        <span class="ac-path">${escapeHtml(currentDir)}</span>
      </div>`;
    }

    html += items.map((item, i) => `
      <div class="ac-item ${i === selectedIdx ? 'selected' : ''}" data-action="enter" data-index="${i}">
        <span class="ac-icon">\u{1F4C1}</span>
        <span class="ac-name">${escapeHtml(item.name)}</span>
        <span class="ac-path">${escapeHtml(item.path)}</span>
      </div>
    `).join('');

    if (!items.length && currentDir) {
      html += `<div class="ac-item ac-empty"><span class="ac-icon">&#8709;</span><span class="ac-name">No subdirectories</span></div>`;
    }

    dropdown.innerHTML = html;
  }

  function hide() { dropdown.classList.add('hidden'); items = []; selectedIdx = -1; }

  function enterDir(idx) {
    if (idx >= 0 && idx < items.length) {
      const dir = items[idx].path;
      const sep = dir.includes('/') ? '/' : '\\';
      input.value = dir + sep;
      browse(dir);
    }
  }

  function selectDir(path) {
    input.value = path;
    hide();
    input.focus();
  }

  input.addEventListener('focus', () => { if (!launched) browse(); });
  input.addEventListener('click', () => { if (dropdown.classList.contains('hidden') && !launched) browse(); });
  input.addEventListener('input', () => { browseLazy(); updateBookmarkStar(); });

  input.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden')) {
      if (e.key === 'Enter') { launchSession(); return; }
      if (e.key === 'ArrowDown') { browse(); return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, -1); render(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (selectedIdx >= 0) enterDir(selectedIdx);
      else if (items.length > 0) enterDir(0);
    }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0) enterDir(selectedIdx);
      else { hide(); launchSession(); }
    }
    else if (e.key === 'Escape') { hide(); }
    else if (e.key === 'Backspace' && input.value.endsWith('\\')) {
      e.preventDefault();
      const parent = input.value.replace(/[/\\]$/, '').replace(/[/\\][^/\\]*$/, '');
      if (parent) { input.value = parent; browse(parent); }
    }
  });

  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const el = e.target.closest('.ac-item');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'parent') browse(el.dataset.path);
    else if (action === 'select') selectDir(el.dataset.path);
    else if (action === 'enter') enterDir(parseInt(el.dataset.index, 10));
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('.launch-center')) hide(); });
}
