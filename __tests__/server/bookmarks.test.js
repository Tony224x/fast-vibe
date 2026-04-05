const request = require('supertest');

jest.mock('node-pty');

// Reset bookmarks cache between tests by re-requiring the module
let app;
beforeAll(() => {
  ({ app } = require('../../server'));
});

const HEADER = { 'X-Requested-With': 'FastVibe' };

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
    expect(res.body.some(b => b.path === '/tmp/test-project')).toBe(true);
    expect(res.body.find(b => b.path === '/tmp/test-project').name).toBe('Test Project');
  });

  test('POST duplicate path is deduplicated', async () => {
    // Add the same path twice
    await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/dedup-test' });
    const res = await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/dedup-test' });
    const count = res.body.filter(b => b.path === '/tmp/dedup-test').length;
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
    const bookmark = res.body.find(b => b.path === '/home/user/my-project');
    expect(bookmark.name).toBe('my-project');
  });

  test('DELETE /api/bookmarks removes by path', async () => {
    // Ensure it exists
    await request(app).post('/api/bookmarks').set(HEADER).send({ path: '/tmp/to-delete' });
    // Delete it
    const res = await request(app)
      .delete('/api/bookmarks')
      .set(HEADER)
      .send({ path: '/tmp/to-delete' });
    expect(res.status).toBe(200);
    expect(res.body.some(b => b.path === '/tmp/to-delete')).toBe(false);
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
