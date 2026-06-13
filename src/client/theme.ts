import { theme, terminals } from './state';

// Palettes ANSI calmes & sémantiquement honnêtes : bleu=bleu, jaune=jaune,
// cyan=cyan — accordées au fond warm-dark mais lisibles. L'orange (--brand)
// ne sert QUE de curseur (pas de slot ANSI), pour que la couleur de marque
// reste un "verbe" et que les TUI 256-couleurs restent justes.
export const THEME_DARK = {
  background: '#1E1A17', foreground: '#EDE6DC', cursor: '#e95d0c', cursorAccent: '#1E1A17',
  selectionBackground: 'rgba(237, 230, 220, 0.14)',
  selectionInactiveBackground: 'rgba(237, 230, 220, 0.08)',
  black: '#3A322D', red: '#E5705F', green: '#6FB36A', yellow: '#D9A441',
  blue: '#6CA0C7', magenta: '#C18FD6', cyan: '#5FB0A8', white: '#C9BFB3',
  brightBlack: '#8A7E74', brightRed: '#F0997F', brightGreen: '#8FCB86', brightYellow: '#E6BC72',
  brightBlue: '#8FB6DC', brightMagenta: '#D2A8E6', brightCyan: '#82C8C0', brightWhite: '#F5EFE8',
};

export const THEME_LIGHT = {
  background: '#F5EFE8', foreground: '#2A2420', cursor: '#e95d0c', cursorAccent: '#F5EFE8',
  selectionBackground: 'rgba(42, 36, 32, 0.10)',
  selectionInactiveBackground: 'rgba(42, 36, 32, 0.06)',
  black: '#2A2420', red: '#C0392B', green: '#2E7D43', yellow: '#A9722A',
  blue: '#2E5C9A', magenta: '#7B4FB0', cyan: '#2E8077', white: '#564943',
  brightBlack: '#8A7E78', brightRed: '#D04A3A', brightGreen: '#3E9456', brightYellow: '#B07D22',
  brightBlue: '#3D6FB0', brightMagenta: '#8F5FC4', brightCyan: '#3A968B', brightWhite: '#2A2420',
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
