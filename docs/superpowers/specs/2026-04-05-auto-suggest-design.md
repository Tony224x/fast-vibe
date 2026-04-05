# Auto-Suggest System Design

## Overview

System that proposes pre-filled responses when a worker finishes a task and is idle. Two modes:

- **static** — instant pattern matching on worker output (no AI, zero cost)
- **ai** — hidden Claude Code terminal analyzes output in background + static fallback while waiting

Configurable via `suggestMode` setting: `off` | `static` | `ai`.

## Architecture

```
Worker N finishes task (detectTaskDone)
    ↓
Frontend calls POST /api/suggest/:workerId
    ↓
Backend reads worker output (getOutput)
    ↓
┌──────────────────────────────────┐
│ Static: pattern match → instant  │──→ suggestion stored
│ AI: pattern match + queue to     │
│     suggesteur PTY               │──→ AI suggestion replaces static when ready
└──────────────────────────────────┘
    ↓
GET /api/status returns suggestions
    ↓
Frontend renders in sidebar under status card
```

## 1. Settings

New setting `suggestMode` with 3 values.

**Backend** (`server.js`):
- Add to `DEFAULTS`: `suggestMode: 'off'`
- Validate in `POST /api/settings`: must be `off`, `static`, or `ai`
- Pass to `ptyManager` so it knows whether to spawn the suggesteur

**Frontend** (`index.html` + `app.js`):
- New `<select>` in settings modal: Off / Static / AI
- Variable `suggestMode` loaded from settings

## 2. Static Suggestions (Pattern Matching)

Located in `lib/suggest-patterns.js`. Exported function `matchStaticSuggestion(output)` returns `{ text, confidence }` or `null`.

### Patterns (ordered by priority)

| Pattern | Suggestion | Confidence |
|---------|-----------|------------|
| `Do you want to (proceed\|continue)\?` | `yes` | high |
| `\(y\/n\)` or `\(Y\/N\)` or `\[y\/N\]` | `yes` | high |
| `Allow\|Approve\|Permit.*\?` | `yes` | high |
| `Error:.*\|error\[.*\]\|FAIL` + idle prompt | `fix this error` | medium |
| `test.*fail\|FAILED\|✗` + idle prompt | `fix the failing tests and run them again` | medium |
| `merge conflict` | `resolve the merge conflicts` | medium |
| Idle prompt `❯` after >30 chunks (long task) | `/compact` | low |
| Idle prompt `❯` with no recent error | (no suggestion) | — |

The function scans the last 3000 chars of stripped output. First match wins.

## 3. AI Suggestions (Suggesteur PTY)

### 3.1 Spawn

A hidden PTY slot managed by `PtyManager`:
- Property: `this.suggesteur = { pty, chunks, chunksTotalLen, ... }` (same shape as regular slots, no `ws`)
- Spawned in `launchAll()` when `suggestMode === 'ai'`
- Runs Claude Code with `--dangerously-skip-permissions` (or respects `trustMode`)
- System prompt loaded from `.suggest-prompt.md` via `--append-system-prompt-file`

### 3.2 System Prompt (`.suggest-prompt.md`)

```
You are a suggestion engine for a multi-terminal coding environment.
You receive the recent output of a Claude Code worker terminal.
Your job: suggest what the user should type next.

Rules:
- Reply with ONLY the suggested text, no explanation
- Keep it concise (1 sentence max)
- If the worker is asking a yes/no question, suggest "yes" or "no"
- If there's an error, suggest a fix command
- If the task seems complete, suggest "/compact"
- Prefix your answer with [SUGGEST] exactly
```

### 3.3 Request Flow

1. `POST /api/suggest/:workerId` triggers generation
2. Backend reads `getOutput(workerId, 3000)`
3. Static match runs immediately → stored as suggestion with `source: 'static'`
4. If `suggestMode === 'ai'`:
   - Add to `suggestQueue`
   - Process sequentially: send to suggesteur via `sendInput()`
   - Message: `"Worker ${id} output:\n${output}\n\nSuggest response."`
5. Poll suggesteur output for `[SUGGEST]` pattern (check every 500ms, timeout 30s)
6. When found, store suggestion with `source: 'ai'`, replacing any static one

### 3.4 Queue

- `this.suggestQueue = []` — array of `{ workerId, output }`
- `this.suggestBusy = false`
- Process one at a time; when done, shift next from queue
- If a workerId is already in queue, skip duplicate

### 3.5 Cleanup

- Suggesteur is killed with `killAll()`
- If suggesteur crashes, log and fall back to static-only for remaining session

## 4. API Changes

### New Endpoints

**`POST /api/suggest/:workerId`**
Triggers suggestion generation for the given worker.
- Reads worker output
- Runs static match
- Queues AI generation if mode is `ai`
- Returns `{ ok: true, suggestion: { text, source, pending } }` or `{ ok: true, suggestion: null }`

**`POST /api/suggest/:workerId/send`**
Sends the suggestion text to the worker terminal.
- Body: `{ text }` (optional override; if absent, sends stored suggestion)
- Calls `sendInput(workerId, text)`
- Clears the suggestion for that worker
- Returns `{ ok: true }`

**`POST /api/suggest/:workerId/dismiss`**
Clears the suggestion for the given worker.
- Returns `{ ok: true }`

### Modified Endpoint

**`GET /api/status`**
Add `suggestion` field to each terminal status:
```json
{
  "terminals": [
    {
      "id": 1,
      "alive": true,
      "suggestion": {
        "text": "yes",
        "source": "static",
        "pending": true
      }
    }
  ]
}
```

- `text`: the suggestion string
- `source`: `"static"` or `"ai"`
- `pending`: `true` if AI is still generating (static shown as placeholder)
- `null` if no suggestion

## 5. Frontend UI

### 5.1 Sidebar Suggestion Bar

Rendered inside `updateSidebar()`, below the actions div of each status card:

```html
<div class="suggest-bar" data-worker="1">
  <div class="suggest-text">yes</div>
  <div class="suggest-actions">
    <button class="btn-suggest-send" title="Send to worker">Send</button>
    <button class="btn-suggest-edit" title="Edit before sending">Edit</button>
    <button class="btn-suggest-dismiss" title="Dismiss">&times;</button>
  </div>
</div>
```

When "Edit" is clicked, `.suggest-text` becomes an `<input>` pre-filled with the suggestion.
When "Send" is clicked (or Enter in edit mode), calls `POST /api/suggest/:id/send`.

### 5.2 CSS

```css
.suggest-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 5px 8px;
  background: rgba(232, 96, 26, 0.08);
  border: 1px solid rgba(232, 96, 26, 0.2);
  border-radius: 6px;
  font-size: 11px;
}

.suggest-bar.pending { opacity: 0.6; }

.suggest-text {
  flex: 1;
  color: var(--fg-light);
  font-family: 'Cascadia Code', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-suggest-send {
  background: var(--primary);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 600;
}

.btn-suggest-edit,
.btn-suggest-dismiss {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 0 4px;
}
```

### 5.3 Trigger

In `detectTaskDone()`, after detecting task completion:
```javascript
if (suggestMode !== 'off') {
  postJson(`/api/suggest/${index}`);
}
```

The next `pollStatus()` cycle (2s) picks up the suggestion and renders it.

### 5.4 Pending State

When `suggestion.pending === true` (AI still working), show the static suggestion with a pulsing indicator and lower opacity. When the AI suggestion arrives on the next poll, it replaces the static one and removes the pending state.

## 6. Files to Create/Modify

| File | Action |
|------|--------|
| `lib/suggest-patterns.js` | **Create** — static pattern matching |
| `.suggest-prompt.md` | **Create** — system prompt for AI suggesteur |
| `lib/pty-manager.js` | **Modify** — add suggesteur spawn/kill, suggestion storage, queue |
| `server.js` | **Modify** — add suggest endpoints, suggestMode setting, status response |
| `public/app.js` | **Modify** — trigger suggest on task done, render sidebar UI, send/edit/dismiss |
| `public/style.css` | **Modify** — add suggest-bar styles |
| `public/index.html` | **Modify** — add suggestMode select in settings modal |

## 7. Edge Cases

- **Suggesteur crashes**: fall back to static-only, log warning
- **Worker output too large**: truncate to last 3000 chars
- **AI timeout**: 30s max, then keep static suggestion, clear pending
- **User types before suggestion**: suggestion is stale, dismissed on next `detectTaskDone` for same worker
- **Multiple workers finish simultaneously**: queue processes sequentially, each gets static immediately
- **Suggesteur busy with previous request**: new request queued, duplicates deduped
- **Session stop**: `killAll()` kills suggesteur too, all suggestions cleared
