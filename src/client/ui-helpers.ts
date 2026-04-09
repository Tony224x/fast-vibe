import { noPilot, workerCount, terminals, sidebarWidth, setState } from './state';
import { postJson } from './utils';
import { fitAll, fitAllRAF, scheduleFitAll } from './terminal';
import { showToast } from './toast';

export function inlineConfirm(btn: HTMLElement, action: () => void): void {
  const el = btn as HTMLElement & { dataset: DOMStringMap };
  if (el.dataset.confirming) {
    action();
    delete el.dataset.confirming;
    el.innerHTML = el.dataset.originalHtml!;
    el.classList.remove('confirming');
    return;
  }
  el.dataset.originalHtml = el.innerHTML;
  el.dataset.confirming = 'true';
  el.innerHTML = 'Confirm?';
  el.classList.add('confirming');
  setTimeout(() => {
    if (el.dataset.confirming) {
      delete el.dataset.confirming;
      el.innerHTML = el.dataset.originalHtml!;
      el.classList.remove('confirming');
    }
  }, 2000);
}

export async function compactTerminal(id: number): Promise<void> {
  await postJson(`/api/terminal/${id}/compact`);
  showToast(`Terminal ${id} compacted`);
}

export async function clearTerminal(id: number): Promise<void> {
  await postJson(`/api/terminal/${id}/clear`);
  showToast(`Terminal ${id} cleared`);
}

export async function restartTerminal(id: number): Promise<void> {
  const t = terminals[id];
  if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
    t.ws.send(JSON.stringify({ type: 'restart' }));
    showToast(`Terminal ${id} restarted`);
  }
}

export async function sendBroadcast(): Promise<void> {
  const input = document.getElementById('broadcast-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  const startIdx = noPilot ? 0 : 1;
  const total = noPilot ? workerCount : 1 + workerCount;
  const promises: Promise<Response>[] = [];
  for (let i = startIdx; i < total; i++) {
    promises.push(postJson(`/api/terminal/${i}/send`, { text }));
  }
  await Promise.all(promises);
  showToast(`Broadcast sent to ${total - startIdx} workers`);
  input.value = '';
}

export function initSplitters(container: HTMLElement): void {
  container.querySelectorAll('.split-v').forEach(handle => {
    handle.addEventListener('mousedown', (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      const prev = (handle as HTMLElement).previousElementSibling as HTMLElement;
      const next = (handle as HTMLElement).nextElementSibling as HTMLElement;
      if (!prev || !next) return;
      const startX = me.clientX;
      const prevW = prev.offsetWidth;
      const nextW = next.offsetWidth;
      document.body.classList.add('resizing', 'resizing-col');
      (handle as HTMLElement).classList.add('dragging');

      function onMove(e: Event) {
        const me = e as MouseEvent;
        const dx = me.clientX - startX;
        const newPrev = Math.max(80, prevW + dx);
        const newNext = Math.max(80, nextW - dx);
        const total = newPrev + newNext;
        prev.style.flex = `0 0 ${(newPrev / total * 100).toFixed(1)}%`;
        next.style.flex = `0 0 ${(newNext / total * 100).toFixed(1)}%`;
        fitAllRAF();
      }
      function onUp() {
        document.body.classList.remove('resizing', 'resizing-col');
        (handle as HTMLElement).classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        fitAll();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  container.querySelectorAll('.split-h').forEach(handle => {
    handle.addEventListener('mousedown', (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      const prevRow = (handle as HTMLElement).previousElementSibling as HTMLElement;
      const nextRow = (handle as HTMLElement).nextElementSibling as HTMLElement;
      if (!prevRow || !nextRow) return;
      const startY = me.clientY;
      const prevH = prevRow.offsetHeight;
      const nextH = nextRow.offsetHeight;
      document.body.classList.add('resizing', 'resizing-row');
      (handle as HTMLElement).classList.add('dragging');

      function onMove(e: Event) {
        const me = e as MouseEvent;
        const dy = me.clientY - startY;
        const newPrev = Math.max(60, prevH + dy);
        const newNext = Math.max(60, nextH - dy);
        const total = newPrev + newNext;
        prevRow.style.flex = `0 0 ${(newPrev / total * 100).toFixed(1)}%`;
        nextRow.style.flex = `0 0 ${(newNext / total * 100).toFixed(1)}%`;
        fitAllRAF();
      }
      function onUp() {
        document.body.classList.remove('resizing', 'resizing-row');
        (handle as HTMLElement).classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        fitAll();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

export function initSidebarResize(): void {
  const handle = document.getElementById('sidebar-resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const app = document.getElementById('app')!;
    const sidebar = document.getElementById('sidebar')!;
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'resizing-col');

    function onMove(e: MouseEvent) {
      const dx = startX - e.clientX;
      const newWidth = Math.max(60, Math.min(500, startW + dx));
      setState('sidebarWidth', newWidth);
      const cols = app.classList.contains('has-preview')
        ? `1fr 1fr 5px ${newWidth}px`
        : `1fr 5px ${newWidth}px`;
      app.style.gridTemplateColumns = cols;
      fitAllRAF();
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-col');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      fitAll();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

export function initPilotResize(): void {
  const handle = document.getElementById('resize-handle');
  if (!handle) return;

  let startY: number, startPilotH: number, container: HTMLElement;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pilot = document.querySelector('.terminal-pane.pilot') as HTMLElement | null;
    if (!pilot || pilot.classList.contains('hidden')) return;
    container = document.getElementById('terminals')!;
    startY = e.clientY;
    startPilotH = pilot.offsetHeight;
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'resizing-row');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e: MouseEvent) {
    const pilot = document.querySelector('.terminal-pane.pilot') as HTMLElement | null;
    if (!pilot) return;
    const totalH = container.offsetHeight;
    const newH = Math.max(60, Math.min(totalH - 60, startPilotH + (e.clientY - startY)));
    const pct = (newH / totalH * 100).toFixed(1);
    pilot.style.flex = `0 0 ${pct}%`;
    fitAllRAF();
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-row');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fitAll();
  }
}
