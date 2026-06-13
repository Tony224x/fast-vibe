// ────────────────────────────────────────────────────────────
// Command palette (Ctrl/Cmd+K) — the universal action surface + pane
// switcher. Vanilla, no dep. Registry rebuilt on every open so the PANES
// section and launched-gated actions stay live. Run handlers read
// focusedIndex/terminals lazily at invocation time.
// ────────────────────────────────────────────────────────────

import {
  launched, noPilot, workerCount, focusedIndex, theme, terminals, unreadTerminals, setState,
} from './state';
import { setFocused, toggleExpand } from './terminal';
import {
  compactTerminal, clearTerminal, restartTerminal,
  verifyTerminal, copyOutput, nextStepsTerminal,
} from './ui-helpers';
import { togglePreview, toggleZen, toggleSidebar } from './preview';
import { toggleTerminalSearch, toggleGlobalSearch } from './search';
import { openSettings } from './settings';
import { openHelp } from './help';
import { launchSession, stopSession } from './session';
import { applyTheme } from './theme';
import { postJson, escapeHtml } from './utils';
import { ICONS } from './icons';
import { showToast } from './toast';

interface PaletteCommand {
  id: string;
  section: string;
  label: string;
  hint?: string;          // right-aligned, e.g. a keyboard shortcut
  keywords?: string;      // extra search terms (not shown)
  icon?: string;          // inline SVG string
  dotColor?: string;      // PANES rows show a status dot instead of an icon
  run: () => void;
}

interface Scored { cmd: PaletteCommand; positions: number[]; }

// ── DOM + state ──

let overlay: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let open = false;
let registry: PaletteCommand[] = [];
let filtered: Scored[] = [];
let selected = 0;
let lastFocusBeforeOpen: HTMLElement | null = null;

// ── Registry ──

function paneLabel(i: number): string {
  if (!noPilot && i === 0) return 'Pilot';
  return `Worker ${noPilot ? i + 1 : i}`;
}

function paneDotColor(i: number): string {
  if (unreadTerminals.has(i)) return 'var(--brand)';
  const dot = document.querySelector(`.terminal-pane[data-index="${i}"] .status-dot`);
  if (dot?.classList.contains('dead')) return 'var(--danger)';
  if (dot?.classList.contains('receiving')) return 'var(--brand)';
  if (dot?.classList.contains('alive')) return 'var(--success)';
  return 'var(--fg-faint)';
}

function buildRegistry(): PaletteCommand[] {
  const cmds: PaletteCommand[] = [];
  const total = noPilot ? workerCount : 1 + workerCount;

  // PANES — jump-to, first so a blind Ctrl+K → Enter lands on a sane pane.
  if (launched) {
    for (let i = 0; i < total; i++) {
      cmds.push({
        id: `pane-${i}`, section: 'Panes', label: `Go to ${paneLabel(i)}`,
        hint: i < 8 ? `Ctrl ${i + 1}` : undefined, keywords: `terminal switch jump ${i + 1}`,
        dotColor: paneDotColor(i), run: () => setFocused(i),
      });
    }
  }

  // FOCUSED PANE — verbs on the active terminal (read focusedIndex lazily).
  if (launched) {
    const on = () => paneLabel(focusedIndex);
    cmds.push(
      { id: 'expand', section: 'Focused pane', label: 'Expand / collapse pane', hint: 'dbl-click', icon: ICONS.expand, keywords: 'fullscreen zoom maximize', run: () => toggleExpand(focusedIndex) },
      { id: 'search-pane', section: 'Focused pane', label: 'Search in pane', hint: 'Ctrl ⇧ F', icon: ICONS.search, keywords: 'find', run: () => toggleTerminalSearch(focusedIndex) },
      { id: 'verify', section: 'Focused pane', label: 'Verify (code review)', icon: ICONS.check, keywords: 'review check qa', run: () => verifyTerminal(focusedIndex) },
      { id: 'next-steps', section: 'Focused pane', label: 'Suggest next steps', icon: ICONS.sparkles, keywords: 'ideas plan', run: () => nextStepsTerminal(focusedIndex) },
      { id: 'copy', section: 'Focused pane', label: 'Copy output', icon: ICONS.copy, keywords: 'clipboard', run: () => copyOutput(focusedIndex) },
      { id: 'compact', section: 'Focused pane', label: 'Compact context', icon: ICONS.layers, keywords: 'tokens summarize', run: () => compactTerminal(focusedIndex) },
      { id: 'clear', section: 'Focused pane', label: 'Clear context', icon: ICONS.eraser, keywords: 'reset wipe', run: () => clearTerminal(focusedIndex) },
      { id: 'restart', section: 'Focused pane', label: 'Restart pane', icon: ICONS.refresh, keywords: 'relaunch reload', run: () => restartTerminal(focusedIndex) },
    );
    void on;
  }

  // LAYOUT / SESSION.
  if (launched) {
    cmds.push(
      { id: 'global-search', section: 'Layout & session', label: 'Search all panes', hint: 'Ctrl ⇧ G', icon: ICONS.search, keywords: 'find grep everywhere', run: () => toggleGlobalSearch() },
      { id: 'broadcast', section: 'Layout & session', label: 'Broadcast to all workers', hint: 'Ctrl ⇧ B', icon: ICONS.send, keywords: 'send all message', run: () => (document.getElementById('broadcast-input') as HTMLInputElement | null)?.focus() },
    );
  }
  cmds.push(
    { id: 'preview', section: 'Layout & session', label: 'Toggle preview panel', icon: ICONS.monitor, keywords: 'browser iframe web', run: () => togglePreview() },
    { id: 'sidebar', section: 'Layout & session', label: 'Toggle sidebar', icon: ICONS.columns, keywords: 'spaces hide show', run: () => toggleSidebar() },
    { id: 'zen', section: 'Layout & session', label: 'Toggle Zen mode', hint: 'Ctrl ⇧ F', icon: ICONS.zap, keywords: 'focus distraction fullscreen', run: () => toggleZen() },
    { id: 'theme', section: 'Layout & session', label: `Switch theme (now: ${theme})`, icon: ICONS.moon, keywords: 'dark light system color appearance', run: cycleTheme },
    { id: 'settings', section: 'Layout & session', label: 'Open settings', icon: ICONS.settings, keywords: 'preferences config workers engine', run: () => openSettings() },
    { id: 'help', section: 'Layout & session', label: 'Open quick guide', hint: '?', icon: ICONS.messageSquare, keywords: 'shortcuts documentation', run: () => openHelp() },
  );
  if (!launched) {
    cmds.push({ id: 'start', section: 'Session', label: 'Start session', icon: ICONS.plus, keywords: 'launch run begin', run: () => launchSession() });
  } else {
    cmds.push({ id: 'stop', section: 'Session', label: 'Stop session', icon: ICONS.x, keywords: 'kill end quit', run: () => stopSession() });
  }

  return cmds;
}

function cycleTheme(): void {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  setState('theme', next);
  applyTheme();
  postJson('/api/settings', { theme: next }).catch(() => {});
  showToast(`Theme: ${next}`);
}

// ── Fuzzy subsequence scorer (returns matched positions, or null) ──
// Each query char must appear in order. Rewards contiguous runs, word
// boundaries, and prefixes — VSCode/Codex-palette feel.

function fuzzy(query: string, target: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let score = 0, ti = 0, run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (let k = ti; k < t.length; k++) { if (t[k] === q[qi]) { found = k; break; } }
    if (found === -1) return null;
    positions.push(found);
    const atBoundary = found === 0 || /[\s\-_/(]/.test(t[found - 1]);
    score += 1;
    if (found === ti && qi > 0) { run += 1; score += run * 2; } else { run = 0; }
    if (atBoundary) score += 3;
    if (found === qi) score += 2;
    if (qi === 0 && found === 0) score += 6;
    ti = found + 1;
  }
  return { score, positions };
}

// ── Render ──

function highlight(label: string, positions: number[]): string {
  if (!positions.length) return escapeHtml(label);
  const mark = new Set(positions);
  let out = '';
  for (let i = 0; i < label.length; i++) {
    const ch = escapeHtml(label[i]);
    out += mark.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return out;
}

function render(): void {
  if (!listEl) return;
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="palette-empty">No matching command</div>`;
    return;
  }
  const showSections = (inputEl?.value.trim() ?? '') === '';
  let lastSection = '';
  listEl.innerHTML = filtered.map((s, i) => {
    const c = s.cmd;
    let head = '';
    if (showSections && c.section !== lastSection) {
      lastSection = c.section;
      head = `<div class="palette-section">${escapeHtml(c.section)}</div>`;
    }
    const glyph = c.dotColor
      ? `<span class="palette-dot" style="background:${c.dotColor}"></span>`
      : (c.icon ?? ICONS.empty);
    return head + (
      `<div class="palette-item${i === selected ? ' selected' : ''}" role="option" data-i="${i}" aria-selected="${i === selected}">` +
        `<span class="palette-icon">${glyph}</span>` +
        `<span class="palette-label">${highlight(c.label, s.positions)}</span>` +
        (c.hint ? `<kbd>${escapeHtml(c.hint)}</kbd>` : '') +
      `</div>`
    );
  }).join('');
  (listEl.querySelector('.palette-item.selected') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
}

function refilter(): void {
  const q = inputEl?.value.trim() ?? '';
  if (!q) {
    filtered = registry.map(cmd => ({ cmd, positions: [] }));
  } else {
    filtered = registry
      .map(cmd => {
        const onLabel = fuzzy(q, cmd.label);
        const onAll = fuzzy(q, `${cmd.label} ${cmd.keywords ?? ''} ${cmd.section}`);
        if (onLabel) return { cmd, positions: onLabel.positions, score: onLabel.score + 4 };
        if (onAll) return { cmd, positions: [], score: onAll.score };
        return null;
      })
      .filter((x): x is { cmd: PaletteCommand; positions: number[]; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .map(({ cmd, positions }) => ({ cmd, positions }));
  }
  selected = 0;
  render();
}

// ── Open / close ──

export function openPalette(): void {
  if (!overlay) initPalette();
  if (open) return;
  open = true;
  lastFocusBeforeOpen = document.activeElement as HTMLElement | null;
  registry = buildRegistry();
  overlay!.classList.remove('hidden');
  inputEl!.value = '';
  refilter();
  requestAnimationFrame(() => inputEl!.focus());
}

export function closePalette(): void {
  if (!open || !overlay) return;
  open = false;
  overlay.classList.add('hidden');
  if (lastFocusBeforeOpen && document.body.contains(lastFocusBeforeOpen)) lastFocusBeforeOpen.focus();
  else if (launched) setFocused(focusedIndex);
}

export function isPaletteOpen(): boolean { return open; }

export function togglePalette(): void {
  if (open) closePalette(); else openPalette();
}

function move(delta: number): void {
  if (!filtered.length) return;
  selected = (selected + delta + filtered.length) % filtered.length;
  render();
}

function runSelected(): void {
  const cmd = filtered[selected]?.cmd;
  if (!cmd) return;
  closePalette();
  // defer so the overlay teardown doesn't swallow focus from the action
  setTimeout(() => { try { cmd.run(); } catch (e) { showToast(`Command failed: ${(e as Error).message}`); } }, 0);
}

// ── Init (build DOM + listeners once) ──

export function initPalette(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'palette-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML =
    `<div id="palette" role="dialog" aria-label="Command palette">` +
      `<div id="palette-search">` +
        `<span id="palette-search-icon">${ICONS.search}</span>` +
        `<input id="palette-input" type="text" placeholder="Type a command or jump to a pane…" spellcheck="false" autocomplete="off" aria-label="Command">` +
      `</div>` +
      `<div id="palette-list" role="listbox"></div>` +
    `</div>`;
  document.body.appendChild(overlay);

  inputEl = overlay.querySelector('#palette-input') as HTMLInputElement;
  listEl = overlay.querySelector('#palette-list') as HTMLElement;

  inputEl.addEventListener('input', refilter);
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
    else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runSelected(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'Home') { e.preventDefault(); selected = 0; render(); }
    else if (e.key === 'End') { e.preventDefault(); selected = Math.max(0, filtered.length - 1); render(); }
  });

  listEl.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.palette-item') as HTMLElement | null;
    if (!item) return;
    selected = parseInt(item.dataset.i!, 10);
    runSelected();
  });
  listEl.addEventListener('mousemove', (e) => {
    const item = (e.target as HTMLElement).closest('.palette-item') as HTMLElement | null;
    if (!item) return;
    const i = parseInt(item.dataset.i!, 10);
    if (i !== selected) { selected = i; render(); }
  });

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
}
