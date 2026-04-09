import WebSocket from 'ws';

jest.mock('node-pty');

import { server, ptyManager, PORT } from '../src/server';

let httpServer: import('http').Server;
let port: number;

beforeAll((done) => {
  httpServer = server.listen(0, '127.0.0.1', () => {
    port = (httpServer.address() as import('net').AddressInfo).port;
    ptyManager.launchAll(process.cwd(), 2, { engine: 'claude', noPilot: false });
    done();
  });
});

afterAll((done) => {
  ptyManager.killAll();
  httpServer.close(done);
});

function connectWS(opts: { origin?: string; query?: string } = {}) {
  const { origin, query } = opts;
  const headers = origin ? { origin } : {};
  const url = `ws://127.0.0.1:${port}/ws${query || ''}`;
  return new WebSocket(url, { headers });
}

const VALID_ORIGIN = `http://localhost:${PORT}`;
const VALID_ORIGIN_IP = `http://127.0.0.1:${PORT}`;

describe('WebSocket origin validation (CSWSH)', () => {
  test('accepts connection with localhost origin', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN, query: '?terminal=0' });
    ws.on('open', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', done);
  });

  test('accepts connection with 127.0.0.1 origin', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN_IP, query: '?terminal=0' });
    ws.on('open', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', done);
  });

  test('rejects connection with evil origin', (done) => {
    const ws = connectWS({ origin: 'http://evil.com', query: '?terminal=0' });
    ws.on('close', (code) => {
      expect(code).toBe(4003);
      done();
    });
    ws.on('error', () => {});
  });

  test('accepts connection without origin header', (done) => {
    const ws = connectWS({ query: '?terminal=0' });
    ws.on('open', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', done);
  });
});

describe('WebSocket terminal index validation', () => {
  test('rejects missing terminal param', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN });
    ws.on('close', (code) => {
      expect(code).toBe(4000);
      done();
    });
    ws.on('error', () => {});
  });

  test('rejects terminal=-1', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN, query: '?terminal=-1' });
    ws.on('close', (code) => {
      expect(code).toBe(4000);
      done();
    });
    ws.on('error', () => {});
  });

  test('rejects terminal=abc (NaN)', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN, query: '?terminal=abc' });
    ws.on('close', (code) => {
      expect(code).toBe(4000);
      done();
    });
    ws.on('error', () => {});
  });

  test('accepts valid terminal index', (done) => {
    const ws = connectWS({ origin: VALID_ORIGIN, query: '?terminal=1' });
    ws.on('open', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', done);
  });
});
