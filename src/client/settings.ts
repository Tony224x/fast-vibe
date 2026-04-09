import { workerCount, previewUrl, engine, noPilot, trustMode, useWSL, autoFocus, suggestMode, theme, setState } from './state';
import { postJson } from './utils';
import { applyTheme } from './theme';

export function openSettings(): void {
  (document.getElementById('setting-workers') as HTMLInputElement).value = String(workerCount);
  (document.getElementById('setting-preview-url') as HTMLInputElement).value = previewUrl;
  (document.getElementById('setting-engine') as HTMLSelectElement).value = engine;
  (document.getElementById('setting-no-pilot') as HTMLInputElement).checked = noPilot;
  (document.getElementById('setting-trust-mode') as HTMLInputElement).checked = trustMode;
  (document.getElementById('setting-use-wsl') as HTMLInputElement).checked = useWSL;
  (document.getElementById('setting-auto-focus') as HTMLInputElement).checked = autoFocus;
  (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value = suggestMode;
  (document.getElementById('setting-theme') as HTMLSelectElement).value = theme;
  document.getElementById('settings-overlay')!.classList.remove('hidden');
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
  const newSuggestMode = (document.getElementById('setting-suggest-mode') as HTMLSelectElement).value;
  const newTheme = (document.getElementById('setting-theme') as HTMLSelectElement).value;

  setState('workerCount', newWorkerCount);
  setState('previewUrl', newPreviewUrl);
  setState('engine', newEngine);
  setState('noPilot', newNoPilot);
  setState('trustMode', newTrustMode);
  setState('useWSL', newUseWSL);
  setState('autoFocus', newAutoFocus);
  setState('suggestMode', newSuggestMode);
  setState('theme', newTheme);

  applyTheme();
  await postJson('/api/settings', {
    workers: newWorkerCount, previewUrl: newPreviewUrl, engine: newEngine,
    noPilot: newNoPilot, trustMode: newTrustMode, useWSL: newUseWSL,
    autoFocus: newAutoFocus, suggestMode: newSuggestMode, theme: newTheme,
  });

  closeSettings();
}
