# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**fast-vibe** — web-based terminal multiplexer: **1 Pilot + 4 Workers** Claude Code instances in parallel, with a control API so the Pilot can orchestrate the Workers.

## Architecture

```
Browser (localhost:3333)              Node.js Backend
┌──────────────────────────────┐     ┌─────────────────────┐
│  [📁 directory]  [Start]     │     │                     │
├──────────────────────────────┤     │  PTY 0 (pilot)      │
│  Pilot (term 0)              │◄──► │  PTY 1-4 (workers)  │
├──────────┬───────────────────┤ WS  │                     │
│ Worker 1 │ Worker 2          │◄──► │  REST API:          │
├──────────┼───────────────────┤     │  /api/terminal/:id/ │
│ Worker 3 │ Worker 4          │     │    send, output     │
└──────────┴───────────────────┘     └─────────────────────┘
```

- **Pilot controls Workers** via `curl` to the REST API from within its Claude Code session
- All terminals auto-launch `claude --dangerously-skip-permissions` with alias `c`
- Directory is chosen from the web UI before launching

## Commands

```bash
npm install    # Install deps (node-pty requires build tools on Windows)
npm start      # Start server at http://localhost:3333
npm run dev    # Dev mode with auto-reload
```

## API

| Endpoint | Description |
|----------|-------------|
| `POST /api/launch` `{"cwd":"..."}` | Start all 5 terminals in directory |
| `POST /api/stop` | Kill all terminals |
| `POST /api/terminal/:id/send` `{"text":"..."}` | Send input to terminal |
| `GET /api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `GET /api/status` | Status of all 5 terminals |

## Key Files

- `server.js` — Express + WebSocket + API routes
- `lib/pty-manager.js` — PTY lifecycle: spawn, attach, kill, sendInput, getOutput
- `public/app.js` — xterm.js terminals, WebSocket, launch bar logic
- `public/index.html` — Pilot + Workers grid layout
- `public/style.css` — Dark theme

## Constraints

- 3 npm deps only: express, ws, node-pty
- No frontend framework — vanilla JS + xterm.js via CDN
- Must work on Windows (ConPTY)
