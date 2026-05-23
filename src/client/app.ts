import { setState, theme } from './state';
import { applyTheme } from './theme';
import { handleGlobalKeydown } from './keyboard';
import { launchSession, stopSession, restoreSession } from './session';
import { openSettings, saveSettings, closeSettings, initProfilesUI } from './settings';
import { loadBookmarksUI, addBookmark, toggleBookmarks, pickFolder, renderWelcomeProjects, updateBookmarkStar } from './bookmarks';
import { togglePreview, loadPreview, refreshPreview, toggleZen, toggleSidebar } from './preview';
import { initAutocomplete } from './autocomplete';
import { toggleExpand, setFocused, fitAll, scheduleFitAll } from './terminal';
import { pollStatus, pollMiniMap, initSidebarClickDelegation } from './sidebar';
import { compactTerminal, clearTerminal, restartTerminal, removeTerminal, sendBroadcast, inlineConfirm, initSidebarResize, initPilotResize, verifyTerminal, copyOutput, nextStepsTerminal, sendQuickPrompt, QUICK_PROMPTS, improveBroadcastPrompt, improveComposePrompt, sendComposePrompt } from './ui-helpers';
import { escapeHtml, postJson, deleteJson } from './utils';
import { initHelp } from './help';
import { initVoice, toggleVoiceCapture } from './voice';
import { debounce } from './utils';
import { showToast } from './toast';

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
    setState('autoFollow', !!s.autoFollow);
    setState('suggestMode', s.suggestMode || 'off');
    setState('theme', s.theme || 'dark');
    setState('localSTT', !!s.localSTT);
    applyTheme();
  } catch {}

  // Auto-reconnect : si une session est déjà active côté serveur (browser
  // fermé/rouvert), reconstruire le grid au lieu d'afficher le welcome.
  let sessionActive = false;
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    if (data.session && Array.isArray(data.terminals) && data.terminals.length > 0) {
      const indices = data.terminals.map((t: { id: number }) => t.id);
      await restoreSession(data.session, indices);
      sessionActive = true;
    }
  } catch {}

  // Opt-in restore : si aucune session n'est active côté serveur mais un
  // état persisté existe (.session-state.json), proposer à l'utilisateur de
  // la reprendre via un bandeau. Évite les surprises au boot serveur.
  if (!sessionActive) {
    try {
      const r = await fetch('/api/restore-info');
      const info = await r.json();
      if (info.available) {
        const banner = document.getElementById('restore-banner');
        const details = document.getElementById('restore-banner-details');
        const resumeBtn = document.getElementById('btn-restore-resume');
        const discardBtn = document.getElementById('btn-restore-discard');
        if (banner && details && resumeBtn && discardBtn) {
          const ageMin = info.ageMs != null ? Math.round(info.ageMs / 60000) : null;
          const ageStr = ageMin == null ? '' : ageMin < 1 ? ' · il y a < 1 min' : ` · il y a ${ageMin} min`;
          details.textContent = `${info.cwd} · ${info.engine}${info.noPilot ? ', no pilot' : ''} · ${info.workers} workers${ageStr}`;
          banner.classList.remove('hidden');
          resumeBtn.addEventListener('click', async () => {
            (resumeBtn as HTMLButtonElement).disabled = true;
            try {
              const res = await postJson('/api/restore');
              const out = await res.json();
              if (!res.ok) {
                showToast(out.error || `Restore failed (${res.status})`);
                (resumeBtn as HTMLButtonElement).disabled = false;
                return;
              }
              // Re-fetch status to obtain the rebuilt session + indices and
              // reuse the existing reconnect path. restoreSession bâtit le
              // grid et attach les WS.
              const s = await (await fetch('/api/status')).json();
              if (s.session && Array.isArray(s.terminals)) {
                const indices = s.terminals.map((t: { id: number }) => t.id);
                banner.classList.add('hidden');
                await restoreSession(s.session, indices);
              }
            } catch (e: unknown) {
              showToast(`Restore failed: ${(e as Error).message}`);
              (resumeBtn as HTMLButtonElement).disabled = false;
            }
          });
          discardBtn.addEventListener('click', async () => {
            try { await deleteJson('/api/restore-info'); } catch {}
            banner.classList.add('hidden');
          });
        }
      }
    } catch {}
  }

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
    const btn = (e.target as HTMLElement).closest('.btn-pane-action, .prompt-item, .compose-btn') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = parseInt(btn.dataset.index!, 10);
    if (action === 'compact') compactTerminal(idx);
    else if (action === 'clear') inlineConfirm(btn, () => clearTerminal(idx));
    else if (action === 'restart') restartTerminal(idx);
    else if (action === 'delete') removeTerminal(idx);
    else if (action === 'overflow-toggle') {
      const actions = btn.closest('.pane-actions');
      if (!actions) return;
      const wasOpen = actions.classList.contains('overflow-open');
      document.querySelectorAll('.pane-actions.overflow-open').forEach(el => el.classList.remove('overflow-open'));
      if (!wasOpen) actions.classList.add('overflow-open');
    }
    else if (action === 'verify') verifyTerminal(idx);
    else if (action === 'copy') copyOutput(idx);
    else if (action === 'next-steps') nextStepsTerminal(idx);
    else if (action === 'prompts-toggle') {
      e.preventDefault();
      e.stopPropagation();
      const wrapper = btn.closest('.pane-prompts-wrapper') as HTMLElement | null;
      const menu = wrapper?.querySelector('.pane-prompts-menu') as HTMLElement | null;
      if (!menu) return;
      // Lazy-fill the menu (the static pilot pane in index.html ships empty)
      if (!menu.children.length) {
        menu.innerHTML = QUICK_PROMPTS.map(p =>
          `<button class="prompt-item" data-action="prompt-pick" data-index="${idx}" data-prompt-id="${p.id}">` +
          `<span class="prompt-label">${escapeHtml(p.label)}</span>` +
          `<span class="prompt-hint">${escapeHtml(p.hint)}</span>` +
          `</button>`
        ).join('');
      }
      const wasOpen = !menu.classList.contains('hidden');
      // Close any other open prompts menu first
      document.querySelectorAll('.pane-prompts-menu').forEach(el => el.classList.add('hidden'));
      if (!wasOpen) menu.classList.remove('hidden');
    }
    else if (action === 'prompt-pick') {
      const promptId = btn.dataset.promptId;
      if (promptId) sendQuickPrompt(idx, promptId);
      document.querySelectorAll('.pane-prompts-menu').forEach(el => el.classList.add('hidden'));
    }
    else if (action === 'compose-toggle') {
      e.preventDefault();
      e.stopPropagation();
      const wrapper = btn.closest('.pane-compose-wrapper') as HTMLElement | null;
      const popover = wrapper?.querySelector('.pane-compose-popover') as HTMLElement | null;
      if (!popover) return;
      const wasOpen = !popover.classList.contains('hidden');
      // Close other compose + prompts popovers
      document.querySelectorAll('.pane-compose-popover').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.pane-prompts-menu').forEach(el => el.classList.add('hidden'));
      if (!wasOpen) {
        popover.classList.remove('hidden');
        const ta = popover.querySelector('.compose-textarea') as HTMLTextAreaElement | null;
        ta?.focus();
      }
    }
    else if (action === 'compose-improve') improveComposePrompt(idx);
    else if (action === 'compose-send') sendComposePrompt(idx);
    else if (action === 'compose-voice') {
      e.preventDefault();
      e.stopPropagation();
      toggleVoiceCapture(idx);
    }
  });

  // Compose popover keyboard shortcuts (Ctrl+I = improve, Ctrl+Enter = send)
  document.getElementById('terminals')!.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    const ta = (ke.target as HTMLElement).closest('.compose-textarea') as HTMLTextAreaElement | null;
    if (!ta) return;
    const idx = parseInt(ta.dataset.index!, 10);
    if (isNaN(idx)) return;
    if ((ke.ctrlKey || ke.metaKey) && ke.key.toLowerCase() === 'i') {
      ke.preventDefault();
      improveComposePrompt(idx);
    } else if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') {
      ke.preventDefault();
      sendComposePrompt(idx);
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      const popover = ta.closest('.pane-compose-popover') as HTMLElement | null;
      popover?.classList.add('hidden');
    }
  });

  // Close overflow popover on outside click
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.pane-actions')) {
      document.querySelectorAll('.pane-actions.overflow-open').forEach(el => el.classList.remove('overflow-open'));
    }
    if (!target.closest('.pane-prompts-wrapper')) {
      document.querySelectorAll('.pane-prompts-menu').forEach(el => el.classList.add('hidden'));
    }
    if (!target.closest('.pane-compose-wrapper')) {
      document.querySelectorAll('.pane-compose-popover').forEach(el => el.classList.add('hidden'));
    }
  });

  // Broadcast
  document.getElementById('btn-broadcast-send')!.addEventListener('click', sendBroadcast);
  document.getElementById('btn-broadcast-improve')!.addEventListener('click', improveBroadcastPrompt);
  document.getElementById('broadcast-input')!.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter') sendBroadcast();
    // Ctrl/Cmd+I → improve in place
    else if ((ke.ctrlKey || ke.metaKey) && ke.key.toLowerCase() === 'i') {
      ke.preventDefault();
      improveBroadcastPrompt();
    }
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
  initProfilesUI();
  initHelp();
  initVoice();
});
