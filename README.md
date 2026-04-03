# fast-vibe

Web-based terminal multiplexer that runs **1 pilot + N workers** AI coding instances in parallel, with a control API, live preview, and context management. Supports **Claude Code** and **Kiro CLI** engines.

```
┌────────────────────────────┬──────────────┬──────────┐
│  [📁 /path/to/project] [⚙]│  Preview URL │          │
├────────────────────────────┼──────────────┤  Status  │
│      PILOT (Claude/Kiro)   │              │  Panel   │
├─────────┬──────────────────┤    iframe     │ compact  │
│Worker 1 │ Worker 2         │    preview    │ clear    │
├─────────┼──────────────────┤              │          │
│Worker 3 │ Worker 4         │              │          │
└─────────┴──────────────────┴──────────────┴──────────┘
```

## Features

- **Multi-engine** — choose between Claude Code and Kiro CLI
- **Safe by default** — runs without permission bypass; enable Trust Mode in settings to skip prompts
- **WSL support** — launch CLI inside WSL from a Windows host (Run in WSL option)
- **Pilot + Workers** — 1 orchestrator dispatches tasks to N workers via REST API (Agent tool disabled, forced curl)
- **No-Pilot mode** — run N workers without an orchestrator (all terminals are independent workers)
- **Configurable workers** — 1 to 8 parallel instances (Settings modal)
- **Live preview** — iframe panel to see your app running alongside the terminals
- **Directory bookmarks** — save favorite project paths, persisted across restarts
- **Native folder picker** — OS file dialog to select project directory (WSL-aware)
- **Directory browser** — click the input to browse folders, navigate with `..`, select with checkmark
- **Zen mode** — `Ctrl+Shift+F` hides sidebar and launch bar for maximum terminal space
- **Native app mode** — `npm run app` opens a Chrome/Edge window without browser chrome
- **Context management** — compact/clear worker contexts via API or sidebar buttons
- **Auto-launch** — all terminals auto-start the selected CLI engine

## How it works

1. Open `http://localhost:3333`, click the directory input to browse folders
2. Configure engine (Claude/Kiro), worker count, no-pilot mode, and preview URL in **Settings** (⚙)
3. Click **Start** — spawns terminals with the selected engine
4. In pilot mode, the **pilot** controls workers via `curl` (Agent tool is disabled):

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

> Requires Node.js 18+ and one of:
> - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
> - [Kiro CLI](https://kiro.dev) (`kiro-cli`)
>
> On Windows, `node-pty` needs Visual Studio Build Tools.

## Usage

```bash
npm start        # Browser mode → http://localhost:3333
npm run app      # Native window (Chrome/Edge, no browser chrome)
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get settings (workers, previewUrl, engine, noPilot, trustMode, useWSL) |
| `POST` | `/api/settings` | Update settings `{"workers": 4, "engine": "kiro", "noPilot": true, "trustMode": false, "useWSL": true}` |
| `POST` | `/api/launch` | Start terminals `{"cwd": "/path", "workers": 4}` |
| `POST` | `/api/stop` | Stop all terminals |
| `POST` | `/api/terminal/:id/send` | Send text to terminal `{"text": "..."}` |
| `GET` | `/api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `POST` | `/api/terminal/:id/compact` | Compact worker context (keep summary) |
| `POST` | `/api/terminal/:id/clear` | Clear worker context (full reset) |
| `GET` | `/api/status` | Status of all terminals |
| `GET` | `/api/bookmarks` | List saved directory bookmarks |
| `POST` | `/api/bookmarks` | Add bookmark `{"path": "/my/project"}` |
| `DELETE` | `/api/bookmarks` | Remove bookmark `{"path": "/my/project"}` |
| `POST` | `/api/pick-folder` | Open native OS folder picker |
| `GET` | `/api/browse?path=...` | Directory browser suggestions |

### Engine modes

| Engine | Safe mode (default) | Trust mode | Pilot support |
|--------|---------------------|------------|---------------|
| `claude` | `claude` | `claude --dangerously-skip-permissions` | ✅ with system prompt |
| `kiro` | `kiro-cli chat --tui` | `kiro-cli chat --trust-all-tools --tui` | ❌ (use no-pilot mode) |

## Stack

- **Backend**: Node.js, Express, ws, node-pty
- **Frontend**: Vanilla JS, xterm.js (CDN), Outfit + General Sans fonts
- **3 npm dependencies**, no bundler

## License

MIT
