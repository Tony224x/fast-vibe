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
  // Cache du buffer ANSI-strippé pour getOutput() — invalidé en même temps
  // que joinedCache via le flag dirty. Évite le re-strip à chaque appel.
  strippedCache: string;
  restartCount: number;
  removed?: boolean;
  // UUID v4 — passé à `claude --session-id <uuid>` au 1er lancement,
  // puis utilisé avec `claude --resume <uuid>` pour reprendre la conversation
  // après redémarrage du serveur. Null pour kiro (pas de session id).
  sessionId?: string | null;
  // true si le prochain spawn doit faire --resume (session déjà existante côté
  // claude), false si --session-id (création fresh avec id contrôlé).
  resume?: boolean;
  // Slot marqué crashed après épuisement du retry budget (3 tentatives).
  // L'utilisateur doit restart manuellement. Reset au spawn réussi.
  crashed?: boolean;
  // True quand on a sauté un envoi WS pour cause de backpressure. Le
  // prochain envoi doit alors push le buffer complet pour resync xterm.
  wsDesynced?: boolean;
  // Timer du \r différé après bracketed-paste dans sendInput. On le clear
  // avant chaque nouveau set pour ne pas accumuler des Enter en rafale.
  pendingEnterTimer?: ReturnType<typeof setTimeout> | null;
  // Timer qui reset restartCount après uptime stable (60s). Permet de ne
  // pas brûler le retry budget sur des crashes espacés dans le temps.
  uptimeTimer?: ReturnType<typeof setTimeout> | null;
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
  // True quand le slot a épuisé son budget de restarts. Le frontend
  // affiche un état "crashed" et un bouton restart manuel.
  crashed?: boolean;
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
