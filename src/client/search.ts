import { terminals } from './state';
import { scheduleFitAll } from './terminal';

export let searchVisible = -1;

export function toggleTerminalSearch(index: number): void {
  if (searchVisible === index) {
    closeTerminalSearch();
    return;
  }
  closeTerminalSearch();
  const t = terminals[index];
  if (!t || !t.searchAddon) return;

  const pane = document.querySelector(`.terminal-pane[data-index="${index}"]`);
  if (!pane) return;

  const header = pane.querySelector('.pane-header')!;
  const bar = document.createElement('div');
  bar.className = 'search-bar';
  bar.id = 'search-bar-active';
  bar.innerHTML = `<input type="text" placeholder="Search..." spellcheck="false" autocomplete="off">
    <button data-action="prev" title="Previous">&#9650;</button>
    <button data-action="next" title="Next">&#9660;</button>
    <button data-action="close" title="Close">&#10005;</button>`;
  header.after(bar);

  const input = bar.querySelector('input')!;
  input.focus();
  input.addEventListener('input', () => { t.searchAddon!.findNext(input.value); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.shiftKey ? t.searchAddon!.findPrevious(input.value) : t.searchAddon!.findNext(input.value); }
    if (e.key === 'Escape') closeTerminalSearch();
  });
  bar.addEventListener('click', (e: Event) => {
    const action = (e.target as HTMLElement).dataset?.action;
    if (action === 'next') t.searchAddon!.findNext(input.value);
    else if (action === 'prev') t.searchAddon!.findPrevious(input.value);
    else if (action === 'close') closeTerminalSearch();
  });

  searchVisible = index;
  scheduleFitAll();
}

export function closeTerminalSearch(): void {
  const bar = document.getElementById('search-bar-active');
  if (bar) {
    const idx = searchVisible;
    bar.remove();
    if (terminals[idx]?.searchAddon) terminals[idx].searchAddon!.clearDecorations();
    scheduleFitAll();
  }
  searchVisible = -1;
}
