import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import type { WebSocket } from 'ws';

import { matchStaticSuggestion } from './suggest-patterns';
import type { Slot, Suggestion, SuggesteurState, TerminalStatus, LaunchOptions } from './types';

export const MAX_BUFFER = 50 * 1024;
// Cap dur sur le nombre de workers vivants (hors tombstones).
// Chaque worker = une instance Claude Code complète (~150-400 MB). Sans cap,
// addWorker peut être appelé indéfiniment et faire exploser la RAM machine.
export const MAX_WORKERS = 8;
// Kiro TUI redessine fréquemment (~10×/s avec spinners + status bars) avec
// des séquences ANSI lourdes. On augmente la cible buffer pour ce moteur
// afin de réduire les rotations et préserver l'historique au reattach.
const MAX_BUFFER_KIRO = 200 * 1024;
const WS_HIGH_WATER = 128 * 1024;
// Décalage entre deux spawns successifs au lancement/restore. Sur Windows,
// spawner N PTY (ConPTY) + N claude.exe simultanément crée un pic CPU/disque
// qui ralentit le démarrage et fiabilise mal chaque worker. On échelonne les
// spawns au-delà du premier pour lisser le pic. Le premier worker est spawné
// de façon synchrone (réactivité + état immédiat pour les tests).
const SPAWN_STAGGER_MS = 150;
// ANSI escape sequences :
//   - CSI:  ESC [ ... final-byte (0x40-0x7e) — séquences couleur, curseur, etc.
//   - OSC:  ESC ] ... terminator (BEL=0x07 OU ST=ESC \\) — titre, hyperlinks, OSC 52
//   - DCS:  ESC P ... ST — Device Control String (sixel, etc.)
//   - APC:  ESC _ ... ST — Application Program Command (Kitty graphics)
//   - PM:   ESC ^ ... ST — Privacy Message
//   - charset: ESC ( B / ESC ) B — sélection de table
//   - ESC =, ESC > — keypad mode
//   - ESC #8 — DECALN (test fill)
//   - solo \r (carriage return) — éliminé pour cohérence avec stripAnsi
export const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-B]|\x1b[=>]|\x1b#\d|\r/g;

function safeWrite(proc: IPty | null, data: string): void {
  try {
    if (proc) proc.write(data);
  } catch {
    // PTY already exited — ignore
  }
}

function log(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

const SUGGEST_PROMPT_FILE = path.join(__dirname, '..', '.suggest-prompt.md');

export class PtyManager {
  count: number;
  cwd: string;
  slots: Slot[];
  engine: string;
  trustMode: boolean;
  useWSL: boolean;
  suggestMode: string;
  suggesteur: SuggesteurState | null;
  suggestions: Record<number, Suggestion>;
  suggestQueue: Array<{ workerId: number; output: string }>;
  suggestBusy: boolean;
  logsEnabled: boolean;
  logsDir: string;
  autoRestart: boolean;
  // Seuil d'inactivité (minutes) avant auto-compactage d'un worker claude
  // idle. 0 = désactivé. Voir Settings.autoCompactIdleMin.
  autoCompactIdleMin: number;
  private _compactSweepTimer: ReturnType<typeof setInterval> | null = null;
  // Buffer cap par slot, calibré selon l'engine actif. Kiro TUI a besoin de
  // plus pour préserver l'historique TUI complet entre rotations.
  maxBuffer: number;
  // Cache de résolution de binaires (Windows : node-pty ne résout pas
  // PATHEXT — il faut un path absolu ou l'extension exacte).
  private _binaryCache: Map<string, string> = new Map();
  // Jeton de génération incrémenté à chaque launchAll/restoreAll/killAll. Les
  // spawns échelonnés (différés via setTimeout) vérifient ce jeton avant de
  // s'exécuter — si un stop/relaunch a eu lieu entre-temps, le spawn obsolète
  // est annulé (sinon il ressusciterait un worker dans une grille déjà détruite).
  private _launchGen: number = 0;
  // Timers des spawns échelonnés en vol, clearés dans killAll().
  private _staggerTimers: Array<ReturnType<typeof setTimeout>> = [];
  // Notification de mutation d'état (pour persistance .session-state.json)
  onStateChange?: () => void;

  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
    this.engine = 'claude';
    this.trustMode = false;
    this.useWSL = false;
    this.suggestMode = 'off';
    this.logsEnabled = false;
    this.logsDir = '';
    this.autoRestart = true;
    this.autoCompactIdleMin = 0;
    this.maxBuffer = MAX_BUFFER;
    // Suggesteur state
    this.suggesteur = null;
    this.suggestions = {};
    this.suggestQueue = [];
    this.suggestBusy = false;
  }

  private notifyStateChange(): void {
    try { this.onStateChange?.(); } catch (e: unknown) {
      log('state-change-error', (e as Error).message);
    }
  }

  // Spawn une liste d'indices de slots en échelonnant les spawns au-delà du
  // premier (voir SPAWN_STAGGER_MS) pour lisser le pic ConPTY/CPU au démarrage.
  // Le 1er est synchrone (réactivité + état immédiat pour les tests) ; les
  // suivants sont différés et gardés par le jeton de génération courant — un
  // stop/relaunch entre-temps les annule.
  private _spawnStaggered(indices: number[]): void {
    if (indices.length === 0) return;
    const gen = this._launchGen;
    this.spawn(indices[0], this.cwd);
    for (let k = 1; k < indices.length; k++) {
      const index = indices[k];
      const timer = setTimeout(() => {
        if (gen !== this._launchGen) return; // génération obsolète → annulé
        const slot = this.slots[index];
        if (!slot || slot.removed) return;
        this.spawn(index, this.cwd);
      }, k * SPAWN_STAGGER_MS);
      timer.unref?.();
      this._staggerTimers.push(timer);
    }
  }

  spawn(index: number, cwd?: string): IPty | null {
    if (index >= this.slots.length) return null;
    const slot = this.slots[index];
    if (slot.pty) return slot.pty;

    const workdir = cwd || this.cwd;

    // ── Stratégie de spawn par engine ──
    //
    // Pour Kiro (TUI lourd, pas de session id) : on spawn `kiro-cli` directement
    // sans passer par un shell wrapper. Conséquences :
    //  - onExit reflète exactement la fin du process Kiro (pas le shell parent)
    //  - Pas de "retomber dans le shell" si Kiro plante : le slot est marqué
    //    inactif et le retry est pertinent.
    //  - Plus de prompt detection ($#>) qui peut fire sur du contenu Kiro.
    //
    // Pour Claude : on garde le shell parent à cause des aliases (doskey/alias)
    // et de la commande complexe (--session-id, etc.) qui sont plus simples à
    // composer en shell que en argv.
    //
    // Pour le suggesteur (Claude headless) : utilise toujours le shell wrapper.
    let proc: IPty;
    let launch: ReturnType<typeof this._buildLaunch>;
    try {
      launch = this._buildLaunch(workdir, slot);
      proc = pty.spawn(launch.shell, launch.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: launch.cwd,
        env: process.env as Record<string, string>,
      });
    } catch (e: unknown) {
      const msg = (e as Error).message || 'unknown error';
      // Message contextuel — l'erreur "File not found:" de CreateProcess est
      // cryptique sans indiquer ce qu'on tentait de lancer. On annote.
      const annotated = `spawn failed: ${msg}`;
      log('spawn-error', `index=${index} ${annotated}`);
      // Notifier l'utilisateur dans le terminal (au lieu d'un slot vide
      // silencieux). Marquer crashed pour stopper le retry automatique :
      // une erreur de spawn est en général un problème permanent (binaire
      // introuvable, perms, etc.) que le retry ne résoudra pas.
      slot.crashed = true;
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[31m[fast-vibe] ${annotated}\x1b[0m\r\n`);
        }
      } catch { /* ws gone */ }
      return null;
    }

    slot.pty = proc;
    slot.startedAt = new Date().toISOString();
    slot.startedAtMs = Date.now();
    slot.lastActivityMs = Date.now();
    slot.compactedWhileIdle = false;
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.strippedCache = '';
    slot.dirty = false;
    slot.crashed = false;
    slot.wsDesynced = false;
    // pty.spawn a réussi → à partir de maintenant la session existe (ou est en
    // train d'être créée par claude). Les prochains lancements doivent donc
    // faire --resume. On le pose ICI (pas dans _buildLaunch) pour qu'un spawn
    // qui throw ne poisonne pas le flag (cf. _buildLaunch).
    if (this.engine === 'claude' && slot.sessionId) slot.resume = true;
    log('spawn', `worker-${index} pid=${proc.pid} cwd=${workdir} engine=${this.engine} mode=${launch.mode}`);

    // Reset restartCount après 60s d'uptime stable. Évite que des crashes
    // espacés (ex: une fois par heure) finissent par épuiser le budget retry.
    if (slot.uptimeTimer) clearTimeout(slot.uptimeTimer);
    slot.uptimeTimer = setTimeout(() => {
      if (slot.pty === proc && slot.restartCount > 0) {
        log('uptime-reset', `terminal=${index} pid=${proc.pid} restartCount ${slot.restartCount}→0`);
        slot.restartCount = 0;
      }
    }, 60_000);

    proc.onData((data: string) => {
      slot.chunks.push(data);
      slot.chunksTotalLen += data.length;
      slot.dirty = true;
      // Horodatage du dernier output : sert à mesurer l'inactivité pour
      // l'auto-compactage. On ne touche PAS compactedWhileIdle ici — l'output
      // du /compact lui-même ne doit pas être pris pour du nouveau travail.
      slot.lastActivityMs = Date.now();
      // Rotation : on déclenche uniquement quand on dépasse 1.5× la cible
      // (au lieu de 1×) ou que le nombre de chunks devient pathologique
      // (>200 — Kiro TUI peut spammer 50-100 micro-chunks par redraw).
      // Réduit la fréquence des grosses concats sur le hot path TUI.
      const rotateThreshold = this.maxBuffer + (this.maxBuffer >> 1);
      if (slot.chunksTotalLen > rotateThreshold || slot.chunks.length > 200) {
        slot.joinedCache = slot.chunks.join('').slice(-this.maxBuffer);
        slot.chunks = [slot.joinedCache];
        slot.chunksTotalLen = slot.joinedCache.length;
        slot.dirty = false;
        slot.strippedCache = '';
      }
      if (this.logsEnabled && this.logsDir) {
        const stripped = data.replace(ANSI_RE, '');
        fs.appendFile(path.join(this.logsDir, `terminal-${index}.log`), stripped, () => {});
      }
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          if (slot.ws.bufferedAmount < WS_HIGH_WATER) {
            // Si on a précédemment sauté des chunks, on resync en envoyant
            // tout le buffer (qui inclut la chunk courante via slot.chunks).
            if (slot.wsDesynced) {
              slot.ws.send(this._getBuffer(slot));
              slot.wsDesynced = false;
            } else {
              slot.ws.send(data);
            }
          } else {
            // Backpressure haute : on note la désync sans dropper. Le buffer
            // serveur (slot.chunks) garde tout, donc le replay au prochain
            // envoi possible reconstitue correctement l'écran xterm.
            slot.wsDesynced = true;
          }
        }
      } catch { /* WS gone */ }
    });

    // Watchdog de démarrage (backstop) : avec le spawn direct, le binaire
    // (claude/kiro) tourne déjà dans le PTY — il n'y a plus rien à injecter.
    // Mais s'il hang ou est introuvable de façon silencieuse, le pane resterait
    // muet sans jamais exit (donc sans recovery). Si après 15s le PTY est
    // toujours vivant ET n'a émis AUCUN octet (zéro octet = réellement bloqué ;
    // un binaire sain émet ses séquences d'init immédiatement), on prévient
    // l'utilisateur au lieu d'un pane noir silencieux.
    if (slot.startupTimer) clearTimeout(slot.startupTimer);
    slot.startupTimer = setTimeout(() => {
      slot.startupTimer = null;
      if (slot.pty === proc && slot.chunksTotalLen === 0) {
        log('startup-stall', `terminal=${index} pid=${proc.pid} no output after 15s`);
        try {
          if (slot.ws && slot.ws.readyState === 1) {
            slot.ws.send(`\r\n\x1b[33m[fast-vibe] Aucun affichage après 15s — ${this.engine} est peut-être introuvable ou bloqué. Cliquez Restart, ou vérifiez l'installation.\x1b[0m\r\n`);
          }
        } catch { /* WS gone */ }
      }
    }, 15_000);
    slot.startupTimer.unref?.();

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      log('exit', `worker-${index} pid=${proc.pid} code=${exitCode}`);
      if (slot.pty === proc) {
        slot.pty = null;
      }
      if (slot.uptimeTimer) { clearTimeout(slot.uptimeTimer); slot.uptimeTimer = null; }
      if (slot.startupTimer) { clearTimeout(slot.startupTimer); slot.startupTimer = null; }
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
      this._scheduleRestart(index, slot, exitCode);
    });

    return proc;
  }

  // Résout un binaire vers son path absolu (where.exe sur Windows, which
  // ailleurs). Cache en mémoire pour ne pas refaire le subprocess à chaque
  // spawn. Retourne null si introuvable.
  //
  // Pourquoi nécessaire : node-pty sur Windows utilise CreateProcess sans
  // résolution PATHEXT — passer 'kiro-cli' (sans extension) plante avec
  // 'File not found:'. Sur cette machine kiro-cli est .exe, ailleurs ça
  // peut être .cmd / .ps1. Résolution dynamique via where.exe est la
  // seule façon fiable.
  private _resolveBinary(name: string): string | null {
    if (this._binaryCache.has(name)) return this._binaryCache.get(name) || null;
    try {
      const tool = process.platform === 'win32' ? 'where.exe' : 'which';
      const out = execSync(`${tool} ${name}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      // where.exe peut retourner plusieurs lignes — on prend la première.
      const first = out.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0);
      if (first) {
        this._binaryCache.set(name, first);
        return first;
      }
    } catch { /* not found */ }
    this._binaryCache.set(name, '');
    return null;
  }

  // Construit la commande à lancer pour un slot. Renvoie les args pty.spawn
  // + une éventuelle commande à taper via le shell parent (mode 'shell').
  private _buildLaunch(workdir: string, slot: Slot): {
    shell: string;
    args: string[];
    cwd: string | undefined;
    mode: 'direct' | 'shell';
    injectCmd: string | null;
  } {
    const isWin = process.platform === 'win32';

    // ── Kiro : spawn direct ──
    if (this.engine === 'kiro') {
      // Ordre des args : `kiro-cli chat [chat-options] --tui`
      // --trust-all-tools (alias -a) est un flag de la sous-commande `chat`,
      // pas un flag global → il DOIT venir après `chat` ou kiro-cli rejette
      // avec "unexpected argument '--trust-all-tools' found".
      //
      // --agent-engine v2 est forcé : --tui ne fonctionne qu'avec v2 (Kiro
      // refuse avec 'Conflicting options: --tui cannot be used with
      // --agent-engine=v1' si la config utilisateur force v1). Le help dit
      // que v2 est default, mais on ne fait pas confiance au default global
      // pour ne pas péter quand l'utilisateur change sa config Kiro.
      const kiroArgs: string[] = ['chat', '--agent-engine', 'v2'];
      if (this.trustMode) kiroArgs.push('--trust-all-tools');
      kiroArgs.push('--tui');

      if (this.useWSL && isWin) {
        return {
          shell: 'wsl.exe',
          args: ['--cd', workdir, '--', 'kiro-cli', ...kiroArgs],
          cwd: undefined,
          mode: 'direct',
          injectCmd: null,
        };
      }

      // Résolution explicite du binaire — cf. _resolveBinary.
      // Sur cette machine c'est .exe, sur d'autres .cmd, etc.
      const resolved = this._resolveBinary('kiro-cli');
      if (!resolved) {
        // Pas de fallback hasardeux : on log et on laisse le throw remonter
        // au catch de spawn() avec un message explicite.
        throw new Error(
          'kiro-cli not found in PATH. Install Kiro CLI from https://kiro.dev or enable WSL mode in settings.'
        );
      }

      return {
        shell: resolved,
        args: kiroArgs,
        cwd: workdir,
        mode: 'direct',
        injectCmd: null,
      };
    }

    // ── Claude : spawn direct ──
    //
    // Historiquement on passait par un shell parent (cmd.exe/bash) qui posait
    // un alias `c` puis "tapait" la commande claude en guettant le prompt.
    // C'était la cause racine n°1 des "panes noirs" : la détection de prompt
    // est une course de timing qui rate sous charge (spawns simultanés,
    // démarrage à froid) → commande perdue → pane figé sur un prompt nu qui
    // n'exit jamais → aucune recovery.
    //
    // On lance donc claude DIRECTEMENT dans le PTY (comme Kiro). Conséquences :
    //  - plus de course de prompt → démarrage déterministe
    //  - kill() cible claude.exe directement (plus de couche cmd.exe) → moins
    //    d'orphelins qui gardent le verrou de session → --resume fiable
    //  - claude exit → PTY exit → onExit → _scheduleRestart (recovery fast-fail
    //    inchangée ; "No conversation found" est imprimé direct dans le PTY)
    //  - trade-off : plus d'alias `c`, et le pane se ferme après /exit (code 0,
    //    pas d'auto-restart) → bouton Restart.
    const claudeArgs: string[] = [];
    if (this.trustMode) claudeArgs.push('--dangerously-skip-permissions');

    // Stratégie sessions persistantes :
    //  - 1er lancement : --session-id <uuid>
    //  - Reboot : --resume <uuid>
    const sid = slot.sessionId;
    if (sid) {
      // Lecture seule de slot.resume ici. Le passage à `resume = true` se fait
      // dans spawn() APRÈS un pty.spawn réussi (cf. là-bas) : sinon un spawn qui
      // throw (binaire introuvable) basculerait resume=true pour une session que
      // claude n'a jamais créée → le prochain Restart ferait `--resume <uuid>`
      // d'une session inexistante → "No conversation found" garanti.
      claudeArgs.push(slot.resume ? '--resume' : '--session-id', sid);
    }

    if (this.useWSL && isWin) {
      return {
        shell: 'wsl.exe',
        args: ['--cd', workdir, '--', 'claude', ...claudeArgs],
        cwd: undefined,
        mode: 'direct',
        injectCmd: null,
      };
    }

    // node-pty/CreateProcess sur Windows ne résout pas PATHEXT → on résout le
    // chemin absolu du binaire (where.exe, caché). Fallback au nom nu si la
    // résolution échoue : laisse node-pty tenter, et le catch de spawn()
    // affiche un message rouge clair si claude est réellement introuvable.
    // (Le fallback garde aussi les tests verts : node-pty y est mocké.)
    const claudeBin = this._resolveBinary('claude') || 'claude';
    return {
      shell: claudeBin,
      args: claudeArgs,
      cwd: workdir,
      mode: 'direct',
      injectCmd: null,
    };
  }

  // Replanifie un restart après exit non-souhaité. Backoff exponentiel
  // 3s → 6s → 12s, puis arrêt définitif (slot.crashed = true).
  //
  // Cas spécial "fast-fail --resume" : si le PTY exit en <10s ET qu'on
  // essayait de reprendre une session existante, c'est presque toujours que
  // l'uuid est déjà détenu ailleurs (orphan claude après crash propre,
  // multi-process, lock fichier). On régénère un NOUVEAU sessionId pour
  // repartir 100% propre, sans attendre le backoff exponentiel.
  private _scheduleRestart(index: number, slot: Slot, exitCode: number): void {
    if (!this.autoRestart || slot.removed || exitCode === 0) return;

    const uptimeMs = slot.startedAtMs ? Date.now() - slot.startedAtMs : Infinity;
    const fastFailUptime = uptimeMs < 10_000;

    // Detection sémantique : claude écrit "No conversation found with
    // session ID: <uuid>" puis exit 1 si --resume cible un UUID inconnu.
    // Le seuil d'uptime à 10s rate ce cas quand shell+claude startup
    // (chargement des sessions sur disque, parse) dépasse 10s. En grep'ant
    // le buffer on capture l'erreur quel que soit le temps total.
    const buffer = this._getBuffer(slot);
    const resumeFailedSemantic = !!(
      slot.resume &&
      buffer &&
      /No conversation found with session ID/i.test(buffer)
    );

    const fastFail = fastFailUptime || resumeFailedSemantic;

    // UX : si le terminal a été stable (>= 10s) ET qu'on n'a pas détecté
    // une resume-failure sémantique, l'exit est soit un crash visible
    // soit une sortie intentionnelle de l'user (Ctrl+C, /exit qui sort
    // en non-0 dans certains cas). Dans tous ces cas, on ne relance PAS
    // automatiquement — l'user n'a pas envie qu'on lui force un restart
    // qu'il n'a pas demandé. Message gris non-alarmant + bouton Restart
    // manuel via l'UI.
    if (!fastFail) {
      log('exit-stable', `terminal=${index} stable exit after ${(uptimeMs/1000).toFixed(1)}s code=${exitCode} — no auto-restart`);
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[90m[fast-vibe] Session terminée (code ${exitCode}). Cliquez Restart pour relancer.\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
      return;
    }

    if (slot.restartCount >= 3) {
      slot.crashed = true;
      log('crashed', `terminal=${index} retry budget exhausted (3 attempts)`);
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[91m[Crashed: 3 restart attempts failed. Click Restart to retry.]\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
      return;
    }

    slot.restartCount++;

    // Fast-fail sur --resume → l'uuid est soit locké ailleurs, soit
    // inconnu de claude. Régénération de l'uuid + restart quasi-immédiat
    // (500ms). On ne brûle pas le retry budget en backoff exponentiel
    // sur un problème connu.
    if (this.engine === 'claude' && slot.resume && slot.sessionId && fastFail) {
      const oldId = slot.sessionId;
      const cause = resumeFailedSemantic ? 'session inconnue' : `${(uptimeMs/1000).toFixed(1)}s`;
      slot.sessionId = randomUUID();
      slot.resume = false;
      try {
        if (slot.ws && slot.ws.readyState === 1) {
          slot.ws.send(`\r\n\x1b[33m[fast-vibe] --resume failed (${cause}), starting fresh session…\x1b[0m\r\n`);
        }
      } catch { /* WS gone */ }
      log('resume-fastfail', `terminal=${index} oldSession=${oldId} → newSession=${slot.sessionId} cause=${cause} uptime=${(uptimeMs/1000).toFixed(1)}s`);
      this.notifyStateChange();
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = setTimeout(() => {
        slot.restartTimer = null;
        if (!slot.removed && this.autoRestart) this.spawn(index, this.cwd);
      }, 500);
      return;
    }

    const delayMs = Math.min(3000 * Math.pow(2, slot.restartCount - 1), 30_000);
    log('auto-restart', `terminal=${index} attempt=${slot.restartCount}/3 in ${delayMs}ms uptime=${(uptimeMs/1000).toFixed(1)}s`);
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      if (!slot.removed && this.autoRestart) this.spawn(index, this.cwd);
    }, delayMs);
  }

  attach(index: number, ws: WebSocket): void {
    if (index >= this.slots.length) {
      ws.close(4000, 'Terminal index out of range');
      return;
    }
    const slot = this.slots[index];

    if (!slot.pty) {
      this.spawn(index);
    }

    if (slot.ws) {
      slot.ws.removeAllListeners('message');
      slot.ws.removeAllListeners('close');
    }

    slot.ws = ws;

    if (slot.chunksTotalLen > 0) {
      try { ws.send(this._getBuffer(slot)); } catch { /* WS gone */ }
    }

    ws.on('error', (err: Error) => {
      log('ws-error', `terminal=${index} ${err.message}`);
      this.detach(index);
    });

    ws.on('message', (data: Buffer | string) => {
      const msg = data.toString();

      if (msg.startsWith('{"type"')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            this.resize(index, parsed.cols, parsed.rows);
            return;
          }
          if (parsed.type === 'restart') {
            this.restart(index);
            return;
          }
          if (parsed.type === 'raw' && typeof parsed.data === 'string') {
            this._markUserActivity(slot);
            safeWrite(slot.pty, parsed.data);
            return;
          }
        } catch { /* not JSON */ }
      }

      if (slot.pty) {
        this._markUserActivity(slot);
        safeWrite(slot.pty, msg.replace(/\n/g, '\r'));
      }
    });

    ws.on('close', () => {
      this.detach(index);
    });
  }

  detach(index: number): void {
    if (index < this.slots.length) {
      this.slots[index].ws = null;
    }
  }

  resize(index: number, cols: number, rows: number): void {
    if (index >= this.slots.length || !this.slots[index].pty) return;
    const proc = this.slots[index].pty!;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
    // ConPTY (Windows) a un bug connu : le child process ne reçoit pas
    // toujours SIGWINCH au premier resize, surtout sous TUI. Un second
    // resize 50ms après force le child à redessiner et règle la majorité
    // des artefacts visuels Kiro après split/drag.
    if (process.platform === 'win32') {
      setTimeout(() => {
        if (this.slots[index] && this.slots[index].pty === proc) {
          try { proc.resize(cols, rows); } catch { /* PTY gone */ }
        }
      }, 50);
    }
  }

  restart(index: number): void {
    if (index >= this.slots.length) return;
    const slot = this.slots[index];
    // Restart manuel = reset l'état crashed + le compteur. L'utilisateur
    // demande explicitement à recommencer, on redonne 3 tentatives.
    slot.crashed = false;
    slot.restartCount = 0;
    const previous = slot.pty;
    this.kill(index);
    // Petit délai pour laisser ConPTY (Windows) finir le cleanup du PTY
    // précédent avant qu'un nouveau prenne sa place. Sans ça on peut avoir
    // 2 PTYs share le même slot pendant ~100ms, et le onExit du précédent
    // (déjà en vol) flippe slot.pty à null après le nouveau spawn.
    const delay = previous && process.platform === 'win32' ? 100 : 0;
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      // autoRestart=false signale qu'un killAll est en cours — on n'a pas
      // le droit de re-spawn, sinon on resuscite après teardown (test leak
      // ou shutdown du serveur).
      if (slot.removed || !this.autoRestart) return;
      this.spawn(index, this.cwd);
      try {
        if (slot.ws && slot.ws.readyState === 1 && slot.chunksTotalLen > 0) {
          slot.ws.send(this._getBuffer(slot));
        }
      } catch { /* WS gone */ }
    }, delay);
  }

  sendInput(index: number, text: string): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    this._markUserActivity(slot);
    // Multi-line text: wrap in bracketed-paste so embedded newlines stay
    // as newlines instead of being interpreted as Enter (submit).
    // Single-line text: convert any \n to \r for plain typing.
    // A trailing \r (after a short delay) submits the prompt — Claude Code
    // paste mode needs a separate Enter once the paste buffer is rendered.
    if (text.includes('\n')) {
      safeWrite(slot.pty, `\x1b[200~${text}\x1b[201~`);
    } else {
      safeWrite(slot.pty, text.replace(/\n/g, '\r'));
    }
    // Clear tout pendingEnter précédent : si l'utilisateur enchaîne plusieurs
    // sends rapidement, on ne veut pas accumuler des Enter en rafale qui
    // submitteraient dans le désordre côté TUI.
    if (slot.pendingEnterTimer) clearTimeout(slot.pendingEnterTimer);
    slot.pendingEnterTimer = setTimeout(() => {
      slot.pendingEnterTimer = null;
      safeWrite(slot.pty, '\r');
    }, 100);
    return true;
  }

  // Send a slash command (e.g. /compact, /clear) — no paste delay needed
  sendCommand(index: number, command: string): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (!slot.pty) return false;
    this._markUserActivity(slot);
    safeWrite(slot.pty, command + '\r');
    return true;
  }

  // Signale une entrée utilisateur réelle (frappe clavier, send API, raw WS).
  // Reset le flag compactedWhileIdle pour autoriser un nouveau compactage après
  // la prochaine période d'inactivité, et rafraîchit l'horloge d'activité.
  private _markUserActivity(slot: Slot): void {
    slot.lastActivityMs = Date.now();
    slot.compactedWhileIdle = false;
  }

  private _getBuffer(slot: Slot): string {
    if (slot.dirty) {
      slot.joinedCache = slot.chunks.join('');
      slot.dirty = false;
      // Le buffer brut a changé → on invalide le cache strippé.
      slot.strippedCache = '';
    }
    return slot.joinedCache;
  }

  getOutput(index: number, lastN: number = 2000): string {
    if (index >= this.slots.length) return '';
    const slot = this.slots[index];
    if (slot.chunksTotalLen === 0) return '';
    // Cache strippé : on ne re-parse les ANSI que si le buffer brut a changé
    // depuis le dernier appel. Sur un Kiro TUI qui spamme des frames mais
    // dont l'API poll régulièrement, c'est ~100× plus rapide.
    // Important : invalider aussi quand `dirty=true` (du nouveau contenu est
    // arrivé même si on n'a pas appelé _getBuffer entre temps).
    if (slot.dirty || !slot.strippedCache) {
      const raw = this._getBuffer(slot);
      slot.strippedCache = raw.replace(ANSI_RE, '');
    }
    return slot.strippedCache.slice(-lastN);
  }

  // ── Auto-compactage des workers idle ──

  // Active/désactive et (re)démarre le sweep. min=0 → off. Idempotent.
  setAutoCompactIdleMin(min: number): void {
    this.autoCompactIdleMin = Math.max(0, Math.floor(min || 0));
    this._startCompactSweep();
  }

  private _startCompactSweep(): void {
    this._stopCompactSweep();
    if (!(this.autoCompactIdleMin > 0) || this.engine !== 'claude') return;
    // Sweep toutes les 2 min — granularité suffisante pour un seuil en minutes,
    // négligeable en CPU. unref() pour ne pas tenir le process en vie.
    this._compactSweepTimer = setInterval(() => this._autoCompactSweep(), 120_000);
    this._compactSweepTimer.unref?.();
  }

  private _stopCompactSweep(): void {
    if (this._compactSweepTimer) {
      clearInterval(this._compactSweepTimer);
      this._compactSweepTimer = null;
    }
  }

  private _autoCompactSweep(): void {
    if (!(this.autoCompactIdleMin > 0) || this.engine !== 'claude') return;
    const idleMs = this.autoCompactIdleMin * 60_000;
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.pty || slot.removed || slot.compactedWhileIdle) continue;
      const last = slot.lastActivityMs ?? slot.startedAtMs ?? now;
      if (now - last < idleMs) continue;
      // Ne compacter que si le worker est au prompt (pas en plein rendu ni en
      // train d'attendre une confirmation). Sinon on retente au sweep suivant.
      const tail = this.getOutput(i, 200).trimEnd();
      if (!/[❯>$#]$/.test(tail)) continue;
      // sendCommand() appelle _markUserActivity (reset lastActivityMs + flag) :
      // on repose donc compactedWhileIdle=true APRÈS pour bloquer toute
      // re-compaction jusqu'à une vraie entrée utilisateur.
      this.sendCommand(i, '/compact');
      slot.compactedWhileIdle = true;
      log('auto-compact', `terminal=${i} idle ${((now - last) / 60000).toFixed(1)}min → /compact`);
    }
  }

  // Launch N workers indépendants.
  launchAll(cwd: string, workerCount: number = 4, opts: LaunchOptions = {}): void {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.engine = opts.engine || 'claude';
    this.trustMode = !!opts.trustMode;
    this.useWSL = !!opts.useWSL;
    this.suggestMode = opts.suggestMode || 'off';
    this.logsEnabled = !!opts.logsEnabled;
    this.autoCompactIdleMin = Math.max(0, Math.floor(opts.autoCompactIdleMin || 0));
    this.maxBuffer = this.engine === 'kiro' ? MAX_BUFFER_KIRO : MAX_BUFFER;
    if (this.logsEnabled) {
      this.logsDir = path.join(this.cwd, 'logs');
      if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.count = workerCount;

    log('launch', `engine=${this.engine} workers=${workerCount} trust=${this.trustMode} cwd=${this.cwd}`);

    // Rebuild slots array — un UUID v4 par slot pour les sessions claude.
    // Ces UUIDs sont la clé de la persistance : on les passe à
    // `claude --session-id <uuid>` au 1er lancement, puis `--resume <uuid>`
    // après reboot pour reprendre la même conversation.
    this.slots = Array.from({ length: this.count }, (): Slot => ({
      pty: null, ws: null, startedAt: null,
      chunks: [], chunksTotalLen: 0, joinedCache: '', strippedCache: '', dirty: false,
      restartCount: 0,
      sessionId: this.engine === 'claude' ? randomUUID() : null,
      resume: false,
      crashed: false,
      wsDesynced: false,
      pendingEnterTimer: null,
      uptimeTimer: null,
      restartTimer: null,
    }));

    this._spawnStaggered(Array.from({ length: this.count }, (_, i) => i));

    this._startCompactSweep();
    this.notifyStateChange();
    // Suggesteur is spawned on demand (first AI suggestion request), not at launch
  }

  // Restore depuis un état persisté (.session-state.json) — appelé au boot du
  // serveur. Les slots sont reconstruits avec les sessionIds capturés
  // précédemment, et chaque worker spawn avec --resume <uuid>.
  restoreAll(state: {
    cwd: string;
    engine: string;
    trustMode: boolean;
    useWSL: boolean;
    workers: Array<{ index: number; sessionId: string | null; removed?: boolean }>;
  }): void {
    this.killAll();
    this.cwd = state.cwd || process.cwd();
    this.engine = state.engine || 'claude';
    this.trustMode = !!state.trustMode;
    this.useWSL = !!state.useWSL;
    this.maxBuffer = this.engine === 'kiro' ? MAX_BUFFER_KIRO : MAX_BUFFER;
    // Slots indexed by position; on recrée la grille telle que persistée
    // (workers déjà supprimés inclus comme tombstones pour préserver les indices)
    const maxIndex = state.workers.reduce((m, w) => Math.max(m, w.index), -1);
    this.count = maxIndex + 1;
    this.slots = Array.from({ length: this.count }, (_, i): Slot => {
      const w = state.workers.find(x => x.index === i);
      return {
        pty: null, ws: null, startedAt: null,
        chunks: [], chunksTotalLen: 0, joinedCache: '', strippedCache: '', dirty: false,
        restartCount: 0,
        sessionId: w?.sessionId ?? null,
        resume: !!(w?.sessionId),
        removed: w?.removed,
        crashed: false,
        wsDesynced: false,
        pendingEnterTimer: null,
        uptimeTimer: null,
      };
    });

    log('restore', `engine=${this.engine} count=${this.count} cwd=${this.cwd}`);

    this._spawnStaggered(
      this.slots.map((s, i) => (s.removed ? -1 : i)).filter(i => i >= 0)
    );

    this.notifyStateChange();
  }

  // Compte les workers vivants (slots non-tombstone).
  countLiveWorkers(): number {
    return this.slots.filter(s => !s.removed).length;
  }

  // Ajoute un worker. Retourne -1 si le cap MAX_WORKERS est atteint (le serveur
  // traduit en HTTP 400) pour éviter de spawn une N-ième instance claude qui
  // ferait saturer la RAM.
  addWorker(): number {
    if (this.countLiveWorkers() >= MAX_WORKERS) {
      log('addworker-capped', `refused: ${MAX_WORKERS} live workers max`);
      return -1;
    }
    const newIndex = this.slots.length;
    this.slots.push({
      pty: null, ws: null, startedAt: null,
      chunks: [], chunksTotalLen: 0, joinedCache: '', strippedCache: '', dirty: false,
      restartCount: 0,
      sessionId: this.engine === 'claude' ? randomUUID() : null,
      resume: false,
      crashed: false,
      wsDesynced: false,
      pendingEnterTimer: null,
      uptimeTimer: null,
      restartTimer: null,
    });
    this.count = this.slots.length;
    this.spawn(newIndex, this.cwd);
    this.notifyStateChange();
    return newIndex;
  }

  // Permanently remove a worker. The slot stays in the array as a tombstone so
  // that indices (and therefore layout pane references) don't shift; subsequent
  // calls to addWorker continue to push at the end. getStatus filters tombstones
  // out so the UI sees them as truly gone.
  removeWorker(index: number): boolean {
    if (index >= this.slots.length) return false;
    const slot = this.slots[index];
    if (slot.removed) return true;
    slot.removed = true;
    this.kill(index);
    this.notifyStateChange();
    return true;
  }

  kill(index: number): void {
    if (index >= this.slots.length) return;
    const slot = this.slots[index];
    if (slot.pty) {
      const pid = slot.pty.pid;
      log('kill', `terminal=${index} pid=${pid}`);
      // Windows : pty.kill() envoie WM_CLOSE au shell parent (cmd.exe) mais
      // ne propage PAS au grand-enfant (claude.exe / kiro-cli.exe lancé via
      // l'alias `c` injecté). Résultat : N orphelins claude.exe tournent
      // après chaque kill, et le prochain --resume <uuid> se heurte au
      // verrou de session déjà détenu → terminal vide / boucle de retry.
      // `taskkill /T /F /PID` tue l'arbre des descendants. On le fait AVANT
      // pty.kill() pour ne pas laisser la fenêtre où le shell parent meurt
      // mais l'enfant survit en zombie.
      if (process.platform === 'win32' && pid) {
        try {
          execSync(`taskkill /T /F /PID ${pid}`, {
            stdio: 'ignore',
            timeout: 3000,
            windowsHide: true,
          });
        } catch { /* process already dead, or perms — pty.kill() couvrira */ }
      }
      try { slot.pty.kill(); } catch (e: unknown) { log('kill-error', `terminal=${index} ${(e as Error).message}`); }
      slot.pty = null;
    }
    if (slot.pendingEnterTimer) { clearTimeout(slot.pendingEnterTimer); slot.pendingEnterTimer = null; }
    if (slot.uptimeTimer) { clearTimeout(slot.uptimeTimer); slot.uptimeTimer = null; }
    if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }
    if (slot.startupTimer) { clearTimeout(slot.startupTimer); slot.startupTimer = null; }
    slot.startedAt = null;
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.strippedCache = '';
    slot.dirty = false;
    slot.wsDesynced = false;
  }

  killAll(): void {
    const oldAutoRestart = this.autoRestart;
    this.autoRestart = false;
    // Invalide les spawns échelonnés en vol (jeton de génération) et clear
    // leurs timers — sinon un spawn différé ressusciterait un worker juste tué.
    this._launchGen++;
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    this._stopCompactSweep();
    for (let i = 0; i < this.slots.length; i++) {
      this.kill(i);
    }
    this.autoRestart = oldAutoRestart;
    this.killSuggesteur();
  }

  // ── Suggesteur ──

  private spawnSuggesteur(): void {
    if (this.suggesteur && this.suggesteur.pty) return;

    const workdir = this.cwd;
    let shell: string, shellArgs: string[] = [];
    if (this.useWSL && process.platform === 'win32') {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
    } else {
      shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    }

    let proc: IPty;
    try {
      proc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.useWSL ? undefined : workdir,
        env: process.env as Record<string, string>,
      });
    } catch (e: unknown) {
      log('spawn-error', `suggesteur ${(e as Error).message}`);
      return;
    }

    this.suggesteur = {
      pty: proc,
      chunks: [],
      chunksTotalLen: 0,
      joinedCache: '',
      dirty: false,
      ready: false,
    };

    const sg = this.suggesteur;

    proc.onData((data: string) => {
      sg.chunks.push(data);
      sg.chunksTotalLen += data.length;
      sg.dirty = true;
      const rotateThreshold = this.maxBuffer + (this.maxBuffer >> 1);
      if (sg.chunksTotalLen > rotateThreshold || sg.chunks.length > 200) {
        sg.joinedCache = sg.chunks.join('').slice(-this.maxBuffer);
        sg.chunks = [sg.joinedCache];
        sg.chunksTotalLen = sg.joinedCache.length;
        sg.dirty = false;
      }
    });

    // Launch Claude Code in the suggesteur
    const nl = (process.platform === 'win32' && !this.useWSL) ? '\r' : '\n';
    const claudeCmd = this.trustMode ? 'claude --dangerously-skip-permissions' : 'claude';
    const promptPath = SUGGEST_PROMPT_FILE.replace(/\\/g, '/');
    const cmd = `${claudeCmd} --append-system-prompt-file "${promptPath}"${nl}`;

    let launched = false;
    const onData = (data: string): void => {
      if (launched) return;
      if (/[$#>]\s*$/.test(data)) {
        launched = true;
        launchDisp.dispose();
        safeWrite(proc, cmd);
        // Mark ready after Claude Code startup (~5s)
        setTimeout(() => { sg.ready = true; }, 8000);
      }
    };
    const launchDisp = proc.onData(onData);
    setTimeout(() => {
      if (!launched && sg.pty) {
        launched = true;
        safeWrite(proc, cmd);
        setTimeout(() => { sg.ready = true; }, 8000);
      }
      launchDisp.dispose();
    }, 5000);

    proc.onExit(() => {
      if (this.suggesteur && this.suggesteur.pty === proc) {
        this.suggesteur.pty = null;
        this.suggesteur.ready = false;
      }
    });
  }

  private killSuggesteur(): void {
    if (this.suggesteur && this.suggesteur.pty) {
      const pid = this.suggesteur.pty.pid;
      if (process.platform === 'win32' && pid) {
        try {
          execSync(`taskkill /T /F /PID ${pid}`, {
            stdio: 'ignore',
            timeout: 3000,
            windowsHide: true,
          });
        } catch { /* already gone */ }
      }
      try { this.suggesteur.pty.kill(); } catch { /* already dead */ }
    }
    this.suggesteur = null;
    this.suggestQueue = [];
    this.suggestBusy = false;
    this.suggestions = {};
  }

  generateSuggestion(workerId: number): void {
    if (this.suggestMode === 'off') return;

    const output = this.getOutput(workerId, 3000);
    // Skip if output is too short (startup noise, no real interaction yet)
    if (!output || output.length < 100) return;

    // Static match (instant)
    const staticMatch = matchStaticSuggestion(output);
    if (staticMatch) {
      this.suggestions[workerId] = {
        text: staticMatch.text,
        source: 'static',
        pending: this.suggestMode === 'ai',
      };
    }

    // AI mode: spawn suggesteur on demand, then queue
    if (this.suggestMode === 'ai' && this.engine === 'claude') {
      if (!this.suggesteur || !this.suggesteur.pty) {
        this.spawnSuggesteur();
        // Queue the request — it will be processed when suggesteur is ready
      }
      // Dedupe: remove existing entry for this worker
      this.suggestQueue = this.suggestQueue.filter(q => q.workerId !== workerId);
      this.suggestQueue.push({ workerId, output });
      // Try processing (will skip if suggesteur not ready yet)
      this._processSuggestQueue();
      // Retry after suggesteur startup if not ready
      if (this.suggesteur && !this.suggesteur.ready) {
        setTimeout(() => this._processSuggestQueue(), 10000);
      }
    }
  }

  private _getSuggesteurOutput(): string {
    const sg = this.suggesteur;
    if (!sg || sg.chunksTotalLen === 0) return '';
    if (sg.dirty) {
      sg.joinedCache = sg.chunks.join('');
      sg.dirty = false;
    }
    return sg.joinedCache;
  }

  private _processSuggestQueue(): void {
    if (this.suggestBusy || this.suggestQueue.length === 0) return;
    if (!this.suggesteur || !this.suggesteur.pty || !this.suggesteur.ready) return;

    this.suggestBusy = true;
    const item = this.suggestQueue.shift()!;
    const { workerId, output } = item;
    const sg = this.suggesteur;

    // Reset buffer so we only see the response to THIS request
    sg.chunks = [];
    sg.chunksTotalLen = 0;
    sg.joinedCache = '';
    sg.dirty = false;

    // Send the worker output to suggesteur (truncated to avoid paste issues)
    const truncated = output.slice(-1500).replace(/\n{3,}/g, '\n\n');
    const message = `Worker ${workerId} output:\n${truncated}\n\nSuggest response.`;
    safeWrite(sg.pty, message);
    setTimeout(() => {
      safeWrite(sg.pty, '\r');
    }, 150);

    // Poll for response
    let attempts = 0;
    const maxAttempts = 60; // 30s at 500ms intervals
    const done = (suggestion: Suggestion | null): void => {
      clearInterval(pollInterval);
      if (suggestion) {
        this.suggestions[workerId] = suggestion;
      } else if (this.suggestions[workerId]) {
        this.suggestions[workerId].pending = false;
      }
      this.suggestBusy = false;
      this._processSuggestQueue();
    };
    const pollInterval = setInterval(() => {
      attempts++;
      if (!sg.pty || attempts > maxAttempts) {
        done(null);
        return;
      }

      const raw = this._getSuggesteurOutput();
      const stripped = raw.replace(ANSI_RE, '');

      // Method 1: look for [SUGGEST] prefix
      const suggestMatch = stripped.match(/\[SUGGEST\]\s*(.+)/);
      if (suggestMatch) {
        const text = suggestMatch[1].trim();
        done(text && !text.startsWith('NONE') ? { text, source: 'ai', pending: false } : null);
        return;
      }

      // Method 2: detect idle prompt (Claude finished responding)
      if (stripped.length > 200 && /❯\s*$/.test(stripped)) {
        const lines = stripped.split(/\n/).map(l => l.trim()).filter(l =>
          l.length > 1 &&
          !/^❯/.test(l) &&
          !/^Worker \d/.test(l) &&
          l !== 'Suggest response.' &&
          !/^\s*$/.test(l)
        );
        const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
        if (lastLine && lastLine.length > 1 && lastLine.length < 300) {
          const cleaned = lastLine.replace(/^\[SUGGEST\]\s*/, '');
          done({ text: cleaned, source: 'ai', pending: false });
        } else {
          done(null);
        }
      }
    }, 500);
  }

  dismissSuggestion(workerId: number): void {
    delete this.suggestions[workerId];
  }

  getSuggestion(workerId: number): Suggestion | null {
    return this.suggestions[workerId] || null;
  }

  getStatus(): TerminalStatus[] {
    return this.slots
      .map((slot, i) => ({
        id: i,
        pid: slot.pty ? slot.pty.pid : null,
        alive: !!slot.pty,
        startedAt: slot.startedAt,
        role: 'worker' as const,
        suggestion: this.suggestions[i] || null,
        removed: !!slot.removed,
        crashed: !!slot.crashed,
      }))
      .filter(s => !s.removed)
      .map(({ removed: _r, ...rest }) => rest);
  }
}
