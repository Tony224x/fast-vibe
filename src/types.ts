import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';

export interface Settings {
  workers: number;
  previewUrl: string;
  engine: 'claude' | 'kiro';
  trustMode: boolean;
  useWSL: boolean;
  autoFocus: boolean;
  autoFollow: boolean;
  theme: 'dark' | 'light' | 'system';
  suggestMode: 'off' | 'static' | 'ai';
  logsEnabled: boolean;
  // Si true, le serveur Node spawn automatiquement le sidecar Python
  // scripts/whisper_sidecar.py au boot et le kill au shutdown. Si false,
  // l'user doit le lancer lui-même (ou il n'y a pas de transcription).
  localSTT: boolean;
  // Compactage auto des workers claude restés silencieux (aucun output) plus
  // de N minutes alors qu'ils sont au prompt. 0 = désactivé (default). Réduit
  // la RAM des workers idle dont le contexte ne fait que grossir.
  autoCompactIdleMin: number;
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
  // Timestamp ms du dernier spawn — utilisé par _scheduleRestart pour
  // détecter un exit "fast-fail" (<10s = --resume cassé probable).
  startedAtMs?: number | null;
  // Timestamp ms du dernier output PTY (onData) — sert à mesurer l'inactivité
  // pour l'auto-compactage. Mis à jour à chaque chunk reçu du worker.
  lastActivityMs?: number;
  // True après un /compact auto pendant une période d'idle. Reset à la
  // prochaine entrée utilisateur réelle (nouveau travail), pas par l'output
  // du compact lui-même — évite de re-compacter en boucle un worker silencieux.
  compactedWhileIdle?: boolean;
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
  // Timer du restart différé (fast-fail recovery ou backoff exponentiel).
  // Stocké pour pouvoir être cleared dans kill()/killAll() — sinon un slot
  // tué pendant son délai de restart resuscite tout seul 500ms-12s après.
  restartTimer?: ReturnType<typeof setTimeout> | null;
  // Watchdog de démarrage : si après N secondes le PTY est vivant mais n'a
  // émis AUCUN octet (chunksTotalLen===0), on prévient l'utilisateur que le
  // worker est bloqué (binaire introuvable/qui hang) au lieu d'un pane muet.
  startupTimer?: ReturnType<typeof setTimeout> | null;
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
  role: 'worker';
  suggestion: Suggestion | null;
  // True quand le slot a épuisé son budget de restarts. Le frontend
  // affiche un état "crashed" et un bouton restart manuel.
  crashed?: boolean;
}

export interface LaunchOptions {
  engine?: 'claude' | 'kiro';
  trustMode?: boolean;
  useWSL?: boolean;
  suggestMode?: 'off' | 'static' | 'ai';
  logsEnabled?: boolean;
  autoCompactIdleMin?: number;
}

export interface Profile {
  name: string;
  settings: Partial<Settings> & { cwd?: string };
}

export const DEFAULTS: Settings = {
  workers: 4,
  previewUrl: '',
  engine: 'claude',
  trustMode: false,
  useWSL: false,
  autoFocus: true,
  autoFollow: false,
  theme: 'dark',
  suggestMode: 'off',
  logsEnabled: false,
  localSTT: false,
  autoCompactIdleMin: 0,
};
