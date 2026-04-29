// Layout tree model + DOM renderer for the workers area.
// Supports drag-to-split (4 sides) and stack/tabs (center drop).
//
// Node types
//   pane   — leaf, holds one terminal index
//   split  — N children separated by handles; dir='row' is side-by-side, dir='col' is stacked
//   tabs   — N pane children stacked in z; only `active` is visible, others hidden via display:none
//
// xterm DOM is preserved across re-renders by detaching every `.pane-body` before the
// rebuild and re-slotting it into the new shell that has the same id (term-N).

import { ICONS } from './icons';
import { noPilot, activeSpace, setState } from './state';
import { escapeHtml, postJson } from './utils';

export type PaneNode = { type: 'pane'; index: number };
export type SplitNode = { type: 'split'; dir: 'row' | 'col'; children: LayoutNode[]; sizes?: number[] };
export type TabsNode = { type: 'tabs'; active: number; children: PaneNode[] };
export type GroupNode = { type: 'group'; id: string; name: string; color: string; collapsed: boolean; child: LayoutNode };
export type LayoutNode = PaneNode | SplitNode | TabsNode | GroupNode;

const GROUP_COLORS = ['#e95d0c', '#3aa17e', '#5b8def', '#c067d4', '#d4a017', '#dc7c4d'];
let groupColorIdx = 0;
function nextGroupColor(): string { const c = GROUP_COLORS[groupColorIdx % GROUP_COLORS.length]; groupColorIdx++; return c; }
function newGroupId(): string { return 'g' + Math.random().toString(36).slice(2, 8); }

export type DropZone = 'top' | 'right' | 'bottom' | 'left' | 'center';

let currentLayout: LayoutNode | null = null;
const selectedPanes = new Set<number>();
let groupCounter = 0;

export function getLayout(): LayoutNode | null { return currentLayout; }
export function setLayout(t: LayoutNode | null): void { currentLayout = t; }

function updateSelectionUI(host: HTMLElement): void {
  host.querySelectorAll('.terminal-pane').forEach(p => {
    const idx = parseInt((p as HTMLElement).dataset.index!, 10);
    p.classList.toggle('multi-selected', selectedPanes.has(idx));
  });
  updateGroupToolbar(host);
}

function updateGroupToolbar(host: HTMLElement): void {
  let bar = document.getElementById('layout-toolbar') as HTMLElement | null;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'layout-toolbar';
    bar.innerHTML = `
      <span class="layout-toolbar-count"></span>
      <button class="btn-primary btn-layout-group">${ICONS.layers}<span>Group</span></button>
      <button class="btn-layout-clear" title="Clear selection">${ICONS.x}</button>`;
    document.body.appendChild(bar);
    bar.querySelector('.btn-layout-group')!.addEventListener('click', () => {
      if (!currentLayout || selectedPanes.size < 2) return;
      const name = window.prompt('Group name:', `Group ${++groupCounter}`);
      if (!name) return;
      const captured = captureSizes(host, currentLayout);
      const result = wrapGroup(captured, Array.from(selectedPanes), name);
      if (!result.ok) {
        bar!.classList.add('shake');
        setTimeout(() => bar!.classList.remove('shake'), 400);
        return;
      }
      currentLayout = result.tree;
      selectedPanes.clear();
      // Stay in the default view so the user sees the new group form inline,
      // surrounded by the rest of the workers — switching into a zoomed group
      // view here used to hide the group header and confused users.
      if (result.id && activeSpace !== 'default') setActiveSpace(result.id);
      renderLayout(host, currentLayout);
      (host as DndHost).__layoutOnChange?.();
      updateSelectionUI(host);
    });
    bar.querySelector('.btn-layout-clear')!.addEventListener('click', () => {
      selectedPanes.clear();
      updateSelectionUI(host);
    });
  }
  const count = selectedPanes.size;
  bar.classList.toggle('visible', count >= 2);
  (bar.querySelector('.layout-toolbar-count') as HTMLElement).textContent = `${count} selected`;
}

export function clearLayoutSelection(host: HTMLElement): void {
  selectedPanes.clear();
  updateSelectionUI(host);
}

// ── Default layout (mimics the old 2-column workers grid) ──
export function buildDefaultLayout(indices: number[]): LayoutNode | null {
  if (indices.length === 0) return null;
  if (indices.length === 1) return { type: 'pane', index: indices[0] };
  const cols = indices.length <= 2 ? indices.length : 2;
  const rows = Math.ceil(indices.length / cols);
  const colTrees: LayoutNode[] = [];
  for (let c = 0; c < cols; c++) {
    const items: LayoutNode[] = [];
    for (let r = 0; r < rows; r++) {
      const idx = r * cols + c;
      if (idx < indices.length) items.push({ type: 'pane', index: indices[idx] });
    }
    if (items.length === 1) colTrees.push(items[0]);
    else if (items.length > 1) colTrees.push({ type: 'split', dir: 'col', children: items });
  }
  if (colTrees.length === 1) return colTrees[0];
  return { type: 'split', dir: 'row', children: colTrees };
}

// ── Tree ops ──

// Collect all pane indices under a subtree.
export function collectPanes(node: LayoutNode): Set<number> {
  const s = new Set<number>();
  function walk(n: LayoutNode): void {
    if (n.type === 'pane') s.add(n.index);
    else if (n.type === 'tabs') n.children.forEach(c => s.add(c.index));
    else if (n.type === 'group') walk(n.child);
    else n.children.forEach(walk);
  }
  walk(node);
  return s;
}

// Remove a pane from the tree. Collapses singleton splits/tabs back to their lone child.
export function detachPane(tree: LayoutNode | null, idx: number): { tree: LayoutNode | null; pane: PaneNode | null } {
  if (!tree) return { tree: null, pane: null };
  if (tree.type === 'pane') {
    return tree.index === idx ? { tree: null, pane: tree } : { tree, pane: null };
  }
  if (tree.type === 'tabs') {
    const found = tree.children.find(c => c.index === idx);
    if (!found) return { tree, pane: null };
    const remaining = tree.children.filter(c => c.index !== idx);
    if (remaining.length === 0) return { tree: null, pane: found };
    if (remaining.length === 1) return { tree: remaining[0], pane: found };
    const newActive = tree.active === idx ? remaining[0].index : tree.active;
    return { tree: { type: 'tabs', active: newActive, children: remaining }, pane: found };
  }
  if (tree.type === 'group') {
    const r = detachPane(tree.child, idx);
    if (!r.pane) return { tree, pane: null };
    if (!r.tree) return { tree: null, pane: r.pane };
    return { tree: { ...tree, child: r.tree }, pane: r.pane };
  }
  // split
  let foundPane: PaneNode | null = null;
  const newChildren: LayoutNode[] = [];
  for (const c of tree.children) {
    if (foundPane) { newChildren.push(c); continue; }
    const r = detachPane(c, idx);
    if (r.pane) {
      foundPane = r.pane;
      if (r.tree) newChildren.push(r.tree);
    } else {
      newChildren.push(c);
    }
  }
  if (!foundPane) return { tree, pane: null };
  if (newChildren.length === 0) return { tree: null, pane: foundPane };
  if (newChildren.length === 1) return { tree: newChildren[0], pane: foundPane };
  return { tree: { type: 'split', dir: tree.dir, children: newChildren }, pane: foundPane };
}

// Split the leaf or tabs-node containing targetIdx by adding source on the given side.
export function splitOn(tree: LayoutNode, targetIdx: number, source: LayoutNode, zone: 'top' | 'right' | 'bottom' | 'left'): LayoutNode {
  function makeSplit(target: LayoutNode): LayoutNode {
    if (zone === 'right')  return { type: 'split', dir: 'row', children: [target, source] };
    if (zone === 'left')   return { type: 'split', dir: 'row', children: [source, target] };
    if (zone === 'bottom') return { type: 'split', dir: 'col', children: [target, source] };
    return { type: 'split', dir: 'col', children: [source, target] };
  }
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'pane') return node.index === targetIdx ? makeSplit(node) : node;
    if (node.type === 'tabs') return node.children.some(c => c.index === targetIdx) ? makeSplit(node) : node;
    if (node.type === 'group') return { ...node, child: walk(node.child) };
    return { type: 'split', dir: node.dir, sizes: node.sizes, children: node.children.map(walk) };
  }
  return walk(tree);
}

// Stack source onto target (creates or extends a tabs node).
export function stackOn(tree: LayoutNode, targetIdx: number, source: PaneNode): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'pane' && node.index === targetIdx) {
      return { type: 'tabs', active: source.index, children: [node, source] };
    }
    if (node.type === 'tabs' && node.children.some(c => c.index === targetIdx)) {
      return { type: 'tabs', active: source.index, children: [...node.children, source] };
    }
    if (node.type === 'group') {
      return { ...node, child: walk(node.child) };
    }
    if (node.type === 'split') {
      return { type: 'split', dir: node.dir, sizes: node.sizes, children: node.children.map(walk) };
    }
    return node;
  }
  return walk(tree);
}

// Apply a drop zone result to the tree.
export function applyDrop(tree: LayoutNode, sourceIdx: number, targetIdx: number, zone: DropZone): LayoutNode {
  if (sourceIdx === targetIdx) return tree;
  const detached = detachPane(tree, sourceIdx);
  if (!detached.pane || !detached.tree) return tree;
  const source: PaneNode = { type: 'pane', index: sourceIdx };
  if (zone === 'center') return stackOn(detached.tree, targetIdx, source);
  return splitOn(detached.tree, targetIdx, source, zone);
}

// Switch the active tab inside a tabs node containing this pane index.
export function setActiveTab(tree: LayoutNode, paneIdx: number): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'tabs' && node.children.some(c => c.index === paneIdx)) {
      return { type: 'tabs', active: paneIdx, children: node.children };
    }
    if (node.type === 'group') return { ...node, child: walk(node.child) };
    if (node.type === 'split') {
      return { type: 'split', dir: node.dir, sizes: node.sizes, children: node.children.map(walk) };
    }
    return node;
  }
  return walk(tree);
}

// Find the tabs siblings of a pane (returns null if not in a tabs node).
export function findTabsContext(tree: LayoutNode | null, paneIdx: number): { siblings: number[]; active: number } | null {
  if (!tree) return null;
  if (tree.type === 'tabs') {
    if (tree.children.some(c => c.index === paneIdx)) {
      return { siblings: tree.children.map(c => c.index), active: tree.active };
    }
    return null;
  }
  if (tree.type === 'group') return findTabsContext(tree.child, paneIdx);
  if (tree.type === 'split') {
    for (const c of tree.children) {
      const r = findTabsContext(c, paneIdx);
      if (r) return r;
    }
  }
  return null;
}

// ── Group ops ──

export function wrapGroup(tree: LayoutNode, paneIdxs: number[], name: string, color?: string): { tree: LayoutNode; ok: boolean; id: string | null } {
  const set = new Set(paneIdxs);
  if (set.size < 2) return { tree, ok: false, id: null };

  // Path 1 — exact-subtree wrap: preserves user-resized splits when the
  // selection happens to match a contiguous subtree.
  let wrappedId: string | null = null;
  function walk(node: LayoutNode): LayoutNode {
    if (wrappedId) return node;
    const panes = collectPanes(node);
    if (panes.size === set.size && Array.from(set).every(i => panes.has(i))) {
      wrappedId = newGroupId();
      return { type: 'group', id: wrappedId, name, color: color || nextGroupColor(), collapsed: false, child: node };
    }
    if (node.type === 'split') return { ...node, children: node.children.map(walk) };
    if (node.type === 'group') return { ...node, child: walk(node.child) };
    return node;
  }
  const next = walk(tree);
  if (wrappedId) return { tree: next, ok: true, id: wrappedId };

  // Path 2 — detach + regroup: selection is non-contiguous (e.g. a fresh
  // worker plus an unrelated existing one). Pull each selected pane out, then
  // bundle them into a brand-new group node and graft it back as a row-split
  // sibling of whatever's left of the tree.
  let working: LayoutNode | null = tree;
  const collected: PaneNode[] = [];
  for (const idx of paneIdxs) {
    if (!working) break;
    const r = detachPane(working, idx);
    if (r.pane) {
      collected.push(r.pane);
      working = r.tree;
    }
  }
  if (collected.length < 2) return { tree, ok: false, id: null };
  const groupChild: LayoutNode = { type: 'split', dir: 'row', children: collected };
  const groupId = newGroupId();
  const groupNode: GroupNode = { type: 'group', id: groupId, name, color: color || nextGroupColor(), collapsed: false, child: groupChild };
  if (!working) return { tree: groupNode, ok: true, id: groupId };
  const newTree: LayoutNode = working.type === 'split' && working.dir === 'row'
    ? { type: 'split', dir: 'row', children: [...working.children, groupNode] }
    : { type: 'split', dir: 'row', children: [working, groupNode] };
  return { tree: newTree, ok: true, id: groupId };
}

export function ungroup(tree: LayoutNode, groupId: string): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'group') {
      if (node.id === groupId) return walk(node.child);
      return { ...node, child: walk(node.child) };
    }
    if (node.type === 'split') return { ...node, children: node.children.map(walk) };
    return node;
  }
  return walk(tree);
}

export function updateGroup(tree: LayoutNode, groupId: string, patch: Partial<Pick<GroupNode, 'name' | 'color' | 'collapsed'>>): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'group') {
      const child = walk(node.child);
      return node.id === groupId ? { ...node, ...patch, child } : { ...node, child };
    }
    if (node.type === 'split') return { ...node, children: node.children.map(walk) };
    return node;
  }
  return walk(tree);
}

export function findGroupPanes(tree: LayoutNode | null, groupId: string): number[] {
  if (!tree) return [];
  if (tree.type === 'group' && tree.id === groupId) return Array.from(collectPanes(tree.child));
  if (tree.type === 'group') return findGroupPanes(tree.child, groupId);
  if (tree.type === 'split') {
    for (const c of tree.children) {
      const r = findGroupPanes(c, groupId);
      if (r.length) return r;
    }
  }
  return [];
}

// ── Pane HTML template ──

export function paneLabel(index: number): string {
  if (index === 0 && !noPilot) return 'Pilot';
  return noPilot ? `Worker ${index + 1}` : `Worker ${index}`;
}

function paneHeaderHtml(index: number, label: string, tabs: { siblings: number[]; active: number } | null, isPilot: boolean): string {
  const tabBar = tabs ? `
        <span class="pane-tab-nav">
          <button class="btn-pane-action btn-tab-prev" data-action="tab-prev" data-index="${index}" title="Previous tab">${ICONS.chevronLeft}</button>
          <span class="pane-tab-pos">${tabs.siblings.indexOf(index) + 1}/${tabs.siblings.length}</span>
          <button class="btn-pane-action btn-tab-next" data-action="tab-next" data-index="${index}" title="Next tab">${ICONS.chevronRight}</button>
        </span>` : '';
  const deleteBtn = isPilot ? '' : `<button class="btn-pane-action btn-ctx-danger" data-action="delete" data-index="${index}" data-tooltip="Delete worker" title="Delete">${ICONS.trash}</button>`;
  return `<div class="pane-header" draggable="true">
        <span class="pane-title">${escapeHtml(label)}<span class="unread-dot"></span></span>
        <span class="pane-status">
          <span class="status-dot"></span>
          <span class="status-text">--</span>
        </span>${tabBar}
        <span class="pane-actions">
          <span class="pane-actions-overflow">
            <button class="btn-pane-action btn-verify" data-action="verify" data-index="${index}" data-tooltip="Verify (code review)" title="Verify">${ICONS.check}<span>Verify</span></button>
            <button class="btn-pane-action" data-action="copy" data-index="${index}" data-tooltip="Copy output" title="Copy">${ICONS.copy}</button>
            <button class="btn-pane-action" data-action="compact" data-index="${index}" data-tooltip="Compact context" title="Compact">${ICONS.layers}</button>
            <button class="btn-pane-action" data-action="clear" data-index="${index}" data-tooltip="Clear context" title="Clear">${ICONS.eraser}</button>
            <button class="btn-pane-action" data-action="restart" data-index="${index}" data-tooltip="Restart" title="Restart">${ICONS.refresh}</button>
          </span>
          <button class="btn-pane-action btn-overflow-toggle" data-action="overflow-toggle" data-index="${index}" data-tooltip="More actions" title="More">${ICONS.moreHorizontal}</button>
          ${deleteBtn}
        </span>
        <button class="btn-expand" data-index="${index}" data-tooltip="Expand / Collapse" title="Expand">${ICONS.expand}</button>
      </div>`;
}

function paneShellHtml(index: number, tabs: { siblings: number[]; active: number } | null): string {
  const isPilot = index === 0 && !noPilot;
  const cls = `terminal-pane ${isPilot ? 'pilot' : 'worker'}${tabs ? ' in-tabs' : ''}`;
  const header = paneHeaderHtml(index, paneLabel(index), tabs, isPilot);
  return `<div class="${cls}" data-index="${index}" draggable="false">${header}<div class="pane-body" id="term-${index}"></div></div>`;
}

// ── Renderer ──

function buildNode(node: LayoutNode, tabsCtx: TabsNode | null, host: HTMLElement): HTMLElement {
  if (node.type === 'pane') {
    const wrap = document.createElement('div');
    const tabs = tabsCtx ? { siblings: tabsCtx.children.map(c => c.index), active: tabsCtx.active } : null;
    wrap.innerHTML = paneShellHtml(node.index, tabs);
    return wrap.firstElementChild as HTMLElement;
  }
  if (node.type === 'tabs') {
    const wrap = document.createElement('div');
    wrap.className = 'pane-tabs-stack';
    wrap.style.flex = '1 1 0';
    wrap.dataset.tabsActive = String(node.active);
    node.children.forEach(c => {
      const el = buildNode(c, node, host);
      el.style.display = c.index === node.active ? '' : 'none';
      wrap.appendChild(el);
    });
    return wrap;
  }
  if (node.type === 'group') {
    const wrap = document.createElement('div');
    wrap.className = 'pane-group' + (node.collapsed ? ' collapsed' : '');
    wrap.dataset.groupId = node.id;
    wrap.style.flex = '1 1 0';
    wrap.style.setProperty('--group-color', node.color);
    const header = document.createElement('div');
    header.className = 'pane-group-header';
    header.innerHTML = `
      <span class="pane-group-dot"></span>
      <span class="pane-group-name" data-action="rename" title="Double-click to rename">${escapeHtml(node.name)}</span>
      <span class="pane-group-actions">
        <button class="btn-pane-action" data-action="group-broadcast" data-group-id="${node.id}" title="Broadcast to group">${ICONS.send}</button>
        <button class="btn-pane-action" data-action="group-collapse" data-group-id="${node.id}" title="Collapse / expand">${node.collapsed ? ICONS.chevronRight : ICONS.chevronDown}</button>
        <button class="btn-pane-action" data-action="group-ungroup" data-group-id="${node.id}" title="Ungroup">${ICONS.x}</button>
      </span>`;
    wrap.appendChild(header);
    // Always render the body — collapsed state just hides it via CSS — so the .pane-body
    // elements stay in the DOM and xterm is preserved across collapse/expand cycles.
    const body = document.createElement('div');
    body.className = 'pane-group-body';
    const childEl = buildNode(node.child, null, host);
    childEl.style.flex = '1 1 0';
    body.appendChild(childEl);
    wrap.appendChild(body);
    return wrap;
  }
  // split
  const wrap = document.createElement('div');
  wrap.className = node.dir === 'row' ? 'layout-row' : 'layout-col';
  // If any child is a collapsed group, drop captured sizes so live siblings expand
  // to fill the space the group gave up (the collapsed group's !important flex still
  // pins it to its header size).
  const hasCollapsedGroup = node.children.some(c => c.type === 'group' && c.collapsed);
  const useSizes = node.sizes && !hasCollapsedGroup;
  node.children.forEach((child, i) => {
    if (i > 0) {
      const handle = document.createElement('div');
      handle.className = node.dir === 'row' ? 'split-v' : 'split-h';
      wrap.appendChild(handle);
    }
    const childEl = buildNode(child, null, host);
    childEl.style.flex = useSizes ? `0 0 ${node.sizes![i]}%` : '1 1 0';
    wrap.appendChild(childEl);
  });
  return wrap;
}

// Read back current sizes from inline styles so a re-render after a tree mutation
// preserves user-resized splits where the affected branch is unchanged.
export function captureSizes(host: HTMLElement, tree: LayoutNode): LayoutNode {
  function walk(node: LayoutNode, dom: HTMLElement | null): LayoutNode {
    if (!dom) return node;
    if (node.type === 'pane' || node.type === 'tabs') return node;
    if (node.type === 'group') {
      const body = dom.querySelector(':scope > .pane-group-body') as HTMLElement | null;
      const inner = body?.firstElementChild as HTMLElement | null;
      return { ...node, child: walk(node.child, inner) };
    }
    // split
    const childEls: HTMLElement[] = [];
    for (const el of Array.from(dom.children) as HTMLElement[]) {
      if (el.classList.contains('split-v') || el.classList.contains('split-h')) continue;
      childEls.push(el);
    }
    const sizes: number[] = [];
    let allHavePct = true;
    for (const el of childEls) {
      const m = el.style.flex.match(/0 0 ([\d.]+)%/);
      if (m) sizes.push(parseFloat(m[1]));
      else { allHavePct = false; break; }
    }
    const newChildren = node.children.map((c, idx) => walk(c, childEls[idx] || null));
    const out: SplitNode = { type: 'split', dir: node.dir, children: newChildren };
    if (allHavePct && sizes.length === node.children.length) out.sizes = sizes;
    return out;
  }
  const root = host.firstElementChild as HTMLElement | null;
  return walk(tree, root);
}

// ── Drag-and-drop wiring ──

function computeZone(rect: DOMRect, x: number, y: number): DropZone {
  const dx = x - rect.left;
  const dy = y - rect.top;
  const w = rect.width;
  const h = rect.height;
  const cx0 = w * 0.3, cx1 = w * 0.7;
  const cy0 = h * 0.3, cy1 = h * 0.7;
  if (dx >= cx0 && dx <= cx1 && dy >= cy0 && dy <= cy1) return 'center';
  const dTop = dy / h;
  const dBottom = (h - dy) / h;
  const dLeft = dx / w;
  const dRight = (w - dx) / w;
  const min = Math.min(dTop, dBottom, dLeft, dRight);
  if (min === dTop) return 'top';
  if (min === dBottom) return 'bottom';
  if (min === dLeft) return 'left';
  return 'right';
}

function ensureOverlay(): HTMLElement {
  let ov = document.getElementById('drop-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'drop-overlay';
  ov.innerHTML = `
    <div class="drop-zone drop-zone-top" data-zone="top"></div>
    <div class="drop-zone drop-zone-right" data-zone="right"></div>
    <div class="drop-zone drop-zone-bottom" data-zone="bottom"></div>
    <div class="drop-zone drop-zone-left" data-zone="left"></div>
    <div class="drop-zone drop-zone-center" data-zone="center"></div>`;
  document.body.appendChild(ov);
  return ov;
}

function showOverlay(rect: DOMRect, zone: DropZone): void {
  const ov = ensureOverlay();
  ov.style.left = `${rect.left}px`;
  ov.style.top = `${rect.top}px`;
  ov.style.width = `${rect.width}px`;
  ov.style.height = `${rect.height}px`;
  ov.style.display = 'block';
  ov.querySelectorAll('.drop-zone').forEach(z => {
    (z as HTMLElement).classList.toggle('active', (z as HTMLElement).dataset.zone === zone);
  });
}

function hideOverlay(): void {
  const ov = document.getElementById('drop-overlay');
  if (ov) ov.style.display = 'none';
}

type DndHost = HTMLElement & {
  __layoutOnChange?: () => void;
  __onPaneSpawned?: (idx: number) => void;
};

export function initLayoutDnd(host: HTMLElement, onChange: () => void): void {
  const h = host as DndHost;
  h.__layoutOnChange = onChange;
  if ((h as DndHost & { __layoutDndInited?: boolean }).__layoutDndInited) return;
  (h as DndHost & { __layoutDndInited?: boolean }).__layoutDndInited = true;

  let sourceIdx: number | null = null;
  let activeTarget: HTMLElement | null = null;
  let activeZone: DropZone | null = null;
  let activeGroupTarget: HTMLElement | null = null;

  function clearGroupHighlight(): void {
    if (activeGroupTarget) {
      activeGroupTarget.classList.remove('group-drop-target');
      activeGroupTarget = null;
    }
  }

  function cleanup(): void {
    sourceIdx = null;
    activeTarget = null;
    activeZone = null;
    clearGroupHighlight();
    hideOverlay();
    document.body.classList.remove('layout-dragging');
    host.querySelectorAll('.layout-dragging').forEach(el => el.classList.remove('layout-dragging'));
  }

  host.addEventListener('dragstart', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); return; }
    const header = (e.target as HTMLElement).closest('.pane-header') as HTMLElement | null;
    if (!header) return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) {
      e.preventDefault();
      return;
    }
    const pane = header.closest('.terminal-pane') as HTMLElement | null;
    if (!pane) return;
    sourceIdx = parseInt(pane.dataset.index!, 10);
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(sourceIdx));
    pane.classList.add('layout-dragging');
    document.body.classList.add('layout-dragging');
  });

  // Multi-select on mousedown: fires before any drag begins, so ctrl-click works
  // even when the browser would otherwise interpret it as a drag start.
  host.addEventListener('mousedown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.button !== 0) return;
    const header = (e.target as HTMLElement).closest('.pane-header') as HTMLElement | null;
    if (!header) return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) return;
    const pane = header.closest('.terminal-pane') as HTMLElement;
    const idx = parseInt(pane.dataset.index!, 10);
    e.preventDefault();
    e.stopPropagation();
    if (selectedPanes.has(idx)) selectedPanes.delete(idx); else selectedPanes.add(idx);
    updateSelectionUI(host);
  });

  host.addEventListener('dragover', (e) => {
    if (sourceIdx === null) return;
    const tgt = e.target as HTMLElement;

    // Group-header drop: drop a worker on a group's title bar to move it inside.
    const groupHeader = tgt.closest('.pane-group-header') as HTMLElement | null;
    if (groupHeader && !tgt.closest('.terminal-pane')) {
      const groupEl = groupHeader.closest('.pane-group') as HTMLElement | null;
      if (groupEl) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        hideOverlay();
        activeTarget = null;
        activeZone = null;
        if (activeGroupTarget !== groupEl) {
          clearGroupHighlight();
          groupEl.classList.add('group-drop-target');
          activeGroupTarget = groupEl;
        }
        return;
      }
    }
    clearGroupHighlight();

    const pane = tgt.closest('.terminal-pane') as HTMLElement | null;
    if (!pane) { hideOverlay(); activeTarget = null; activeZone = null; return; }
    const targetIdx = parseInt(pane.dataset.index!, 10);
    if (targetIdx === sourceIdx) { hideOverlay(); activeTarget = null; activeZone = null; return; }
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const rect = pane.getBoundingClientRect();
    const zone = computeZone(rect, e.clientX, e.clientY);
    activeTarget = pane;
    activeZone = zone;
    showOverlay(rect, zone);
  });

  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node)) {
      hideOverlay();
      clearGroupHighlight();
    }
  });

  host.addEventListener('drop', (e) => {
    e.preventDefault();
    if (sourceIdx === null) { cleanup(); return; }

    // Group-header drop wins when present.
    if (activeGroupTarget) {
      const gid = activeGroupTarget.dataset.groupId!;
      const tree = currentLayout;
      if (tree) {
        const captured = captureSizes(host, tree);
        currentLayout = injectPaneIntoGroup(captured, gid, sourceIdx);
        renderLayout(host, currentLayout);
        h.__layoutOnChange?.();
      }
      cleanup();
      return;
    }

    if (activeTarget === null || activeZone === null) { cleanup(); return; }
    const targetIdx = parseInt(activeTarget.dataset.index!, 10);
    const tree = currentLayout;
    if (tree) {
      const captured = captureSizes(host, tree);
      const next = applyDrop(captured, sourceIdx, targetIdx, activeZone);
      currentLayout = next;
      renderLayout(host, next);
      h.__layoutOnChange?.();
    }
    cleanup();
  });

  host.addEventListener('dragend', cleanup);

  // Tab switching + group actions (delegated). Multi-select is on mousedown above.
  host.addEventListener('click', (e) => {
    if (!currentLayout) return;
    const target = e.target as HTMLElement;

    // Bottom-left dock: click a collapsed-group chip to expand it back inline.
    const chip = target.closest('.collapsed-group-chip') as HTMLElement | null;
    if (chip) {
      e.stopPropagation();
      const gid = chip.dataset.groupId!;
      currentLayout = updateGroup(currentLayout, gid, { collapsed: false });
      renderLayout(host, currentLayout);
      h.__layoutOnChange?.();
      return;
    }

    // Swallow ctrl-click follow-up (selection already toggled on mousedown).
    if (e.ctrlKey || e.metaKey) {
      const header = target.closest('.pane-header') as HTMLElement | null;
      if (header && !target.closest('button, input, select')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const tabBtn = target.closest('[data-action="tab-prev"], [data-action="tab-next"]') as HTMLElement | null;
    if (tabBtn) {
      e.stopPropagation();
      const idx = parseInt(tabBtn.dataset.index!, 10);
      const ctx = findTabsContext(currentLayout, idx);
      if (!ctx) return;
      const pos = ctx.siblings.indexOf(idx);
      const newIdx = tabBtn.dataset.action === 'tab-prev'
        ? ctx.siblings[(pos - 1 + ctx.siblings.length) % ctx.siblings.length]
        : ctx.siblings[(pos + 1) % ctx.siblings.length];
      currentLayout = setActiveTab(currentLayout, newIdx);
      renderLayout(host, currentLayout);
      h.__layoutOnChange?.();
      return;
    }

    const groupBtn = target.closest('[data-action^="group-"]') as HTMLElement | null;
    if (groupBtn) {
      e.stopPropagation();
      const gid = groupBtn.dataset.groupId!;
      const action = groupBtn.dataset.action;
      if (action === 'group-collapse') {
        const captured = captureSizes(host, currentLayout);
        currentLayout = updateGroup(captured, gid, { collapsed: !groupCollapsedById(captured, gid) });
        renderLayout(host, currentLayout);
        h.__layoutOnChange?.();
      } else if (action === 'group-ungroup') {
        const captured = captureSizes(host, currentLayout);
        currentLayout = ungroup(captured, gid);
        if (activeSpace === gid) setActiveSpace('default');
        renderLayout(host, currentLayout);
        h.__layoutOnChange?.();
      } else if (action === 'group-broadcast') {
        const indices = findGroupPanes(currentLayout, gid);
        const text = window.prompt('Broadcast to group:');
        if (text) indices.forEach(i => postJson(`/api/terminal/${i}/send`, { text }));
      }
      return;
    }
  });

  // Inline rename on group name (dblclick).
  host.addEventListener('dblclick', (e) => {
    const nameEl = (e.target as HTMLElement).closest('.pane-group-name') as HTMLElement | null;
    if (!nameEl || !currentLayout) return;
    e.stopPropagation();
    const groupEl = nameEl.closest('.pane-group') as HTMLElement;
    const gid = groupEl.dataset.groupId!;
    const oldName = nameEl.textContent || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pane-group-name-input';
    input.value = oldName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (save: boolean): void => {
      const newName = input.value.trim() || oldName;
      if (save && newName !== oldName && currentLayout) {
        currentLayout = updateGroup(currentLayout, gid, { name: newName });
        renderLayout(host, currentLayout);
        h.__layoutOnChange?.();
      } else {
        renderLayout(host, currentLayout!);
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit(true);
      else if (ev.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  });
}

function groupCollapsedById(tree: LayoutNode, gid: string): boolean {
  function walk(n: LayoutNode): boolean | null {
    if (n.type === 'group') {
      if (n.id === gid) return n.collapsed;
      return walk(n.child);
    }
    if (n.type === 'split') {
      for (const c of n.children) {
        const r = walk(c);
        if (r !== null) return r;
      }
    }
    return null;
  }
  return walk(tree) || false;
}

// ── Spaces (default + group-scoped views) ──

// Hidden offscreen container that holds pane-bodies whose space isn't currently
// rendered. xterm DOM stays alive while parked here, so switching back to the
// space restores the live terminal without losing scrollback.
function getBodyStore(): HTMLElement {
  let store = document.getElementById('pane-body-store');
  if (!store) {
    store = document.createElement('div');
    store.id = 'pane-body-store';
    store.style.display = 'none';
    document.body.appendChild(store);
  }
  return store;
}

// Find a group node by id anywhere in the tree.
export function findGroupNode(tree: LayoutNode | null, gid: string): GroupNode | null {
  if (!tree) return null;
  if (tree.type === 'group') {
    if (tree.id === gid) return tree;
    return findGroupNode(tree.child, gid);
  }
  if (tree.type === 'split') {
    for (const c of tree.children) {
      const r = findGroupNode(c, gid);
      if (r) return r;
    }
  }
  return null;
}

// Collect every group node in the tree (used by the sidebar Spaces list).
export function listGroups(tree: LayoutNode | null): GroupNode[] {
  if (!tree) return [];
  const out: GroupNode[] = [];
  function walk(n: LayoutNode): void {
    if (n.type === 'group') { out.push(n); walk(n.child); }
    else if (n.type === 'split') n.children.forEach(walk);
  }
  walk(tree);
  return out;
}

// In default view, collapsed groups disappear from the inline grid (they live
// in the bottom-left dock instead). Expanded groups stay inline as before.
function stripCollapsedGroups(node: LayoutNode): LayoutNode | null {
  if (node.type === 'pane' || node.type === 'tabs') return node;
  if (node.type === 'group') {
    if (node.collapsed) return null;
    const child = stripCollapsedGroups(node.child);
    if (!child) return null;
    return { ...node, child };
  }
  const kids = node.children.map(stripCollapsedGroups).filter(Boolean) as LayoutNode[];
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { type: 'split', dir: node.dir, sizes: undefined, children: kids };
}

function getSpaceSubtree(tree: LayoutNode | null): LayoutNode | null {
  if (!tree) return null;
  if (activeSpace === 'default') return stripCollapsedGroups(tree);
  const g = findGroupNode(tree, activeSpace);
  return g ? g.child : null;
}

// Inject a pane into a group's subtree (used by drag-into-group-header).
// Detaches the pane from its current location, then appends it inside the
// target group as a row split.
export function injectPaneIntoGroup(tree: LayoutNode, gid: string, paneIdx: number): LayoutNode {
  const detached = detachPane(tree, paneIdx);
  if (!detached.pane || !detached.tree) return tree;
  const newPane: PaneNode = { type: 'pane', index: paneIdx };
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'group' && node.id === gid) {
      // If pane is already inside this group, no-op.
      if (collectPanes(node).has(paneIdx)) return node;
      const newChild: LayoutNode = node.child.type === 'split' && node.child.dir === 'row'
        ? { type: 'split', dir: 'row', children: [...node.child.children, newPane] }
        : { type: 'split', dir: 'row', children: [node.child, newPane] };
      return { ...node, child: newChild };
    }
    if (node.type === 'group') return { ...node, child: walk(node.child) };
    if (node.type === 'split') return { ...node, children: node.children.map(walk) };
    return node;
  }
  return walk(detached.tree);
}

// Append a new pane to the active space. For 'default' it rebuilds the
// ungrouped section as a balanced 2-col grid that includes the new pane —
// previously we just appended as a sibling, which produced asymmetric trees
// (a fresh worker took a full column to itself). Top-level groups are kept
// intact and grafted back to the right of the rebuilt grid. For a group
// space we still just append to the group's child as a row split.
export function addPaneToActiveSpace(tree: LayoutNode | null, paneIdx: number): LayoutNode {
  const newPane: PaneNode = { type: 'pane', index: paneIdx };
  if (!tree) return newPane;
  if (activeSpace === 'default') {
    const topGroups: GroupNode[] = [];
    function collectTopGroups(n: LayoutNode): void {
      if (n.type === 'group') { topGroups.push(n); return; }
      if (n.type === 'split') n.children.forEach(collectTopGroups);
    }
    collectTopGroups(tree);
    const grouped = new Set<number>();
    topGroups.forEach(g => collectPanes(g.child).forEach(i => grouped.add(i)));
    const ungrouped = Array.from(collectPanes(tree)).filter(i => !grouped.has(i)).sort((a, b) => a - b);
    ungrouped.push(paneIdx);
    const ungroupedTree = buildDefaultLayout(ungrouped);
    if (topGroups.length === 0) return ungroupedTree || newPane;
    if (!ungroupedTree) {
      return topGroups.length === 1
        ? topGroups[0]
        : { type: 'split', dir: 'row', children: topGroups };
    }
    return { type: 'split', dir: 'row', children: [ungroupedTree, ...topGroups] };
  }
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'group' && node.id === activeSpace) {
      const newChild: LayoutNode = node.child.type === 'split' && node.child.dir === 'row'
        ? { type: 'split', dir: 'row', children: [...node.child.children, newPane] }
        : { type: 'split', dir: 'row', children: [node.child, newPane] };
      return { ...node, child: newChild };
    }
    if (node.type === 'group') return { ...node, child: walk(node.child) };
    if (node.type === 'split') return { ...node, children: node.children.map(walk) };
    return node;
  }
  return walk(tree);
}

// Drop every captured `sizes` array so all splits revert to flex:1 1 0
// (equal share of their parent). Used by the sidebar "Rebalance" action.
export function clearAllSizes(tree: LayoutNode): LayoutNode {
  if (tree.type === 'pane' || tree.type === 'tabs') return tree;
  if (tree.type === 'group') return { ...tree, child: clearAllSizes(tree.child) };
  return { type: 'split', dir: tree.dir, children: tree.children.map(clearAllSizes) };
}

// Rebuild the current space as a fresh balanced grid.
// Topology-level rebalance (clearAllSizes only flattens sizes within the current
// shape — that breaks down once you have an asymmetric tree like an extra worker
// appended as a third top-level column). For default view: rebuild ungrouped
// panes via buildDefaultLayout, then graft top-level groups back as row-split
// siblings — each group's interior is also rebuilt the same way. For a group
// view: rebuild only that group's interior.
export function rebalanceLayout(tree: LayoutNode): LayoutNode {
  function rebalanceGroupInterior(group: GroupNode): GroupNode {
    const panes = Array.from(collectPanes(group.child)).sort((a, b) => a - b);
    const newChild = buildDefaultLayout(panes);
    return newChild ? { ...group, child: newChild } : group;
  }

  if (activeSpace !== 'default') {
    function walk(n: LayoutNode): LayoutNode {
      if (n.type === 'group' && n.id === activeSpace) return rebalanceGroupInterior(n);
      if (n.type === 'group') return { ...n, child: walk(n.child) };
      if (n.type === 'split') return { ...n, children: n.children.map(walk) };
      return n;
    }
    return walk(tree);
  }

  const topGroups: GroupNode[] = [];
  function collectTopGroups(n: LayoutNode): void {
    if (n.type === 'group') { topGroups.push(n); return; }
    if (n.type === 'split') n.children.forEach(collectTopGroups);
  }
  collectTopGroups(tree);

  const grouped = new Set<number>();
  topGroups.forEach(g => collectPanes(g.child).forEach(i => grouped.add(i)));
  const ungrouped = Array.from(collectPanes(tree)).filter(i => !grouped.has(i)).sort((a, b) => a - b);

  const rebalancedGroups = topGroups.map(rebalanceGroupInterior);
  const ungroupedTree = buildDefaultLayout(ungrouped);

  if (rebalancedGroups.length === 0) return ungroupedTree || tree;
  if (!ungroupedTree) {
    return rebalancedGroups.length === 1
      ? rebalancedGroups[0]
      : { type: 'split', dir: 'row', children: rebalancedGroups };
  }
  return { type: 'split', dir: 'row', children: [ungroupedTree, ...rebalancedGroups] };
}

export function setActiveSpace(space: string): void {
  setState('activeSpace', space);
}

export function renderLayout(host: HTMLElement, tree: LayoutNode): void {
  // 1. Collect pane-bodies from host AND offscreen store so xterm survives space switches.
  const bodies = new Map<number, HTMLElement>();
  const collect = (root: HTMLElement): void => {
    root.querySelectorAll('.pane-body').forEach(b => {
      const m = (b as HTMLElement).id.match(/^term-(\d+)$/);
      if (m) { bodies.set(Number(m[1]), b as HTMLElement); b.remove(); }
    });
  };
  collect(host);
  collect(getBodyStore());

  // 1b. Ensure every pane in the FULL tree has a body somewhere — even panes
  // that aren't visible in the current space need an attachable DOM node so
  // xterm.open() succeeds on first launch (those bodies live in the offscreen
  // store until their space is opened).
  const allIndices = collectPanes(tree);
  allIndices.forEach(idx => {
    if (!bodies.has(idx)) {
      const body = document.createElement('div');
      body.className = 'pane-body';
      body.id = `term-${idx}`;
      bodies.set(idx, body);
    }
  });

  // 2. Resolve subtree for the active space.
  host.innerHTML = '';
  const subtree = getSpaceSubtree(tree);

  if (!subtree) {
    const empty = document.createElement('div');
    empty.className = 'space-empty';
    empty.textContent = activeSpace === 'default'
      ? 'No workers visible. Expand a group from the dock or click + Worker.'
      : 'No workers in this group yet. Click + Worker on its sidebar card.';
    host.appendChild(empty);
    bodies.forEach(b => getBodyStore().appendChild(b));
    renderCollapsedDock(host, tree);
    return;
  }

  const root = buildNode(subtree, null, host);
  root.style.flex = '1 1 0';
  host.appendChild(root);

  const used = new Set<number>();
  bodies.forEach((body, idx) => {
    const slot = host.querySelector(`#term-${idx}`);
    if (slot && slot !== body) { slot.replaceWith(body); used.add(idx); }
  });
  const store = getBodyStore();
  bodies.forEach((body, idx) => { if (!used.has(idx)) store.appendChild(body); });

  renderCollapsedDock(host, tree);
  updateSelectionUI(host);
}

// Bottom-left dock that surfaces every collapsed group as a compact chip.
// Only visible in the default view — the group view is a zoom and has no use
// for the dock.
function renderCollapsedDock(host: HTMLElement, tree: LayoutNode): void {
  const old = host.querySelector(':scope > .collapsed-groups-dock');
  if (old) old.remove();
  if (activeSpace !== 'default') return;
  const groups = listGroups(tree).filter(g => g.collapsed);
  if (groups.length === 0) return;
  const dock = document.createElement('div');
  dock.className = 'collapsed-groups-dock';
  groups.forEach(g => {
    const chip = document.createElement('button');
    chip.className = 'collapsed-group-chip';
    chip.dataset.groupId = g.id;
    chip.style.setProperty('--group-color', g.color);
    chip.title = `Expand ${g.name}`;
    chip.innerHTML = `
      <span class="collapsed-group-dot"></span>
      <span class="collapsed-group-name">${escapeHtml(g.name)}</span>
      <span class="collapsed-group-count">${collectPanes(g.child).size}</span>
      ${ICONS.chevronRight}`;
    dock.appendChild(chip);
  });
  host.appendChild(dock);
}
