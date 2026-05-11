// Always-on prompt improver — réutilise une session `claude -p` via --resume
// pour bénéficier du cache prompt (~22k tokens cachés sur le system prompt
// après le 1er appel). Pas de PTY ni de pollution des workers.
//
// Comportement :
//  1. Premier appel : spawn `claude -p --output-format json`, prime la session
//     avec le meta-prompt + le texte user. On capture le session_id.
//  2. Appels suivants : `claude --resume <id> -p --output-format json` avec
//     un préambule court et le texte user. Cache hit = ~2-3s au lieu de 5-10s.
//  3. Si la session expire (erreur claude), on l'invalide et on retry une fois.
//
// Les requêtes sont sérialisées (mutex) car partager une session entre appels
// concurrents corromprait l'historique.

import { spawn } from 'child_process';

const META_PROMPT = `Tu es un améliorateur de prompts dédié à des agents de coding (Claude Code, Kiro CLI).

À partir de maintenant, je vais t'envoyer plusieurs prompts à améliorer, chacun dans un message séparé. Pour CHAQUE prompt reçu :
- Réponds UNIQUEMENT avec le prompt amélioré, sans préambule, sans guillemets, sans markdown wrap.
- Garde la même langue que le prompt d'origine.
- Garde la même intention — n'invente pas de scope.
- Précise les contraintes implicites (vérification, cause racine, scope, contraintes techniques) si pertinent.
- Sois concis — pas de remplissage.

Voici le PREMIER prompt à améliorer :
---
{TEXT}
---`;

const RESUME_PREAMBLE = `Prompt à améliorer (mêmes règles que tout à l'heure) :
---
{TEXT}
---`;

interface ClaudeJsonResult {
  type: string;
  is_error: boolean;
  result: string;
  session_id?: string;
  duration_ms?: number;
  usage?: { cache_read_input_tokens?: number };
}

interface ImproveOutcome {
  improved: string;
  session_id: string | null;
  cached_tokens: number;
  duration_ms: number;
  reused_session: boolean;
}

export class PromptImprover {
  private sessionId: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  getSessionId(): string | null { return this.sessionId; }

  reset(): void { this.sessionId = null; }

  // Sérialise les appels via une chaîne de promesses (évite que deux
  // requêtes concurrentes claude --resume corrompent la session).
  async improve(text: string): Promise<ImproveOutcome> {
    const next = this.chain.then(() => this._improveOnce(text));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async _improveOnce(text: string): Promise<ImproveOutcome> {
    try {
      return await this._runOnce(text, this.sessionId);
    } catch (err) {
      // Session peut-être invalidée → tente une recréation propre
      if (this.sessionId) {
        this.sessionId = null;
        return this._runOnce(text, null);
      }
      throw err;
    }
  }

  private async _runOnce(text: string, sessionId: string | null): Promise<ImproveOutcome> {
    const args = sessionId
      ? ['--resume', sessionId, '-p', '--output-format', 'json']
      : ['-p', '--output-format', 'json'];

    const stdin = sessionId
      ? RESUME_PREAMBLE.replace('{TEXT}', text)
      : META_PROMPT.replace('{TEXT}', text);

    const json = await spawnClaudeJson(args, stdin, this.timeoutMs);
    if (json.is_error) throw new Error(json.result || 'claude returned an error');
    if (!json.result || !json.result.trim()) throw new Error('empty result from claude');

    if (json.session_id) this.sessionId = json.session_id;

    return {
      improved: json.result.trim(),
      session_id: json.session_id || null,
      cached_tokens: json.usage?.cache_read_input_tokens ?? 0,
      duration_ms: json.duration_ms ?? 0,
      reused_session: !!sessionId,
    };
  }
}

function spawnClaudeJson(args: string[], stdin: string, timeoutMs: number): Promise<ClaudeJsonResult> {
  return new Promise<ClaudeJsonResult>((resolve, reject) => {
    const child = spawn('claude', args, { shell: process.platform === 'win32', windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      finish(() => reject(new Error(`claude timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => finish(() => reject(new Error(`spawn claude failed: ${err.message}`))));
    child.on('close', (code: number) => finish(() => {
      if (code !== 0) {
        const reason = (stderr.trim() || stdout.trim() || '').slice(0, 500);
        return reject(new Error(`claude exited ${code}${reason ? ': ' + reason : ''}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
        resolve(parsed);
      } catch (err: unknown) {
        reject(new Error(`failed to parse claude JSON: ${(err as Error).message}`));
      }
    }));

    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch (err: unknown) {
      finish(() => reject(new Error(`stdin write failed: ${(err as Error).message}`)));
    }
  });
}

// Singleton partagé par le serveur. Lazily instantié au premier import.
export const improver = new PromptImprover();
