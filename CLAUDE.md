# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**fast-vibe** — web-based terminal multiplexer: **1 Pilot + N Workers** AI coding instances in parallel, with a control API so the Pilot can orchestrate the Workers. Supports Claude Code and Kiro CLI engines, with an optional no-pilot mode.

## Architecture

```
Browser (localhost:3333)              Node.js Backend
┌──────────────────────────────┐     ┌─────────────────────┐
│  [📁 directory]  [Start]     │     │                     │
├──────────────────────────────┤     │  PTY 0 (pilot)      │
│  Pilot (term 0)              │◄──► │  PTY 1-N (workers)  │
├──────────┬───────────────────┤ WS  │                     │
│ Worker 1 │ Worker 2          │◄──► │  REST API:          │
├──────────┼───────────────────┤     │  /api/terminal/:id/ │
│ Worker 3 │ Worker 4          │     │    send, output     │
└──────────┴───────────────────┘     └─────────────────────┘
```

- **Engine selection**: Claude Code (`claude --dangerously-skip-permissions`) or Kiro CLI (`kiro-cli chat --trust-all-tools --tui`)
- **No-pilot mode**: all terminals are independent workers (no orchestrator)
- **Pilot controls Workers** via `curl` to the REST API (Claude engine only)
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
| `GET/POST /api/settings` | Get/set settings (workers, previewUrl, engine, noPilot) |
| `POST /api/launch` `{"cwd":"..."}` | Start terminals in directory |
| `POST /api/stop` | Kill all terminals |
| `POST /api/terminal/:id/send` `{"text":"..."}` | Send input to terminal |
| `GET /api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `POST /api/terminal/:id/compact` | Compact context |
| `POST /api/terminal/:id/clear` | Clear context |
| `GET /api/status` | Status of all terminals |

## Key Files

- `server.js` — Express + WebSocket + API routes, settings (engine, noPilot)
- `lib/pty-manager.js` — PTY lifecycle: spawn, attach, kill, sendInput, getOutput, engine-aware launch
- `public/app.js` — xterm.js terminals, WebSocket, launch bar logic, noPilot UI
- `public/index.html` — Pilot + Workers grid layout, settings modal (engine select, noPilot checkbox)
- `public/style.css` — Dark theme

## Constraints

- 3 npm deps only: express, ws, node-pty
- No frontend framework — vanilla JS + xterm.js via CDN
- Must work on Windows (ConPTY)
