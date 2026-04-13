import { setState, theme } from './state';
import { applyTheme } from './theme';
import { handleGlobalKeydown } from './keyboard';
import { launchSession, stopSession } from './session';
import { openSettings, saveSettings, closeSettings } from './settings';
import { loadBookmarksUI, addBookmark, toggleBookmarks, pickFolder, renderWelcomeProjects, updateBookmarkStar } from './bookmarks';
import { togglePreview, loadPreview, refreshPreview, toggleZen, toggleSidebar } from './preview';
import { initAutocomplete } from './autocomplete';
import { toggleExpand, setFocused, fitAll, scheduleFitAll } from './terminal';
import { pollStatus, pollMiniMap, initSidebarClickDelegation } from './sidebar';
import { compactTerminal, clearTerminal, restartTerminal, sendBroadcast, inlineConfirm, initSidebarResize, initPilotResize, verifyTerminal } from './ui-helpers';
import { debounce } from './utils';

document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    setState('workerCount', s.workers || 4);
    setState('previewUrl', s.previewUrl || '');
    setState('engine', s.engine || 'claude');
    setState('noPilot', !!s.noPilot);
    setState('trustMode', !!s.trustMode);
    setState('useWSL', !!s.useWSL);
    if (s.lastCwd) (document.getElementById('cwd-input') as HTMLInputElement).value = s.lastCwd;
    setState('autoFocus', s.autoFocus !== false);
    setState('suggestMode', s.suggestMode || 'off');
    setState('theme', s.theme || 'dark');
    applyTheme();
  } catch {}

  document.getElementById('btn-start')!.addEventListener('click', () => launchSession());
  document.getElementById('btn-stop')!.addEventListener('click', (e) => {
    inlineConfirm(e.currentTarget as HTMLElement, () => stopSession());
  });
  document.getElementById('btn-settings')!.addEventListener('click', () => openSettings());
  document.getElementById('btn-settings-save')!.addEventListener('click', () => saveSettings());
  document.getElementById('btn-settings-cancel')!.addEventListener('click', () => closeSettings());
  document.getElementById('settings-overlay')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Bookmarks & browse
  document.getElementById('btn-bookmark')!.addEventListener('click', addBookmark);
  document.getElementById('btn-bookmarks')!.addEventListener('click', toggleBookmarks);
  document.getElementById('btn-browse')!.addEventListener('click', pickFolder);
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.bookmark-wrapper')) {
      document.getElementById('bookmarks-dropdown')!.classList.add('hidden');
    }
  });
  loadBookmarksUI();

  // Preview controls
  document.getElementById('btn-preview-toggle')!.addEventListener('click', () => togglePreview());
  document.getElementById('btn-preview-go')!.addEventListener('click', () => loadPreview());
  document.getElementById('btn-preview-refresh')!.addEventListener('click', () => refreshPreview());
  document.getElementById('btn-preview-close')!.addEventListener('click', () => togglePreview(false));
  document.getElementById('preview-url')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') loadPreview();
  });

  // Autocomplete
  initAutocomplete(document.getElementById('cwd-input') as HTMLInputElement);

  // Expand on double-click (delegated)
  document.getElementById('terminals')!.addEventListener('dblclick', (e) => {
    const header = (e.target as HTMLElement).closest('.pane-header');
    if (header) {
      const index = parseInt((header.parentElement as HTMLElement).dataset.index!, 10);
      toggleExpand(index);
    }
  });

  // Expand on button click (delegated)
  document.getElementById('terminals')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.btn-expand') as HTMLElement | null;
    if (btn) {
      toggleExpand(parseInt(btn.dataset.index!, 10));
    }
  });

  // Pane header actions (delegated)
  document.getElementById('terminals')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.btn-pane-action') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = parseInt(btn.dataset.index!, 10);
    if (action === 'compact') compactTerminal(idx);
    else if (action === 'clear') inlineConfirm(btn, () => clearTerminal(idx));
    else if (action === 'restart') restartTerminal(idx);
    else if (action === 'verify') verifyTerminal(idx);
  });

  // Broadcast
  document.getElementById('btn-broadcast-send')!.addEventListener('click', sendBroadcast);
  document.getElementById('broadcast-input')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') sendBroadcast();
  });

  // Zen mode
  document.getElementById('btn-zen')!.addEventListener('click', toggleZen);

  // Sidebar hide/show
  document.getElementById('btn-sidebar-hide')!.addEventListener('click', toggleSidebar);
  document.getElementById('btn-sidebar-show')!.addEventListener('click', toggleSidebar);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);

  // Sidebar & pilot resize
  initSidebarResize();
  initPilotResize();

  // System theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'system') applyTheme();
  });

  setInterval(pollStatus, 2000);
  setInterval(pollMiniMap, 5000);
  window.addEventListener('resize', debounce(fitAll, 100));

  // Welcome & bookmarks
  renderWelcomeProjects();

  // Sidebar click delegation
  initSidebarClickDelegation();
});
