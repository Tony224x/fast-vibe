import { workerCount, previewUrl, engine, noPilot, trustMode, useWSL, autoFocus, autoFollow, suggestMode, theme, setState } from './state';
import { postJson, deleteJson, escapeHtml } from './utils';
import { applyTheme } from './theme';
import { showToast } from './toast';
import { ICONS } from './icons';

export function openSettings(): void {
  (document.getElementById('setting-workers') as HTMLInputElement).value = String(workerCount);
  (document.getElementById('setting-preview-url') as HTMLInputElement).value = previewUrl;
  (document.getElementById('setting-engine') as HTMLSelectElement).value = engine;
  (document.getElementById('setting-no-pilot') as HTMLInputElement).checked = noPilot;
  (document.getElementById('setting-trust-mode') as HTMLInputElement).checked = trustMode;
  (document.getElementById('setting-use-wsl') as HTMLInputElement).checked = useWSL;
  (document.getElementById('setting-auto-focus') as HTMLInputElement).checked = autoFocus;
  (document.getElementById('setting-auto-follow') as HTMLInputElement).checked = autoFollow;
  (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value = suggestMode;
  (document.getElementById('setting-theme') as HTMLSelectElement).value = theme;
  document.getElementById('settings-overlay')!.classList.remove('hidden');
  loadProfiles();
}

export function closeSettings(): void {
  document.getElementById('settings-overlay')!.classList.add('hidden');
}

export async function saveSettings(): Promise<void> {
  const newWorkerCount = Math.max(1, Math.min(8, parseInt((document.getElementById('setting-workers') as HTMLInputElement).value, 10) || 4));
  const newPreviewUrl = (document.getElementById('setting-preview-url') as HTMLInputElement).value.trim();
  const newEngine = (document.getElementById('setting-engine') as HTMLSelectElement).value;
  const newNoPilot = (document.getElementById('setting-no-pilot') as HTMLInputElement).checked;
  const newTrustMode = (document.getElementById('setting-trust-mode') as HTMLInputElement).checked;
  const newUseWSL = (document.getElementById('setting-use-wsl') as HTMLInputElement).checked;
  const newAutoFocus = (document.getElementById('setting-auto-focus') as HTMLInputElement).checked;
  const newAutoFollow = (document.getElementById('setting-auto-follow') as HTMLInputElement).checked;
  const newSuggestMode = (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value;
  const newTheme = (document.getElementById('setting-theme') as HTMLSelectElement).value;

  setState('workerCount', newWorkerCount);
  setState('previewUrl', newPreviewUrl);
  setState('engine', newEngine);
  setState('noPilot', newNoPilot);
  setState('trustMode', newTrustMode);
  setState('useWSL', newUseWSL);
  setState('autoFocus', newAutoFocus);
  setState('autoFollow', newAutoFollow);
  setState('suggestMode', newSuggestMode);
  setState('theme', newTheme);

  applyTheme();
  await postJson('/api/settings', {
    workers: newWorkerCount, previewUrl: newPreviewUrl, engine: newEngine,
    noPilot: newNoPilot, trustMode: newTrustMode, useWSL: newUseWSL,
    autoFocus: newAutoFocus, autoFollow: newAutoFollow,
    suggestMode: newSuggestMode, theme: newTheme,
  });

  closeSettings();
}


// ── Profiles ──

let cachedProfiles: { name: string; settings: Record<string, unknown> }[] = [];

export async function loadProfiles(): Promise<void> {
  const list = document.getElementById('profiles-list');
  if (!list) return;
  try {
    const res = await fetch('/api/profiles');
    cachedProfiles = await res.json();
    if (!cachedProfiles.length) { list.innerHTML = '<span class="setting-hint">No saved profiles</span>'; return; }
    list.innerHTML = cachedProfiles.map(p =>
      `<div class="profile-item">
        <button class="btn-profile-load" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>
        <button class="btn-profile-del" data-name="${escapeHtml(p.name)}" title="Delete">${ICONS.x}</button>
      </div>`
    ).join('');
  } catch { list.innerHTML = '<span class="setting-hint">Failed to load profiles</span>'; }
}

export async function saveProfile(): Promise<void> {
  const input = document.getElementById('profile-name') as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  // Read current form values, not in-memory state (user may have changed fields without saving)
  const s = {
    workers: Math.max(1, Math.min(8, parseInt((document.getElementById('setting-workers') as HTMLInputElement).value, 10) || 4)),
    previewUrl: (document.getElementById('setting-preview-url') as HTMLInputElement).value.trim(),
    engine: (document.getElementById('setting-engine') as HTMLSelectElement).value,
    noPilot: (document.getElementById('setting-no-pilot') as HTMLInputElement).checked,
    trustMode: (document.getElementById('setting-trust-mode') as HTMLInputElement).checked,
    useWSL: (document.getElementById('setting-use-wsl') as HTMLInputElement).checked,
    autoFocus: (document.getElementById('setting-auto-focus') as HTMLInputElement).checked,
    autoFollow: (document.getElementById('setting-auto-follow') as HTMLInputElement).checked,
    suggestMode: (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value,
    theme: (document.getElementById('setting-theme') as HTMLSelectElement).value,
  };
  await postJson('/api/profiles', { name, settings: s });
  input.value = '';
  showToast(`Profile "${name}" saved`);
  loadProfiles();
}

export async function loadProfile(name: string): Promise<void> {
  const p = cachedProfiles.find(pr => pr.name === name);
  if (!p) return;
  const s = p.settings;
  if (s.workers != null) { setState('workerCount', s.workers as number); (document.getElementById('setting-workers') as HTMLInputElement).value = String(s.workers); }
  if (s.previewUrl != null) { setState('previewUrl', s.previewUrl as string); (document.getElementById('setting-preview-url') as HTMLInputElement).value = s.previewUrl as string; }
  if (s.engine != null) { setState('engine', s.engine as string); (document.getElementById('setting-engine') as HTMLSelectElement).value = s.engine as string; }
  if (s.noPilot != null) { setState('noPilot', s.noPilot as boolean); (document.getElementById('setting-no-pilot') as HTMLInputElement).checked = s.noPilot as boolean; }
  if (s.trustMode != null) { setState('trustMode', s.trustMode as boolean); (document.getElementById('setting-trust-mode') as HTMLInputElement).checked = s.trustMode as boolean; }
  if (s.useWSL != null) { setState('useWSL', s.useWSL as boolean); (document.getElementById('setting-use-wsl') as HTMLInputElement).checked = s.useWSL as boolean; }
  if (s.autoFocus != null) { setState('autoFocus', s.autoFocus as boolean); (document.getElementById('setting-auto-focus') as HTMLInputElement).checked = s.autoFocus as boolean; }
  if (s.autoFollow != null) { setState('autoFollow', s.autoFollow as boolean); (document.getElementById('setting-auto-follow') as HTMLInputElement).checked = s.autoFollow as boolean; }
  if (s.suggestMode != null) { setState('suggestMode', s.suggestMode as string); (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value = s.suggestMode as string; }
  if (s.theme != null) { setState('theme', s.theme as string); (document.getElementById('setting-theme') as HTMLSelectElement).value = s.theme as string; applyTheme(); }
  // Persist to server so settings survive reload
  await postJson('/api/settings', s);
  showToast(`Profile "${name}" loaded`);
}

export function initProfilesUI(): void {
  const saveBtn = document.getElementById('btn-profile-save');
  if (saveBtn) saveBtn.addEventListener('click', saveProfile);

  const list = document.getElementById('profiles-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('btn-profile-load')) {
        loadProfile(target.dataset.name!);
      } else if (target.classList.contains('btn-profile-del')) {
        deleteJson('/api/profiles', { name: target.dataset.name });
        showToast(`Profile deleted`);
        setTimeout(loadProfiles, 200);
      }
    });
  }
}
