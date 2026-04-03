const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { PtyManager } = require('./lib/pty-manager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const ptyManager = new PtyManager();

// Persisted settings
const SETTINGS_FILE = path.join(__dirname, '.settings.json');
const DEFAULTS = { workers: 4, previewUrl: '', engine: 'claude', noPilot: false, trustMode: false, useWSL: false };

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Settings API ──

app.get('/api/settings', (req, res) => {
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  if (req.body.workers != null) {
    settings.workers = Math.max(1, Math.min(8, parseInt(req.body.workers, 10) || 4));
  }
  if (req.body.previewUrl != null) {
    settings.previewUrl = req.body.previewUrl;
  }
  if (req.body.engine != null && ['claude', 'kiro'].includes(req.body.engine)) {
    settings.engine = req.body.engine;
  }
  if (req.body.noPilot != null) {
    settings.noPilot = !!req.body.noPilot;
  }
  if (req.body.trustMode != null) {
    settings.trustMode = !!req.body.trustMode;
  }
  if (req.body.useWSL != null) {
    settings.useWSL = !!req.body.useWSL;
  }
  saveSettings();
  res.json(settings);
});

// ── Status API ──

app.get('/api/status', (req, res) => {
  res.json({ terminals: ptyManager.getStatus() });
});

// ── Bookmarks API ──

const BOOKMARKS_FILE = path.join(__dirname, '.bookmarks.json');

function loadBookmarks() {
  try { return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8')); }
  catch { return []; }
}

function saveBookmarks(list) {
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/bookmarks', (req, res) => {
  res.json(loadBookmarks());
});

app.post('/api/bookmarks', (req, res) => {
  const { path: p, name } = req.body;
  if (!p) return res.status(400).json({ error: 'Missing path' });
  const list = loadBookmarks();
  if (!list.find(b => b.path === p)) {
    list.push({ path: p, name: name || path.basename(p) });
    saveBookmarks(list);
  }
  res.json(list);
});

app.delete('/api/bookmarks', (req, res) => {
  const { path: p } = req.body;
  const list = loadBookmarks().filter(b => b.path !== p);
  saveBookmarks(list);
  res.json(list);
});

// ── Native folder picker ──

app.post('/api/pick-folder', (req, res) => {
  const { exec } = require('child_process');
  const isWSL = process.platform === 'linux' && fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  const isWin = process.platform === 'win32' || isWSL;

  const psCmd = `${isWSL ? 'powershell.exe' : 'powershell'} -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;

  const cmd = isWin
    ? psCmd
    : (process.platform === 'darwin'
      ? `osascript -e 'POSIX path of (choose folder)'`
      : `zenity --file-selection --directory 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null`);

  exec(cmd, { timeout: 60000 }, (err, stdout) => {
    let folder = (stdout || '').trim();
    if (err || !folder) return res.json({ folder: null });
    // Convert Windows path to WSL path if needed
    if (isWSL && /^[A-Z]:\\/.test(folder)) {
      folder = '/mnt/' + folder[0].toLowerCase() + folder.slice(2).replace(/\\/g, '/');
    }
    res.json({ folder });
  });
});

// ── Directory autocomplete ──

app.get('/api/browse', (req, res) => {
  const raw = req.query.path || '';
  const partial = raw ? raw.replace(/\//g, path.sep) : (process.env.USERPROFILE || process.env.HOME || 'C:\\');
  let dir, prefix;

  try {
    const stat = fs.statSync(partial);
    if (stat.isDirectory()) {
      dir = partial;
      prefix = '';
    } else {
      dir = path.dirname(partial);
      prefix = path.basename(partial).toLowerCase();
    }
  } catch {
    dir = path.dirname(partial);
    prefix = path.basename(partial).toLowerCase();
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter(e => !prefix || e.name.toLowerCase().startsWith(prefix))
      .slice(0, 15)
      .map(e => ({
        name: e.name,
        path: path.join(dir, e.name),
      }));
    res.json({ dir, suggestions: dirs });
  } catch {
    res.json({ dir, suggestions: [] });
  }
});

// ── Launch / Stop ──

app.post('/api/launch', (req, res) => {
  const cwd = req.body.cwd || process.cwd();
  const workers = req.body.workers || settings.workers;
  settings.workers = workers;
  ptyManager.launchAll(cwd, workers, { engine: settings.engine, noPilot: settings.noPilot, trustMode: settings.trustMode, useWSL: settings.useWSL });
  res.json({ ok: true, cwd, workers, engine: settings.engine, noPilot: settings.noPilot });
});

app.post('/api/stop', (req, res) => {
  ptyManager.killAll();
  res.json({ ok: true });
});

// ── Terminal control ──

app.post('/api/terminal/:id/send', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const text = req.body.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }
  const ok = ptyManager.sendInput(id, text);
  res.json({ ok, terminal: id });
});

app.post('/api/terminal/:id/compact', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = ptyManager.sendCommand(id, '/compact');
  res.json({ ok, terminal: id, action: 'compact' });
});

app.post('/api/terminal/:id/clear', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = ptyManager.sendCommand(id, '/clear');
  res.json({ ok, terminal: id, action: 'clear' });
});

app.get('/api/terminal/:id/output', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const last = parseInt(req.query.last, 10) || 2000;
  const output = ptyManager.getOutput(id, last);
  res.json({ terminal: id, output });
});

// ── WebSocket ──

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const index = parseInt(url.searchParams.get('terminal'), 10);

  if (isNaN(index) || index < 0) {
    ws.close(4000, 'Invalid terminal index');
    return;
  }

  ptyManager.attach(index, ws);
});

// ── Shutdown ──

function cleanup() {
  ptyManager.killAll();
  server.close();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => { ptyManager.killAll(); });

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`fast-vibe running at http://localhost:${PORT}`);
});
