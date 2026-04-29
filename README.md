# fast-vibe

Web-based terminal multiplexer that runs **1 pilot + N workers** AI coding instances in parallel, with a control API, drag-to-split layout, spaces/groups, live preview, and context management. Supports **Claude Code** and **Kiro CLI** engines.

```
┌──────────┬─────────────────────────────────────┬──────────┐
│  Spaces  │  [📁 /path/to/project]  [⚙] [Start] │          │
│ ──────── ├─────────────────────────────────────┤  Status  │
│ Default  │       PILOT (Claude / Kiro)         │   Panel  │
│ Group A  ├──────────────┬──────────────────────┤  compact │
│ Group B  │   Worker 1   │   Worker 2 / Tab     │  clear   │
│   +      ├──────────────┼──────────────────────┤  verify  │
│          │   Worker 3   │   Worker 4   │ ⋯ │   │  copy    │
└──────────┴──────────────┴──────────────┴──────┴──────────┘
                ▲ drag pane header onto another pane
                  to split (top/right/bottom/left)
                  or drop center to stack as tabs
```

## Features

### Layout & spaces (3.0)

- **Layout tree** — panes, splits, tab stacks and groups. Drag a pane header onto another to split in 4 directions or drop on the center to stack as tabs.
- **Spaces sidebar** — `Default` plus per-group spaces. Switch contexts, broadcast input across a group, ungroup at any time.
- **Groups** — Ctrl-click multiple pane headers to multi-select, then wrap them with the floating Group button. Renamable, collapsible, broadcast-capable.
- **Dynamic workers** — spawn or delete workers at runtime; pane indices stay stable via slot tombstoning.
- **Balanced grid** — new panes integrate into a balanced 2-col topology; one-click **Rebalance** rebuilds the topology from scratch.
- **Overflow menu** — secondary actions collapse into a `⋯` popover when a pane is narrower than ~380px (container queries).
- **Persisted layout** — saved automatically via `/api/layout`.

### Engines & runtime

- **Multi-engine** — Claude Code or Kiro CLI.
- **Safe by default** — runs without permission bypass; enable Trust Mode in settings to skip prompts.
- **WSL support** — launch CLI inside WSL from a Windows host.
- **Pilot + Workers** — 1 orchestrator dispatches tasks to N workers via REST API (Agent tool disabled, forced curl).
- **No-Pilot mode** — N independent workers, no orchestrator.

### UX

- **Help modal** (`?`) — quick guide for layout, groups, pane actions and shortcuts.
- **Profiles** — save/load named presets of settings + cwd.
- **Live preview** — iframe panel alongside the terminals.
- **Directory bookmarks** — favorite paths persisted across restarts.
- **Native folder picker** + **directory browser** with WSL-aware path handling.
- **Zen mode** (`Ctrl+Shift+F`) — hide sidebar and launch bar.
- **Native app mode** — `npm run app` opens a Chrome/Edge window without browser chrome.
- **Auto-focus** — switch focus to the terminal that just finished its task (configurable).
- **Auto-follow** — opt-in forced auto-scroll (off by default).
- **Themes** — dark / light / system.
- **Search** — `Ctrl+Shift+F` searches the focused terminal buffer.
- **Suggest mode** — off / static / AI suggestions next to a worker.
- **Persistent settings** — last project path, layout, profiles all saved across restarts.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `?` | Open help |
| `Ctrl+Shift+F` | Toggle Zen mode |
| `Ctrl+Shift+B` | Broadcast to focused group |
| `Ctrl+Shift+G` | Group selected panes |
| `Ctrl+Shift+S` | Toggle sidebar |
| `Ctrl+1` … `Ctrl+8` | Switch focused terminal |
| `Ctrl+]` / `Ctrl+[` | Cycle focused terminal |
| `Esc` | Close modal / clear group selection / exit expanded |

## How it works

1. Open `http://localhost:3333`, click the directory input to browse folders.
2. Configure engine, worker count, no-pilot, trust mode, theme, etc. in **Settings** (⚙).
3. Click **Start** — spawns terminals with the selected engine.
4. Rearrange panes by dragging headers; spawn / delete workers at runtime.
5. In pilot mode, the **pilot** controls workers via `curl` (Agent tool is disabled):

```bash
# Send a task to worker 2
curl -s -X POST http://localhost:3333/api/terminal/2/send \
  -H "Content-Type: application/json" \
  -d '{"text":"implement the auth module"}'

# Read worker 2 output
curl -s http://localhost:3333/api/terminal/2/output?last=3000

# Compact / clear worker 2 context
curl -s -X POST http://localhost:3333/api/terminal/2/compact
curl -s -X POST http://localhost:3333/api/terminal/2/clear

# Spawn a new worker, or remove one
curl -s -X POST   http://localhost:3333/api/terminal/spawn
curl -s -X DELETE http://localhost:3333/api/terminal/3
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
npm start        # Build + serve → http://localhost:3333
npm run dev      # Dev mode (TS watch)
npm test         # Jest test suite
npm run typecheck
```

## API

### Settings & lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Read settings |
| `POST` | `/api/settings` | Update settings (`workers`, `previewUrl`, `engine`, `noPilot`, `trustMode`, `useWSL`, `autoFocus`, `autoFollow`, `theme`, `suggestMode`, `logsEnabled`) |
| `POST` | `/api/launch` | Start terminals `{"cwd":"/path","workers":4}` |
| `POST` | `/api/stop` | Stop all terminals |
| `GET` | `/api/status` | Status of all terminals |

### Terminal control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/terminal/spawn` | Spawn a new worker, returns `{index}` |
| `DELETE` | `/api/terminal/:id` | Remove a worker (pilot is protected in pilot mode) |
| `POST` | `/api/terminal/:id/send` | Send text `{"text":"..."}` |
| `GET` | `/api/terminal/:id/output?last=N` | Read last N chars (ANSI stripped) |
| `POST` | `/api/terminal/:id/compact` | Compact context (keep summary) |
| `POST` | `/api/terminal/:id/clear` | Clear context (full reset) |
| `POST` | `/api/batch/compact` | Compact all workers |
| `POST` | `/api/batch/clear` | Clear all workers |

### Layout, profiles, search

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/layout` | Read saved layout tree |
| `POST` | `/api/layout` | Save layout `{"layout": ... }` (or `null` to clear) |
| `GET` | `/api/profiles` | List profiles |
| `POST` | `/api/profiles` | Save profile `{"name":"...","settings":{...,"cwd":"..."}}` |
| `DELETE` | `/api/profiles` | Delete profile `{"name":"..."}` |
| `GET` | `/api/search?q=...&id=N` | Search terminal buffer |

### Suggestions (AI / static)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/suggest/:workerId` | Request a suggestion |
| `POST` | `/api/suggest/:workerId/send` | Accept and send |
| `POST` | `/api/suggest/:workerId/dismiss` | Dismiss |

### Bookmarks & filesystem

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/bookmarks` | List bookmarks |
| `POST` | `/api/bookmarks` | Add `{"path":"/my/project"}` |
| `DELETE` | `/api/bookmarks` | Remove `{"path":"/my/project"}` |
| `POST` | `/api/pick-folder` | Native OS folder picker |
| `GET` | `/api/browse?path=...` | Directory browser suggestions |

### Engine modes

| Engine | Safe mode (default) | Trust mode | Pilot support |
|--------|---------------------|------------|---------------|
| `claude` | `claude` | `claude --dangerously-skip-permissions` | ✅ with system prompt |
| `kiro` | `kiro-cli chat --tui` | `kiro-cli chat --trust-all-tools --tui` | ❌ (use no-pilot mode) |

## Stack

- **Backend** — Node.js, Express, ws, node-pty (TypeScript, compiled with `tsc`)
- **Frontend** — Vanilla TS bundled with esbuild, xterm.js (CDN), Outfit + General Sans fonts
- **Tests** — Jest + supertest
- **3 runtime npm dependencies**, no UI framework

## License

MIT
