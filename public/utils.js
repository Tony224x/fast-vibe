// Pure utility functions — shared between browser and tests

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ESC_MAP[c]);
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')   // OSC sequences
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')         // CSI sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')               // charset sequences
    .replace(/\x1b[>=<]/g, '')                       // mode sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // control chars (keep \n\r\t)
}

function elapsed(iso) {
  if (!iso) return '-';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Wrapper for POST fetch with CSRF header
function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function deleteJson(url, body) {
  return fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FastVibe' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

// Export for Node.js (tests), no-op in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { debounce, escapeHtml, stripAnsi, elapsed, postJson, deleteJson, ESC_MAP };
}
