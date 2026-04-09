import { escapeHtml, stripAnsi, elapsed, debounce, postJson, deleteJson } from '../src/client/utils';

// ── escapeHtml (XSS protection) ──

describe('escapeHtml', () => {
  test('escapes <script> tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("a 'b' c")).toBe('a &#39;b&#39; c');
  });

  test('escapes angle brackets', () => {
    expect(escapeHtml('<div class="x">')).toBe('&lt;div class=&quot;x&quot;&gt;');
  });

  test('returns normal text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  test('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('handles all special chars together', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

// ── stripAnsi ──

describe('stripAnsi', () => {
  test('strips CSI color codes', () => {
    expect(stripAnsi('\x1b[31mRed\x1b[0m')).toBe('Red');
  });

  test('strips OSC sequences (title set)', () => {
    expect(stripAnsi('\x1b]0;My Title\x07text')).toBe('text');
  });

  test('strips charset sequences', () => {
    expect(stripAnsi('\x1b(Btest')).toBe('test');
  });

  test('strips mode sequences', () => {
    expect(stripAnsi('\x1b>test\x1b=end')).toBe('testend');
  });

  test('strips control chars but keeps newlines/tabs', () => {
    expect(stripAnsi('hello\x01\x02world\n\ttab')).toBe('helloworld\n\ttab');
  });

  test('returns clean text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  test('handles complex mixed ANSI', () => {
    const input = '\x1b[1;32m✓\x1b[0m \x1b[90mtest passed\x1b[0m';
    expect(stripAnsi(input)).toBe('✓ test passed');
  });
});

// ── elapsed ──

describe('elapsed', () => {
  test('returns "-" for null', () => {
    expect(elapsed(null)).toBe('-');
  });

  test('returns "-" for undefined', () => {
    expect(elapsed(undefined)).toBe('-');
  });

  test('returns "-" for empty string', () => {
    expect(elapsed('')).toBe('-');
  });

  test('formats seconds', () => {
    const iso = new Date(Date.now() - 30000).toISOString();
    expect(elapsed(iso)).toBe('30s');
  });

  test('formats minutes and seconds', () => {
    const iso = new Date(Date.now() - 125000).toISOString(); // 2m 5s
    expect(elapsed(iso)).toBe('2m 5s');
  });

  test('formats hours and minutes', () => {
    const iso = new Date(Date.now() - 7500000).toISOString(); // 2h 5m
    expect(elapsed(iso)).toBe('2h 5m');
  });

  test('returns 0s for now', () => {
    const iso = new Date().toISOString();
    expect(elapsed(iso)).toBe('0s');
  });
});

// ── debounce ──

describe('debounce', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('calls function after delay', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a');
  });

  test('resets timer on rapid calls', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    jest.advanceTimersByTime(50);
    debounced('b');
    jest.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });
});

// ── postJson / deleteJson (CSRF headers) ──

describe('postJson', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn(() => Promise.resolve({ ok: true } as Response));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sends POST with X-Requested-With: FastVibe', async () => {
    await postJson('/api/test', { key: 'val' });
    expect(global.fetch).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
      body: JSON.stringify({ key: 'val' }),
    });
  });

  test('sends undefined body when body is null', async () => {
    await postJson('/api/test', null);
    expect(global.fetch).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
      body: undefined,
    });
  });

  test('sends undefined body when no body argument', async () => {
    await postJson('/api/test');
    expect(global.fetch).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
      body: undefined,
    });
  });
});

describe('deleteJson', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn(() => Promise.resolve({ ok: true } as Response));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sends DELETE with X-Requested-With: FastVibe', async () => {
    await deleteJson('/api/bookmarks', { path: '/tmp' });
    expect(global.fetch).toHaveBeenCalledWith('/api/bookmarks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
      body: JSON.stringify({ path: '/tmp' }),
    });
  });

  test('uses DELETE method, not POST', async () => {
    await deleteJson('/api/test');
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[1].method).toBe('DELETE');
  });
});
