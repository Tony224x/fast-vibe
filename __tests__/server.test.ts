import request from 'supertest';

jest.mock('node-pty');

import { app, ptyManager } from '../src/server';

const HEADER = { 'X-Requested-With': 'FastVibe' };

// ── Settings API (from settings.test.js) ──

describe('Settings API', () => {
  test('GET /api/settings returns default settings', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('workers');
    expect(res.body).toHaveProperty('engine');
    expect(res.body).toHaveProperty('noPilot');
    expect(res.body).toHaveProperty('trustMode');
    expect(res.body).toHaveProperty('useWSL');
    expect(res.body).toHaveProperty('autoFocus');
  });

  describe('workers validation', () => {
    test('workers=0 clamps to 1', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 0 });
      expect(res.body.workers).toBe(1);
    });

    test('workers=99 clamps to 8', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 99 });
      expect(res.body.workers).toBe(8);
    });

    test('workers="abc" defaults to 4', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 'abc' });
      expect(res.body.workers).toBe(4);
    });

    test('workers=3 sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 3 });
      expect(res.body.workers).toBe(3);
    });
  });

  describe('engine validation', () => {
    test('engine="kiro" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ engine: 'kiro' });
      expect(res.body.engine).toBe('kiro');
    });

    test('engine="evil" is ignored', async () => {
      await request(app).post('/api/settings').set(HEADER).send({ engine: 'claude' });
      const res = await request(app).post('/api/settings').set(HEADER).send({ engine: 'evil' });
      expect(res.body.engine).toBe('claude');
    });

    test('engine="claude" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ engine: 'claude' });
      expect(res.body.engine).toBe('claude');
    });
  });

  describe('boolean coercion', () => {
    test('noPilot=1 coerces to true', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ noPilot: 1 });
      expect(res.body.noPilot).toBe(true);
    });

    test('noPilot=0 coerces to false', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ noPilot: 0 });
      expect(res.body.noPilot).toBe(false);
    });

    test('trustMode="yes" coerces to true', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ trustMode: 'yes' });
      expect(res.body.trustMode).toBe(true);
    });

    test('useWSL=false sets false', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ useWSL: false });
      expect(res.body.useWSL).toBe(false);
    });

    test('autoFocus=true sets true', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ autoFocus: true });
      expect(res.body.autoFocus).toBe(true);
    });
  });

  describe('theme validation', () => {
    test('theme="light" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ theme: 'light' });
      expect(res.body.theme).toBe('light');
    });

    test('theme="system" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ theme: 'system' });
      expect(res.body.theme).toBe('system');
    });

    test('theme="dark" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ theme: 'dark' });
      expect(res.body.theme).toBe('dark');
    });

    test('theme="evil" is ignored', async () => {
      await request(app).post('/api/settings').set(HEADER).send({ theme: 'dark' });
      const res = await request(app).post('/api/settings').set(HEADER).send({ theme: 'evil' });
      expect(res.body.theme).toBe('dark');
    });
  });

  describe('suggestMode validation', () => {
    test('suggestMode="static" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ suggestMode: 'static' });
      expect(res.body.suggestMode).toBe('static');
    });

    test('suggestMode="ai" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ suggestMode: 'ai' });
      expect(res.body.suggestMode).toBe('ai');
    });

    test('suggestMode="off" sets correctly', async () => {
      const res = await request(app).post('/api/settings').set(HEADER).send({ suggestMode: 'off' });
      expect(res.body.suggestMode).toBe('off');
    });

    test('suggestMode="evil" is ignored', async () => {
      await request(app).post('/api/settings').set(HEADER).send({ suggestMode: 'off' });
      const res = await request(app).post('/api/settings').set(HEADER).send({ suggestMode: 'evil' });
      expect(res.body.suggestMode).toBe('off');
    });
  });

  test('GET returns new fields theme and suggestMode', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body).toHaveProperty('theme');
    expect(res.body).toHaveProperty('suggestMode');
  });

  test('partial update leaves other fields unchanged', async () => {
    await request(app).post('/api/settings').set(HEADER).send({ workers: 2, engine: 'claude' });
    const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 5 });
    expect(res.body.workers).toBe(5);
    expect(res.body.engine).toBe('claude');
  });
});

// ── Bookmarks API (from bookmarks.test.js) ──

describe('Bookmarks API', () => {
  test('GET /api/bookmarks returns array', async () => {
    const res = await request(app).get('/api/bookmarks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/bookmarks adds a bookmark', async () => {
    const res = await request(app)
      .post('/api/bookmarks')
      .set(HEADER)
      .send({ path: '/tmp/test-project', name: 'Test Project' });
    expect(res.status).toBe(200);
    expect(res.body.some((b: any) => b.path === '/tmp/test-project')).toBe(true);
    expect(res.body.find((b: any) => b.path === '/tmp/test-project').name).toBe('Test Project');
  });

  test('POST duplicate path is deduplicated', async () => {
    await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/dedup-test' });
    const res = await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/dedup-test' });
    const count = res.body.filter((b: any) => b.path === '/tmp/dedup-test').length;
    expect(count).toBe(1);
  });

  test('POST without path returns 400', async () => {
    const res = await request(app)
      .post('/api/bookmarks')
      .set(HEADER)
      .send({ name: 'No Path' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path/i);
  });

  test('POST with path but no name uses basename', async () => {
    const res = await request(app)
      .post('/api/bookmarks')
      .set(HEADER)
      .send({ path: '/home/user/my-project' });
    expect(res.status).toBe(200);
    const bookmark = res.body.find((b: any) => b.path === '/home/user/my-project');
    expect(bookmark.name).toBe('my-project');
  });

  test('DELETE /api/bookmarks removes by path', async () => {
    await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/to-delete' });
    const res = await request(app)
      .delete('/api/bookmarks')
      .set(HEADER)
      .send({ path: '/tmp/to-delete' });
    expect(res.status).toBe(200);
    expect(res.body.some((b: any) => b.path === '/tmp/to-delete')).toBe(false);
  });

  test('DELETE nonexistent path returns remaining list without error', async () => {
    const before = await request(app).get('/api/bookmarks');
    const res = await request(app)
      .delete('/api/bookmarks')
      .set(HEADER)
      .send({ path: '/nonexistent' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(before.body.length);
  });
});

// ── CSRF middleware (from csrf.test.js) ──

describe('CSRF middleware', () => {
  describe('blocks requests without X-Requested-With header', () => {
    test('POST /api/settings → 403', async () => {
      const res = await request(app)
        .post('/api/settings')
        .send({ workers: 4 });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/X-Requested-With/);
    });

    test('DELETE /api/bookmarks → 403', async () => {
      const res = await request(app)
        .delete('/api/bookmarks')
        .send({ path: '/tmp/test' });
      expect(res.status).toBe(403);
    });

    test('POST /api/launch → 403', async () => {
      const res = await request(app)
        .post('/api/launch')
        .send({ cwd: '/tmp' });
      expect(res.status).toBe(403);
    });

    test('POST /api/terminal/0/send → 403', async () => {
      const res = await request(app)
        .post('/api/terminal/0/send')
        .send({ text: 'hello' });
      expect(res.status).toBe(403);
    });
  });

  describe('blocks requests with wrong X-Requested-With value', () => {
    test('POST with X-Requested-With: XMLHttpRequest → 403', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ workers: 4 });
      expect(res.status).toBe(403);
    });
  });

  describe('allows requests with correct header', () => {
    test('POST /api/settings with FastVibe header → 200', async () => {
      const res = await request(app)
        .post('/api/settings')
        .set('X-Requested-With', 'FastVibe')
        .send({ workers: 4 });
      expect(res.status).toBe(200);
    });
  });

  describe('does not block safe methods', () => {
    test('GET /api/settings → 200', async () => {
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
    });

    test('GET /api/status → 200', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
    });

    test('GET /api/bookmarks → 200', async () => {
      const res = await request(app).get('/api/bookmarks');
      expect(res.status).toBe(200);
    });
  });
});

// ── Terminal control API (from terminal.test.js) ──

describe('Terminal control API', () => {
  beforeAll(() => {
    ptyManager.launchAll(process.cwd(), 2, { engine: 'claude', noPilot: false });
  });

  afterAll(() => {
    ptyManager.killAll();
  });

  describe('POST /api/terminal/:id/send', () => {
    test('sends text to terminal', async () => {
      const res = await request(app)
        .post('/api/terminal/0/send')
        .set(HEADER)
        .send({ text: 'hello world' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.terminal).toBe(0);
    });

    test('returns 400 without text', async () => {
      const res = await request(app)
        .post('/api/terminal/0/send')
        .set(HEADER)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/text/i);
    });
  });

  describe('POST /api/terminal/:id/compact', () => {
    test('sends /compact command', async () => {
      const res = await request(app)
        .post('/api/terminal/0/compact')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.action).toBe('compact');
    });
  });

  describe('POST /api/terminal/:id/clear', () => {
    test('sends /clear command', async () => {
      const res = await request(app)
        .post('/api/terminal/0/clear')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.action).toBe('clear');
    });
  });

  describe('GET /api/terminal/:id/output', () => {
    test('returns terminal output', async () => {
      const res = await request(app).get('/api/terminal/0/output');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('terminal', 0);
      expect(typeof res.body.output).toBe('string');
    });

    test('respects last query param', async () => {
      const res = await request(app).get('/api/terminal/0/output?last=100');
      expect(res.status).toBe(200);
      expect(res.body.output.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Launch / Stop API', () => {
    test('POST /api/launch starts terminals', async () => {
      const res = await request(app)
        .post('/api/launch')
        .set(HEADER)
        .send({ cwd: process.cwd(), workers: 2 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.workers).toBe(2);
    });

    test('POST /api/stop kills all terminals', async () => {
      await request(app).post('/api/launch').set(HEADER).send({ cwd: process.cwd(), workers: 1 });
      const res = await request(app).post('/api/stop').set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('GET /api/status returns terminal statuses', async () => {
      await request(app).post('/api/launch').set(HEADER).send({ cwd: process.cwd(), workers: 2 });
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.terminals)).toBe(true);
      expect(res.body.terminals.length).toBeGreaterThan(0);
      expect(res.body.terminals[0]).toHaveProperty('id');
      expect(res.body.terminals[0]).toHaveProperty('alive');
      expect(res.body.terminals[0]).toHaveProperty('role');
      ptyManager.killAll();
    });
  });
});

// ── Suggest API (from suggest.test.js) ──

describe('Suggest API', () => {
  beforeAll(() => {
    ptyManager.launchAll(process.cwd(), 2, { engine: 'claude', noPilot: false, suggestMode: 'static' });
  });

  afterAll(() => {
    ptyManager.killAll();
  });

  describe('POST /api/suggest/:workerId', () => {
    test('returns 200 with suggestion field', async () => {
      const res = await request(app)
        .post('/api/suggest/1')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('suggestion');
    });

    test('CSRF blocks without header', async () => {
      const res = await request(app).post('/api/suggest/1');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/suggest/:workerId/send', () => {
    test('returns 400 when no suggestion exists', async () => {
      ptyManager.dismissSuggestion(1);
      const res = await request(app)
        .post('/api/suggest/1/send')
        .set(HEADER);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/suggestion/i);
    });

    test('sends suggestion text when available', async () => {
      (ptyManager as any).suggestions = (ptyManager as any).suggestions || {};
      (ptyManager as any).suggestions[1] = { text: 'yes', source: 'static', pending: false };
      const res = await request(app)
        .post('/api/suggest/1/send')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('sends custom text from body', async () => {
      const res = await request(app)
        .post('/api/suggest/1/send')
        .set(HEADER)
        .send({ text: 'custom response' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('POST /api/suggest/:workerId/dismiss', () => {
    test('dismisses suggestion', async () => {
      (ptyManager as any).suggestions = (ptyManager as any).suggestions || {};
      (ptyManager as any).suggestions[1] = { text: 'yes', source: 'static', pending: false };
      const res = await request(app)
        .post('/api/suggest/1/dismiss')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(ptyManager.getSuggestion(1)).toBeNull();
    });
  });
});
