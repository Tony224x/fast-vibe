import { launched, workerCount, expandedIndex, focusedIndex, terminals } from './state';
import { setFocused, toggleExpand } from './terminal';
import { toggleTerminalSearch, closeTerminalSearch, searchVisible, toggleGlobalSearch } from './search';
import { toggleZen } from './preview';
import { openHelp, closeHelp, isHelpOpen } from './help';
import { togglePalette, closePalette, isPaletteOpen } from './palette';

export function handleGlobalKeydown(e: KeyboardEvent): void {
  // Command palette (Ctrl/Cmd+K) — highest priority, works from anywhere.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (e.key === '?' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    if (isHelpOpen()) closeHelp();
    else openHelp();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    if (launched) toggleTerminalSearch(focusedIndex);
    else toggleZen();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'G') {
    e.preventDefault();
    if (launched) toggleGlobalSearch();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    const t = terminals[focusedIndex];
    if (t) {
      t.followMode = !t.followMode;
      if (t.followMode) t.term.scrollToBottom();
    }
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'B') {
    e.preventDefault();
    if (launched) document.getElementById('broadcast-input')?.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (isPaletteOpen()) { closePalette(); return; }
    if (isHelpOpen()) { closeHelp(); return; }
    if (searchVisible >= 0) { closeTerminalSearch(); return; }
    if (expandedIndex >= 0) { toggleExpand(expandedIndex); return; }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
    e.preventDefault();
    const idx = parseInt(e.key, 10) - 1;
    if (idx < workerCount && launched) setFocused(idx);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === ']' || e.key === '[')) {
    e.preventDefault();
    if (!launched) return;
    if (e.key === ']') setFocused((focusedIndex + 1) % workerCount);
    else setFocused((focusedIndex - 1 + workerCount) % workerCount);
    return;
  }
}
