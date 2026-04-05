# fast-vibe v1.3.0

## Security Hardening

- **CSRF protection**: all POST/DELETE requests require `X-Requested-With: FastVibe` header; browsers block cross-origin custom headers without CORS preflight
- **WebSocket origin check** (CSWSH): rejects connections from origins other than localhost
- **XSS prevention**: `escapeHtml()` applied to all user-generated content (bookmarks, paths, labels, sidebar cards)
- **Subresource Integrity** (SRI): `integrity` + `crossorigin` attributes on CDN scripts (xterm, addon-fit)
- **Localhost-only binding**: server listens on `127.0.0.1` instead of `0.0.0.0`
- **Input validation**: stricter parseInt handling on settings, whitelisted enum values for theme/suggestMode

## Performance

- **Chunked buffer system**: replaces `string +=` concatenation with `chunks[]` array + lazy `.join()` with dirty flag — O(1) append instead of O(n)
- **WebSocket backpressure**: skips sending when `bufferedAmount > WS_HIGH_WATER` (128 KB)
- **Faster getOutput**: slices raw buffer first, then strips ANSI on the smaller substring (~25x less regex work)
- **Smarter fitAll**: skips terminals whose container size hasn't changed; `scheduleFitAll()` and `fitAllRAF()` debounce layout thrashing during resize
- **Tab-hidden optimization**: status polling and mini-map polling pause when browser tab is hidden
- **Async file I/O**: `fs.writeFile` (non-blocking) replaces `fs.writeFileSync` for settings, bookmarks, pilot prompt
- **Bookmarks cache**: in-memory cache avoids re-reading file on every GET
- **Shared TextDecoder**: single instance reused across all WebSocket messages

## UI Enhancements

- **Light theme** + **system theme**: dark/light/system toggle in settings; CSS custom properties swap, xterm theme updates live
- **Toast notifications**: non-blocking slide-in toasts for compact/clear/broadcast/task-done events
- **Browser notifications**: native `Notification` API when tab is hidden and a worker finishes
- **Terminal search**: `Ctrl+Shift+F` opens an inline search bar (xterm search addon) with prev/next/close
- **Broadcast**: sidebar input (`Ctrl+Shift+B`) to send text to all workers at once
- **Sidebar resize**: draggable handle to adjust sidebar width; collapses/expands with hide/show button
- **Welcome screen**: project quick-launch cards from bookmarks and last-used path
- **Mini-map**: 3-line output preview in each sidebar status card (polled every 5s)
- **Pane header actions**: compact / clear / restart buttons appear on hover
- **Inline confirm**: destructive actions (clear, stop) require double-click confirmation with 2s timeout
- **Unread tracking**: orange dot badge on unfocused terminals that received output
- **Activity pulse**: status dot animates when a terminal is actively receiving data
- **Drag & drop**: reorder sidebar status cards by dragging
- **Keyboard shortcuts**: `Ctrl+1-8` switch terminal, `Ctrl+]/[` next/prev, `Escape` close expanded/search
- **Enhanced tooltips**: CSS-only tooltips on launch bar buttons
- **Column-based worker grid**: workers arranged in columns instead of rows for better vertical space usage

## Auto-Suggest System

- **Static mode**: instant pattern matching against common prompts (y/n, errors, task completion) — zero latency
- **AI mode**: spawns a dedicated Claude Code "suggesteur" instance that analyzes worker output and proposes responses
- **Suggest bar**: appears in sidebar cards with send/edit/dismiss actions; editable inline before sending
- **Configurable**: off / static / ai toggle in settings

## Testing Infrastructure

- Jest + supertest dev dependencies
- `__tests__/` directory with server, pty-manager, and utils test suites
- `npm test` / `npm run test:ci` scripts
- Server module exports (`app`, `server`, `ptyManager`) for testability

## Other Improvements

- **Memory leak fix**: proper `.dispose()` on temporary `onData` listeners (launch detection, suggesteur)
- **Cross-platform newlines**: `\r` on Windows native, `\n` on WSL/Linux
- **Shared utilities**: `public/utils.js` extracts `debounce`, `escapeHtml`, `stripAnsi`, `elapsed`, `postJson`, `deleteJson`
- **Smarter auto-focus**: won't steal focus if user typed in the last 3 seconds
- **Suggest prompt**: `.suggest-prompt.md` system prompt for the AI suggesteur
- **Static patterns**: `lib/suggest-patterns.js` with 20+ patterns for permission prompts, errors, task completion

## Files Changed

| File | Changes |
|------|---------|
| `server.js` | CSRF middleware, WS origin check, suggest API, async writes, localhost binding, module exports |
| `lib/pty-manager.js` | Chunked buffers, WS backpressure, suggesteur system, listener disposal, cross-platform newlines |
| `public/app.js` | Theme system, search, broadcast, sidebar resize, welcome screen, mini-map, unread tracking, toasts, keyboard shortcuts, inline confirm |
| `public/index.html` | SRI attributes, search addon, sidebar resize handle, broadcast bar, welcome projects, theme/suggest settings, keyboard hints |
| `public/style.css` | Light theme, toast/search/suggest/broadcast/welcome styles, activity pulse, sidebar resize, column grid, drag & drop |
| `public/utils.js` | **New** — shared utilities (escapeHtml, stripAnsi, debounce, postJson, etc.) |
| `lib/suggest-patterns.js` | **New** — static suggestion pattern matching |
| `.suggest-prompt.md` | **New** — AI suggesteur system prompt |
| `jest.config.js` | **New** — test configuration |
| `__tests__/` | **New** — test suites |
| `package.json` | jest + supertest devDependencies, test scripts |
