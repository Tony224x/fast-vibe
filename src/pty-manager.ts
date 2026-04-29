import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import type { WebSocket } from 'ws';

import { matchStaticSuggestion } from './suggest-patterns';
import type { Slot, Suggestion, SuggesteurState, TerminalStatus, LaunchOptions } from './types';

export const MAX_BUFFER = 50 * 1024;
const WS_HIGH_WATER = 128 * 1024;
export const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][0-9A-B]|\r/g;

function safeWrite(proc: IPty | null, data: string): void {
  try {
    if (proc) proc.write(data);
  } catch {
    // PTY already exited — ignore
  }
}

function log(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

export const PILOT_PROMPT_FILE = path.join(__dirname, '..', '.pilot-prompt.md');
const SUGGEST_PROMPT_FILE = path.join(__dirname, '..', '.suggest-prompt.md');

export function writePilotPrompt(workerCount: number): void {
  const ids = Array.from({ length: workerCount }, (_, i) => i + 1).join(', ');
  fs.writeFile(PILOT_PROMPT_FILE, `You are the PILOT orchestrator. You have ${workerCount} EXTERNAL worker Claude Code instances (workers 1-${workerCount}) running in separate terminals. You MUST delegate work to them via a REST API.

## CRITICAL RULES

- NEVER use the Agent tool or launch subagents. You have REAL external workers for that.
- ALWAYS delegate parallelizable work to the external workers via curl commands below.
- You are the coordinator: break tasks, dispatch to workers, monitor, verify, report.
- Do NOT do the workers' job yourself. Your role is to orchestrate, not implement.

## COMMANDS (use via Bash tool)

Send a task to worker N (replace N with 1-${workerCount}):
curl -s -X POST http://localhost:3333/api/terminal/N/send -H "Content-Type: application/json" -H "X-Requested-With: FastVibe" -d '{"text":"your detailed instruction here"}'

Read worker N output:
curl -s http://localhost:3333/api/terminal/N/output?last=5000

Check all statuses:
curl -s http://localhost:3333/api/status

Compact a worker's context (free memory, keep summary):
curl -s -X POST http://localhost:3333/api/terminal/N/compact -H "X-Requested-With: FastVibe"

Clear a worker's context (full reset, start fresh):
curl -s -X POST http://localhost:3333/api/terminal/N/clear -H "X-Requested-With: FastVibe"

## CONTEXT MANAGEMENT

Workers have limited context windows. You MUST manage their context:
- After a worker completes a task, ALWAYS compact it: curl -s -X POST http://localhost:3333/api/terminal/N/compact -H "X-Requested-With: FastVibe"
- When switching to a completely different topic, clear instead: curl -s -X POST http://localhost:3333/api/terminal/N/clear -H "X-Requested-With: FastVibe"
- Before sending a new task, check if the worker needs compacting first

## WORKFLOW

1. Analyze the user's request and break it into ${workerCount} sub-tasks
2. Send each sub-task to a different worker using curl (worker IDs: ${ids})
3. Poll their output every 30-60s to monitor progress
4. When all workers finish, read their outputs and verify quality
5. **Compact all workers** after verifying results
6. Report a summary to the user

## IMPORTANT

The workers are full Claude Code instances with file access. Give them clear, specific instructions including file paths and expected outcomes. They can read, write, and run code independently.
`, () => {});
}

export class PtyManager {
  count: number;
  cwd: string;
  slots: Slot[];
  engine: string;
  noPilot: boolean;
  trustMode: boolean;
  useWSL: boolean;
  suggestMode: string;
  suggesteur: SuggesteurState | null;
  suggestions: Record<number, Suggestion>;
  suggestQueue: Array<{ workerId: number; output: string }>;
  suggestBusy: boolean;
  logsEnabled: boolean;
  logsDir: string;
  autoRestart: boolean;

  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
    this.engine = 'claude';
    this.noPilot = false;
    this.trustMode = false;
    this.useWSL = false;
    this.suggestMode = 'off';
    this.logsEnabled = false;
    this.logsDir = '';
    this.autoRestart = true;
    // Suggesteur state
    this.suggesteur = null;
    this.suggestions = {};
    this.suggestQueue = [];
    this.suggestBusy = false;
  }

  spawn(index: number, cwd?: string): IPty | null {
    if (index >= this.slots.length) return null;
    const slot = this.slots[index];
    if (slot.pty) return slot.pty;

    const workdir = cwd || this.cwd;
    let shell: string, shellArgs: string[] = [];
    if (this.useWSL && process.platform === 'win32') {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
    } else {
      shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    }

    let proc: IPty;
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.useWSL ? undefined : workdir,
        env: process.env as Record<string, string>,
      });
    } catch (e: unknown) {
      log('spawn-error', `index=${index} ${(e as Error).message}`);
      return null;
    }

    slot.pty = proc;
    slot.startedAt = new Date().toISOString();
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.dirty = false;
    const role = (index === 0 && !this.noPilot) ? 'pilot' : `worker-${index}`;
    log('spawn', `${role} pid=${proc.pid} cwd=${workdir}`);

    proc.onData((data: string) => {
      slot.chunks.push(data);
      slot.chunksTotalLen += data.length;
      slot.dirty = true;
      if (slot.chunksTotalLen > MAX_BUFFER || slot.chunks.length > 100) {
        slot.joinedCache = slot.chunks.join('').slice(-MAX_BUFFER);
        slot.chunks = [slot.joinedCache];
        slot.chunksTotalLen = slot.joinedCache.length;
        slot.dirty = false;
      }
      if (this.logsEnabled && this.logsDir) {
        const stripped = data.replace(ANSI_RE, '');
        fs.appendFile(path.join(this.logsDir, `terminal-${index}.log`), stripped, () => {});
      }
      try {
        if (slot.ws && slot.ws.readyState === 1 && slot.ws.bufferedAmount < WS_HIGH_WATER) {
          slot.ws.send(data);
        }
      } catch { /* WS gone */ }
    });

    // Auto-launch CLI — wait for shell prompt before sending command
    const launchCmd = ((): string => {
      const nl = (process.platform === 'win32' && !this.useWSL) ? '\r' : '\n';
      const isPilot = index === 0 && !this.noPilot;

      if (this.engine === 'kiro') {
        return (this.trustMode ? 'kiro-cli chat --trust-all-tools --tui' : 'kiro-cli chat --tui') + nl;
      } else {
        const claudeCmd = this.trustMode ? 'claude --dangerously-skip-permissions' : 'claude';
        const alias = process.platform === 'win32' && !this.useWSL
          ? `doskey c=${claudeCmd} $*`
          : `alias c="${claudeCmd}"`;

        let cmd = claudeCmd;
        if (isPilot) {
          const promptPath = PILOT_PROMPT_FILE.replace(/\\/g, '/');
          cmd = `${claudeCmd} --disallowedTools Agent --append-system-prompt-file "${promptPath}"`;
        }
        return alias + nl + cmd + nl;
      }
    })();

    let launched = false;
    const onData = (data: string): void => {
      if (launched) return;
      // Detect shell prompt: $ or # or > at end of line
      if (/[$#>]\s*$/.test(data)) {
        launched = true;
        launchDisposable.dispose();
        safeWrite(proc, launchCmd);
      }
    };
    const launchDisposable = proc.onData(onData);

    // Fallback timeout in case prompt detection misses
    setTimeout(() => {
      if (!launched && slot.pty) {
        launched = true;
        safeWrite(proc, launchCmd);
      }
      launchDisposable.dispose();
    }, 5000);

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      log('exit', `${role} pid=${proc.pid} code=${exitCode}`);
      if (slot.pty === proc) {
        slot.pty = null;
      }
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
      // Auto-restart on unexpected exit
      if (this.autoRestart && !slot.removed && exitCode !== 0 && slot.restartCount < 3) {
        slot.restartCount++;
        log('auto-restart', `terminal=${index} attempt=${slot.restartCount}/3 in 3s`);
        setTimeout(() => { this.spawn(index, this.cwd); }, 3000);
      }
    });

    return proc;
  }

  attach(index: number, ws: WebSocket): void {
    if (index >= this.slots.length) {
      ws.close(4000, 'Terminal index out of range');
      return;
    }
    const slot = this.slots[index];

    if (!slot.pty) {
      this.spawn(index);
    }

    if (slot.ws) {
      slot.ws.removeAllListeners('message');
      slot.ws.removeAllListeners('close');
    }

    slot.ws = ws;

    if (slot.chunksTotalLen > 0) {
      try { ws.send(this._getBuffer(slot)); } catch { /* WS gone */ }
    }

    ws.on('error', (err: Error) => {
      log('ws-error', `terminal=${index} ${err.message}`);
      this.detach(index);
    });

    ws.on('message', (data: Buffer | string) => {
      const msg = data.toString();

      if (msg.startsWith('{"type"')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            this.resize(index, parsed.cols, parsed.rows);
            return;
          }
          if (parsed.type === 'restart') {
            this.restart(index);
            return;
          }
          if (parsed.type === 'raw' && typeof parsed.data === 'string') {
            safeWrite(slot.pty, parsed.data);
            return;
          }
        } catch { /* not JSON */ }
      }

      if (slot.pty) {
        safeWrite(slot.pty, msg.replace(/\n/g, '\r'));
      }
    });

    ws.on('close', () => {
      this.detach(index);
    });
  }

  detach(index: number): void {
    if (index < this.slots.length) {
      this.slots[index].ws = null;
    }
  }

  resize(index: number, cols: number, rows: number): void {
    if (index < this.slots.length && this.slots[index].pty) {
      try { this.slots[index].pty!.resize(cols, rows); } catch { /* PTY gone */ }
    }
  }

  restart(index: number): void {
    this.kill(index);
    this.spawn(index, this.cwd);
    const slot = this.slots[index];
    try {
      if (slot.ws && slot.ws.readyState === 1 && slot.chunksTotalLen > 0) {
        slot.ws.send(this._getBuffer(slot));
      }
    } catch { /* WS gone */ }
  }

  sendInput(index: number, text: string): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    // Multi-line text: wrap in bracketed-paste so embedded newlines stay
    // as newlines instead of being interpreted as Enter (submit).
    // Single-line text: convert any \n to \r for plain typing.
    // A trailing \r (after a short delay) submits the prompt — Claude Code
    // paste mode needs a separate Enter once the paste buffer is rendered.
    if (text.includes('\n')) {
      safeWrite(slot.pty, `\x1b[200~${text}\x1b[201~`);
    } else {
      safeWrite(slot.pty, text.replace(/\n/g, '\r'));
    }
    setTimeout(() => {
      safeWrite(slot.pty, '\r');
    }, 100);
    return true;
  }

  // Send a slash command (e.g. /compact, /clear) — no paste delay needed
  sendCommand(index: number, command: string): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    safeWrite(slot.pty, command + '\r');
    return true;
  }

  private _getBuffer(slot: Slot): string {
    if (slot.dirty) {
      slot.joinedCache = slot.chunks.join('');
      slot.dirty = false;
    }
    return slot.joinedCache;
  }

  getOutput(index: number, lastN: number = 2000): string {
    if (index >= this.slots.length) return '';
    const slot = this.slots[index];
    if (slot.chunksTotalLen === 0) return '';
    const raw = this._getBuffer(slot);
    // Slice first (cheap), then strip ANSI on smaller string (~25x less work)
    const tail = raw.slice(-(lastN + 1024));
    return tail.replace(ANSI_RE, '').slice(-lastN);
  }

  // Launch 1 pilot + N workers
  launchAll(cwd: string, workerCount: number = 4, opts: LaunchOptions = {}): void {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.engine = opts.engine || 'claude';
    this.noPilot = !!opts.noPilot;
    this.trustMode = !!opts.trustMode;
    this.useWSL = !!opts.useWSL;
    this.suggestMode = opts.suggestMode || 'off';
    this.logsEnabled = !!opts.logsEnabled;
    if (this.logsEnabled) {
      this.logsDir = path.join(this.cwd, 'logs');
      if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.count = this.noPilot ? workerCount : 1 + workerCount;

    log('launch', `engine=${this.engine} workers=${workerCount} noPilot=${this.noPilot} trust=${this.trustMode} cwd=${this.cwd}`);

    // Rebuild slots array
    this.slots = Array.from({ length: this.count }, (): Slot => ({
      pty: null, ws: null, startedAt: null,
      chunks: [], chunksTotalLen: 0, joinedCache: '', dirty: false,
      restartCount: 0,
    }));

    // Update pilot prompt with correct worker count (only for claude with pilot)
    if (this.engine === 'claude' && !this.noPilot) {
      writePilotPrompt(workerCount);
    }

    for (let i = 0; i < this.count; i++) {
      this.spawn(i, this.cwd);
    }

    // Suggesteur is spawned on demand (first AI suggestion request), not at launch
  }

  // Add a single new worker slot at the end and spawn its PTY. Returns the new
   // index. Workers added this way are independent of the original launchAll
   // configuration and persist until killAll().
  addWorker(): number {
    const newIndex = this.slots.length;
    this.slots.push({
      pty: null, ws: null, startedAt: null,
      chunks: [], chunksTotalLen: 0, joinedCache: '', dirty: false,
      restartCount: 0,
    });
    this.count = this.slots.length;
    this.spawn(newIndex, this.cwd);
    return newIndex;
  }

  // Permanently remove a worker. The slot stays in the array as a tombstone so
  // that indices (and therefore layout pane references) don't shift; subsequent
  // calls to addWorker continue to push at the end. getStatus filters tombstones
  // out so the UI sees them as truly gone.
  removeWorker(index: number): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (slot.removed) return true;
    slot.removed = true;
    this.kill(index);
    return true;
  }

  kill(index: number): void {
    if (index >= this.slots.length) return;
    const slot = this.slots[index];
    if (slot.pty) {
      log('kill', `terminal=${index} pid=${slot.pty.pid}`);
      try { slot.pty.kill(); } catch (e: unknown) { log('kill-error', `terminal=${index} ${(e as Error).message}`); }
      slot.pty = null;
    }
    slot.startedAt = null;
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.dirty = false;
  }

  killAll(): void {
    const oldAutoRestart = this.autoRestart;
    this.autoRestart = false;
    for (let i = 0; i < this.slots.length; i++) {
      this.kill(i);
    }
    this.autoRestart = oldAutoRestart;
    this.killSuggesteur();
  }

  // ── Suggesteur ──

  private spawnSuggesteur(): void {
    if (this.suggesteur && this.suggesteur.pty) return;

    const workdir = this.cwd;
    let shell: string, shellArgs: string[] = [];
    if (this.useWSL && process.platform === 'win32') {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
    } else {
      shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    }

    let proc: IPty;
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.useWSL ? undefined : workdir,
        env: process.env as Record<string, string>,
      });
    } catch (e: unknown) {
      log('spawn-error', `suggesteur ${(e as Error).message}`);
      return;
    }

    this.suggesteur = {
      pty: proc,
      chunks: [],
      chunksTotalLen: 0,
      joinedCache: '',
      dirty: false,
      ready: false,
    };

    const sg = this.suggesteur;

    proc.onData((data: string) => {
      sg.chunks.push(data);
      sg.chunksTotalLen += data.length;
      sg.dirty = true;
      if (sg.chunksTotalLen > MAX_BUFFER || sg.chunks.length > 100) {
        sg.joinedCache = sg.chunks.join('').slice(-MAX_BUFFER);
        sg.chunks = [sg.joinedCache];
        sg.chunksTotalLen = sg.joinedCache.length;
        sg.dirty = false;
      }
    });

    // Launch Claude Code in the suggesteur
    const nl = (process.platform === 'win32' && !this.useWSL) ? '\r' : '\n';
    const claudeCmd = this.trustMode ? 'claude --dangerously-skip-permissions' : 'claude';
    const promptPath = SUGGEST_PROMPT_FILE.replace(/\\/g, '/');
    const cmd = `${claudeCmd} --append-system-prompt-file "${promptPath}"${nl}`;

    let launched = false;
    const onData = (data: string): void => {
      if (launched) return;
      if (/[$#>]\s*$/.test(data)) {
        launched = true;
        launchDisp.dispose();
        safeWrite(proc, cmd);
        // Mark ready after Claude Code startup (~5s)
        setTimeout(() => { sg.ready = true; }, 8000);
      }
    };
    const launchDisp = proc.onData(onData);
    setTimeout(() => {
      if (!launched && sg.pty) {
        launched = true;
        safeWrite(proc, cmd);
        setTimeout(() => { sg.ready = true; }, 8000);
      }
      launchDisp.dispose();
    }, 5000);

    proc.onExit(() => {
      if (this.suggesteur && this.suggesteur.pty === proc) {
        this.suggesteur.pty = null;
        this.suggesteur.ready = false;
      }
    });
  }

  private killSuggesteur(): void {
    if (this.suggesteur && this.suggesteur.pty) {
      try { this.suggesteur.pty.kill(); } catch { /* already dead */ }
    }
    this.suggesteur = null;
    this.suggestQueue = [];
    this.suggestBusy = false;
    this.suggestions = {};
  }

  generateSuggestion(workerId: number): void {
    if (this.suggestMode === 'off') return;

    const output = this.getOutput(workerId, 3000);
    // Skip if output is too short (startup noise, no real interaction yet)
    if (!output || output.length < 100) return;

    // Static match (instant)
    const staticMatch = matchStaticSuggestion(output);
    if (staticMatch) {
      this.suggestions[workerId] = {
        text: staticMatch.text,
        source: 'static',
        pending: this.suggestMode === 'ai',
      };
    }

    // AI mode: spawn suggesteur on demand, then queue
    if (this.suggestMode === 'ai' && this.engine === 'claude') {
      if (!this.suggesteur || !this.suggesteur.pty) {
        this.spawnSuggesteur();
        // Queue the request — it will be processed when suggesteur is ready
      }
      // Dedupe: remove existing entry for this worker
      this.suggestQueue = this.suggestQueue.filter(q => q.workerId !== workerId);
      this.suggestQueue.push({ workerId, output });
      // Try processing (will skip if suggesteur not ready yet)
      this._processSuggestQueue();
      // Retry after suggesteur startup if not ready
      if (this.suggesteur && !this.suggesteur.ready) {
        setTimeout(() => this._processSuggestQueue(), 10000);
      }
    }
  }

  private _getSuggesteurOutput(): string {
    const sg = this.suggesteur;
    if (!sg || sg.chunksTotalLen === 0) return '';
    if (sg.dirty) {
      sg.joinedCache = sg.chunks.join('');
      sg.dirty = false;
    }
    return sg.joinedCache;
  }

  private _processSuggestQueue(): void {
    if (this.suggestBusy || this.suggestQueue.length === 0) return;
    if (!this.suggesteur || !this.suggesteur.pty || !this.suggesteur.ready) return;

    this.suggestBusy = true;
    const item = this.suggestQueue.shift()!;
    const { workerId, output } = item;
    const sg = this.suggesteur;

    // Reset buffer so we only see the response to THIS request
    sg.chunks = [];
    sg.chunksTotalLen = 0;
    sg.joinedCache = '';
    sg.dirty = false;

    // Send the worker output to suggesteur (truncated to avoid paste issues)
    const truncated = output.slice(-1500).replace(/\n{3,}/g, '\n\n');
    const message = `Worker ${workerId} output:\n${truncated}\n\nSuggest response.`;
    safeWrite(sg.pty, message);
    setTimeout(() => {
      safeWrite(sg.pty, '\r');
    }, 150);

    // Poll for response
    let attempts = 0;
    const maxAttempts = 60; // 30s at 500ms intervals
    const done = (suggestion: Suggestion | null): void => {
      clearInterval(pollInterval);
      if (suggestion) {
        this.suggestions[workerId] = suggestion;
      } else if (this.suggestions[workerId]) {
        this.suggestions[workerId].pending = false;
      }
      this.suggestBusy = false;
      this._processSuggestQueue();
    };
    const pollInterval = setInterval(() => {
      attempts++;
      if (!sg.pty || attempts > maxAttempts) {
        done(null);
        return;
      }

      const raw = this._getSuggesteurOutput();
      const stripped = raw.replace(ANSI_RE, '');

      // Method 1: look for [SUGGEST] prefix
      const suggestMatch = stripped.match(/\[SUGGEST\]\s*(.+)/);
      if (suggestMatch) {
        const text = suggestMatch[1].trim();
        done(text && !text.startsWith('NONE') ? { text, source: 'ai', pending: false } : null);
        return;
      }

      // Method 2: detect idle prompt (Claude finished responding)
      if (stripped.length > 200 && /❯\s*$/.test(stripped)) {
        const lines = stripped.split(/\n/).map(l => l.trim()).filter(l =>
          l.length > 1 &&
          !/^❯/.test(l) &&
          !/^Worker \d/.test(l) &&
          l !== 'Suggest response.' &&
          !/^\s*$/.test(l)
        );
        const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
        if (lastLine && lastLine.length > 1 && lastLine.length < 300) {
          const cleaned = lastLine.replace(/^\[SUGGEST\]\s*/, '');
          done({ text: cleaned, source: 'ai', pending: false });
        } else {
          done(null);
        }
      }
    }, 500);
  }

  dismissSuggestion(workerId: number): void {
    delete this.suggestions[workerId];
  }

  getSuggestion(workerId: number): Suggestion | null {
    return this.suggestions[workerId] || null;
  }

  getStatus(): TerminalStatus[] {
    return this.slots
      .map((slot, i) => ({
        id: i,
        pid: slot.pty ? slot.pty.pid : null,
        alive: !!slot.pty,
        startedAt: slot.startedAt,
        role: (i === 0 && !this.noPilot) ? 'pilot' as const : 'worker' as const,
        suggestion: this.suggestions[i] || null,
        removed: !!slot.removed,
      }))
      .filter(s => !s.removed)
      .map(({ removed: _r, ...rest }) => rest);
  }
}
