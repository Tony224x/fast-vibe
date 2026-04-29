export function openHelp(): void {
  document.getElementById('help-overlay')?.classList.remove('hidden');
}

export function closeHelp(): void {
  document.getElementById('help-overlay')?.classList.add('hidden');
}

export function isHelpOpen(): boolean {
  const el = document.getElementById('help-overlay');
  return !!el && !el.classList.contains('hidden');
}

export function initHelp(): void {
  document.getElementById('btn-help')?.addEventListener('click', openHelp);
  document.getElementById('btn-help-close')?.addEventListener('click', closeHelp);
  document.getElementById('help-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'help-overlay') closeHelp();
  });
}
