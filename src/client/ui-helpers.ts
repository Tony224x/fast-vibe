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

const VERIFY_PROMPT = `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that were edited earlier in this conversation.

## Phase 2: Launch Three Review Sub-Agents in Parallel

Launch all three sub-agents concurrently. Pass each one the full diff so it has the complete context.

### Agent 1: Code Reuse Review

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Review

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Agent 3: Efficiency Review

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

## Phase 3: Fix Issues

Wait for all three sub-agents to complete. Aggregate their findings and fix each issue directly. If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

When done, briefly summarize what was fixed (or confirm the code was already clean).
`;

export async function verifyTerminal(id: number): Promise<void> {
  await postJson(`/api/terminal/${id}/send`, { text: VERIFY_PROMPT });
  showToast(`Verify prompt sent to terminal ${id}`);
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
  const h = handle;

  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const app = document.getElementById('app')!;
    const sidebar = document.getElementById('sidebar')!;
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    h.classList.add('dragging');
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
      h.classList.remove('dragging');
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
  const h = handle;

  let startY: number, startPilotH: number, container: HTMLElement;

  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pilot = document.querySelector('.terminal-pane.pilot') as HTMLElement | null;
    if (!pilot || pilot.classList.contains('hidden')) return;
    container = document.getElementById('terminals')!;
    startY = e.clientY;
    startPilotH = pilot.offsetHeight;
    h.classList.add('dragging');
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
    h.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-row');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fitAll();
  }
}
