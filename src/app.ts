#!/usr/bin/env node
// Auto-restart wrapper for fast-vibe server
// Restarts the server on crash with exponential backoff

import { spawn, exec, execSync, ChildProcess } from 'child_process';
import path from 'path';

const SERVER: string = path.join(__dirname, 'server.js');
const MAX_DELAY: number = 30000;
const MIN_DELAY: number = 1000;
const HEALTHY_THRESHOLD: number = 60000;
const PORT: string | number = process.env.PORT || 3333;
const NO_WINDOW: boolean = process.argv.includes('--no-window');

let delay: number = MIN_DELAY;
let child: ChildProcess | null = null;
let stopping: boolean = false;
let windowOpened: boolean = false;

function ts(): string { return new Date().toISOString().slice(11, 23); }

function openAppWindow(): void {
  if (windowOpened || NO_WINDOW) return;
  windowOpened = true;

  const url = `http://localhost:${PORT}`;

  const browsers: string[] = process.platform === 'win32'
    ? [
        `start msedge --app="${url}" --new-window`,
        `start chrome --app="${url}" --new-window`,
        `start "" "${url}"`,
      ]
    : process.platform === 'darwin'
      ? [
          `open -a "Google Chrome" --args --app="${url}"`,
          `open "${url}"`,
        ]
      : [
          `google-chrome --app="${url}" 2>/dev/null`,
          `chromium --app="${url}" 2>/dev/null`,
          `xdg-open "${url}"`,
        ];

  function tryNext(i: number): void {
    if (i >= browsers.length) return;
    exec(browsers[i], (err) => {
      if (err) tryNext(i + 1);
      else console.log(`[${ts()}] [supervisor] app window opened`);
    });
  }
  tryNext(0);
}

function start(): void {
  console.log(`[${ts()}] [supervisor] starting server.js (restart delay=${delay}ms)`);

  child = spawn(process.execPath, [SERVER], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  });

  const startedAt: number = Date.now();

  child.stdout!.on('data', (data: Buffer) => {
    process.stdout.write(data);
    if (!windowOpened && data.toString().includes('running at')) {
      openAppWindow();
    }
  });

  child.on('exit', (code: number | null, signal: string | null) => {
    const uptime: string = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[${ts()}] [supervisor] server exited code=${code} signal=${signal} uptime=${uptime}s`);

    if (stopping) {
      process.exit(0);
      return;
    }

    if (Date.now() - startedAt > HEALTHY_THRESHOLD) {
      delay = MIN_DELAY;
    } else {
      delay = Math.min(delay * 2, MAX_DELAY);
    }

    console.log(`[${ts()}] [supervisor] restarting in ${delay}ms...`);
    setTimeout(start, delay);
  });
}

// Arrête le serveur enfant en garantissant qu'aucun process claude/cmd ne
// survit en orphelin.
//
// Windows : node traduit child.kill('SIGINT') en TerminateProcess — le serveur
// est tué brutalement, son handler `process.on('SIGINT', cleanup)` ne tourne
// PAS, et les arbres `cmd.exe → claude.exe` qu'il a spawné deviennent
// orphelins (fuite ~200 MB × N à chaque arrêt/restart superviseur). On tue donc
// tout l'arbre du child via `taskkill /T /F` tant qu'il est encore vivant pour
// pouvoir le walker. L'état de session est déjà persisté en continu côté serveur
// (.session-state.json sur chaque mutation), donc pas besoin d'arrêt gracieux.
//
// POSIX : SIGINT/SIGTERM sont délivrés proprement → cleanup() tourne et fait
// killAll(). On ajoute un SIGKILL de backstop si le child traîne au-delà du délai.
function shutdownChild(signal: NodeJS.Signals): void {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    try {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch { /* déjà mort, ou perms — le kill() ci-dessous couvrira */ }
    try { child.kill(); } catch { /* gone */ }
  } else {
    try { child.kill(signal); } catch { /* gone */ }
    // Backstop : si le serveur ne s'est pas arrêté après 2.5s, on force.
    setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } }, 2500).unref();
  }
}

process.on('SIGINT', () => {
  stopping = true;
  console.log(`[${ts()}] [supervisor] SIGINT — shutting down`);
  shutdownChild('SIGINT');
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  stopping = true;
  shutdownChild('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});

start();
