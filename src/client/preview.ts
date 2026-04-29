import { previewVisible, sidebarWidth, setState } from './state';
import { scheduleFitAll } from './terminal';

function syncSidebarColumns(app: HTMLElement): void {
  if (app.classList.contains('sidebar-hidden')) {
    app.style.gridTemplateColumns = '';
    return;
  }
  app.style.gridTemplateColumns = app.classList.contains('has-preview')
    ? `1fr 1fr 6px ${sidebarWidth}px`
    : `1fr 6px ${sidebarWidth}px`;
}

export function togglePreview(show?: boolean): void {
  const visible = show !== undefined ? show : !previewVisible;
  setState('previewVisible', visible);
  document.getElementById('preview')!.classList.toggle('hidden', !visible);
  const app = document.getElementById('app')!;
  app.classList.toggle('has-preview', visible);
  syncSidebarColumns(app);
  scheduleFitAll();
}

export function toggleZen(): void {
  const app = document.getElementById('app')!;
  app.classList.toggle('sidebar-hidden');
  app.classList.toggle('launchbar-hidden');
  document.getElementById('btn-sidebar-show')!.classList.toggle('hidden', !app.classList.contains('sidebar-hidden'));
  syncSidebarColumns(app);
  scheduleFitAll();
}

export function toggleSidebar(): void {
  const app = document.getElementById('app')!;
  app.classList.toggle('sidebar-hidden');
  document.getElementById('btn-sidebar-show')!.classList.toggle('hidden', !app.classList.contains('sidebar-hidden'));
  syncSidebarColumns(app);
  scheduleFitAll();
}

export function loadPreview(): void {
  const url = (document.getElementById('preview-url') as HTMLInputElement).value.trim();
  if (url) {
    (document.getElementById('preview-frame') as HTMLIFrameElement).src = url.startsWith('http') ? url : 'http://' + url;
  }
}

export function refreshPreview(): void {
  const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
  frame.src = frame.src;
}
