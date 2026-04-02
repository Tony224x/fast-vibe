# fast-vibe

Web-based terminal multiplexer that runs **1 pilot + 4 worker** Claude Code instances in parallel with a control API.

```
┌─────────────────────────────────────────┬──────────┐
│  [📁 /path/to/project]       [Start]   │          │
├─────────────────────────────────────────┤  Status  │
│           PILOT (Claude Code)           │  Panel   │
├───────────────┬─────────────────────────┤          │
│   Worker 1    │    Worker 2             │          │
├───────────────┼─────────────────────────┤          │
│   Worker 3    │    Worker 4             │          │
└───────────────┴─────────────────────────┴──────────┘
```

## How it works

1. Choose a project directory in the web interface
2. Click **Start** — spawns 5 terminals (1 pilot + 4 workers), each running `claude --dangerously-skip-permissions`
3. The **pilot** Claude Code can control workers via the REST API:

```bash
# Send a task to worker 2
curl -X POST http://localhost:3333/api/terminal/2/send \
  -H "Content-Type: application/json" \
  -d '{"text":"implement the auth module"}'

# Read worker 2 output (last 2000 chars)
curl http://localhost:3333/api/terminal/2/output?last=2000
```

## Install

```bash
git clone https://github.com/anthropics/fast-vibe.git
cd fast-vibe
npm install
```

> Requires Node.js 18+ and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed.

## Usage

```bash
npm start
# Open http://localhost:3333
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Status of all 5 terminals |
| `POST` | `/api/launch` | Start all terminals `{"cwd": "/path"}` |
| `POST` | `/api/stop` | Stop all terminals |
| `POST` | `/api/terminal/:id/send` | Send text to terminal `{"text": "..."}` |
| `GET` | `/api/terminal/:id/output?last=N` | Read last N chars of output |

## Stack

- **Backend**: Node.js, Express, ws, node-pty
- **Frontend**: Vanilla JS, xterm.js (CDN)
- **3 npm dependencies**, no bundler

## License

MIT
