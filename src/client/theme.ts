import { theme, terminals } from './state';

export const THEME_DARK = {
  background: '#1E1A17', foreground: '#F5EFE8', cursor: '#E8601A', cursorAccent: '#1E1A17',
  selectionBackground: 'rgba(232, 96, 26, 0.25)',
  black: '#3D3530', red: '#ff7b72', green: '#3fb950', yellow: '#E8601A',
  blue: '#F0843F', magenta: '#bc8cff', cyan: '#D4C9BD', white: '#F5EFE8',
  brightBlack: '#8A7E74', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#F0843F',
  brightBlue: '#E8601A', brightMagenta: '#d2a8ff', brightCyan: '#D4C9BD', brightWhite: '#FFFFFF',
};

export const THEME_LIGHT = {
  background: '#F5EFE8', foreground: '#2A2420', cursor: '#E8601A', cursorAccent: '#F5EFE8',
  selectionBackground: 'rgba(232, 96, 26, 0.2)',
  black: '#2A2420', red: '#d1242f', green: '#1a7f37', yellow: '#C44A0E',
  blue: '#C44A0E', magenta: '#8250df', cyan: '#8A7E74', white: '#F5EFE8',
  brightBlack: '#8A7E74', brightRed: '#ff8182', brightGreen: '#3fb950', brightYellow: '#E8601A',
  brightBlue: '#F0843F', brightMagenta: '#bc8cff', brightCyan: '#D4C9BD', brightWhite: '#FFFFFF',
};

export function resolveTheme(): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme as 'dark' | 'light';
}

export function getXtermTheme(): typeof THEME_DARK {
  return resolveTheme() === 'light' ? THEME_LIGHT : THEME_DARK;
}

export function applyTheme(): void {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  const xtermTheme = resolved === 'light' ? THEME_LIGHT : THEME_DARK;
  terminals.forEach(t => { if (t) t.term.options.theme = xtermTheme; });
}
