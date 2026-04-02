const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 50 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][0-9A-B]|\r/g;

// Write pilot system prompt to a file so it doesn't clutter the terminal
const PILOT_PROMPT_FILE = path.join(__dirname, '..', '.pilot-prompt.md');

function writePilotPrompt(workerCount) {
  const ids = Array.from({ length: workerCount }, (_, i) => i + 1).join(', ');
  fs.writeFileSync(PILOT_PROMPT_FILE, `You are the PILOT orchestrator. You control ${workerCount} worker Claude Code instances (workers 1-${workerCount}) via a REST API on localhost:3333.

## COMMANDS TO CONTROL WORKERS

- Send a task to worker N:
  curl -s -X POST http://localhost:3333/api/terminal/N/send -H "Content-Type: application/json" -d '{"text":"your instruction here"}'

- Read worker N output (last 3000 chars, ANSI stripped):
  curl -s http://localhost:3333/api/terminal/N/output?last=3000

- Check all statuses:
  curl -s http://localhost:3333/api/status

## WORKFLOW

1. When the user gives you a task, break it into sub-tasks for the ${workerCount} workers
2. Send each sub-task to a different worker using the send API
3. Monitor progress by reading their output periodically
4. Verify the work quality by reading outputs and checking results
5. Report back to the user with a summary

You can also do work yourself directly. Use workers for parallelizable tasks.
Worker IDs are ${ids}. Always use curl via Bash to communicate with them.
`);
}

// Write default prompt
writePilotPrompt(4);

class PtyManager {
  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
  }

  spawn(index, cwd) {
    if (index >= this.slots.length) return null;
    const slot = this.slots[index];
    if (slot.pty) return slot.pty;

    const workdir = cwd || this.cwd;
    const shell = process.platform === 'win32'
      ? 'cmd.exe'
      : (process.env.SHELL || '/bin/bash');

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workdir,
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

    // Auto-launch claude
    setTimeout(() => {
      if (!slot.pty) return;
      const nl = process.platform === 'win32' ? '\r\n' : '\n';
      const alias = process.platform === 'win32'
        ? 'doskey c=claude --dangerously-skip-permissions $*'
        : 'alias c="claude --dangerously-skip-permissions"';

      let cmd = 'claude --dangerously-skip-permissions';
      if (index === 0) {
        const promptPath = PILOT_PROMPT_FILE.replace(/\\/g, '/');
        cmd = `claude --dangerously-skip-permissions --append-system-prompt-file "${promptPath}"`;
      }
      proc.write(alias + nl + cmd + nl);
    }, 500);

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
    const nl = process.platform === 'win32' ? '\r\n' : '\n';
    slot.pty.write(text + nl);
    return true;
  }

  getOutput(index, lastN = 2000) {
    if (index >= this.slots.length) return '';
    const raw = this.slots[index].buffer || '';
    return raw.replace(ANSI_RE, '').slice(-lastN);
  }

  // Launch 1 pilot + N workers
  launchAll(cwd, workerCount = 4) {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.count = 1 + workerCount; // pilot + workers

    // Rebuild slots array
    this.slots = Array.from({ length: this.count }, () => ({
      pty: null, ws: null, startedAt: null, buffer: '',
    }));

    // Update pilot prompt with correct worker count
    writePilotPrompt(workerCount);

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
      role: i === 0 ? 'pilot' : 'worker',
    }));
  }
}

module.exports = { PtyManager };
