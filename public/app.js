let workerCount = 4;
let previewUrl = '';
let engine = 'claude';
let noPilot = false;
const terminals = [];
let expandedIndex = -1;
let focusedIndex = 0;
let launched = false;
let previewVisible = false;

const THEME = {
  background: '#1E1A17', foreground: '#F5EFE8', cursor: '#E8601A', cursorAccent: '#1E1A17',
  selectionBackground: 'rgba(232, 96, 26, 0.25)',
  black: '#3D3530', red: '#ff7b72', green: '#3fb950', yellow: '#E8601A',
  blue: '#F0843F', magenta: '#bc8cff', cyan: '#D4C9BD', white: '#F5EFE8',
  brightBlack: '#8A7E74', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#F0843F',
  brightBlue: '#E8601A', brightMagenta: '#d2a8ff', brightCyan: '#D4C9BD', brightWhite: '#FFFFFF',
};

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
  } catch {}

  document.getElementById('btn-start').addEventListener('click', () => launchSession());
  document.getElementById('btn-stop').addEventListener('click', () => stopSession());
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

  // Zen mode
  document.getElementById('btn-zen').addEventListener('click', toggleZen);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); toggleZen(); }
  });

  setInterval(pollStatus, 2000);
  window.addEventListener('resize', debounce(fitAll, 100));
});

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
    await fetch('/api/stop', { method: 'POST' });
  }

  await fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, workers: workerCount }),
  });

  // Build worker panes dynamically
  buildWorkerPanes(workerCount);

  // Hide/show pilot pane based on noPilot mode
  const pilotPane = document.querySelector('.terminal-pane.pilot');
  if (noPilot) {
    if (pilotPane) pilotPane.remove();
  } else {
    // Re-add pilot pane if it was removed in a previous noPilot session
    const terminalsEl = document.getElementById('terminals');
    const grid = document.getElementById('workers-grid');
    if (!document.querySelector('.terminal-pane.pilot')) {
      grid.insertAdjacentHTML('beforebegin', `
        <div class="terminal-pane pilot" data-index="0">
          <div class="pane-header">
            <span class="pane-title">Pilot</span>
            <span class="pane-status">
              <span class="status-dot"></span>
              <span class="status-text">--</span>
            </span>
          </div>
          <div class="pane-body" id="term-0"></div>
        </div>`);
    }
  }

  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('terminals').classList.remove('hidden');
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
  document.getElementById('session-info').textContent = `${cwd} (${engine}${noPilot ? ', no pilot' : ''})`;

  launched = true;
  const totalTerminals = noPilot ? workerCount : 1 + workerCount;

  for (let i = 0; i < totalTerminals; i++) {
    createTerminal(i);
  }

  setFocused(noPilot ? 0 : 0);
  setTimeout(fitAll, 100);

  // Auto-open preview if URL is set
  if (previewUrl) {
    document.getElementById('preview-url').value = previewUrl;
    togglePreview(true);
    loadPreview();
  }
}

async function stopSession() {
  await fetch('/api/stop', { method: 'POST' });
  destroyTerminals();

  document.getElementById('terminals').classList.add('hidden');
  document.getElementById('welcome').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('session-info').textContent = '';

  launched = false;
  expandedIndex = -1;
}

function destroyTerminals() {
  terminals.forEach((t) => {
    if (t) {
      if (t.ws) t.ws.close();
      t.term.dispose();
    }
  });
  terminals.length = 0;
}

function buildWorkerPanes(count) {
  const grid = document.getElementById('workers-grid');
  grid.innerHTML = '';
  // Adjust grid columns based on worker count
  if (count <= 2) {
    grid.style.gridTemplateColumns = '1fr '.repeat(count).trim();
  } else {
    grid.style.gridTemplateColumns = '1fr 1fr';
  }
  const startIdx = noPilot ? 0 : 1;
  for (let i = startIdx; i < startIdx + count; i++) {
    const label = noPilot ? `Worker ${i + 1}` : `Worker ${i}`;
    grid.insertAdjacentHTML('beforeend', `
      <div class="terminal-pane worker" data-index="${i}">
        <div class="pane-header">
          <span class="pane-title">${label}</span>
          <span class="pane-status">
            <span class="status-dot"></span>
            <span class="status-text">--</span>
          </span>
        </div>
        <div class="pane-body" id="term-${i}"></div>
      </div>
    `);
  }
}

// ── Terminal ──

function createTerminal(index) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    theme: THEME, allowProposedApi: true, scrollback: 5000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById(`term-${index}`);
  term.open(container);
  requestAnimationFrame(() => fitAddon.fit());

  const ws = connectWebSocket(index, term);

  term.onData((data) => {
    const t = terminals[index];
    if (t && t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(data);
  });

  container.addEventListener('mousedown', () => setFocused(index));
  terminals[index] = { term, fitAddon, ws, index };
}

function connectWebSocket(index, term) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?terminal=${index}`);

  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
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

// ── Focus & Expand ──

function setFocused(index) {
  focusedIndex = index;
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
  setTimeout(fitAll, 50);
}

function fitAll() {
  terminals.forEach((t) => {
    if (!t) return;
    t.fitAddon.fit();
    if (t.ws && t.ws.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
    }
  });
}

// ── Preview ──

function togglePreview(show) {
  previewVisible = (show !== undefined) ? show : !previewVisible;
  document.getElementById('preview').classList.toggle('hidden', !previewVisible);
  document.getElementById('app').classList.toggle('has-preview', previewVisible);
  setTimeout(fitAll, 50);
}

function toggleZen() {
  const app = document.getElementById('app');
  app.classList.toggle('sidebar-hidden');
  app.classList.toggle('launchbar-hidden');
  setTimeout(fitAll, 50);
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

// ── Settings ──

function openSettings() {
  document.getElementById('setting-workers').value = workerCount;
  document.getElementById('setting-preview-url').value = previewUrl;
  document.getElementById('setting-engine').value = engine;
  document.getElementById('setting-no-pilot').checked = noPilot;
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

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workers: workerCount, previewUrl, engine, noPilot }),
  });

  closeSettings();
}

// ── Status ──

async function pollStatus() {
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
  pane.querySelector('.status-dot').className = `status-dot ${alive ? 'alive' : 'dead'}`;
  pane.querySelector('.status-text').textContent = alive ? 'running' : 'stopped';
}

function updateSidebar(statuses) {
  document.getElementById('status-list').innerHTML = statuses.map((s, i) => {
    const label = s.role === 'pilot' ? 'Pilot' : (noPilot ? `Worker ${i + 1}` : `Worker ${i}`);
    return `
    <div class="status-card ${i === focusedIndex ? 'active' : ''} ${s.role === 'pilot' ? 'pilot-card' : ''}"
         data-index="${i}" onclick="setFocused(${i})">
      <div class="status-card-header">
        <span class="status-dot ${s.alive ? 'alive' : 'dead'}"></span>
        <strong>${label}</strong>
      </div>
      <div class="status-card-info">
        PID: ${s.pid || '-'} &middot; ${s.alive ? elapsed(s.startedAt) : 'stopped'}
      </div>
      ${s.alive ? `<div class="status-card-actions">
        <button class="btn-ctx" onclick="event.stopPropagation();compactTerminal(${i})" title="Compact context">&#8860; compact</button>
        <button class="btn-ctx btn-ctx-danger" onclick="event.stopPropagation();clearTerminal(${i})" title="Clear context">&#8855; clear</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

async function compactTerminal(id) {
  await fetch(`/api/terminal/${id}/compact`, { method: 'POST' });
}

async function clearTerminal(id) {
  await fetch(`/api/terminal/${id}/clear`, { method: 'POST' });
}

function elapsed(iso) {
  if (!iso) return '-';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Bookmarks ──

let bookmarks = [];

async function loadBookmarksUI() {
  try {
    const res = await fetch('/api/bookmarks');
    bookmarks = await res.json();
  } catch { bookmarks = []; }
  updateBookmarkStar();
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
    await fetch('/api/bookmarks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  } else {
    await fetch('/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
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
    <div class="bm-item" data-path="${b.path}">
      <span class="bm-name">${b.name}</span>
      <span class="bm-path">${b.path}</span>
      <button class="bm-del" data-del="${b.path}" title="Remove">&#10005;</button>
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
      await fetch('/api/bookmarks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: el.dataset.del }) });
      await loadBookmarksUI();
      renderBookmarks();
    });
  });
}

async function pickFolder() {
  const btn = document.getElementById('btn-browse');
  btn.disabled = true;
  try {
    const res = await fetch('/api/pick-folder', { method: 'POST' });
    const data = await res.json();
    if (data.folder) {
      document.getElementById('cwd-input').value = data.folder;
      updateBookmarkStar();
    }
  } catch {}
  btn.disabled = false;
}

// ── Utils ──

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

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

    // Parent directory link
    if (currentDir && parentPath && parentPath !== currentDir) {
      html += `<div class="ac-item ac-parent" data-action="parent" data-path="${parentPath}">
        <span class="ac-icon">&#8617;</span>
        <span class="ac-name">..</span>
        <span class="ac-path">${parentPath}</span>
      </div>`;
    }

    // Current directory — select this one
    if (currentDir) {
      html += `<div class="ac-item ac-current" data-action="select" data-path="${currentDir}">
        <span class="ac-icon">&#10003;</span>
        <span class="ac-name">Select this folder</span>
        <span class="ac-path">${currentDir}</span>
      </div>`;
    }

    // Subdirectories
    html += items.map((item, i) => `
      <div class="ac-item ${i === selectedIdx ? 'selected' : ''}" data-action="enter" data-index="${i}">
        <span class="ac-icon">\u{1F4C1}</span>
        <span class="ac-name">${item.name}</span>
        <span class="ac-path">${item.path}</span>
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

  // Open on focus/click
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
      // Navigate up when deleting trailing backslash
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
