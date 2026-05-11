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
  // UUID v4 — passé à `claude --session-id <uuid>` au 1er lancement,
  // puis utilisé avec `claude --resume <uuid>` pour reprendre la conversation
  // après redémarrage du serveur. Null pour kiro (pas de session id).
  sessionId?: string | null;
  // true si le prochain spawn doit faire --resume (session déjà existante côté
  // claude), false si --session-id (création fresh avec id contrôlé).
  resume?: boolean;
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
  noPilot: true,
  trustMode: false,
  useWSL: false,
  autoFocus: true,
  autoFollow: false,
  theme: 'dark',
  suggestMode: 'off',
  logsEnabled: false,
};
