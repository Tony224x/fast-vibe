import {
  setState, terminals, focusedIndex, unreadTerminals, autoFocus, autoFollow,
  noPilot, workerCount, launched, launchTimestamp, suggestMode,
  lastUserInputAt, expandedIndex, textDecoder, TerminalEntry,
} from './state';
import { getXtermTheme } from './theme';
import { stripAnsi, postJson, debounce } from './utils';
import { notifyTaskDone } from './toast';
import { ICONS } from './icons';

// ── WebSocket Reconnect Backoff ──

const wsReconnectAttempts: Record<number, number> = {};

// Réinitialise les compteurs de retry. Appelé au stop pour ne pas pénaliser
// le prochain launch avec les attempts hérités d'une session précédente.
export function resetWsReconnectAttempts(index?: number): void {
  if (index == null) {
    for (const k of Object.keys(wsReconnectAttempts)) delete wsReconnectAttempts[Number(k)];
  } else {
    delete wsReconnectAttempts[index];
  }
}

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

// Drop the cached body dimensions on every terminal so the next fitAll
// always re-runs fitAddon.fit(). Use this after the DOM tree is rebuilt
// (space switch, ungroup, drop) — pane bodies may have moved between
// host and the offscreen store, and the cached size is meaningless until
// they're laid out in their new parent.
export function invalidateFitCache(): void {
  terminals.forEach((t) => {
    if (!t) return;
    t.lastBodyW = undefined;
    t.lastBodyH = undefined;
  });
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
//
// Patterns testés UNIQUEMENT contre la dernière ligne non-vide du buffer
// strippé (cf. detectTaskDone). Évite les faux positifs sur du texte qui
// contient `❯` au milieu (commentaire de code, output Kiro intermédiaire,
// ANSI mal strippée).
const DONE_PATTERNS: RegExp[] = [
  /^❯\s*$/,
  /^kiro>\s*$/i,
  /^\$\s*$/,
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
    // Extraction de la dernière ligne non-vide pour test strict (vs scan
    // global qui matchait au milieu du buffer).
    const lines = clean.split(/\n/);
    const lastLine = lines.reverse().find(l => l.trim().length > 0)?.trim() ?? '';
    if (!lastLine) return;
    for (const pat of DONE_PATTERNS) {
      if (pat.test(lastLine)) {
        const label = (index === 0 && !noPilot) ? 'Pilot' : (noPilot ? `Worker ${index + 1}` : `Worker ${index}`);
        notifyTaskDone(label);
        if (Date.now() - lastUserInputAt > 3000) setFocused(index);
        const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`) as HTMLElement | null;
        if (pane) {
          // Les panes n'ont plus de border (grille canvas-unifié) → on flashe
          // un ring inset vert. Reset à '' laisse le box-shadow .focused se réaffirmer.
          pane.style.boxShadow = 'inset 0 0 0 1.5px var(--success)';
          setTimeout(() => { pane.style.boxShadow = ''; }, 1500);
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

export function connectWebSocket(index: number, term: InstanceType<typeof Terminal>, signal?: AbortSignal): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?terminal=${index}`);

  ws.onmessage = (e: MessageEvent) => {
    if (signal?.aborted) return;
    const data = typeof e.data === 'string' ? e.data : textDecoder.decode(e.data);
    term.write(data);
    markReceiving(index, true);
    if (index !== focusedIndex) {
      unreadTerminals.add(index);
      updateUnreadUI(index, true);
    }
    if (autoFocus && index !== focusedIndex) detectTaskDone(index, data);
    // Follow mode: auto-scroll to bottom (only if globally enabled)
    const t = terminals[index];
    if (t && autoFollow && t.followMode) term.scrollToBottom();
  };
  ws.onopen = () => {
    // Reset le compteur de retry à chaque connexion réussie : un terminal
    // qui se reconnecte après un long down ne doit pas pénaliser le délai
    // suivant si la prochaine déconnexion est rapide.
    delete wsReconnectAttempts[index];
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    updatePaneDot(index, true);
  };
  ws.onclose = () => {
    updatePaneDot(index, false);
    if (!launched || signal?.aborted) return;
    const attempt = wsReconnectAttempts[index] || 0;
    const delay = Math.min(1500 * Math.pow(2, attempt), 30000);
    wsReconnectAttempts[index] = attempt + 1;
    term.write('\r\n\x1b[90m[Reconnecting...]\x1b[0m\r\n');
    setTimeout(() => {
      if (signal?.aborted) return;
      const t = terminals[index];
      if (t && launched) t.ws = connectWebSocket(index, term, signal);
    }, delay);
  };
  ws.onerror = () => {};

  // Si le terminal est détruit avant que la WS soit ouverte/utilisée, on
  // ferme proprement pour ne pas laisser une connexion orpheline qui
  // continuerait à tenter de reconnect.
  if (signal) {
    signal.addEventListener('abort', () => {
      try { ws.close(); } catch { /* already closed */ }
    }, { once: true });
  }

  return ws;
}

// ── Create Terminal ──

export function createTerminal(index: number): void {
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    cursorInactiveStyle: 'outline',
    fontSize: 13,
    // IBM Plex Mono — humaniste/chaleureuse, plus douce à lire que JetBrains
    // Mono (au goût d'Anthony). Chargée via Google Fonts dans index.html, en
    // phase avec --font-mono. Fallback Consolas (Windows). Aucune ligature
    // (alignement TUI box-drawing U+2500 préservé).
    fontFamily: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
    fontWeight: 400,
    fontWeightBold: 600,
    lineHeight: 1.3,
    letterSpacing: 0,            // MUST stay 0 — tout tracking cisaille le box-drawing U+2500
    minimumContrastRatio: 1,     // ne pas recolorer la chrome grise intentionnelle de Claude Code
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: true,
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

  // Renderer GPU avec fallback gracieux : WebGL → Canvas → DOM (built-in).
  // try/catch + onContextLoss protègent les sessions Windows/ConPTY/Intel-GPU/RDP
  // où un contexte WebGL peut échouer ou être perdu (sinon : pane blanche).
  let activeRenderer: 'webgl' | 'canvas' | 'dom' = 'dom';
  const loadCanvasFallback = (): void => {
    try {
      if (typeof CanvasAddon !== 'undefined') {
        term.loadAddon(new CanvasAddon.CanvasAddon());
        activeRenderer = 'canvas';
      }
    } catch { /* on garde le renderer DOM */ }
  };
  try {
    if (typeof WebglAddon !== 'undefined') {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* déjà disposé */ } loadCanvasFallback(); });
      term.loadAddon(webgl);
      activeRenderer = 'webgl';
    } else {
      loadCanvasFallback();
    }
  } catch {
    loadCanvasFallback();
  }

  requestAnimationFrame(() => fitAddon.fit());

  // AbortController qui sera abort() dans destroyTerminals : tous les
  // addEventListener attachés ci-dessous l'utilisent comme signal pour
  // s'auto-déconnecter d'un coup, sans nécessiter de tracker chaque
  // listener individuellement.
  const abortController = new AbortController();
  const signal = abortController.signal;

  // Scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'btn-scroll-bottom hidden';
  scrollBtn.innerHTML = ICONS.arrowDown;
  scrollBtn.title = 'Scroll to bottom (re-enables follow mode)';
  scrollBtn.addEventListener('click', () => {
    const t = terminals[index];
    if (t) t.followMode = true;
    term.scrollToBottom();
    scrollBtn.classList.add('hidden');
  }, { signal });
  container.appendChild(scrollBtn);

  term.onScroll(() => {
    const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
    const t = terminals[index];
    if (t) {
      if (atBottom) {
        t.followMode = true;
        scrollBtn.classList.add('hidden');
      } else {
        t.followMode = false;
        scrollBtn.classList.remove('hidden');
      }
    }
  });

  // Let Ctrl+1-8, Ctrl+[/], Ctrl+Shift+S, Ctrl+Shift+G bubble to document handler
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    // Ctrl/Cmd+K → laisse bulle au document handler pour ouvrir la command palette
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'k' || e.key === 'K')) return false;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') return false;
    if (e.ctrlKey && !e.shiftKey && (e.key === ']' || e.key === '[')) return false;
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 'G')) return false;
    // Ctrl+Enter → send literal \n for multiline input (Kiro CLI)
    if (e.ctrlKey && e.key === 'Enter' && e.type === 'keydown') {
      const t = terminals[index];
      if (t?.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'raw', data: '\n' }));
      return false;
    }
    return true;
  });

  const ws = connectWebSocket(index, term, signal);

  term.onData((data: string) => {
    const t = terminals[index];
    if (t && t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(data);
    setState('lastUserInputAt', Date.now());
  });

  container.addEventListener('mousedown', () => setFocused(index), { signal });
  terminals[index] = { term, fitAddon, searchAddon, ws, index, followMode: autoFollow, abortController, renderer: activeRenderer };
}
