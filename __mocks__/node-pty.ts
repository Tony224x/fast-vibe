import { EventEmitter } from 'events';

interface MockPty extends EventEmitter {
  pid: number;
  write: jest.Mock;
  resize: jest.Mock;
  kill: jest.Mock;
  onData: jest.Mock;
  onExit: jest.Mock;
}

export function spawn(): MockPty {
  const proc = new EventEmitter() as MockPty;
  proc.pid = Math.floor(Math.random() * 10000) + 1000;
  proc.write = jest.fn();
  proc.resize = jest.fn();
  proc.kill = jest.fn(() => proc.emit('exit', { exitCode: 0 }));
  proc.onData = jest.fn((cb: (data: string) => void) => {
    proc.on('data', cb);
    return { dispose: () => proc.removeListener('data', cb) };
  });
  proc.onExit = jest.fn((cb: (e: { exitCode: number }) => void) => {
    proc.on('exit', cb);
    return { dispose: () => proc.removeListener('exit', cb) };
  });
  process.nextTick(() => proc.emit('data', '$ '));
  return proc;
}
