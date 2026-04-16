import { launched, noPilot, workerCount, expandedIndex, focusedIndex, terminals } from './state';
import { setFocused, toggleExpand } from './terminal';
import { toggleTerminalSearch, closeTerminalSearch, searchVisible, toggleGlobalSearch } from './search';
import { toggleZen } from './preview';

export function handleGlobalKeydown(e: KeyboardEvent): void {
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
    if (searchVisible >= 0) { closeTerminalSearch(); return; }
    if (expandedIndex >= 0) { toggleExpand(expandedIndex); return; }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
    e.preventDefault();
    const idx = parseInt(e.key, 10) - 1;
    const totalTerminals = noPilot ? workerCount : 1 + workerCount;
    if (idx < totalTerminals && launched) setFocused(idx);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === ']' || e.key === '[')) {
    e.preventDefault();
    if (!launched) return;
    const totalTerminals = noPilot ? workerCount : 1 + workerCount;
    if (e.key === ']') setFocused((focusedIndex + 1) % totalTerminals);
    else setFocused((focusedIndex - 1 + totalTerminals) % totalTerminals);
    return;
  }
}
