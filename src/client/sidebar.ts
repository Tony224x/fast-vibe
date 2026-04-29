import { activeSpace, launched } from './state';
import { escapeHtml, postJson } from './utils';
import { createTerminal, updatePaneDot, fitAll } from './terminal';
import { showToast } from './toast';
import { ICONS } from './icons';
import { initSplitters } from './ui-helpers';
import {
  addPaneToActiveSpace, collectPanes, findGroupPanes, getLayout,
  listGroups, rebalanceLayout, renderLayout, setActiveSpace, setLayout, ungroup,
} from './layout';

export const miniMapData: Record<number, string> = {};
export let sidebarConfirming = false;

let tabHidden = false;
document.addEventListener('visibilitychange', () => { tabHidden = document.hidden; });

let lastSidebarHash = '';

// Render the Spaces list (Default + each group). Worker status indicators
// remain visible inside each pane-header — the sidebar is now a navigation
// surface across spaces, not a per-worker dashboard.
export function updateSidebar(statuses: Array<{id: number; alive: boolean}>): void {
  if (sidebarConfirming) return;

  const tree = getLayout();
  const groups = listGroups(tree);
  const aliveCount = statuses.filter(s => s.alive).length;

  const inGroupSet = new Set<number>();
  groups.forEach(g => collectPanes(g).forEach(i => inGroupSet.add(i)));
  const defaultCount = statuses.filter(s => !inGroupSet.has(s.id)).length;

  const hash = `${activeSpace}|${aliveCount}|${defaultCount}|` + groups.map(g => `${g.id}:${g.name}:${collectPanes(g).size}`).join(',');
  if (hash === lastSidebarHash) return;
  lastSidebarHash = hash;

  const items: string[] = [];
  items.push(`
    <div class="space-card ${activeSpace === 'default' ? 'active' : ''}" data-space="default">
      <span class="space-card-dot" style="--c: var(--brand)"></span>
      <span class="space-card-name">Default</span>
      <span class="space-card-count">${defaultCount}</span>
      <span class="space-card-actions">
        <button class="space-card-btn" data-card-action="add-worker" data-space="default" title="Add worker to Default">${ICONS.plus || '+'}</button>
      </span>
    </div>`);
  groups.forEach(g => {
    items.push(`
      <div class="space-card ${activeSpace === g.id ? 'active' : ''}" data-space="${g.id}" style="--c: ${g.color}">
        <span class="space-card-dot"></span>
        <span class="space-card-name">${escapeHtml(g.name)}</span>
        <span class="space-card-count">${collectPanes(g).size}</span>
        <span class="space-card-actions">
          <button class="space-card-btn" data-card-action="add-worker" data-space="${g.id}" title="Add worker to ${escapeHtml(g.name)}">${ICONS.plus || '+'}</button>
          <button class="space-card-btn" data-card-action="broadcast" data-space="${g.id}" title="Broadcast to ${escapeHtml(g.name)}">${ICONS.send}</button>
          <button class="space-card-btn" data-card-action="ungroup" data-space="${g.id}" title="Ungroup ${escapeHtml(g.name)}">${ICONS.x}</button>
        </span>
      </div>`);
  });

  const list = document.getElementById('status-list')!;
  const activeLabel = activeSpace === 'default'
    ? 'Default'
    : (groups.find(g => g.id === activeSpace)?.name || 'Default');
  list.innerHTML = `<button class="btn-new-worker" data-action="new-worker" title="Add worker to ${escapeHtml(activeLabel)}">
    ${ICONS.plus}<span>New Worker</span><span class="btn-new-worker-target">${escapeHtml(activeLabel)}</span>
  </button>
  <div class="batch-actions">
    <button class="btn-batch" data-batch="rebalance" title="Equalize all worker sizes">${ICONS.columns}<span>Rebalance</span></button>
    <button class="btn-batch" data-batch="compact" title="Compact all">${ICONS.layers}<span>Compact All</span></button>
    <button class="btn-batch btn-ctx-danger" data-batch="clear" title="Clear all">${ICONS.eraser}<span>Clear All</span></button>
  </div>` + items.join('');
}

export async function pollStatus(): Promise<void> {
  if (!launched || tabHidden) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateSidebar(data.terminals);
    data.terminals.forEach((s: {id: number; alive: boolean}) => updatePaneDot(s.id, s.alive));
  } catch { /* network blip — next tick will retry */ }
}

// Mini-map is no longer rendered, but keep the export so existing callers don't break.
export async function pollMiniMap(): Promise<void> { /* removed: status lives in pane-headers */ }

// Sidebar click → switch active space, or perform a per-card action.
// Spawn one worker into the active space, persist the new layout and re-render.
// Shared between the sidebar `+` buttons and the floating in-view FAB.
export function spawnWorkerInActiveSpace(targetSpace?: string): void {
  const grid = document.getElementById('workers-grid') as HTMLElement | null;
  if (!grid) return;
  const renderAndWire = (tree: import('./layout').LayoutNode): void => {
    renderLayout(grid, tree);
    initSplitters(grid);
  };
  const finishRender = (): void => {
    lastSidebarHash = '';
    const tree = getLayout();
    if (tree) renderAndWire(tree);
    pollStatus();
  };
  if (targetSpace && targetSpace !== activeSpace) {
    setActiveSpace(targetSpace);
    const tree = getLayout();
    if (tree) renderAndWire(tree);
  }
  postJson('/api/terminal/spawn')
    .then(r => r.json() as Promise<{ ok: boolean; index: number; error?: string }>)
    .then((data) => {
      const idx = data.index;
      const tree = getLayout();
      if (typeof idx !== 'number') {
        showToast(data.error || 'Failed to spawn worker');
        return;
      }
      setLayout(addPaneToActiveSpace(tree, idx));
      renderAndWire(getLayout()!);
      createTerminal(idx);
      requestAnimationFrame(() => fitAll());
      postJson('/api/layout', { layout: getLayout() });
      finishRender();
    })
    .catch(() => { showToast('Failed to spawn worker'); });
}

export function initSidebarClickDelegation(): void {
  const statusList = document.getElementById('status-list')!;
  const grid = document.getElementById('workers-grid') as HTMLElement | null;

  function rerender(): void {
    lastSidebarHash = '';
    const tree = getLayout();
    if (grid && tree) {
      renderLayout(grid, tree);
      initSplitters(grid);
    }
    pollStatus();
  }


  statusList.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const newWorkerBtn = target.closest('.btn-new-worker') as HTMLElement | null;
    if (newWorkerBtn) {
      e.stopPropagation();
      spawnWorkerInActiveSpace();
      return;
    }

    const batchBtn = target.closest('.btn-batch') as HTMLElement | null;
    if (batchBtn) {
      e.stopPropagation();
      const action = batchBtn.dataset.batch;
      if (action === 'compact') { postJson('/api/batch/compact'); showToast('Compacting all terminals'); }
      else if (action === 'clear') { postJson('/api/batch/clear'); showToast('Clearing all terminals'); }
      else if (action === 'rebalance') {
        const tree = getLayout();
        if (!tree || !grid) return;
        const next = rebalanceLayout(tree);
        setLayout(next);
        renderLayout(grid, next);
        initSplitters(grid);
        postJson('/api/layout', { layout: next });
        requestAnimationFrame(() => fitAll());
        showToast('Worker sizes rebalanced');
      }
      return;
    }

    // Inline action button on a space card (handled before card-click so the
    // click doesn't fall through and switch space when the user only meant
    // to press a tiny action button).
    const cardBtn = target.closest('.space-card-btn') as HTMLElement | null;
    if (cardBtn) {
      e.stopPropagation();
      const action = cardBtn.dataset.cardAction;
      const space = cardBtn.dataset.space!;
      if (action === 'add-worker') {
        spawnWorkerInActiveSpace(space);
      } else if (action === 'broadcast') {
        const indices = findGroupPanes(getLayout(), space);
        const text = window.prompt('Broadcast to group:');
        if (text) indices.forEach(i => postJson(`/api/terminal/${i}/send`, { text }));
      } else if (action === 'ungroup') {
        const tree = getLayout();
        if (!tree || !grid) return;
        setLayout(ungroup(tree, space));
        if (activeSpace === space) setActiveSpace('default');
        renderLayout(grid, getLayout()!);
        initSplitters(grid);
        postJson('/api/layout', { layout: getLayout() });
        rerender();
      }
      return;
    }

    const card = target.closest('.space-card') as HTMLElement | null;
    if (card && card.dataset.space) {
      setActiveSpace(card.dataset.space);
      rerender();
    }
  });
}
