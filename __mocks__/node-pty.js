const EventEmitter = require('events');

function spawn(file, args, opts) {
  const proc = new EventEmitter();
  proc.pid = Math.floor(Math.random() * 10000) + 1000;
  proc.write = jest.fn();
  proc.resize = jest.fn();
  proc.kill = jest.fn(() => {
    proc.emit('exit', { exitCode: 0 });
  });

  // Mimic node-pty's IDisposable pattern
  proc.onData = jest.fn((cb) => {
    proc.on('data', cb);
    return { dispose: () => proc.removeListener('data', cb) };
  });
  proc.onExit = jest.fn((cb) => {
    proc.on('exit', cb);
    return { dispose: () => proc.removeListener('exit', cb) };
  });

  // Simulate shell prompt so auto-launch logic fires
  process.nextTick(() => proc.emit('data', '$ '));

  return proc;
}

module.exports = { spawn };
