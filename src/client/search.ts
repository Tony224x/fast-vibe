import { terminals } from './state';
import { scheduleFitAll, setFocused } from './terminal';
import { escapeHtml, debounce } from './utils';

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


export function toggleGlobalSearch(): void {
  const container = document.getElementById('terminals')!;
  const existing = document.getElementById('global-search-bar');
  if (existing) {
    existing.remove();
    scheduleFitAll();
    return;
  }
  const bar = document.createElement('div');
  bar.id = 'global-search-bar';
  bar.className = 'global-search-bar';
  bar.innerHTML = `<input type="text" placeholder="Search all terminals..." spellcheck="false" autocomplete="off">
    <button data-action="close" title="Close">&#10005;</button>
    <div class="global-search-results"></div>`;
  container.insertBefore(bar, container.firstChild);

  const input = bar.querySelector('input')!;
  const results = bar.querySelector('.global-search-results')!;
  input.focus();

  const doSearch = debounce(async () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&last=5000`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        results.innerHTML = '<div class="gs-empty">No matches</div>';
        return;
      }
      results.innerHTML = data.results.map((r: { terminal: number; role: string; matches: string[] }) =>
        `<div class="gs-group" data-index="${r.terminal}">
          <div class="gs-header">${escapeHtml(r.role)} #${r.terminal}</div>
          ${r.matches.slice(0, 3).map((m: string) => `<div class="gs-match">${escapeHtml(m)}</div>`).join('')}
        </div>`
      ).join('');
    } catch { results.innerHTML = '<div class="gs-empty">Search error</div>'; }
  }, 300);
  input.addEventListener('input', doSearch);

  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleGlobalSearch(); });

  bar.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.action === 'close') { toggleGlobalSearch(); return; }
    const group = target.closest('.gs-group') as HTMLElement | null;
    if (group) { setFocused(parseInt(group.dataset.index!, 10)); toggleGlobalSearch(); }
  });

  scheduleFitAll();
}
