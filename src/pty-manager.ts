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
// Kiro TUI redessine fréquemment (~10×/s avec spinners + status bars) avec
// des séquences ANSI lourdes. On augmente la cible buffer pour ce moteur
// afin de réduire les rotations et préserver l'historique au reattach.
const MAX_BUFFER_KIRO = 200 * 1024;
const WS_HIGH_WATER = 128 * 1024;
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

export const PILOT_PROMPT_FILE = path.join(__dirname, '..', '.pilot-prompt.md');
const SUGGEST_PROMPT_FILE = path.join(__dirname, '..', '.suggest-prompt.md');

export function writePilotPrompt(workerCount: number): void {
  const ids = Array.from({ length: workerCount }, (_, i) => i + 1).join(', ');
  fs.writeFile(PILOT_PROMPT_FILE, `You are the PILOT orchestrator. You have ${workerCount} EXTERNAL worker Claude Code instances (workers 1-${workerCount}) running in separate terminals. You MUST delegate work to them via a REST API.

## CRITICAL RULES

- NEVER use the Agent tool or launch subagents. You have REAL external workers for that.
- ALWAYS delegate parallelizable work to the external workers via curl commands below.
- You are the coordinator: break tasks, dispatch to workers, monitor, verify, report.
- Do NOT do the workers' job yourself. Your role is to orchestrate, not implement.

## COMMANDS (use via Bash tool)

Send a task to worker N (replace N with 1-${workerCount}):
curl -s -X POST http://localhost:3333/api/terminal/N/send -H "Content-Type: application/json" -H "X-Requested-With: FastVibe" -d '{"text":"your detailed instruction here"}'

Read worker N output:
curl -s http://localhost:3333/api/terminal/N/output?last=5000

Check all statuses:
curl -s http://localhost:3333/api/status

Compact a worker's context (free memory, keep summary):
curl -s -X POST http://localhost:3333/api/terminal/N/compact -H "X-Requested-With: FastVibe"

Clear a worker's context (full reset, start fresh):
curl -s -X POST http://localhost:3333/api/terminal/N/clear -H "X-Requested-With: FastVibe"

## CONTEXT MANAGEMENT

Workers have limited context windows. You MUST manage their context:
- After a worker completes a task, ALWAYS compact it: curl -s -X POST http://localhost:3333/api/terminal/N/compact -H "X-Requested-With: FastVibe"
- When switching to a completely different topic, clear instead: curl -s -X POST http://localhost:3333/api/terminal/N/clear -H "X-Requested-With: FastVibe"
- Before sending a new task, check if the worker needs compacting first

## WORKFLOW

1. Analyze the user's request and break it into ${workerCount} sub-tasks
2. Send each sub-task to a different worker using curl (worker IDs: ${ids})
3. Poll their output every 30-60s to monitor progress
4. When all workers finish, read their outputs and verify quality
5. **Compact all workers** after verifying results
6. Report a summary to the user

## IMPORTANT

The workers are full Claude Code instances with file access. Give them clear, specific instructions including file paths and expected outcomes. They can read, write, and run code independently.
`, () => {});
}

export class PtyManager {
  count: number;
  cwd: string;
  slots: Slot[];
  engine: string;
  noPilot: boolean;
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
  // Buffer cap par slot, calibré selon l'engine actif. Kiro TUI a besoin de
  // plus pour préserver l'historique TUI complet entre rotations.
  maxBuffer: number;
  // Cache de résolution de binaires (Windows : node-pty ne résout pas
  // PATHEXT — il faut un path absolu ou l'extension exacte).
  private _binaryCache: Map<string, string> = new Map();
  // Notification de mutation d'état (pour persistance .session-state.json)
  onStateChange?: () => void;

  constructor() {
    this.count = 0;
    this.cwd = process.cwd();
    this.slots = [];
    this.engine = 'claude';
    this.noPilot = false;
    this.trustMode = false;
    this.useWSL = false;
    this.suggestMode = 'off';
    this.logsEnabled = false;
    this.logsDir = '';
    this.autoRestart = true;
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

  spawn(index: number, cwd?: string): IPty | null {
    if (index >= this.slots.length) return null;
    const slot = this.slots[index];
    if (slot.pty) return slot.pty;

    const workdir = cwd || this.cwd;
    const isPilot = index === 0 && !this.noPilot;

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
    // et de la commande complexe (--append-system-prompt-file, --session-id, etc.)
    // qui sont plus simples à composer en shell que en argv.
    //
    // Pour le suggesteur (Claude headless) : utilise toujours le shell wrapper.
    let proc: IPty;
    let launch: ReturnType<typeof this._buildLaunch>;
    try {
      launch = this._buildLaunch(workdir, isPilot, slot);
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
    slot.chunks = [];
    slot.chunksTotalLen = 0;
    slot.joinedCache = '';
    slot.strippedCache = '';
    slot.dirty = false;
    slot.crashed = false;
    slot.wsDesynced = false;
    const role = isPilot ? 'pilot' : `worker-${index}`;
    log('spawn', `${role} pid=${proc.pid} cwd=${workdir} engine=${this.engine} mode=${launch.mode}`);

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

    // Si le launch a une commande à taper après le prompt shell (mode 'shell'),
    // on installe le détecteur de prompt. Sinon (mode 'direct'), le binaire
    // tourne déjà dans le PTY et il n'y a rien à injecter.
    if (launch.injectCmd) {
      this._injectShellCommand(proc, launch.injectCmd);
    }

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      log('exit', `${role} pid=${proc.pid} code=${exitCode}`);
      if (slot.pty === proc) {
        slot.pty = null;
      }
      if (slot.uptimeTimer) { clearTimeout(slot.uptimeTimer); slot.uptimeTimer = null; }
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
  private _buildLaunch(workdir: string, isPilot: boolean, slot: Slot): {
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

    // ── Claude : shell wrapper (alias + flags complexes) ──
    let shell: string;
    let shellArgs: string[] = [];
    let cwd: string | undefined;
    if (this.useWSL && isWin) {
      shell = 'wsl.exe';
      shellArgs = ['--cd', workdir];
      cwd = undefined;
    } else {
      shell = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
      cwd = workdir;
    }

    const nl = (isWin && !this.useWSL) ? '\r' : '\n';
    const claudeCmd = this.trustMode ? 'claude --dangerously-skip-permissions' : 'claude';
    const alias = isWin && !this.useWSL ? `doskey c=${claudeCmd} $*` : `alias c="${claudeCmd}"`;

    // Stratégie sessions persistantes :
    //  - 1er lancement : --session-id <uuid>
    //  - Reboot : --resume <uuid>
    const sid = slot.sessionId;
    const sessionFlag = sid
      ? (slot.resume ? `--resume ${sid}` : `--session-id ${sid}`)
      : '';

    let cmd = claudeCmd;
    if (isPilot) {
      const promptPath = PILOT_PROMPT_FILE.replace(/\\/g, '/');
      cmd = `${claudeCmd} --disallowedTools Agent --append-system-prompt-file "${promptPath}"`;
    }
    if (sessionFlag) cmd = `${cmd} ${sessionFlag}`;

    if (sid && !slot.resume) slot.resume = true;

    return {
      shell,
      args: shellArgs,
      cwd,
      mode: 'shell',
      injectCmd: alias + nl + cmd + nl,
    };
  }

  // Détecte le prompt shell ($#>) et injecte la commande. Fallback timeout 5s.
  private _injectShellCommand(proc: IPty, cmd: string): void {
    let launched = false;
    const onData = (data: string): void => {
      if (launched) return;
      if (/[$#>]\s*$/.test(data)) {
        launched = true;
        launchDisposable.dispose();
        safeWrite(proc, cmd);
      }
    };
    const launchDisposable = proc.onData(onData);
    setTimeout(() => {
      if (!launched) {
        launched = true;
        try { safeWrite(proc, cmd); } catch { /* PTY gone */ }
      }
      launchDisposable.dispose();
    }, 5000);
  }

  // Replanifie un restart après exit non-souhaité. Backoff exponentiel
  // 3s → 6s → 12s, puis arrêt définitif (slot.crashed = true).
  private _scheduleRestart(index: number, slot: Slot, exitCode: number): void {
    if (!this.autoRestart || slot.removed || exitCode === 0) return;

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
    // Fallback Claude : si --resume vient d'échouer (1ère tentative), on
    // bascule sur --session-id pour ne pas boucler sur une session corrompue.
    if (slot.resume && slot.sessionId && slot.restartCount === 1) {
      log('resume-failed', `terminal=${index} session=${slot.sessionId} → fallback to fresh`);
      slot.resume = false;
    }
    const delayMs = Math.min(3000 * Math.pow(2, slot.restartCount - 1), 30_000);
    log('auto-restart', `terminal=${index} attempt=${slot.restartCount}/3 in ${delayMs}ms`);
    setTimeout(() => {
      if (!slot.removed) this.spawn(index, this.cwd);
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
            safeWrite(slot.pty, parsed.data);
            return;
          }
        } catch { /* not JSON */ }
      }

      if (slot.pty) {
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
    setTimeout(() => {
      if (slot.removed) return;
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
    safeWrite(slot.pty, command + '\r');
    return true;
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
    // dont le pilot poll régulièrement, c'est ~100× plus rapide.
    // Important : invalider aussi quand `dirty=true` (du nouveau contenu est
    // arrivé même si on n'a pas appelé _getBuffer entre temps).
    if (slot.dirty || !slot.strippedCache) {
      const raw = this._getBuffer(slot);
      slot.strippedCache = raw.replace(ANSI_RE, '');
    }
    return slot.strippedCache.slice(-lastN);
  }

  // Launch 1 pilot + N workers
  launchAll(cwd: string, workerCount: number = 4, opts: LaunchOptions = {}): void {
    this.killAll();
    this.cwd = cwd || process.cwd();
    this.engine = opts.engine || 'claude';
    this.noPilot = !!opts.noPilot;
    this.trustMode = !!opts.trustMode;
    this.useWSL = !!opts.useWSL;
    this.suggestMode = opts.suggestMode || 'off';
    this.logsEnabled = !!opts.logsEnabled;
    this.maxBuffer = this.engine === 'kiro' ? MAX_BUFFER_KIRO : MAX_BUFFER;
    if (this.logsEnabled) {
      this.logsDir = path.join(this.cwd, 'logs');
      if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.count = this.noPilot ? workerCount : 1 + workerCount;

    log('launch', `engine=${this.engine} workers=${workerCount} noPilot=${this.noPilot} trust=${this.trustMode} cwd=${this.cwd}`);

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
    }));

    // Update pilot prompt with correct worker count (only for claude with pilot)
    if (this.engine === 'claude' && !this.noPilot) {
      writePilotPrompt(workerCount);
    }

    for (let i = 0; i < this.count; i++) {
      this.spawn(i, this.cwd);
    }

    this.notifyStateChange();
    // Suggesteur is spawned on demand (first AI suggestion request), not at launch
  }

  // Restore depuis un état persisté (.session-state.json) — appelé au boot du
  // serveur. Les slots sont reconstruits avec les sessionIds capturés
  // précédemment, et chaque worker spawn avec --resume <uuid>.
  restoreAll(state: {
    cwd: string;
    engine: string;
    noPilot: boolean;
    trustMode: boolean;
    useWSL: boolean;
    workers: Array<{ index: number; sessionId: string | null; removed?: boolean }>;
  }): void {
    this.killAll();
    this.cwd = state.cwd || process.cwd();
    this.engine = state.engine || 'claude';
    this.noPilot = !!state.noPilot;
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

    if (this.engine === 'claude' && !this.noPilot) {
      const workerCount = this.count - 1;
      writePilotPrompt(Math.max(0, workerCount));
    }

    log('restore', `engine=${this.engine} count=${this.count} cwd=${this.cwd}`);

    for (let i = 0; i < this.count; i++) {
      if (!this.slots[i].removed) this.spawn(i, this.cwd);
    }

    this.notifyStateChange();
  }

  // Add a single new worker slot at the end and spawn its PTY. Returns the new
   // index. Workers added this way are independent of the original launchAll
   // configuration and persist until killAll().
  addWorker(): number {
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
      log('kill', `terminal=${index} pid=${slot.pty.pid}`);
      try { slot.pty.kill(); } catch (e: unknown) { log('kill-error', `terminal=${index} ${(e as Error).message}`); }
      slot.pty = null;
    }
    if (slot.pendingEnterTimer) { clearTimeout(slot.pendingEnterTimer); slot.pendingEnterTimer = null; }
    if (slot.uptimeTimer) { clearTimeout(slot.uptimeTimer); slot.uptimeTimer = null; }
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
        role: (i === 0 && !this.noPilot) ? 'pilot' as const : 'worker' as const,
        suggestion: this.suggestions[i] || null,
        removed: !!slot.removed,
        crashed: !!slot.crashed,
      }))
      .filter(s => !s.removed)
      .map(({ removed: _r, ...rest }) => rest);
  }
}
