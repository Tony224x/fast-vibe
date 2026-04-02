# fast-vibe

Web-based terminal multiplexer that runs **1 pilot + N workers** Claude Code instances in parallel, with a control API, live preview, and context management.

```
┌────────────────────────────┬──────────────┬──────────┐
│  [📁 /path/to/project] [⚙]│  Preview URL │          │
├────────────────────────────┼──────────────┤  Status  │
│      PILOT (Claude Code)   │              │  Panel   │
├─────────┬──────────────────┤    iframe     │ compact  │
│Worker 1 │ Worker 2         │    preview    │ clear    │
├─────────┼──────────────────┤              │          │
│Worker 3 │ Worker 4         │              │          │
└─────────┴──────────────────┴──────────────┴──────────┘
```

## Features

- **Pilot + Workers** — 1 orchestrator dispatches tasks to N workers via REST API (Agent tool disabled, forced curl)
- **Configurable workers** — 1 to 8 parallel instances (Settings modal)
- **Live preview** — iframe panel to see your app running alongside the terminals
- **Directory browser** — click the input to browse folders, navigate with `..`, select with checkmark
- **Context management** — compact/clear worker contexts via API or sidebar buttons
- **Auto-launch** — all terminals start `claude --dangerously-skip-permissions` with alias `c`
- **Kalira branding** — Outfit + General Sans fonts, orange theme, hexagonal grid background

## How it works

1. Open `http://localhost:3333`, click the directory input to browse folders
2. Configure worker count and preview URL in **Settings** (⚙)
3. Click **Start** — spawns 1 pilot + N workers, each running Claude Code
4. The **pilot** controls workers via `curl` (Agent tool is disabled):

```bash
# Send a task to worker 2
curl -s -X POST http://localhost:3333/api/terminal/2/send \
  -H "Content-Type: application/json" \
  -d '{"text":"implement the auth module"}'

# Read worker 2 output
curl -s http://localhost:3333/api/terminal/2/output?last=3000

# Compact worker 2 context after task completion
curl -s -X POST http://localhost:3333/api/terminal/2/compact

# Clear worker 2 context (full reset)
curl -s -X POST http://localhost:3333/api/terminal/2/clear
```

## Install

```bash
git clone <repo-url>
cd fast-vibe
npm install
```

> Requires Node.js 18+ and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed.
> On Windows, `node-pty` needs Visual Studio Build Tools.

## Usage

```bash
npm start
# Open http://localhost:3333
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get settings (workers, previewUrl) |
| `POST` | `/api/settings` | Update settings `{"workers": 4, "previewUrl": "..."}` |
| `POST` | `/api/launch` | Start terminals `{"cwd": "/path", "workers": 4}` |
| `POST` | `/api/stop` | Stop all terminals |
| `POST` | `/api/terminal/:id/send` | Send text to terminal `{"text": "..."}` |
| `GET` | `/api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `POST` | `/api/terminal/:id/compact` | Compact worker context (keep summary) |
| `POST` | `/api/terminal/:id/clear` | Clear worker context (full reset) |
| `GET` | `/api/status` | Status of all terminals |
| `GET` | `/api/browse?path=...` | Directory browser suggestions |

## Stack

- **Backend**: Node.js, Express, ws, node-pty
- **Frontend**: Vanilla JS, xterm.js (CDN), Outfit + General Sans fonts
- **3 npm dependencies**, no bundler

## License

MIT
