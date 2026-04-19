export interface TerminalEntry {
  term: Terminal;
  fitAddon: FitAddon.FitAddon;
  searchAddon: SearchAddon.SearchAddon | null;
  ws: WebSocket | null;
  index: number;
  lastBodyW?: number;
  lastBodyH?: number;
  lastCols?: number;
  lastRows?: number;
  followMode: boolean;
}

export let workerCount = 4;
export let previewUrl = '';
export let engine = 'claude';
export let noPilot = false;
export let trustMode = false;
export let useWSL = false;
export let autoFocus = true;
export let autoFollow = false;
export let theme = 'dark';
export let suggestMode = 'off';
export let expandedIndex = -1;
export let focusedIndex = 0;
export let launched = false;
export let launchTimestamp = 0;
export let previewVisible = false;
export let lastUserInputAt = 0;
export let sidebarWidth = 240;
export let sessionTimerInterval: ReturnType<typeof setInterval> | null = null;

export const terminals: TerminalEntry[] = [];
export const textDecoder = new TextDecoder();
export const unreadTerminals = new Set<number>();

const setters = {
  workerCount:     (v: number) => { workerCount = v; },
  previewUrl:      (v: string) => { previewUrl = v; },
  engine:          (v: string) => { engine = v; },
  noPilot:         (v: boolean) => { noPilot = v; },
  trustMode:       (v: boolean) => { trustMode = v; },
  useWSL:          (v: boolean) => { useWSL = v; },
  autoFocus:       (v: boolean) => { autoFocus = v; },
  autoFollow:      (v: boolean) => { autoFollow = v; },
  theme:           (v: string) => { theme = v; },
  suggestMode:     (v: string) => { suggestMode = v; },
  expandedIndex:   (v: number) => { expandedIndex = v; },
  focusedIndex:    (v: number) => { focusedIndex = v; },
  launched:        (v: boolean) => { launched = v; },
  launchTimestamp:  (v: number) => { launchTimestamp = v; },
  previewVisible:  (v: boolean) => { previewVisible = v; },
  lastUserInputAt: (v: number) => { lastUserInputAt = v; },
  sidebarWidth:    (v: number) => { sidebarWidth = v; },
  sessionTimerInterval: (v: ReturnType<typeof setInterval> | null) => { sessionTimerInterval = v; },
} as const;

export type StateKey = keyof typeof setters;

export function setState<K extends StateKey>(key: K, value: Parameters<(typeof setters)[K]>[0]): void {
  (setters[key] as (v: Parameters<(typeof setters)[K]>[0]) => void)(value);
}
