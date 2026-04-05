const request = require('supertest');

jest.mock('node-pty');

const { app } = require('../../server');

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
