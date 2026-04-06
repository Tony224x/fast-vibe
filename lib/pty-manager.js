const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const { matchStaticSuggestion } = require('./suggest-patterns');

const MAX_BUFFER = 50 * 1024;
const WS_HIGH_WATER = 128 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][0-9A-B]|\r/g;

// Safe PTY write — no-op if process is dead
function safeWrite(proc, data) {
  try {
    if (proc) proc.write(data);
  } catch {
    // PTY already exited — ignore
  }
}

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

// Write pilot system prompt to a file so it doesn't clutter the terminal
const PILOT_PROMPT_FILE = path.join(__dirname, '..', '.pilot-prompt.md');
const SUGGEST_PROMPT_FILE = path.join(__dirname, '..', '.suggest-prompt.md');

function writePilotPrompt(workerCount) {
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

class PtyManager {
  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
    this.engine = 'claude';
    this.noPilot = false;
    this.suggestMode = 'off';
    // Suggesteur state
    this.suggesteur = null; // { pty, chunks, chunksTotalLen, joinedCache, dirty }
    this.suggestions = {};  // workerId → { text, source, pending }
    this.suggestQueue = []; // [{ workerId, output }]
    this.suggestBusy = false;
  }

  spawn(index, cwd) {
    if (index >= this.slots.length) return null;
    const slot = this.slots[index];
    if (slot.pty) return slot.pty;

    const workdir = cwd || this.cwd;
    let shell, shellArgs = [];
    if (this.useWSL && process.platform === 'win32') {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
    } else {
      shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    }

    let proc;
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.useWSL ? undefined : workdir,
        env: process.env,
      });
    } catch (e) {
      log('spawn-error', `index=${index} ${e.message}`);
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

    proc.onData((data) => {
      slot.chunks.push(data);
      slot.chunksTotalLen += data.length;
      slot.dirty = true;
      if (slot.chunksTotalLen > MAX_BUFFER || slot.chunks.length > 100) {
        slot.joinedCache = slot.chunks.join('').slice(-MAX_BUFFER);
        slot.chunks = [slot.joinedCache];
        slot.chunksTotalLen = slot.joinedCache.length;
        slot.dirty = false;
      }
      try {
        if (slot.ws && slot.ws.readyState === 1 && slot.ws.bufferedAmount < WS_HIGH_WATER) {
          slot.ws.send(data);
        }
      } catch { /* WS gone */ }
    });

    // Auto-launch CLI — wait for shell prompt before sending command
    const launchCmd = (() => {
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
    const onData = (data) => {
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

    proc.onExit(({ exitCode }) => {
      log('exit', `${role} pid=${proc.pid} code=${exitCode}`);
      if (slot.pty === proc) {
        slot.pty = null;
      }
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
    });

    return proc;
  }

  attach(index, ws) {
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

    ws.on('error', (err) => {
      log('ws-error', `terminal=${index} ${err.message}`);
      this.detach(index);
    });

    ws.on('message', (data) => {
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
        } catch { /* not JSON */ }
      }

      if (slot.pty) {
        safeWrite(slot.pty, msg);
      }
    });

    ws.on('close', () => {
      this.detach(index);
    });
  }

  detach(index) {
    if (index < this.slots.length) {
      this.slots[index].ws = null;
    }
  }

  resize(index, cols, rows) {
    if (index < this.slots.length && this.slots[index].pty) {
      try { this.slots[index].pty.resize(cols, rows); } catch { /* PTY gone */ }
    }
  }

  restart(index) {
    this.kill(index);
    this.spawn(index, this.cwd);
    const slot = this.slots[index];
    try {
      if (slot.ws && slot.ws.readyState === 1 && slot.chunksTotalLen > 0) {
        slot.ws.send(this._getBuffer(slot));
      }
    } catch { /* WS gone */ }
  }

  sendInput(index, text) {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    // Write text, then send Enter after a short delay
    // (Claude Code paste mode needs a separate Enter to submit)
    safeWrite(slot.pty, text);
    setTimeout(() => {
      safeWrite(slot.pty, '\r');
    }, 100);
    return true;
  }

  // Send a slash command (e.g. /compact, /clear) — no paste delay needed
  sendCommand(index, command) {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    safeWrite(slot.pty, command + '\r');
    return true;
  }

  _getBuffer(slot) {
    if (slot.dirty) {
      slot.joinedCache = slot.chunks.join('');
      slot.dirty = false;
    }
    return slot.joinedCache;
  }

  getOutput(index, lastN = 2000) {
    if (index >= this.slots.length) return '';
    const slot = this.slots[index];
    if (slot.chunksTotalLen === 0) return '';
    const raw = this._getBuffer(slot);
    // Slice first (cheap), then strip ANSI on smaller string (~25x less work)
    const tail = raw.slice(-(lastN + 1024));
    return tail.replace(ANSI_RE, '').slice(-lastN);
  }

  // Launch 1 pilot + N workers
  launchAll(cwd, workerCount = 4, opts = {}) {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.engine = opts.engine || 'claude';
    this.noPilot = !!opts.noPilot;
    this.trustMode = !!opts.trustMode;
    this.useWSL = !!opts.useWSL;
    this.suggestMode = opts.suggestMode || 'off';
    this.count = this.noPilot ? workerCount : 1 + workerCount;

    log('launch', `engine=${this.engine} workers=${workerCount} noPilot=${this.noPilot} trust=${this.trustMode} cwd=${this.cwd}`);

    // Rebuild slots array
    this.slots = Array.from({ length: this.count }, () => ({
      pty: null, ws: null, startedAt: null,
      chunks: [], chunksTotalLen: 0, joinedCache: '', dirty: false,
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

  kill(index) {
    if (index >= this.slots.length) return;
    const slot = this.slots[index];
    if (slot.pty) {
      log('kill', `terminal=${index} pid=${slot.pty.pid}`);
      try { slot.pty.kill(); } catch (e) { log('kill-error', `terminal=${index} ${e.message}`); }
      slot.pty = null;
    }
    slot.startedAt = null;
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.dirty = false;
  }

  killAll() {
    for (let i = 0; i < this.slots.length; i++) {
      this.kill(i);
    }
    this.killSuggesteur();
  }

  // ── Suggesteur ──

  spawnSuggesteur() {
    if (this.suggesteur && this.suggesteur.pty) return;

    const workdir = this.cwd;
    let shell, shellArgs = [];
    if (this.useWSL && process.platform === 'win32') {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
    } else {
      shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    }

    let proc;
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.useWSL ? undefined : workdir,
        env: process.env,
      });
    } catch (e) {
      log('spawn-error', `suggesteur ${e.message}`);
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

    proc.onData((data) => {
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
    const onData = (data) => {
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

  killSuggesteur() {
    if (this.suggesteur && this.suggesteur.pty) {
      try { this.suggesteur.pty.kill(); } catch { /* already dead */ }
    }
    this.suggesteur = null;
    this.suggestQueue = [];
    this.suggestBusy = false;
    this.suggestions = {};
  }

  generateSuggestion(workerId) {
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
      if (!this.suggesteur.ready) {
        setTimeout(() => this._processSuggestQueue(), 10000);
      }
    }
  }

  _getSuggesteurOutput() {
    const sg = this.suggesteur;
    if (!sg || sg.chunksTotalLen === 0) return '';
    if (sg.dirty) {
      sg.joinedCache = sg.chunks.join('');
      sg.dirty = false;
    }
    return sg.joinedCache;
  }

  _processSuggestQueue() {
    if (this.suggestBusy || this.suggestQueue.length === 0) return;
    if (!this.suggesteur || !this.suggesteur.pty || !this.suggesteur.ready) return;

    this.suggestBusy = true;
    const { workerId, output } = this.suggestQueue.shift();
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
    const done = (suggestion) => {
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

  dismissSuggestion(workerId) {
    delete this.suggestions[workerId];
  }

  getSuggestion(workerId) {
    return this.suggestions[workerId] || null;
  }

  getStatus() {
    return this.slots.map((slot, i) => ({
      id: i,
      pid: slot.pty ? slot.pty.pid : null,
      alive: !!slot.pty,
      startedAt: slot.startedAt,
      role: (i === 0 && !this.noPilot) ? 'pilot' : 'worker',
      suggestion: this.suggestions[i] || null,
    }));
  }
}

module.exports = { PtyManager, writePilotPrompt, ANSI_RE, MAX_BUFFER, PILOT_PROMPT_FILE };
