import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { PtyManager } from './pty-manager';
import { Settings, Bookmark, Profile, DEFAULTS } from './types';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const ptyManager = new PtyManager();

// Persisted settings
const SETTINGS_FILE = path.join(__dirname, '..', '.settings.json');

function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function saveSettings(): void {
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), (err) => {
    if (err) console.error('[settings] write error:', err.message);
  });
}

let settings: Settings = loadSettings();

app.use(express.json());

// CSRF protection: mutating requests must include X-Requested-With header
// Browsers block cross-origin custom headers without CORS preflight
app.use((req: Request, res: Response, next: NextFunction) => {
  if ((req.method === 'POST' || req.method === 'DELETE') && req.headers['x-requested-with'] !== 'FastVibe') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Settings API ──

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(settings);
});

app.post('/api/settings', (req: Request, res: Response) => {
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
  if (req.body.autoFollow != null) {
    settings.autoFollow = !!req.body.autoFollow;
  }
  if (req.body.theme != null && ['dark', 'light', 'system'].includes(req.body.theme)) {
    settings.theme = req.body.theme;
  }
  if (req.body.suggestMode != null && ['off', 'static', 'ai'].includes(req.body.suggestMode)) {
    settings.suggestMode = req.body.suggestMode;
  }
  if (req.body.logsEnabled != null) {
    settings.logsEnabled = !!req.body.logsEnabled;
  }
  saveSettings();
  res.json(settings);
});

// ── Status API ──

app.get('/api/status', (_req: Request, res: Response) => {
  res.json({ terminals: ptyManager.getStatus() });
});

// ── Bookmarks API ──

const BOOKMARKS_FILE = path.join(__dirname, '..', '.bookmarks.json');
let bookmarksCache: Bookmark[] | null = null;

function loadBookmarks(): Bookmark[] {
  if (bookmarksCache !== null) return bookmarksCache;
  try { bookmarksCache = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8')); }
  catch { bookmarksCache = []; }
  return bookmarksCache!;
}

function saveBookmarks(list: Bookmark[]): void {
  bookmarksCache = list;
  fs.writeFile(BOOKMARKS_FILE, JSON.stringify(list, null, 2), () => {});
}

app.get('/api/bookmarks', (_req: Request, res: Response) => {
  res.json(loadBookmarks());
});

app.post('/api/bookmarks', (req: Request, res: Response) => {
  const { path: p, name } = req.body;
  if (!p) return res.status(400).json({ error: 'Missing path' });
  const list = loadBookmarks();
  if (!list.find(b => b.path === p)) {
    list.push({ path: p, name: name || path.basename(p) });
    saveBookmarks(list);
  }
  res.json(list);
});

app.delete('/api/bookmarks', (req: Request, res: Response) => {
  const { path: p } = req.body;
  const list = loadBookmarks().filter(b => b.path !== p);
  saveBookmarks(list);
  res.json(list);
});

// ── Native folder picker ──

app.post('/api/pick-folder', (_req: Request, res: Response) => {
  const isWSL = process.platform === 'linux' && fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  const isWin = process.platform === 'win32' || isWSL;

  const psCmd = `${isWSL ? 'powershell.exe' : 'powershell'} -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;

  const cmd = isWin
    ? psCmd
    : (process.platform === 'darwin'
      ? `osascript -e 'POSIX path of (choose folder)'`
      : `zenity --file-selection --directory 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null`);

  exec(cmd, { timeout: 60000 }, (err: Error | null, stdout: string) => {
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

app.get('/api/browse', (req: Request, res: Response) => {
  const raw = (req.query.path as string) || '';
  const partial = raw ? raw.replace(/\//g, path.sep) : (process.env.USERPROFILE || process.env.HOME || 'C:\\');
  let dir: string, prefix: string;

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

app.post('/api/launch', (req: Request, res: Response) => {
  const cwd = req.body.cwd || process.cwd();
  if (!fs.existsSync(cwd)) {
    return res.status(400).json({ error: `Directory does not exist: ${cwd}` });
  }
  const workers = req.body.workers || settings.workers;
  settings.workers = workers;
  settings.lastCwd = cwd;
  saveSettings();
  ptyManager.launchAll(cwd, workers, { engine: settings.engine, noPilot: settings.noPilot, trustMode: settings.trustMode, useWSL: settings.useWSL, suggestMode: settings.suggestMode, logsEnabled: settings.logsEnabled });
  res.json({ ok: true, cwd, workers, engine: settings.engine, noPilot: settings.noPilot });
});

app.post('/api/stop', async (_req: Request, res: Response) => {
  await ptyManager.killAll();
  res.json({ ok: true });
});

app.post('/api/terminal/spawn', (_req: Request, res: Response) => {
  if (ptyManager.slots.length === 0) {
    return res.status(400).json({ error: 'No active session — call /api/launch first' });
  }
  const index = ptyManager.addWorker();
  res.json({ ok: true, index });
});

app.delete('/api/terminal/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id) || id < 0 || id >= ptyManager.slots.length) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  if (id === 0 && !ptyManager.noPilot) {
    return res.status(400).json({ error: 'Pilot cannot be removed' });
  }
  ptyManager.removeWorker(id);
  res.json({ ok: true });
});

// ── Terminal control ──

// ── Rate limiter for terminal send ──

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (entry.resetAt < now) rateLimitMap.delete(ip);
  }
}, 60_000);

app.post('/api/terminal/:id/send', (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + 60_000 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > 60) {
    return res.status(429).json({ error: 'Rate limit exceeded. 60 requests per minute.' });
  }
  const id = parseInt(req.params.id as string, 10);
  const text = req.body.text;
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }
  const ok = ptyManager.sendInput(id, text);
  res.json({ ok, terminal: id });
});

app.post('/api/terminal/:id/compact', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const ok = ptyManager.sendCommand(id, '/compact');
  res.json({ ok, terminal: id, action: 'compact' });
});

app.post('/api/terminal/:id/clear', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const ok = ptyManager.sendCommand(id, '/clear');
  res.json({ ok, terminal: id, action: 'clear' });
});

app.get('/api/terminal/:id/output', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const last = parseInt(req.query.last as string, 10) || 2000;
  const output = ptyManager.getOutput(id, last);
  res.json({ terminal: id, output });
});

// ── Suggest API ──

app.post('/api/suggest/:workerId', (req: Request, res: Response) => {
  const workerId = parseInt(req.params.workerId as string, 10);
  ptyManager.generateSuggestion(workerId);
  const suggestion = ptyManager.getSuggestion(workerId);
  res.json({ ok: true, suggestion });
});

app.post('/api/suggest/:workerId/send', (req: Request, res: Response) => {
  const workerId = parseInt(req.params.workerId as string, 10);
  const suggestion = ptyManager.getSuggestion(workerId);
  const text = req.body.text || (suggestion && suggestion.text);
  if (!text) return res.status(400).json({ error: 'No suggestion to send' });
  const ok = ptyManager.sendInput(workerId, text);
  ptyManager.dismissSuggestion(workerId);
  res.json({ ok, terminal: workerId });
});

app.post('/api/suggest/:workerId/dismiss', (req: Request, res: Response) => {
  const workerId = parseInt(req.params.workerId as string, 10);
  ptyManager.dismissSuggestion(workerId);
  res.json({ ok: true });
});

// ── Batch compact/clear ──

app.post('/api/batch/compact', (_req: Request, res: Response) => {
  const results = ptyManager.getStatus().filter(t => t.alive).map(t => ({
    terminal: t.id, ok: ptyManager.sendCommand(t.id, '/compact'),
  }));
  res.json({ ok: true, results });
});

app.post('/api/batch/clear', (_req: Request, res: Response) => {
  const results = ptyManager.getStatus().filter(t => t.alive).map(t => ({
    terminal: t.id, ok: ptyManager.sendCommand(t.id, '/clear'),
  }));
  res.json({ ok: true, results });
});

// ── Layout API ──

const LAYOUT_FILE = path.join(__dirname, '..', '.layout.json');

app.get('/api/layout', (_req: Request, res: Response) => {
  try {
    const raw = fs.readFileSync(LAYOUT_FILE, 'utf8');
    res.json({ layout: JSON.parse(raw) });
  } catch {
    res.json({ layout: null });
  }
});

app.post('/api/layout', (req: Request, res: Response) => {
  const layout = req.body?.layout;
  if (layout === undefined) return res.status(400).json({ error: 'Missing layout' });
  if (layout === null) {
    fs.unlink(LAYOUT_FILE, () => res.json({ ok: true, cleared: true }));
    return;
  }
  fs.writeFile(LAYOUT_FILE, JSON.stringify(layout, null, 2), (err) => {
    if (err) {
      console.error('[layout] write error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

// ── Profiles API ──

const PROFILES_FILE = path.join(__dirname, '..', '.profiles.json');
let profilesCache: Profile[] | null = null;

function loadProfiles(): Profile[] {
  if (profilesCache !== null) return profilesCache;
  try { profilesCache = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); }
  catch { profilesCache = []; }
  return profilesCache!;
}

function saveProfiles(profiles: Profile[]): void {
  profilesCache = profiles;
  fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), () => {});
}

app.get('/api/profiles', (_req: Request, res: Response) => {
  res.json(loadProfiles());
});

app.post('/api/profiles', (req: Request, res: Response) => {
  const { name, settings: s } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.name === name);
  const profile: Profile = { name, settings: s || {} };
  if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
  saveProfiles(profiles);
  res.json(profiles);
});

app.delete('/api/profiles', (req: Request, res: Response) => {
  const { name } = req.body;
  const profiles = loadProfiles().filter(p => p.name !== name);
  saveProfiles(profiles);
  res.json(profiles);
});

// ── Global search API ──

app.get('/api/search', (req: Request, res: Response) => {
  const q = (req.query.q as string || '').toLowerCase();
  const last = parseInt(req.query.last as string, 10) || 3000;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const results = ptyManager.getStatus()
    .filter(t => t.alive)
    .map(t => {
      const output = ptyManager.getOutput(t.id, last);
      if (!output) return null;
      const matches = output.split('\n').filter(line => line.toLowerCase().includes(q)).slice(0, 10);
      return matches.length > 0 ? { terminal: t.id, role: t.role, matches } : null;
    }).filter(Boolean);
  res.json({ results });
});

// ── WebSocket ──

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  // CSWSH protection: reject cross-origin WebSocket connections
  const origin = req.headers.origin;
  if (origin) {
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    if (!allowed.includes(origin)) {
      ws.close(4003, 'Origin not allowed');
      return;
    }
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const index = parseInt(url.searchParams.get('terminal')!, 10);

  if (isNaN(index) || index < 0) {
    ws.close(4000, 'Invalid terminal index');
    return;
  }

  try {
    ptyManager.attach(index, ws);
  } catch (err: unknown) {
    logServer('attach-error', `terminal=${index} ${(err as Error).message}`);
    ws.close(4001, 'Attach failed');
  }
});

// ── Error handling ──

function logServer(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

wss.on('error', (err: Error) => {
  logServer('wss-error', err.message);
});

server.on('error', (err: Error) => {
  logServer('http-error', err.message);
});

process.on('uncaughtException', (err: Error) => {
  logServer('uncaught', err.message, err.stack);
  // Don't exit — keep server alive for running PTY sessions
});

process.on('unhandledRejection', (reason: unknown) => {
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

function cleanup(): void {
  ptyManager.killAll();
  server.close();
}

process.on('SIGINT', () => { cleanup(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { cleanup(); setTimeout(() => process.exit(0), 3000); });
process.on('exit', () => { /* killAll already called in cleanup */ });

const PORT = parseInt(process.env.PORT || '3333', 10);

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    logServer('start', `fast-vibe v1.0.0 running at http://localhost:${PORT} (pid=${process.pid})`);
  });
}

export { app, server, wss, ptyManager, PORT, DEFAULTS, loadSettings, saveSettings, settings };
