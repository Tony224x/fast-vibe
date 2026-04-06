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
const DEFAULTS = { workers: 4, previewUrl: '', engine: 'claude', noPilot: false, trustMode: false, useWSL: false, autoFocus: true, theme: 'dark', suggestMode: 'off' };

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function saveSettings() {
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

let settings = loadSettings();

app.use(express.json());

// CSRF protection: mutating requests must include X-Requested-With header
// Browsers block cross-origin custom headers without CORS preflight
app.use((req, res, next) => {
  if ((req.method === 'POST' || req.method === 'DELETE') && req.headers['x-requested-with'] !== 'FastVibe') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Settings API ──

app.get('/api/settings', (req, res) => {
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  if (req.body.workers != null) {
    const n = parseInt(req.body.workers, 10);
    settings.workers = Math.max(1, Math.min(8, isNaN(n) ? 4 : n));
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
  if (req.body.autoFocus != null) {
    settings.autoFocus = !!req.body.autoFocus;
  }
  if (req.body.theme != null && ['dark', 'light', 'system'].includes(req.body.theme)) {
    settings.theme = req.body.theme;
  }
  if (req.body.suggestMode != null && ['off', 'static', 'ai'].includes(req.body.suggestMode)) {
    settings.suggestMode = req.body.suggestMode;
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
let bookmarksCache = null;

function loadBookmarks() {
  if (bookmarksCache !== null) return bookmarksCache;
  try { bookmarksCache = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8')); }
  catch { bookmarksCache = []; }
  return bookmarksCache;
}

function saveBookmarks(list) {
  bookmarksCache = list;
  fs.writeFile(BOOKMARKS_FILE, JSON.stringify(list, null, 2), () => {});
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
  settings.lastCwd = cwd;
  saveSettings();
  ptyManager.launchAll(cwd, workers, { engine: settings.engine, noPilot: settings.noPilot, trustMode: settings.trustMode, useWSL: settings.useWSL, suggestMode: settings.suggestMode });
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

// ── Suggest API ──

app.post('/api/suggest/:workerId', (req, res) => {
  const workerId = parseInt(req.params.workerId, 10);
  ptyManager.generateSuggestion(workerId);
  const suggestion = ptyManager.getSuggestion(workerId);
  res.json({ ok: true, suggestion });
});

app.post('/api/suggest/:workerId/send', (req, res) => {
  const workerId = parseInt(req.params.workerId, 10);
  const suggestion = ptyManager.getSuggestion(workerId);
  const text = req.body.text || (suggestion && suggestion.text);
  if (!text) return res.status(400).json({ error: 'No suggestion to send' });
  const ok = ptyManager.sendInput(workerId, text);
  ptyManager.dismissSuggestion(workerId);
  res.json({ ok, terminal: workerId });
});

app.post('/api/suggest/:workerId/dismiss', (req, res) => {
  const workerId = parseInt(req.params.workerId, 10);
  ptyManager.dismissSuggestion(workerId);
  res.json({ ok: true });
});

// ── WebSocket ──

wss.on('connection', (ws, req) => {
  // CSWSH protection: reject cross-origin WebSocket connections
  const origin = req.headers.origin;
  if (origin) {
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    if (!allowed.includes(origin)) {
      ws.close(4003, 'Origin not allowed');
      return;
    }
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const index = parseInt(url.searchParams.get('terminal'), 10);

  if (isNaN(index) || index < 0) {
    ws.close(4000, 'Invalid terminal index');
    return;
  }

  try {
    ptyManager.attach(index, ws);
  } catch (err) {
    logServer('attach-error', `terminal=${index} ${err.message}`);
    ws.close(4001, 'Attach failed');
  }
});

// ── Error handling ──

function logServer(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

wss.on('error', (err) => {
  logServer('wss-error', err.message);
});

server.on('error', (err) => {
  logServer('http-error', err.message);
});

process.on('uncaughtException', (err) => {
  logServer('uncaught', err.message, err.stack);
  // Don't exit — keep server alive for running PTY sessions
});

process.on('unhandledRejection', (reason) => {
  logServer('rejection', reason);
});

// ── Memory monitoring ──

setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(0);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
  const ext = (mem.external / 1024 / 1024).toFixed(0);
  const status = ptyManager.getStatus();
  const alive = status.filter(s => s.alive).length;
  logServer('mem', `rss=${rss}MB heap=${heap}MB ext=${ext}MB ptys=${alive}/${status.length}`);
}, 60_000);

// ── Shutdown ──

function cleanup() {
  ptyManager.killAll();
  server.close();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => { ptyManager.killAll(); });

const PORT = process.env.PORT || 3333;

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    logServer('start', `fast-vibe v1.0.0 running at http://localhost:${PORT} (pid=${process.pid})`);
  });
}

module.exports = { app, server, wss, ptyManager, PORT, DEFAULTS, loadSettings, saveSettings, settings };
