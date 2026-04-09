import { focusedIndex, noPilot, workerCount, launched, unreadTerminals } from './state';
import { escapeHtml, elapsed, postJson } from './utils';
import { setFocused, updatePaneDot } from './terminal';
import { compactTerminal, clearTerminal, inlineConfirm } from './ui-helpers';

export const miniMapData: Record<number, string> = {};

export let sidebarConfirming = false;

export let tabHidden = false;
document.addEventListener('visibilitychange', () => { tabHidden = document.hidden; });

export function updateSidebar(statuses: Array<{id: number; pid: number | null; alive: boolean; startedAt: string | null; role: string; suggestion?: {text: string; pending: boolean} | null}>): void {
  // Don't rebuild if an inline confirm is pending — it would wipe the "Confirm?" state
  if (sidebarConfirming) return;

  const html = statuses.map((s, i) => {
    const label = s.role === 'pilot' ? 'Pilot' : (noPilot ? `Worker ${i + 1}` : `Worker ${i}`);
    const pid = Number.isFinite(s.pid) ? s.pid : '-';
    const elapsedStr = s.alive ? escapeHtml(elapsed(s.startedAt)) : 'stopped';
    const isUnread = unreadTerminals.has(i) ? ' has-unread' : '';
    const miniPreview = miniMapData[i] ? `<div class="status-card-preview">${escapeHtml(miniMapData[i])}</div>` : '';
    return `
    <div class="status-card ${i === focusedIndex ? 'active' : ''} ${s.role === 'pilot' ? 'pilot-card' : ''}${isUnread}"
         data-index="${i}" draggable="true">
      <div class="status-card-header">
        <span class="status-dot ${s.alive ? 'alive' : 'dead'}"></span>
        <strong>${escapeHtml(label)}</strong>
      </div>
      <div class="status-card-info">
        PID: ${pid} &middot; ${elapsedStr}
      </div>
      ${miniPreview}
      ${s.alive ? `<div class="status-card-actions">
        <button class="btn-ctx" data-ctx-action="compact" data-index="${i}" title="Compact context">&#8860; compact</button>
        <button class="btn-ctx btn-ctx-danger" data-ctx-action="clear" data-index="${i}" title="Clear context">&#8855; clear</button>
      </div>` : ''}
      ${s.suggestion ? `<div class="suggest-bar${s.suggestion.pending ? ' pending' : ''}" data-worker="${i}">
        <div class="suggest-text" title="${escapeHtml(s.suggestion.text)}">${escapeHtml(s.suggestion.text)}</div>
        <div class="suggest-actions">
          <button class="btn-suggest-send" data-suggest-action="send" data-index="${i}">Send</button>
          <button class="btn-suggest-edit" data-suggest-action="edit" data-index="${i}">Edit</button>
          <button class="btn-suggest-dismiss" data-suggest-action="dismiss" data-index="${i}">&times;</button>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  const list = document.getElementById('status-list')!;
  list.innerHTML = html;
  initSidebarDragDrop(list);
}

export async function pollStatus(): Promise<void> {
  if (!launched || tabHidden) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateSidebar(data.terminals);
    data.terminals.forEach((s: {id: number; alive: boolean}) => updatePaneDot(s.id, s.alive));
  } catch {}
}

export async function pollMiniMap(): Promise<void> {
  if (!launched || tabHidden) return;
  const total = noPilot ? workerCount : 1 + workerCount;
  await Promise.all(Array.from({ length: total }, (_, i) =>
    fetch(`/api/terminal/${i}/output?last=200`)
      .then(r => r.json())
      .then(data => {
        const lines = (data.output as string).trim().split('\n');
        miniMapData[i] = lines.slice(-3).join('\n').slice(0, 120);
      })
      .catch(() => { miniMapData[i] = ''; })
  ));
}

export function initSidebarDragDrop(container: HTMLElement): void {
  const cards = container.querySelectorAll('.status-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', (e: Event) => {
      const de = e as DragEvent;
      (card as HTMLElement).classList.add('dragging');
      de.dataTransfer!.setData('text/plain', (card as HTMLElement).dataset.index!);
      de.dataTransfer!.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      (card as HTMLElement).classList.remove('dragging');
      container.querySelectorAll('.status-card').forEach(c => (c as HTMLElement).classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e: Event) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'move';
      (card as HTMLElement).classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
      (card as HTMLElement).classList.remove('drag-over');
    });
    card.addEventListener('drop', (e: Event) => {
      e.preventDefault();
      (card as HTMLElement).classList.remove('drag-over');
      const de = e as DragEvent;
      const fromIdx = de.dataTransfer!.getData('text/plain');
      const fromCard = container.querySelector(`.status-card[data-index="${fromIdx}"]`);
      if (fromCard && fromCard !== card) {
        const rect = (card as HTMLElement).getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (de.clientY < midY) {
          container.insertBefore(fromCard, card);
        } else {
          container.insertBefore(fromCard, (card as HTMLElement).nextSibling);
        }
      }
    });
  });
}

// Event delegation for sidebar actions (survives innerHTML rebuilds)
export function initSidebarClickDelegation(): void {
  document.getElementById('status-list')!.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest('.status-card') as HTMLElement | null;
    const btn = target.closest('[data-ctx-action]') as HTMLElement | null;
    const suggestBtn = target.closest('[data-suggest-action]') as HTMLElement | null;
    if (suggestBtn) {
      e.stopPropagation();
      const idx = parseInt(suggestBtn.dataset.index!, 10);
      const action = suggestBtn.dataset.suggestAction;
      if (action === 'send') {
        const bar = suggestBtn.closest('.suggest-bar')!;
        const input = bar.querySelector('.suggest-input') as HTMLInputElement | null;
        const text = input ? input.value : bar.querySelector('.suggest-text')?.textContent;
        if (text) postJson(`/api/suggest/${idx}/send`, { text });
      } else if (action === 'edit') {
        const bar = suggestBtn.closest('.suggest-bar')!;
        const textEl = bar.querySelector('.suggest-text') as HTMLElement | null;
        if (textEl && !bar.querySelector('.suggest-input')) {
          const val = textEl.textContent || '';
          textEl.innerHTML = `<input class="suggest-input" type="text" value="${escapeHtml(val)}" spellcheck="false">`;
          const input = textEl.querySelector('.suggest-input') as HTMLInputElement;
          input.focus();
          input.select();
          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              postJson(`/api/suggest/${idx}/send`, { text: input.value });
            } else if (ev.key === 'Escape') {
              postJson(`/api/suggest/${idx}/dismiss`);
            }
          });
        }
      } else if (action === 'dismiss') {
        postJson(`/api/suggest/${idx}/dismiss`);
      }
    } else if (btn) {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index!, 10);
      const action = btn.dataset.ctxAction;
      if (action === 'compact') compactTerminal(idx);
      else if (action === 'clear') {
        sidebarConfirming = true;
        inlineConfirm(btn, () => { clearTerminal(idx); sidebarConfirming = false; });
        // Auto-reset if user doesn't confirm within timeout
        setTimeout(() => { sidebarConfirming = false; }, 2200);
      }
    } else if (card) {
      setFocused(parseInt(card.dataset.index!, 10));
    }
  });
}
