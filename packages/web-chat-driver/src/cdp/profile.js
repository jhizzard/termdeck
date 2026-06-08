'use strict';

// Dedicated-profile management. Chrome 136+ refuses CDP attachment on the *default* user
// profile, so every web-chat session uses a dedicated, persistent --user-data-dir. Persisting
// the dir keeps the human's Grok login warm across TermDeck restarts.

const os = require('os');
const path = require('path');
const fs = require('fs');

// Default debug port for the single-panel case. T2 allocates a distinct port per panel.
const DEFAULT_PORT = 9333;

function profilesRoot() {
  return (
    process.env.TERMDECK_WEB_CHAT_PROFILES_DIR ||
    path.join(os.homedir(), '.termdeck', 'web-chat-profiles')
  );
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Bare name (e.g. "grok") → <profilesRoot>/grok. Absolute path → used verbatim.
function resolveProfileDir(nameOrPath) {
  const v = nameOrPath || 'default';
  if (path.isAbsolute(v)) return ensureDir(v);
  return ensureDir(path.join(profilesRoot(), v));
}

module.exports = { DEFAULT_PORT, profilesRoot, ensureDir, resolveProfileDir };
