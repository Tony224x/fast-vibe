#!/usr/bin/env node
// Auto-restart wrapper for fast-vibe server
// Restarts the server on crash with exponential backoff

const { spawn, exec } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const MAX_DELAY = 30000;
const MIN_DELAY = 1000;
const HEALTHY_THRESHOLD = 60000; // if alive >60s, reset backoff
const PORT = process.env.PORT || 3333;
const NO_WINDOW = process.argv.includes('--no-window');

let delay = MIN_DELAY;
let child = null;
let stopping = false;
let windowOpened = false;

function ts() { return new Date().toISOString().slice(11, 23); }

function openAppWindow() {
  if (windowOpened || NO_WINDOW) return;
  windowOpened = true;

  const url = `http://localhost:${PORT}`;

  // Try Edge first (always on Windows), then Chrome, then default browser
  const browsers = process.platform === 'win32'
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

  function tryNext(i) {
    if (i >= browsers.length) return;
    exec(browsers[i], (err) => {
      if (err) tryNext(i + 1);
      else console.log(`[${ts()}] [supervisor] app window opened`);
    });
  }
  tryNext(0);
}

function start() {
  console.log(`[${ts()}] [supervisor] starting server.js (restart delay=${delay}ms)`);

  child = spawn(process.execPath, [SERVER], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  });

  const startedAt = Date.now();

  // Pipe stdout and detect ready message
  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    if (!windowOpened && data.toString().includes('running at')) {
      openAppWindow();
    }
  });

  child.on('exit', (code, signal) => {
    const uptime = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`[${ts()}] [supervisor] server exited code=${code} signal=${signal} uptime=${uptime}s`);

    if (stopping) {
      process.exit(0);
      return;
    }

    // Reset backoff if it was alive long enough
    if (Date.now() - startedAt > HEALTHY_THRESHOLD) {
      delay = MIN_DELAY;
    } else {
      delay = Math.min(delay * 2, MAX_DELAY);
    }

    console.log(`[${ts()}] [supervisor] restarting in ${delay}ms...`);
    setTimeout(start, delay);
  });
}

// Forward signals to child — stop cleanly, no restart
process.on('SIGINT', () => {
  stopping = true;
  console.log(`[${ts()}] [supervisor] SIGINT — shutting down`);
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  stopping = true;
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
});

start();
