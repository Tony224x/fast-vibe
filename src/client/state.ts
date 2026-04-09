import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';

export interface TerminalEntry {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon | null;
  ws: WebSocket | null;
  index: number;
  lastBodyW?: number;
  lastBodyH?: number;
  lastCols?: number;
  lastRows?: number;
}

export let workerCount = 4;
export let previewUrl = '';
export let engine = 'claude';
export let noPilot = false;
export let trustMode = false;
export let useWSL = false;
export let autoFocus = true;
export let theme = 'dark';
export let suggestMode = 'off';
export let expandedIndex = -1;
export let focusedIndex = 0;
export let launched = false;
export let launchTimestamp = 0;
export let previewVisible = false;
export let lastUserInputAt = 0;
export let sidebarWidth = 240;

export const terminals: TerminalEntry[] = [];
export const textDecoder = new TextDecoder();
export const unreadTerminals = new Set<number>();

const setters: Record<string, (v: any) => void> = {
  workerCount:     (v) => { workerCount = v; },
  previewUrl:      (v) => { previewUrl = v; },
  engine:          (v) => { engine = v; },
  noPilot:         (v) => { noPilot = v; },
  trustMode:       (v) => { trustMode = v; },
  useWSL:          (v) => { useWSL = v; },
  autoFocus:       (v) => { autoFocus = v; },
  theme:           (v) => { theme = v; },
  suggestMode:     (v) => { suggestMode = v; },
  expandedIndex:   (v) => { expandedIndex = v; },
  focusedIndex:    (v) => { focusedIndex = v; },
  launched:        (v) => { launched = v; },
  launchTimestamp:  (v) => { launchTimestamp = v; },
  previewVisible:  (v) => { previewVisible = v; },
  lastUserInputAt: (v) => { lastUserInputAt = v; },
  sidebarWidth:    (v) => { sidebarWidth = v; },
};

export function setState(key: string, value: unknown): void {
  const setter = setters[key];
  if (setter) setter(value);
}
