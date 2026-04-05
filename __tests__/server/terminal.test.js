const request = require('supertest');

jest.mock('node-pty');

const { app, ptyManager } = require('../../server');

const HEADER = { 'X-Requested-With': 'FastVibe' };

beforeAll(() => {
  ptyManager.launchAll(process.cwd(), 2, { engine: 'claude', noPilot: false });
});

afterAll(() => {
  ptyManager.killAll();
});

describe('Terminal control API', () => {
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
    // Launch first
    await request(app).post('/api/launch').set(HEADER).send({ cwd: process.cwd(), workers: 1 });
    const res = await request(app).post('/api/stop').set(HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/status returns terminal statuses', async () => {
    // Launch to have something to report
    await request(app).post('/api/launch').set(HEADER).send({ cwd: process.cwd(), workers: 2 });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.terminals)).toBe(true);
    expect(res.body.terminals.length).toBeGreaterThan(0);
    expect(res.body.terminals[0]).toHaveProperty('id');
    expect(res.body.terminals[0]).toHaveProperty('alive');
    expect(res.body.terminals[0]).toHaveProperty('role');
    // Cleanup
    ptyManager.killAll();
  });
});
