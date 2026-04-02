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

// In-memory settings
let settings = { workers: 4, previewUrl: '' };

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
  res.json(settings);
});

// ── Status API ──

app.get('/api/status', (req, res) => {
  res.json({ terminals: ptyManager.getStatus() });
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
  ptyManager.launchAll(cwd, workers);
  res.json({ ok: true, cwd, workers });
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
