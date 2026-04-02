let workerCount = 4;
let previewUrl = '';
const terminals = [];
let expandedIndex = -1;
let focusedIndex = 0;
let launched = false;
let previewVisible = false;

const THEME = {
  background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88, 166, 255, 0.3)',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d364', brightWhite: '#f0f6fc',
};

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    workerCount = s.workers || 4;
    previewUrl = s.previewUrl || '';
  } catch {}

  document.getElementById('btn-start').addEventListener('click', () => launchSession());
  document.getElementById('btn-stop').addEventListener('click', () => stopSession());
  document.getElementById('btn-settings').addEventListener('click', () => openSettings());
  document.getElementById('btn-settings-save').addEventListener('click', () => saveSettings());
  document.getElementById('btn-settings-cancel').addEventListener('click', () => closeSettings());
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

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

  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('terminals').classList.remove('hidden');
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
  document.getElementById('session-info').textContent = cwd;

  launched = true;
  const totalTerminals = 1 + workerCount;

  for (let i = 0; i < totalTerminals; i++) {
    createTerminal(i);
  }

  setFocused(0);
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
  for (let i = 1; i <= count; i++) {
    grid.insertAdjacentHTML('beforeend', `
      <div class="terminal-pane worker" data-index="${i}">
        <div class="pane-header">
          <span class="pane-title">Worker ${i}</span>
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
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

async function saveSettings() {
  workerCount = Math.max(1, Math.min(8, parseInt(document.getElementById('setting-workers').value, 10) || 4));
  previewUrl = document.getElementById('setting-preview-url').value.trim();

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workers: workerCount, previewUrl }),
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
  document.getElementById('status-list').innerHTML = statuses.map((s, i) => `
    <div class="status-card ${i === focusedIndex ? 'active' : ''} ${s.role === 'pilot' ? 'pilot-card' : ''}"
         data-index="${i}" onclick="setFocused(${i})">
      <div class="status-card-header">
        <span class="status-dot ${s.alive ? 'alive' : 'dead'}"></span>
        <strong>${s.role === 'pilot' ? 'Pilot' : 'Worker ' + i}</strong>
      </div>
      <div class="status-card-info">
        PID: ${s.pid || '-'} &middot; ${s.alive ? elapsed(s.startedAt) : 'stopped'}
      </div>
    </div>
  `).join('');
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

// ── Utils ──

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Autocomplete ──

function initAutocomplete(input) {
  const dropdown = document.getElementById('autocomplete');
  let selectedIdx = -1, items = [];

  const fetchSuggestions = debounce(async () => {
    const val = input.value.trim();
    if (val.length < 2) { hide(); return; }
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(val)}`);
      const data = await res.json();
      items = data.suggestions || [];
      if (!items.length) { hide(); return; }
      selectedIdx = -1;
      render();
      dropdown.classList.remove('hidden');
    } catch { hide(); }
  }, 150);

  function render() {
    dropdown.innerHTML = items.map((item, i) => `
      <div class="ac-item ${i === selectedIdx ? 'selected' : ''}" data-index="${i}">
        <span class="ac-icon">\u{1F4C1}</span>
        <span class="ac-name">${item.name}</span>
        <span class="ac-path">${item.path}</span>
      </div>
    `).join('');
  }

  function hide() { dropdown.classList.add('hidden'); items = []; selectedIdx = -1; }

  function select(idx) {
    if (idx >= 0 && idx < items.length) {
      const sep = items[idx].path.includes('/') ? '/' : '\\';
      input.value = items[idx].path + sep;
      hide();
      input.focus();
      fetchSuggestions();
    }
  }

  input.addEventListener('input', fetchSuggestions);
  input.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden')) {
      if (e.key === 'Enter') { launchSession(); return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, -1); render(); }
    else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      select(selectedIdx >= 0 ? selectedIdx : (items.length > 0 ? 0 : -1));
      if (selectedIdx < 0 && !items.length && e.key === 'Enter') { hide(); launchSession(); }
    }
    else if (e.key === 'Escape') { hide(); }
  });

  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const item = e.target.closest('.ac-item');
    if (item) select(parseInt(item.dataset.index, 10));
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('.launch-center')) hide(); });
}
