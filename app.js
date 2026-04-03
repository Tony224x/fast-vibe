const { exec } = require('child_process');
const { platform } = require('os');

const PORT = process.env.PORT || 3333;
const URL = `http://localhost:${PORT}`;

// Start the server
const server = require('child_process').fork('./server.js', { stdio: 'inherit' });

// Wait for server to be ready, then open native window
setTimeout(() => {
  const os = platform();
  // Try Chrome/Edge in app mode (no tabs, no URL bar — looks like a native app)
  const browsers = os === 'win32'
    ? [
        `start msedge --app=${URL}`,
        `start chrome --app=${URL}`,
      ]
    : os === 'darwin'
    ? [
        `open -a "Google Chrome" --args --app=${URL}`,
        `open -a "Microsoft Edge" --args --app=${URL}`,
      ]
    : [
        `google-chrome --app=${URL}`,
        `microsoft-edge --app=${URL}`,
        `chromium --app=${URL}`,
      ];

  function tryOpen(i) {
    if (i >= browsers.length) {
      console.log(`Open ${URL} manually in your browser.`);
      return;
    }
    exec(browsers[i], (err) => {
      if (err) tryOpen(i + 1);
    });
  }

  tryOpen(0);
}, 1500);

server.on('exit', () => process.exit());
process.on('SIGINT', () => { server.kill(); process.exit(); });
process.on('SIGTERM', () => { server.kill(); process.exit(); });
