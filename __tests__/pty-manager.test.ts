jest.mock('node-pty');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, writeFile: jest.fn((_p: any, _data: any, cb: any) => cb && cb()) };
});

import * as fs from 'fs';
import { PtyManager, writePilotPrompt, ANSI_RE, MAX_BUFFER, PILOT_PROMPT_FILE } from '../src/pty-manager';

const mockWriteFile = fs.writeFile as unknown as jest.Mock;

describe('writePilotPrompt', () => {
  beforeEach(() => {
    mockWriteFile.mockClear();
  });

  test('generates prompt with correct worker count', () => {
    writePilotPrompt(3);
    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain('3 EXTERNAL worker');
    expect(content).toContain('workers 1-3');
    expect(content).toContain('1, 2, 3');
  });

  test('includes CSRF header in curl commands', () => {
    writePilotPrompt(2);
    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain('X-Requested-With: FastVibe');
  });

  test('includes all API endpoints', () => {
    writePilotPrompt(2);
    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain('/api/terminal/N/send');
    expect(content).toContain('/api/terminal/N/output');
    expect(content).toContain('/api/terminal/N/compact');
    expect(content).toContain('/api/terminal/N/clear');
    expect(content).toContain('/api/status');
  });
});

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
      expect(mgr.noPilot).toBe(false);
    });
  });

  describe('launchAll', () => {
    test('creates 1 pilot + N worker slots', () => {
      mgr.launchAll('/tmp', 4, { engine: 'claude', noPilot: false });
      expect(mgr.count).toBe(5);
      expect(mgr.slots.length).toBe(5);
    });

    test('with noPilot creates only N slots', () => {
      mgr.launchAll('/tmp', 3, { engine: 'claude', noPilot: true });
      expect(mgr.count).toBe(3);
      expect(mgr.slots.length).toBe(3);
    });

    test('sets engine and options', () => {
      mgr.launchAll('/tmp', 2, { engine: 'kiro', noPilot: true, trustMode: true, useWSL: false });
      expect(mgr.engine).toBe('kiro');
      expect(mgr.noPilot).toBe(true);
      expect(mgr.trustMode).toBe(true);
      expect(mgr.useWSL).toBe(false);
    });

    test('kills previous terminals before launching', () => {
      mgr.launchAll('/tmp', 2, {});
      mgr.launchAll('/tmp', 3, {});
      expect(mgr.slots.length).toBe(4); // 1 pilot + 3 workers
    });
  });

  describe('getStatus', () => {
    test('returns correct roles with pilot', () => {
      mgr.launchAll('/tmp', 2, { engine: 'claude', noPilot: false });
      const status = mgr.getStatus();
      expect(status[0].role).toBe('pilot');
      expect(status[1].role).toBe('worker');
      expect(status[2].role).toBe('worker');
    });

    test('returns all workers in noPilot mode', () => {
      mgr.launchAll('/tmp', 2, { engine: 'claude', noPilot: true });
      const status = mgr.getStatus();
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
});
