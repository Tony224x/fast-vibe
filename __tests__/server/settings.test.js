const request = require('supertest');

jest.mock('node-pty');

const { app } = require('../../server');

const HEADER = { 'X-Requested-With': 'FastVibe' };

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
      // First set to claude
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
    // Set known state
    await request(app).post('/api/settings').set(HEADER).send({ workers: 2, engine: 'claude' });
    // Update only workers
    const res = await request(app).post('/api/settings').set(HEADER).send({ workers: 5 });
    expect(res.body.workers).toBe(5);
    expect(res.body.engine).toBe('claude');
  });
});
