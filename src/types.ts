import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';

export interface Settings {
  workers: number;
  previewUrl: string;
  engine: 'claude' | 'kiro';
  noPilot: boolean;
  trustMode: boolean;
  useWSL: boolean;
  autoFocus: boolean;
  autoFollow: boolean;
  theme: 'dark' | 'light' | 'system';
  suggestMode: 'off' | 'static' | 'ai';
  logsEnabled: boolean;
  lastCwd?: string;
}

export interface Bookmark {
  path: string;
  name: string;
}

export interface Slot {
  pty: IPty | null;
  ws: WebSocket | null;
  startedAt: string | null;
  chunks: string[];
  chunksTotalLen: number;
  joinedCache: string;
  dirty: boolean;
  restartCount: number;
  removed?: boolean;
}

export interface Suggestion {
  text: string;
  source: 'static' | 'ai';
  pending: boolean;
}

export interface SuggesteurState {
  pty: IPty | null;
  chunks: string[];
  chunksTotalLen: number;
  joinedCache: string;
  dirty: boolean;
  ready: boolean;
}

export interface TerminalStatus {
  id: number;
  pid: number | null;
  alive: boolean;
  startedAt: string | null;
  role: 'pilot' | 'worker';
  suggestion: Suggestion | null;
}

export interface LaunchOptions {
  engine?: 'claude' | 'kiro';
  noPilot?: boolean;
  trustMode?: boolean;
  useWSL?: boolean;
  suggestMode?: 'off' | 'static' | 'ai';
  logsEnabled?: boolean;
}

export interface Profile {
  name: string;
  settings: Partial<Settings> & { cwd?: string };
}

export const DEFAULTS: Settings = {
  workers: 4,
  previewUrl: '',
  engine: 'claude',
  noPilot: false,
  trustMode: false,
  useWSL: false,
  autoFocus: true,
  autoFollow: false,
  theme: 'dark',
  suggestMode: 'off',
  logsEnabled: false,
};
