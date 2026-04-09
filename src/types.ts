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
  theme: 'dark' | 'light' | 'system';
  suggestMode: 'off' | 'static' | 'ai';
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
}

export const DEFAULTS: Settings = {
  workers: 4,
  previewUrl: '',
  engine: 'claude',
  noPilot: false,
  trustMode: false,
  useWSL: false,
  autoFocus: true,
  theme: 'dark',
  suggestMode: 'off',
};
