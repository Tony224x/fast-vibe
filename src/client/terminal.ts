import {
  setState, terminals, focusedIndex, unreadTerminals, autoFocus,
  noPilot, workerCount, launched, launchTimestamp, suggestMode,
  lastUserInputAt, expandedIndex, textDecoder, TerminalEntry,
} from './state';
import { getXtermTheme } from './theme';
import { stripAnsi, postJson, debounce } from './utils';
import { notifyTaskDone } from './toast';

// ── Activity Indicator ──

export const receivingTimers: Record<number, ReturnType<typeof setTimeout>> = {};

export function markReceiving(index: number, active: boolean): void {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;
  const dot = pane.querySelector('.status-dot') as HTMLElement;
  if (active) {
    dot.classList.add('receiving');
    clearTimeout(receivingTimers[index]);
    receivingTimers[index] = setTimeout(() => { dot.classList.remove('receiving'); }, 800);
  } else {
    dot.classList.remove('receiving');
  }
}

// ── Unread Tracking ──

export function updateUnreadUI(index: number, hasUnread: boolean): void {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (pane) pane.querySelector('.pane-header')!.classList.toggle('has-unread', hasUnread);
  const card = document.querySelector(`.status-card[data-index="${index}"]`);
  if (card) card.classList.toggle('has-unread', hasUnread);
}

// ── Focus & Expand ──

export function setFocused(index: number): void {
  setState('focusedIndex', index);
  if (unreadTerminals.has(index)) {
    unreadTerminals.delete(index);
    updateUnreadUI(index, false);
  }
  document.querySelectorAll('.terminal-pane').forEach((p) => {
    p.classList.toggle('focused', parseInt((p as HTMLElement).dataset.index!, 10) === index);
  });
  document.querySelectorAll('.status-card').forEach((c) => {
    c.classList.toggle('active', parseInt((c as HTMLElement).dataset.index!, 10) === index);
  });
  terminals[index]?.term.focus();
}

export function toggleExpand(index: number): void {
  const el = document.getElementById('terminals')!;
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`) as HTMLElement;
  if (expandedIndex === index) {
    pane.classList.remove('expanded');
    el.classList.remove('has-expanded');
    setState('expandedIndex', -1);
  } else {
    if (expandedIndex >= 0) {
      document.querySelector(`.terminal-pane[data-index="${expandedIndex}"]`)?.classList.remove('expanded');
    }
    pane.classList.add('expanded');
    el.classList.add('has-expanded');
    setState('expandedIndex', index);
  }
  setFocused(index);
  scheduleFitAll();
}

// ── Fit ──

export function fitAll(): void {
  terminals.forEach((t) => {
    if (!t) return;
    const el = t.term.element;
    if (!el || el.offsetHeight === 0) return;
    const body = el.parentElement;
    if (body) {
      const w = body.clientWidth, h = body.clientHeight;
      if (w === t.lastBodyW && h === t.lastBodyH) return;
      t.lastBodyW = w;
      t.lastBodyH = h;
    }
    t.fitAddon.fit();
    const cols = t.term.cols, rows = t.term.rows;
    if (cols !== t.lastCols || rows !== t.lastRows) {
      t.lastCols = cols;
      t.lastRows = rows;
      if (t.ws && t.ws.readyState === WebSocket.OPEN) {
        t.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
  });
}

let fitAllRafPending = false;
export function fitAllRAF(): void {
  if (fitAllRafPending) return;
  fitAllRafPending = true;
  requestAnimationFrame(() => { fitAllRafPending = false; fitAll(); });
}

let fitAllTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleFitAll(ms = 50): void {
  if (fitAllTimer) return;
  fitAllTimer = setTimeout(() => { fitAllTimer = null; fitAll(); }, ms);
}

// ── Status Dot ──

export function updatePaneDot(index: number, alive: boolean): void {
  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;
  const dot = pane.querySelector('.status-dot') as HTMLElement;
  if (!dot.classList.contains('receiving')) {
    dot.className = `status-dot ${alive ? 'alive' : 'dead'}`;
  }
  pane.querySelector('.status-text')!.textContent = alive ? 'running' : 'stopped';
}

// ── Auto-focus on task completion ──

export const DONE_PATTERNS: RegExp[] = [
  /\u276f\s*$/m,
  /kiro>\s*$/im,
  /\$\s*$/m,
];

export const termActivity: Record<number, { timer: ReturnType<typeof setTimeout> | null; chunks: number; buffer: string }> = {};

export function detectTaskDone(index: number, data: string): void {
  if (!termActivity[index]) termActivity[index] = { timer: null, chunks: 0, buffer: '' };
  const act = termActivity[index];
  act.chunks++;
  act.buffer += data;
  if (act.buffer.length > 2000) act.buffer = act.buffer.slice(-2000);
  clearTimeout(act.timer!);

  act.timer = setTimeout(() => {
    if (act.chunks < 5) { act.chunks = 0; act.buffer = ''; return; }
    const clean = stripAnsi(act.buffer).trim();
    act.chunks = 0;
    act.buffer = '';
    for (const pat of DONE_PATTERNS) {
      if (pat.test(clean)) {
        const label = (index === 0 && !noPilot) ? 'Pilot' : (noPilot ? `Worker ${index + 1}` : `Worker ${index}`);
        notifyTaskDone(label);
        if (Date.now() - lastUserInputAt > 3000) setFocused(index);
        const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`) as HTMLElement | null;
        if (pane) {
          pane.style.borderColor = 'var(--green)';
          setTimeout(() => { pane.style.borderColor = ''; }, 1500);
        }
        if (suggestMode !== 'off' && Date.now() - launchTimestamp > 30000) {
          postJson(`/api/suggest/${index}`);
        }
        return;
      }
    }
  }, 1500);
}

// ── WebSocket ──

export function connectWebSocket(index: number, term: InstanceType<typeof Terminal>): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?terminal=${index}`);

  ws.onmessage = (e: MessageEvent) => {
    const data = typeof e.data === 'string' ? e.data : textDecoder.decode(e.data);
    term.write(data);
    markReceiving(index, true);
    if (index !== focusedIndex) {
      unreadTerminals.add(index);
      updateUnreadUI(index, true);
    }
    if (autoFocus && index !== focusedIndex) detectTaskDone(index, data);
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    updatePaneDot(index, true);
  };
  ws.onclose = () => {
    updatePaneDot(index, false);
    if (!launched) return;
    term.write('\r\n\x1b[90m[Reconnecting...]\x1b[0m\r\n');
    setTimeout(() => {
      const t = terminals[index];
      if (t && launched) t.ws = connectWebSocket(index, term);
    }, 1500);
  };
  ws.onerror = () => {};
  return ws;
}

// ── Create Terminal ──

export function createTerminal(index: number): void {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    theme: getXtermTheme(), allowProposedApi: true, scrollback: 5000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  let searchAddon: InstanceType<typeof SearchAddon.SearchAddon> | null = null;
  if (typeof SearchAddon !== 'undefined') {
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
  }

  const container = document.getElementById(`term-${index}`)!;
  term.open(container);
  requestAnimationFrame(() => fitAddon.fit());

  const ws = connectWebSocket(index, term);

  term.onData((data: string) => {
    const t = terminals[index];
    if (t && t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(data);
    setState('lastUserInputAt', Date.now());
  });

  container.addEventListener('mousedown', () => setFocused(index));
  terminals[index] = { term, fitAddon, searchAddon, ws, index };
}
