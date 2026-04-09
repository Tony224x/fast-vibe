import { postJson, deleteJson, escapeHtml } from './utils';
import { launchSession } from './session';

export let bookmarks: Array<{path: string; name: string}> = [];

export async function loadBookmarksUI(): Promise<void> {
  try {
    const res = await fetch('/api/bookmarks');
    bookmarks = await res.json();
  } catch { bookmarks = []; }
  updateBookmarkStar();
  renderWelcomeProjects();
}

export function updateBookmarkStar(): void {
  const p = (document.getElementById('cwd-input') as HTMLInputElement).value.trim();
  const btn = document.getElementById('btn-bookmark')!;
  const saved = bookmarks.some(b => b.path === p);
  btn.innerHTML = saved ? '&#9733;' : '&#9734;';
  btn.classList.toggle('saved', saved);
}

export async function addBookmark(): Promise<void> {
  const p = (document.getElementById('cwd-input') as HTMLInputElement).value.trim();
  if (!p) return;
  const exists = bookmarks.some(b => b.path === p);
  if (exists) {
    await deleteJson('/api/bookmarks', { path: p });
  } else {
    await postJson('/api/bookmarks', { path: p });
  }
  await loadBookmarksUI();
}

export function toggleBookmarks(): void {
  const dd = document.getElementById('bookmarks-dropdown')!;
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) renderBookmarks();
}

export function renderBookmarks(): void {
  const dd = document.getElementById('bookmarks-dropdown')!;
  if (!bookmarks.length) {
    dd.innerHTML = '<div class="bm-empty">No bookmarks yet</div>';
    return;
  }
  dd.innerHTML = bookmarks.map(b => `
    <div class="bm-item" data-path="${escapeHtml(b.path)}">
      <span class="bm-name">${escapeHtml(b.name)}</span>
      <span class="bm-path">${escapeHtml(b.path)}</span>
      <button class="bm-del" data-del="${escapeHtml(b.path)}" title="Remove">&#10005;</button>
    </div>`).join('');

  dd.querySelectorAll('.bm-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.bm-del')) return;
      (document.getElementById('cwd-input') as HTMLInputElement).value = (el as HTMLElement).dataset.path!;
      dd.classList.add('hidden');
      updateBookmarkStar();
    });
  });
  dd.querySelectorAll('.bm-del').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteJson('/api/bookmarks', { path: (el as HTMLElement).dataset.del! });
      await loadBookmarksUI();
      renderBookmarks();
    });
  });
}

export function renderWelcomeProjects(): void {
  const container = document.getElementById('welcome-projects');
  if (!container) return;

  // Get lastCwd from the input
  const lastCwd = (document.getElementById('cwd-input') as HTMLInputElement).value.trim();
  const items: Array<{name: string; path: string; isLast: boolean}> = [];

  // Add lastCwd as first card if it exists and is not already a bookmark
  if (lastCwd && !bookmarks.some(b => b.path === lastCwd)) {
    items.push({ name: lastCwd.split(/[/\\]/).pop() || lastCwd, path: lastCwd, isLast: true });
  }

  // Add bookmarks
  bookmarks.forEach(b => {
    items.push({ name: b.name, path: b.path, isLast: b.path === lastCwd });
  });

  if (!items.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="welcome-card ${item.isLast ? 'last-used' : ''}" data-path="${escapeHtml(item.path)}">
      <div class="welcome-card-name">${escapeHtml(item.name)}</div>
      <div class="welcome-card-path">${escapeHtml(item.path)}</div>
    </div>
  `).join('');

  container.querySelectorAll('.welcome-card').forEach(card => {
    card.addEventListener('click', () => {
      (document.getElementById('cwd-input') as HTMLInputElement).value = (card as HTMLElement).dataset.path!;
      updateBookmarkStar();
      launchSession();
    });
  });
}

export async function pickFolder(): Promise<void> {
  const btn = document.getElementById('btn-browse') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const res = await postJson('/api/pick-folder');
    const data = await res.json();
    if (data.folder) {
      (document.getElementById('cwd-input') as HTMLInputElement).value = data.folder;
      updateBookmarkStar();
    }
  } catch {}
  btn.disabled = false;
}
