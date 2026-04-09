import { escapeHtml, debounce } from './utils';
import { launchSession } from './session';
import { updateBookmarkStar } from './bookmarks';
import { launched } from './state';

export function initAutocomplete(input: HTMLInputElement): void {
  const dropdown = document.getElementById('autocomplete')!;
  let selectedIdx = -1, items: Array<{name: string; path: string}> = [], currentDir = '';

  async function browse(pathVal?: string) {
    const query = pathVal || input.value.trim() || '';
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(query)}`);
      const data = await res.json();
      items = data.suggestions || [];
      currentDir = data.dir || '';
      selectedIdx = -1;
      render();
      dropdown.classList.remove('hidden');
    } catch { hide(); }
  }

  const browseLazy = debounce(() => browse(), 150);

  function render() {
    const parentPath = currentDir ? currentDir.replace(/[/\\][^/\\]*$/, '') : '';
    let html = '';

    if (currentDir && parentPath && parentPath !== currentDir) {
      html += `<div class="ac-item ac-parent" data-action="parent" data-path="${escapeHtml(parentPath)}">
        <span class="ac-icon">&#8617;</span>
        <span class="ac-name">..</span>
        <span class="ac-path">${escapeHtml(parentPath)}</span>
      </div>`;
    }

    if (currentDir) {
      html += `<div class="ac-item ac-current" data-action="select" data-path="${escapeHtml(currentDir)}">
        <span class="ac-icon">&#10003;</span>
        <span class="ac-name">Select this folder</span>
        <span class="ac-path">${escapeHtml(currentDir)}</span>
      </div>`;
    }

    html += items.map((item, i) => `
      <div class="ac-item ${i === selectedIdx ? 'selected' : ''}" data-action="enter" data-index="${i}">
        <span class="ac-icon">\u{1F4C1}</span>
        <span class="ac-name">${escapeHtml(item.name)}</span>
        <span class="ac-path">${escapeHtml(item.path)}</span>
      </div>
    `).join('');

    if (!items.length && currentDir) {
      html += `<div class="ac-item ac-empty"><span class="ac-icon">&#8709;</span><span class="ac-name">No subdirectories</span></div>`;
    }

    dropdown.innerHTML = html;
  }

  function hide() { dropdown.classList.add('hidden'); items = []; selectedIdx = -1; }

  function enterDir(idx: number) {
    if (idx >= 0 && idx < items.length) {
      const dir = items[idx].path;
      const sep = dir.includes('/') ? '/' : '\\';
      input.value = dir + sep;
      browse(dir);
    }
  }

  function selectDir(path: string) {
    input.value = path;
    hide();
    input.focus();
  }

  input.addEventListener('focus', () => { if (!launched) browse(); });
  input.addEventListener('click', () => { if (dropdown.classList.contains('hidden') && !launched) browse(); });
  input.addEventListener('input', () => { browseLazy(); updateBookmarkStar(); });

  input.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden')) {
      if (e.key === 'Enter') { launchSession(); return; }
      if (e.key === 'ArrowDown') { browse(); return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, -1); render(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (selectedIdx >= 0) enterDir(selectedIdx);
      else if (items.length > 0) enterDir(0);
    }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0) enterDir(selectedIdx);
      else { hide(); launchSession(); }
    }
    else if (e.key === 'Escape') { hide(); }
    else if (e.key === 'Backspace' && input.value.endsWith('\\')) {
      e.preventDefault();
      const parent = input.value.replace(/[/\\]$/, '').replace(/[/\\][^/\\]*$/, '');
      if (parent) { input.value = parent; browse(parent); }
    }
  });

  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest('.ac-item') as HTMLElement | null;
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'parent') browse(el.dataset.path!);
    else if (action === 'select') selectDir(el.dataset.path!);
    else if (action === 'enter') enterDir(parseInt(el.dataset.index!, 10));
  });

  document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.launch-center')) hide(); });
}
