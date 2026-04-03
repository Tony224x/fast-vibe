const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 50 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][0-9A-B]|\r/g;

// Write pilot system prompt to a file so it doesn't clutter the terminal
const PILOT_PROMPT_FILE = path.join(__dirname, '..', '.pilot-prompt.md');

function writePilotPrompt(workerCount) {
  const ids = Array.from({ length: workerCount }, (_, i) => i + 1).join(', ');
  fs.writeFileSync(PILOT_PROMPT_FILE, `You are the PILOT orchestrator. You have ${workerCount} EXTERNAL worker Claude Code instances (workers 1-${workerCount}) running in separate terminals. You MUST delegate work to them via a REST API.

## CRITICAL RULES

- NEVER use the Agent tool or launch subagents. You have REAL external workers for that.
- ALWAYS delegate parallelizable work to the external workers via curl commands below.
- You are the coordinator: break tasks, dispatch to workers, monitor, verify, report.
- Do NOT do the workers' job yourself. Your role is to orchestrate, not implement.

## COMMANDS (use via Bash tool)

Send a task to worker N (replace N with 1-${workerCount}):
curl -s -X POST http://localhost:3333/api/terminal/N/send -H "Content-Type: application/json" -d '{"text":"your detailed instruction here"}'

Read worker N output:
curl -s http://localhost:3333/api/terminal/N/output?last=5000

Check all statuses:
curl -s http://localhost:3333/api/status

Compact a worker's context (free memory, keep summary):
curl -s -X POST http://localhost:3333/api/terminal/N/compact

Clear a worker's context (full reset, start fresh):
curl -s -X POST http://localhost:3333/api/terminal/N/clear

## CONTEXT MANAGEMENT

Workers have limited context windows. You MUST manage their context:
- After a worker completes a task, ALWAYS compact it: curl -s -X POST http://localhost:3333/api/terminal/N/compact
- When switching to a completely different topic, clear instead: curl -s -X POST http://localhost:3333/api/terminal/N/clear
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
`);
}

// Write default prompt
writePilotPrompt(4);

class PtyManager {
  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
    this.engine = 'claude';
    this.noPilot = false;
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

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.useWSL ? undefined : workdir,
      env: process.env,
    });

    slot.pty = proc;
    slot.startedAt = new Date().toISOString();
    slot.buffer = '';

    proc.onData((data) => {
      slot.buffer += data;
      if (slot.buffer.length > MAX_BUFFER) {
        slot.buffer = slot.buffer.slice(-MAX_BUFFER);
      }
      if (slot.ws && slot.ws.readyState === 1) {
        slot.ws.send(data);
      }
    });

    // Auto-launch CLI — wait for shell prompt before sending command
    const launchCmd = (() => {
      const nl = '\n';
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
        proc.write(launchCmd);
      }
    };
    proc.onData(onData);

    // Fallback timeout in case prompt detection misses
    setTimeout(() => {
      if (!launched && slot.pty) {
        launched = true;
        proc.write(launchCmd);
      }
    }, 5000);

    proc.onExit(({ exitCode }) => {
      if (slot.pty === proc) {
        slot.pty = null;
      }
      if (slot.ws && slot.ws.readyState === 1) {
        slot.ws.send(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
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

    if (slot.buffer) {
      ws.send(slot.buffer);
    }

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
        slot.pty.write(msg);
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
      this.slots[index].pty.resize(cols, rows);
    }
  }

  restart(index) {
    this.kill(index);
    this.spawn(index, this.cwd);
    const slot = this.slots[index];
    if (slot.ws && slot.ws.readyState === 1 && slot.buffer) {
      slot.ws.send(slot.buffer);
    }
  }

  sendInput(index, text) {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    // Write text, then send Enter after a short delay
    // (Claude Code paste mode needs a separate Enter to submit)
    slot.pty.write(text);
    setTimeout(() => {
      if (slot.pty) slot.pty.write('\r');
    }, 100);
    return true;
  }

  // Send a slash command (e.g. /compact, /clear) — no paste delay needed
  sendCommand(index, command) {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    slot.pty.write(command + '\r');
    return true;
  }

  getOutput(index, lastN = 2000) {
    if (index >= this.slots.length) return '';
    const raw = this.slots[index].buffer || '';
    return raw.replace(ANSI_RE, '').slice(-lastN);
  }

  // Launch 1 pilot + N workers
  launchAll(cwd, workerCount = 4, opts = {}) {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.engine = opts.engine || 'claude';
    this.noPilot = !!opts.noPilot;
    this.trustMode = !!opts.trustMode;
    this.useWSL = !!opts.useWSL;
    this.count = this.noPilot ? workerCount : 1 + workerCount;

    // Rebuild slots array
    this.slots = Array.from({ length: this.count }, () => ({
      pty: null, ws: null, startedAt: null, buffer: '',
    }));

    // Update pilot prompt with correct worker count (only for claude with pilot)
    if (this.engine === 'claude' && !this.noPilot) {
      writePilotPrompt(workerCount);
    }

    for (let i = 0; i < this.count; i++) {
      this.spawn(i, this.cwd);
    }
  }

  kill(index) {
    if (index >= this.slots.length) return;
    const slot = this.slots[index];
    if (slot.pty) {
      slot.pty.kill();
      slot.pty = null;
    }
    slot.startedAt = null;
    slot.buffer = '';
  }

  killAll() {
    for (let i = 0; i < this.slots.length; i++) {
      this.kill(i);
    }
  }

  getStatus() {
    return this.slots.map((slot, i) => ({
      id: i,
      pid: slot.pty ? slot.pty.pid : null,
      alive: !!slot.pty,
      startedAt: slot.startedAt,
      role: (i === 0 && !this.noPilot) ? 'pilot' : 'worker',
    }));
  }
}

module.exports = { PtyManager };
