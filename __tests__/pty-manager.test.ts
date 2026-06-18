jest.mock('node-pty');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, writeFile: jest.fn((_p: any, _data: any, cb: any) => cb && cb()) };
});

import { PtyManager, ANSI_RE, MAX_BUFFER, MAX_WORKERS } from '../src/pty-manager';
import * as pty from 'node-pty';

describe('PtyManager', () => {
  let mgr: PtyManager;

  beforeEach(() => {
    mgr = new PtyManager();
  });

  afterEach(() => {
    mgr.killAll();
  });

  describe('constructor', () => {
    test('initializes with empty state', () => {
      expect(mgr.count).toBe(0);
      expect(mgr.slots).toEqual([]);
      expect(mgr.engine).toBe('claude');
    });
  });

  describe('launchAll', () => {
    test('creates N worker slots', () => {
      mgr.launchAll('/tmp', 4, { engine: 'claude' });
      expect(mgr.count).toBe(4);
      expect(mgr.slots.length).toBe(4);
    });

    test('sets engine and options', () => {
      mgr.launchAll('/tmp', 2, { engine: 'kiro', trustMode: true, useWSL: false });
      expect(mgr.engine).toBe('kiro');
      expect(mgr.trustMode).toBe(true);
      expect(mgr.useWSL).toBe(false);
    });

    test('kills previous terminals before launching', () => {
      mgr.launchAll('/tmp', 2, {});
      mgr.launchAll('/tmp', 3, {});
      expect(mgr.slots.length).toBe(3);
    });

    test('claude: spawn réussi flippe slot.resume → true (prochain = --resume)', () => {
      // index 0 spawn synchrone (1er du stagger) + node-pty mocké → succès →
      // resume passe à true APRÈS le spawn (cf. fix anti-poison dans spawn()).
      mgr.launchAll('/tmp', 1, { engine: 'claude' });
      expect((mgr.slots[0] as any).sessionId).toBeTruthy();
      expect((mgr.slots[0] as any).resume).toBe(true);
    });
  });

  describe('_buildLaunch — spawn direct claude', () => {
    function build(opts: { trustMode?: boolean; useWSL?: boolean; sessionId?: string | null; resume?: boolean }) {
      const m = new PtyManager();
      m.engine = 'claude';
      m.trustMode = !!opts.trustMode;
      m.useWSL = !!opts.useWSL;
      const slot: any = { sessionId: opts.sessionId ?? null, resume: !!opts.resume };
      const launch = (m as any)._buildLaunch('/work', slot);
      return { launch, slot };
    }

    test('mode direct, aucune injection shell', () => {
      const { launch } = build({ trustMode: true, sessionId: 'uuid-1', resume: false });
      expect(launch.mode).toBe('direct');
      expect(launch.injectCmd).toBeNull();
    });

    test('1er lancement: --session-id <uuid> + trust flag', () => {
      const { launch, slot } = build({ trustMode: true, sessionId: 'uuid-1', resume: false });
      expect(launch.args).toContain('--dangerously-skip-permissions');
      expect(launch.args).toContain('--session-id');
      expect(launch.args).toContain('uuid-1');
      expect(launch.args).not.toContain('--resume');
      // _buildLaunch est en lecture seule : il ne flippe PAS resume. Le passage
      // à true se fait dans spawn() après un pty.spawn réussi (anti-poison : un
      // spawn qui throw ne doit pas forcer un --resume d'une session inexistante).
      expect(slot.resume).toBe(false);
    });

    test('reboot: --resume <uuid> (pas --session-id)', () => {
      const { launch } = build({ trustMode: true, sessionId: 'uuid-2', resume: true });
      expect(launch.args).toContain('--resume');
      expect(launch.args).toContain('uuid-2');
      expect(launch.args).not.toContain('--session-id');
    });

    test('sans trustMode: pas de --dangerously-skip-permissions', () => {
      const { launch } = build({ trustMode: false, sessionId: 'uuid-3', resume: false });
      expect(launch.args).not.toContain('--dangerously-skip-permissions');
    });

    test('WSL (win32 only): passe par wsl.exe -- claude', () => {
      if (process.platform !== 'win32') return; // branche WSL gardée par isWin
      const { launch } = build({ trustMode: true, useWSL: true, sessionId: 'uuid-4', resume: false });
      expect(launch.shell).toBe('wsl.exe');
      expect(launch.args.slice(0, 4)).toEqual(['--cd', '/work', '--', 'claude']);
      expect(launch.args).toContain('--session-id');
      expect(launch.args).toContain('uuid-4');
    });
  });

  describe('getStatus', () => {
    test('returns all workers', () => {
      mgr.launchAll('/tmp', 2, { engine: 'claude' });
      const status = mgr.getStatus();
      expect(status.length).toBe(2);
      expect(status.every((s: any) => s.role === 'worker')).toBe(true);
    });

    test('reports alive status correctly', () => {
      mgr.launchAll('/tmp', 1, {});
      const status = mgr.getStatus();
      expect(status[0].alive).toBe(true);
      expect(status[0].pid).toBeGreaterThan(0);
    });
  });

  describe('getOutput', () => {
    function setupSlots(chunks: string[]) {
      const joined = chunks.join('');
      (mgr as any).slots = [{ pty: null, ws: null, startedAt: null, chunks, chunksTotalLen: joined.length, joinedCache: joined, dirty: false }];
      (mgr as any).count = 1;
    }

    test('returns empty string for empty buffer', () => {
      setupSlots([]);
      expect(mgr.getOutput(0)).toBe('');
    });

    test('strips ANSI codes', () => {
      setupSlots(['\x1b[31mRed text\x1b[0m']);
      expect(mgr.getOutput(0)).toBe('Red text');
    });

    test('respects lastN parameter', () => {
      setupSlots(['a'.repeat(5000)]);
      const output = mgr.getOutput(0, 100);
      expect(output.length).toBeLessThanOrEqual(100);
    });

    test('returns empty for out-of-range index', () => {
      setupSlots([]);
      expect(mgr.getOutput(99)).toBe('');
    });
  });

  describe('sendInput', () => {
    test('writes text to pty', () => {
      mgr.launchAll('/tmp', 1, {});
      const result = mgr.sendInput(0, 'hello');
      expect(result).toBe(true);
      expect(mgr.slots[0].pty!.write).toHaveBeenCalledWith('hello');
    });

    test('returns false for invalid index', () => {
      mgr.launchAll('/tmp', 1, {});
      expect(mgr.sendInput(99, 'hello')).toBe(false);
    });

    test('returns false for dead slot', () => {
      mgr.launchAll('/tmp', 1, {});
      mgr.kill(0);
      expect(mgr.sendInput(0, 'hello')).toBe(false);
    });

    test('wraps multi-line text in bracketed-paste markers', () => {
      mgr.launchAll('/tmp', 1, {});
      mgr.sendInput(0, 'line1\nline2\nline3');
      expect(mgr.slots[0].pty!.write).toHaveBeenCalledWith(
        '\x1b[200~line1\nline2\nline3\x1b[201~'
      );
    });
  });

  describe('sendCommand', () => {
    test('writes command with carriage return', () => {
      mgr.launchAll('/tmp', 1, {});
      const result = mgr.sendCommand(0, '/compact');
      expect(result).toBe(true);
      expect(mgr.slots[0].pty!.write).toHaveBeenCalledWith('/compact\r');
    });

    test('returns false for invalid index', () => {
      mgr.launchAll('/tmp', 1, {});
      expect(mgr.sendCommand(99, '/compact')).toBe(false);
    });

    test('returns false for dead slot', () => {
      mgr.launchAll('/tmp', 1, {});
      mgr.kill(0);
      expect(mgr.sendCommand(0, '/compact')).toBe(false);
    });
  });

  describe('kill / killAll', () => {
    test('kill clears slot state', () => {
      mgr.launchAll('/tmp', 1, {});
      expect(mgr.slots[0].pty).not.toBeNull();
      mgr.kill(0);
      expect(mgr.slots[0].pty).toBeNull();
      expect(mgr.slots[0].startedAt).toBeNull();
      expect(mgr.slots[0].chunks).toEqual([]);
      expect(mgr.slots[0].chunksTotalLen).toBe(0);
    });

    test('killAll clears all slots', () => {
      mgr.launchAll('/tmp', 3, {});
      mgr.killAll();
      mgr.slots.forEach((slot: any) => {
        expect(slot.pty).toBeNull();
      });
    });
  });

  describe('attach', () => {
    test('closes ws for out-of-range index', () => {
      mgr.launchAll('/tmp', 1, {});
      const fakeWs = {
        readyState: 1,
        close: jest.fn(),
        send: jest.fn(),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
      } as any;
      mgr.attach(99, fakeWs);
      expect(fakeWs.close).toHaveBeenCalledWith(4000, expect.any(String));
    });

    test('sends buffered output on attach', () => {
      const fakePty = { write: jest.fn(), kill: jest.fn(), onData: jest.fn(() => ({ dispose: jest.fn() })), onExit: jest.fn(() => ({ dispose: jest.fn() })) } as any;
      (mgr as any).slots = [{ pty: fakePty, ws: null, startedAt: new Date().toISOString(), chunks: ['hello'], chunksTotalLen: 5, joinedCache: 'hello', dirty: false }];
      (mgr as any).count = 1;
      const fakeWs = {
        readyState: 1,
        close: jest.fn(),
        send: jest.fn(),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
      } as any;
      mgr.attach(0, fakeWs);
      expect(fakeWs.send).toHaveBeenCalledWith('hello');
    });
  });

  describe('ANSI_RE regex', () => {
    test('matches CSI sequences', () => {
      expect('\x1b[31m'.replace(ANSI_RE, '')).toBe('');
      expect('\x1b[0m'.replace(ANSI_RE, '')).toBe('');
      expect('\x1b[1;32;40m'.replace(ANSI_RE, '')).toBe('');
    });

    test('matches OSC sequences', () => {
      expect('\x1b]0;title\x07'.replace(ANSI_RE, '')).toBe('');
    });

    test('matches OSC terminated by ST (ESC backslash)', () => {
      // OSC 11 (background color query) terminé par ST — utilisé par Kiro TUI
      expect('\x1b]11;rgb:0000/0000/0000\x1b\\'.replace(ANSI_RE, '')).toBe('');
      // OSC 8 (hyperlink) terminé par ST
      expect('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'.replace(ANSI_RE, '')).toBe('link');
    });

    test('matches DCS sequences (sixel etc.)', () => {
      expect('\x1bP1;2;3q...\x1b\\'.replace(ANSI_RE, '')).toBe('');
    });

    test('matches keypad mode and DECALN', () => {
      expect('\x1b='.replace(ANSI_RE, '')).toBe('');
      expect('\x1b>'.replace(ANSI_RE, '')).toBe('');
      expect('\x1b#8'.replace(ANSI_RE, '')).toBe('');
    });

    test('does not match normal text', () => {
      expect('hello world'.replace(ANSI_RE, '')).toBe('hello world');
    });
  });

  describe('Sprint 1 — auto-restart backoff', () => {
    test('restart() resets crashed flag and restartCount', () => {
      mgr.launchAll('/tmp', 1);
      mgr.slots[0].crashed = true;
      mgr.slots[0].restartCount = 3;
      mgr.restart(0);
      expect(mgr.slots[0].crashed).toBe(false);
      expect(mgr.slots[0].restartCount).toBe(0);
    });

    test('getStatus exposes crashed flag', () => {
      mgr.launchAll('/tmp', 1);
      mgr.slots[0].crashed = true;
      const status = mgr.getStatus();
      expect(status[0].crashed).toBe(true);
    });
  });

  describe('Sprint 1 — sendInput pendingEnter clear', () => {
    test('multiple rapid sendInput clears previous pendingEnterTimer', () => {
      jest.useFakeTimers();
      mgr.launchAll('/tmp', 1);
      mgr.sendInput(0, 'first');
      const timer1 = mgr.slots[0].pendingEnterTimer;
      expect(timer1).toBeTruthy();
      mgr.sendInput(0, 'second');
      const timer2 = mgr.slots[0].pendingEnterTimer;
      expect(timer2).toBeTruthy();
      expect(timer2).not.toBe(timer1);
      jest.useRealTimers();
    });

    test('kill() clears pendingEnterTimer', () => {
      mgr.launchAll('/tmp', 1);
      mgr.sendInput(0, 'hello');
      expect(mgr.slots[0].pendingEnterTimer).toBeTruthy();
      mgr.kill(0);
      expect(mgr.slots[0].pendingEnterTimer).toBeNull();
    });
  });

  describe('Sprint 2 — strippedCache in getOutput', () => {
    test('reuses strippedCache between calls without re-stripping', () => {
      mgr.launchAll('/tmp', 1);
      const slot = mgr.slots[0] as any;
      slot.chunks = ['\x1b[31mred\x1b[0m text'];
      slot.chunksTotalLen = slot.chunks[0].length;
      slot.joinedCache = slot.chunks[0];
      slot.dirty = false;
      slot.strippedCache = '';

      const out1 = mgr.getOutput(0, 100);
      expect(out1).toBe('red text');
      // Le cache est rempli
      expect(slot.strippedCache).toBe('red text');

      // Second appel : si on mute strippedCache directement, on doit récupérer
      // la nouvelle valeur (preuve que le cache est utilisé sans rebuild).
      slot.strippedCache = 'cached value';
      const out2 = mgr.getOutput(0, 100);
      expect(out2).toBe('cached value');
    });

    test('invalidates strippedCache when buffer is dirty', () => {
      mgr.launchAll('/tmp', 1);
      const slot = mgr.slots[0] as any;
      slot.chunks = ['hello'];
      slot.chunksTotalLen = 5;
      slot.joinedCache = '';
      slot.dirty = true;
      slot.strippedCache = 'stale';

      // Appelle _getBuffer indirectement via getOutput → invalide strippedCache
      mgr.getOutput(0, 100);
      // Le cache a été invalidé puis re-rempli avec la valeur fraîche
      expect(slot.strippedCache).toBe('hello');
    });
  });

  describe('Sprint 2 — engine-aware maxBuffer', () => {
    test('claude engine uses default MAX_BUFFER', () => {
      mgr.launchAll('/tmp', 1, { engine: 'claude' });
      expect(mgr.maxBuffer).toBe(MAX_BUFFER);
    });

    test('kiro engine uses larger buffer', () => {
      mgr.launchAll('/tmp', 1, { engine: 'kiro' });
      expect(mgr.maxBuffer).toBeGreaterThan(MAX_BUFFER);
    });
  });

  describe('suggestions', () => {
    test('getSuggestion returns null when no suggestion exists', () => {
      mgr.launchAll('/tmp', 2, { suggestMode: 'static' });
      expect(mgr.getSuggestion(1)).toBeNull();
    });

    test('dismissSuggestion removes suggestion', () => {
      mgr.launchAll('/tmp', 2, { suggestMode: 'static' });
      (mgr as any).suggestions[1] = { text: 'yes', source: 'static', pending: false };
      mgr.dismissSuggestion(1);
      expect(mgr.getSuggestion(1)).toBeNull();
    });

    test('generateSuggestion does nothing when suggestMode is off', () => {
      mgr.launchAll('/tmp', 1, { suggestMode: 'off' });
      mgr.generateSuggestion(0);
      expect(mgr.getSuggestion(0)).toBeNull();
    });

    test('generateSuggestion creates static suggestion for matching output', () => {
      mgr.launchAll('/tmp', 1, { suggestMode: 'static' });
      const longOutput = 'x'.repeat(200) + 'Do you want to proceed? (y/n)';
      mgr.slots[0].chunks = [longOutput];
      mgr.slots[0].chunksTotalLen = longOutput.length;
      (mgr.slots[0] as any).joinedCache = longOutput;
      (mgr.slots[0] as any).dirty = false;
      mgr.generateSuggestion(0);
      const suggestion = mgr.getSuggestion(0);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.text).toBe('yes');
      expect(suggestion!.source).toBe('static');
    });

    test('generateSuggestion skips short output', () => {
      mgr.launchAll('/tmp', 1, { suggestMode: 'static' });
      mgr.slots[0].chunks = ['short'];
      mgr.slots[0].chunksTotalLen = 5;
      (mgr.slots[0] as any).joinedCache = 'short';
      (mgr.slots[0] as any).dirty = false;
      mgr.generateSuggestion(0);
      expect(mgr.getSuggestion(0)).toBeNull();
    });

    test('suggestMode is set from launchAll opts', () => {
      mgr.launchAll('/tmp', 1, { suggestMode: 'ai' });
      expect(mgr.suggestMode).toBe('ai');
    });
  });

  describe('per-worker cwd', () => {
    test('spawn uses slot.cwd over the global/explicit cwd', () => {
      const spawnSpy = jest.spyOn(pty, 'spawn');
      mgr.launchAll('/global', 1, { engine: 'claude' });
      // index 0 (spawn synchrone du stagger), pas de slot.cwd → workdir global
      expect((spawnSpy.mock.calls[0][2] as any).cwd).toBe('/global');

      // re-pointe le worker puis respawn : slot.cwd doit gagner même si on
      // passe explicitement le cwd global en argument de spawn().
      mgr.kill(0);
      spawnSpy.mockClear();
      mgr.slots[0].cwd = '/perworker';
      mgr.spawn(0, '/global');
      expect((spawnSpy.mock.calls[0][2] as any).cwd).toBe('/perworker');
      spawnSpy.mockRestore();
    });

    test('changeWorkerCwd: set cwd + régénère le sessionId (claude) + resume=false', () => {
      mgr.launchAll('/global', 1, { engine: 'claude' });
      const oldSession = mgr.slots[0].sessionId;
      expect(oldSession).toBeTruthy();
      const ok = mgr.changeWorkerCwd(0, '/newdir');
      expect(ok).toBe(true);
      expect(mgr.slots[0].cwd).toBe('/newdir');
      expect(mgr.slots[0].sessionId).not.toBe(oldSession);
      expect(mgr.slots[0].resume).toBe(false);
    });

    test('changeWorkerCwd: kiro garde sessionId null', () => {
      mgr.launchAll('/global', 1, { engine: 'kiro' });
      expect(mgr.changeWorkerCwd(0, '/newdir')).toBe(true);
      expect(mgr.slots[0].cwd).toBe('/newdir');
      expect(mgr.slots[0].sessionId).toBeNull();
    });

    test('changeWorkerCwd: false hors borne / worker removed', () => {
      mgr.launchAll('/global', 2, {});
      expect(mgr.changeWorkerCwd(99, '/x')).toBe(false);
      expect(mgr.changeWorkerCwd(-1, '/x')).toBe(false);
      mgr.removeWorker(0);
      expect(mgr.changeWorkerCwd(0, '/x')).toBe(false);
    });

    test('restoreAll relit le cwd par worker (absent → global)', () => {
      mgr.restoreAll({
        cwd: '/global', engine: 'claude', trustMode: false, useWSL: false,
        workers: [
          { index: 0, sessionId: 'uuid-a', cwd: '/proj-a' },
          { index: 1, sessionId: 'uuid-b' },
        ],
      });
      expect(mgr.slots[0].cwd).toBe('/proj-a');
      expect(mgr.slots[1].cwd).toBeUndefined();
    });
  });
});
