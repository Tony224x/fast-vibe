import express, { Request, Response, NextFunction, Express } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { exec, spawn, execSync, ChildProcess } from 'child_process';
import { PtyManager, MAX_WORKERS } from './pty-manager';
import { Settings, Bookmark, Profile, DEFAULTS } from './types';
import { improver } from './prompt-improver';

const app: Express = express();
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

// ── Session state (cross-restart resume) ──
//
// Stocke par worker : { index, sessionId, removed }. Au boot, on relit ce
// fichier et on `restoreAll()` pour relancer chaque claude avec --resume.
// Effacé explicitement sur /api/stop (l'utilisateur veut une session neuve)
// mais préservé sur SIGINT/SIGTERM (l'utilisateur veut retrouver son état).

const SESSION_STATE_FILE = path.join(__dirname, '..', '.session-state.json');

interface SessionState {
  cwd: string;
  engine: string;
  trustMode: boolean;
  useWSL: boolean;
  workers: Array<{ index: number; sessionId: string | null; removed?: boolean }>;
}

function persistSessionState(): void {
  // Ne persiste que si une session est effectivement active (au moins un slot
  // avec sessionId). Sinon on n'écrit pas pour ne pas créer un fichier vide.
  if (ptyManager.slots.length === 0) return;
  schedulePersistSessionState();
}

// Debounce 500ms + sérialisation des écritures fs.writeFile pour éviter les
// races de concurrent writes (8 workers qui spawn en parallèle déclenchent
// 8 mutations onStateChange en cascade → 8 writes simultanés au même fichier
// → JSON tronqué possible).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

function schedulePersistSessionState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state: SessionState = {
      cwd: ptyManager.cwd,
      engine: ptyManager.engine,
      trustMode: ptyManager.trustMode,
      useWSL: ptyManager.useWSL,
      workers: ptyManager.slots.map((s, i) => ({
        index: i,
        sessionId: s.sessionId ?? null,
        removed: s.removed,
      })),
    };
    const payload = JSON.stringify(state, null, 2);
    persistChain = persistChain.then(() => new Promise<void>((resolve) => {
      fs.writeFile(SESSION_STATE_FILE, payload, (err) => {
        if (err) console.error('[session-state] write error:', err.message);
        resolve();
      });
    }));
  }, 500);
}

function clearSessionState(): void {
  fs.unlink(SESSION_STATE_FILE, () => { /* noop */ });
}

function loadSessionState(): SessionState | null {
  try {
    const raw = fs.readFileSync(SESSION_STATE_FILE, 'utf8');
    const state = JSON.parse(raw) as SessionState;
    if (!state.cwd || !Array.isArray(state.workers)) return null;
    return state;
  } catch { return null; }
}

ptyManager.onStateChange = persistSessionState;

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
  // Auto-compact idle (minutes, 0 = off). Clampé 0..240. Appliqué à chaud
  // sur le ptyManager pour que le changement prenne effet sans relancer.
  if (req.body.autoCompactIdleMin != null) {
    const m = parseInt(req.body.autoCompactIdleMin, 10);
    settings.autoCompactIdleMin = Math.max(0, Math.min(240, isNaN(m) ? 0 : m));
    ptyManager.setAutoCompactIdleMin(settings.autoCompactIdleMin);
  }
  // localSTT : flip détection. Si on l'active, spawn le sidecar Python.
  // Si on le désactive, kill. On compare avant d'écraser pour ne pas
  // re-spawn inutile sur un POST qui passe la même valeur.
  if (req.body.localSTT != null) {
    const next = !!req.body.localSTT;
    if (next !== settings.localSTT) {
      settings.localSTT = next;
      if (next) void startWhisperSidecar();
      else stopWhisperSidecar();
    }
  }
  saveSettings();
  res.json(settings);
});

// ── Status API ──

app.get('/api/status', (_req: Request, res: Response) => {
  // session: null si aucune session active. Sinon, expose cwd/engine
  // pour que le frontend rebuild le grid lors d'un auto-reconnect (browser
  // fermé/rouvert, ou redémarrage serveur avec restoreAll).
  const session = ptyManager.slots.length > 0 ? {
    cwd: ptyManager.cwd,
    engine: ptyManager.engine,
    trustMode: ptyManager.trustMode,
  } : null;
  res.json({ terminals: ptyManager.getStatus(), session });
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
  // Clamp au cap : le launch crée les slots directement sans passer par
  // addWorker, donc on borne ici aussi pour ne pas spawn > MAX_WORKERS claude.
  const workers = Math.max(1, Math.min(MAX_WORKERS, parseInt(req.body.workers, 10) || settings.workers));
  settings.workers = workers;
  settings.lastCwd = cwd;
  saveSettings();
  ptyManager.launchAll(cwd, workers, { engine: settings.engine, trustMode: settings.trustMode, useWSL: settings.useWSL, suggestMode: settings.suggestMode, logsEnabled: settings.logsEnabled, autoCompactIdleMin: settings.autoCompactIdleMin });
  res.json({ ok: true, cwd, workers, engine: settings.engine });
});

app.post('/api/stop', async (_req: Request, res: Response) => {
  await ptyManager.killAll();
  // /api/stop = "session terminée" : on supprime le state pour que le prochain
  // boot affiche le welcome au lieu de restorer.
  clearSessionState();
  res.json({ ok: true });
});

// ── Restore API (opt-in) ──
//
// Le boot ne relance plus automatiquement les sessions depuis
// .session-state.json. Le client appelle /api/restore-info pour savoir si
// un état est disponible, puis POST /api/restore pour le ressusciter.

app.get('/api/restore-info', (_req: Request, res: Response) => {
  // Si une session est déjà active (slots non vides), pas de "restore" à
  // proposer : c'est le auto-reconnect classique qui prend le relais.
  if (ptyManager.slots.length > 0) {
    return res.json({ available: false, reason: 'session-active' });
  }
  const state = loadSessionState();
  if (!state) return res.json({ available: false });
  if (!state.cwd || !fs.existsSync(state.cwd)) {
    return res.json({ available: false, reason: 'cwd-missing', cwd: state.cwd });
  }
  let ageMs: number | null = null;
  try { ageMs = Date.now() - fs.statSync(SESSION_STATE_FILE).mtimeMs; }
  catch { ageMs = null; }
  const aliveWorkers = state.workers.filter(w => !w.removed).length;
  res.json({
    available: true,
    cwd: state.cwd,
    engine: state.engine,
    workers: aliveWorkers,
    totalWorkers: state.workers.length,
    ageMs,
  });
});

app.post('/api/restore', (_req: Request, res: Response) => {
  if (ptyManager.slots.length > 0) {
    return res.status(409).json({ error: 'Session already active. Stop it first.' });
  }
  const state = loadSessionState();
  if (!state) return res.status(404).json({ error: 'No session state available' });
  if (!state.cwd || !fs.existsSync(state.cwd)) {
    return res.status(400).json({ error: `Saved cwd missing: ${state.cwd}` });
  }
  try {
    ptyManager.restoreAll(state);
    // restoreAll() ne connaît pas le réglage auto-compact (pas dans le state) :
    // on l'applique depuis les settings après coup pour (re)démarrer le sweep.
    ptyManager.setAutoCompactIdleMin(settings.autoCompactIdleMin);
    res.json({ ok: true, cwd: state.cwd, workers: ptyManager.slots.length });
  } catch (e: unknown) {
    res.status(500).json({ error: `restore failed: ${(e as Error).message}` });
  }
});

app.delete('/api/restore-info', (_req: Request, res: Response) => {
  clearSessionState();
  res.json({ ok: true });
});

app.post('/api/terminal/spawn', (_req: Request, res: Response) => {
  if (ptyManager.slots.length === 0) {
    return res.status(400).json({ error: 'No active session — call /api/launch first' });
  }
  const index = ptyManager.addWorker();
  if (index === -1) {
    return res.status(400).json({ error: `Worker cap reached (${MAX_WORKERS} max). Remove a worker before adding another.` });
  }
  res.json({ ok: true, index, liveWorkers: ptyManager.countLiveWorkers() });
});

app.delete('/api/terminal/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id) || id < 0 || id >= ptyManager.slots.length) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  ptyManager.removeWorker(id);
  res.json({ ok: true });
});

// ── Terminal control ──

// ── Rate limiter for terminal send ──

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (entry.resetAt < now) rateLimitMap.delete(ip);
  }
}, 60_000);
rateLimitCleanupTimer.unref?.();

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

// ── Improve prompt (always-on Claude session, --resume + cache) ──
//
// Délègue à PromptImprover qui maintient une session `claude` persistante via
// --resume. La 1ère requête prime la session (~5-10s), les suivantes hit le
// cache prompt (~2-3s). Aucune interaction avec les workers.

const improveLimiter = new Map<string, { count: number; resetAt: number }>();
const improveLimiterCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of improveLimiter) if (e.resetAt < now) improveLimiter.delete(ip);
}, 60_000);
improveLimiterCleanupTimer.unref?.();

app.post('/api/improve-prompt', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = improveLimiter.get(ip);
  if (!entry || entry.resetAt < now) { entry = { count: 0, resetAt: now + 60_000 }; improveLimiter.set(ip, entry); }
  entry.count++;
  if (entry.count > 20) return res.status(429).json({ error: 'Rate limit: 20 requests per minute.' });

  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 4000) return res.status(400).json({ error: 'Text too long (max 4000 chars).' });

  try {
    const out = await improver.improve(text);
    res.json({
      improved: out.improved,
      engine: 'claude',
      session_id: out.session_id,
      reused_session: out.reused_session,
      cached_tokens: out.cached_tokens,
      duration_ms: out.duration_ms,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: `improve failed: ${(err as Error).message}` });
  }
});

// ── Voice transcription proxy ──
//
// Proxy le multipart audio reçu du browser vers le sidecar Python
// faster-whisper (scripts/whisper_sidecar.py) sur 127.0.0.1:WHISPER_PORT.
// On streame avec http.request pour ne pas buffer le blob audio en mémoire
// (peut faire plusieurs MB pour les utterances longues). Le port est lu
// dans l'env FAST_VIBE_WHISPER_PORT, default 8765.

const WHISPER_PORT = parseInt(process.env.FAST_VIBE_WHISPER_PORT || '8765', 10);
const WHISPER_SCRIPT = path.join(__dirname, '..', 'scripts', 'whisper_sidecar.py');

// Sidecar Python géré par nous. Null si :
//  - localSTT = false (l'user n'a pas activé)
//  - localSTT = true mais un autre process tient déjà le port (lancé à la
//    main par l'user dans un autre terminal) → on ne touche pas
//  - spawn a échoué (python absent, etc.)
let whisperSidecar: ChildProcess | null = null;
// Évite les double-spawn quand /api/settings est toggle rapidement.
let whisperSpawnInFlight = false;

function probeWhisperHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: WHISPER_PORT, path: '/health', method: 'GET', timeout: 1500,
    }, (res) => {
      // Drain le body pour libérer la socket sinon Node keep-alive la garde.
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function startWhisperSidecar(): Promise<void> {
  if (whisperSidecar || whisperSpawnInFlight) return;
  whisperSpawnInFlight = true;
  try {
    // Check : si un sidecar tourne déjà (lancé à la main par l'user), on
    // ne le double-spawn pas. Le proxy /api/transcribe l'utilisera quand
    // même puisqu'il vise toujours le port.
    const already = await probeWhisperHealth();
    if (already) {
      logServer('whisper', `sidecar déjà actif sur :${WHISPER_PORT} (process externe), pas de spawn`);
      return;
    }
    if (!fs.existsSync(WHISPER_SCRIPT)) {
      logServer('whisper', `script introuvable : ${WHISPER_SCRIPT} — désactivation`);
      return;
    }
    // Sur Windows le binaire est `python` ; ailleurs souvent `python3`.
    const py = process.platform === 'win32' ? 'python' : 'python3';
    logServer('whisper', `spawning ${py} ${WHISPER_SCRIPT}`);
    const child = spawn(py, [WHISPER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FAST_VIBE_WHISPER_PORT: String(WHISPER_PORT) },
      // detached:false → le child est lié au parent. Sur SIGINT, kill se
      // propage. windowsHide:true évite une console flash sur Windows.
      windowsHide: true,
    });
    whisperSidecar = child;
    // On préfixe les lignes pour distinguer dans les logs Node mélangés.
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[whisper] ${d.toString()}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[whisper-err] ${d.toString()}`));
    child.on('exit', (code, signal) => {
      logServer('whisper', `sidecar exited code=${code} signal=${signal}`);
      if (whisperSidecar === child) whisperSidecar = null;
    });
    child.on('error', (e) => {
      logServer('whisper', `spawn error : ${e.message}. python est-il dans le PATH ?`);
      if (whisperSidecar === child) whisperSidecar = null;
    });
  } finally {
    whisperSpawnInFlight = false;
  }
}

function stopWhisperSidecar(): void {
  if (!whisperSidecar) return;
  const child = whisperSidecar;
  whisperSidecar = null;
  const pid = child.pid;
  logServer('whisper', `killing sidecar pid=${pid}`);
  // Windows : kill() envoie SIGTERM mais ne propage pas aux sous-process.
  // Le Flask de Python peut spawn des workers (rare en threaded mais on est
  // prudents). taskkill /T /F tue l'arbre complet.
  if (process.platform === 'win32' && pid) {
    try {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', timeout: 3000, windowsHide: true });
    } catch { /* déjà mort */ }
  }
  try { child.kill(); } catch { /* déjà mort */ }
}

app.post('/api/transcribe', (req: Request, res: Response) => {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: WHISPER_PORT,
    path: '/transcribe',
    method: 'POST',
    headers: {
      // On forward content-type + content-length pour conserver le boundary
      // multipart. On retire host pour ne pas confuser Flask.
      'content-type': req.headers['content-type'] || '',
      ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
    },
    timeout: 60_000, // 1 min max pour une transcription (utterance ~30s)
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e: NodeJS.ErrnoException) => {
    if (res.headersSent) return;
    if (e.code === 'ECONNREFUSED') {
      res.status(503).json({
        error: 'Sidecar whisper non démarré. Lance : python scripts/whisper_sidecar.py',
        port: WHISPER_PORT,
      });
    } else {
      res.status(502).json({ error: `Proxy whisper: ${e.message}` });
    }
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Whisper timeout (60s)' });
  });
  req.pipe(proxyReq);
});

app.get('/api/transcribe/health', (_req: Request, res: Response) => {
  const probe = http.request({
    hostname: '127.0.0.1',
    port: WHISPER_PORT,
    path: '/health',
    method: 'GET',
    timeout: 2000,
  }, (probeRes) => {
    let body = '';
    probeRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    probeRes.on('end', () => {
      try {
        res.json({ available: true, port: WHISPER_PORT, sidecar: JSON.parse(body) });
      } catch {
        res.json({ available: true, port: WHISPER_PORT, sidecar: null });
      }
    });
  });
  probe.on('error', () => { res.json({ available: false, port: WHISPER_PORT }); });
  probe.on('timeout', () => { probe.destroy(); res.json({ available: false, port: WHISPER_PORT, reason: 'timeout' }); });
  probe.end();
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

// Heartbeat : on tag chaque ws avec _isAlive, ping toutes les 30s. Si on
// n'a pas reçu de pong d'une connexion entre deux pings, on terminate —
// ça permet de nettoyer les connexions zombies (NAT timeout, fermeture
// brutale du client) qui sinon resteraient attachées au slot indéfiniment
// avec des slot.ws.send() partant dans le vide.
const HEARTBEAT_INTERVAL_MS = 30_000;
type WsAlive = WebSocket & { _isAlive?: boolean };

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((rawWs) => {
    const ws = rawWs as WsAlive;
    if (ws._isAlive === false) {
      logServer('ws-zombie-terminate', `client did not pong in ${HEARTBEAT_INTERVAL_MS}ms`);
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    ws._isAlive = false;
    try { ws.ping(); } catch { /* ws closed between checks */ }
  });
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

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

  // Heartbeat init
  (ws as WsAlive)._isAlive = true;
  ws.on('pong', () => { (ws as WsAlive)._isAlive = true; });

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
  // EADDRINUSE : un ancien fast-vibe (ou un orphelin) tient déjà le port. Sans
  // traitement, listen() ne réussit jamais : le process ne sert ni n'exit, le
  // superviseur (dist/app.js) ne voit pas d'exit → ne relance pas → fenêtre
  // jamais ouverte ("l'app ne démarre pas"). On exit(1) pour que le superviseur
  // relance avec backoff au lieu d'un hang silencieux.
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    logServer('http-error', `port ${PORT} déjà utilisé — un fast-vibe tourne déjà ou un orphelin tient le port. Arrêt pour laisser le superviseur relancer.`);
    process.exit(1);
  }
  logServer('http-error', err.message);
});

process.on('uncaughtException', (err: Error) => {
  logServer('uncaught', err.message, err.stack);
  // Politique : un uncaughtException laisse l'état dans un mode incohérent
  // (timer non clearé, slot dans un état hybride, etc.). On essaie un
  // killAll best-effort puis on exit avec un code non-nul. Un supervisor
  // (npm-watch en dev, pm2/systemd en prod) doit respawn le serveur.
  // Si killAll throw, on exit quand même — la cleanup OS s'en chargera.
  try { ptyManager.killAll(); } catch (e) { logServer('uncaught-cleanup-error', String(e)); }
  // Petit délai pour laisser passer les exits PTY avant de quitter.
  setTimeout(() => process.exit(1), 500).unref();
});

process.on('unhandledRejection', (reason: unknown) => {
  logServer('rejection', reason);
});

// ── Memory monitoring ──

const memMonitorTimer = setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(0);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
  const ext = (mem.external / 1024 / 1024).toFixed(0);
  const status = ptyManager.getStatus();
  const alive = status.filter(s => s.alive).length;
  logServer('mem', `rss=${rss}MB heap=${heap}MB ext=${ext}MB ptys=${alive}/${status.length}`);
}, 60_000);
memMonitorTimer.unref?.();

// ── Shutdown ──

function cleanup(): void {
  stopWhisperSidecar();
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
    // Opt-in restore : on n'auto-relance plus les workers au boot. Le client
    // appelle GET /api/restore-info pour découvrir l'état persisté, puis
    // POST /api/restore quand l'utilisateur clique sur "Reprendre". Ça évite
    // de spawn N claude --resume sans contexte (browser fermé, port pris par
    // un ancien process, etc.).
    const restored = loadSessionState();
    if (restored && restored.cwd && fs.existsSync(restored.cwd)) {
      const alive = restored.workers.filter(w => !w.removed).length;
      logServer('restore-available', `cwd=${restored.cwd} workers=${alive} — call POST /api/restore to resume`);
    } else if (restored) {
      logServer('restore-skipped', `cwd missing: ${restored.cwd}`);
      clearSessionState();
    }
    // Auto-start du sidecar whisper si l'user a activé localSTT. Le spawn
    // est async (vérifie d'abord si le port est libre) et n'empêche pas
    // le serveur Node de servir les requêtes en attendant.
    if (settings.localSTT) {
      void startWhisperSidecar();
    }
  });
}

export { app, server, wss, ptyManager, PORT, DEFAULTS, loadSettings, saveSettings, settings };
