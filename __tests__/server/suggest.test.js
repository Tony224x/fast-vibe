const request = require('supertest');

jest.mock('node-pty');

const { app, ptyManager } = require('../../server');

const HEADER = { 'X-Requested-With': 'FastVibe' };

beforeAll(() => {
  ptyManager.launchAll(process.cwd(), 2, { engine: 'claude', noPilot: false, suggestMode: 'static' });
});

afterAll(() => {
  ptyManager.killAll();
});

describe('Suggest API', () => {
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
      // Manually set a suggestion
      ptyManager.suggestions = ptyManager.suggestions || {};
      ptyManager.suggestions[1] = { text: 'yes', source: 'static', pending: false };
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
      ptyManager.suggestions = ptyManager.suggestions || {};
      ptyManager.suggestions[1] = { text: 'yes', source: 'static', pending: false };
      const res = await request(app)
        .post('/api/suggest/1/dismiss')
        .set(HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Verify it's gone
      expect(ptyManager.getSuggestion(1)).toBeNull();
    });
  });
});
