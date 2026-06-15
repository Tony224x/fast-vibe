# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**fast-vibe** — web-based terminal multiplexer: **N Workers** AI coding instances running in parallel, each a full independent CLI session, with a control API to drive them. Supports Claude Code and Kiro CLI engines.

## Architecture

```
Browser (localhost:3333)              Node.js Backend
┌──────────────────────────────┐     ┌─────────────────────┐
│  [📁 directory]  [Start]     │     │                     │
├──────────┬───────────────────┤     │  PTY 0..N-1         │
│ Worker 1 │ Worker 2          │◄──► │  (workers)          │
├──────────┼───────────────────┤ WS  │                     │
│ Worker 3 │ Worker 4          │◄──► │  REST API:          │
├──────────┼───────────────────┤     │  /api/terminal/:id/ │
│ Worker 5 │ Worker 6          │     │    send, output     │
└──────────┴───────────────────┘     └─────────────────────┘
```

- **Engine selection**: Claude Code (`claude --dangerously-skip-permissions`) or Kiro CLI (`kiro-cli chat --trust-all-tools --tui`)
- **All terminals are independent workers** (no orchestrator)
- **Worker cap**: up to `MAX_WORKERS` (8); a RAM warning shows past 6 live workers
- **Auto-compact**: idle Claude workers can auto-`/compact` after a configurable idle window (`autoCompactIdleMin`, Claude engine only)
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
| `GET/POST /api/settings` | Get/set settings (workers, previewUrl, engine, autoCompactIdleMin) |
| `POST /api/launch` `{"cwd":"..."}` | Start terminals in directory |
| `POST /api/stop` | Kill all terminals |
| `POST /api/terminal/:id/send` `{"text":"..."}` | Send input to terminal |
| `GET /api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `POST /api/terminal/:id/compact` | Compact context |
| `POST /api/terminal/:id/clear` | Clear context |
| `GET /api/status` | Status of all terminals |
| `POST /api/transcribe` | Multipart audio → text (proxy vers sidecar Python whisper) |
| `GET /api/transcribe/health` | Probe du sidecar whisper |

## Voice / dictée

Le voice utilise un sidecar Python `faster-whisper` (pas Web Speech API,
trop dépendant des serveurs Google et instable). Le browser enregistre via
MediaRecorder et POST le blob → server proxy → sidecar local → transcript.

```bash
# Setup une fois (premier lancement télécharge ~1.5GB de modèle)
pip install -r scripts/whisper_requirements.txt

# Lancer le sidecar (à garder ouvert pendant l'usage de fast-vibe)
python scripts/whisper_sidecar.py

# Env optionnel pour customiser :
#   FAST_VIBE_WHISPER_PORT (default 8765)
#   WHISPER_MODEL (tiny/base/small/medium/large-v3, default small)
#   WHISPER_DEVICE (cpu/cuda/auto, default auto)
#   WHISPER_LANGUAGE (default fr)
```

Hotkey : maintenir **Ctrl+Espace** pendant qu'on parle, relâcher → transcript
écrit directement dans l'input claude TUI de la pane focusée après ~1s
(via WS raw + bracketed-paste). L'user presse Enter pour submit. Pas de
bloc compose intermédiaire.

## Key Files

- `src/server.ts` — Express + WebSocket + API routes, settings (engine, autoCompactIdleMin)
- `src/pty-manager.ts` — PTY lifecycle: spawn, attach, kill, sendInput, getOutput, engine-aware launch, `MAX_WORKERS`, idle auto-compact sweep
- `src/client/*.ts` — xterm.js terminals, WebSocket, launch bar logic (bundled to `public/bundle.js`)
- `public/index.html` — Workers grid layout, settings modal (engine select, auto-compact)
- `public/style.css` — Dark theme

## Constraints

- 3 npm deps only: express, ws, node-pty
- No frontend framework — vanilla JS + xterm.js via CDN
- Must work on Windows (ConPTY)
