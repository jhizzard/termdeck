// Theme resolver — render-time theme resolution (v0.7.0).
//
// Pre-v0.7.0, the theme each terminal rendered with was snapshotted at session
// creation time and written into sessions.theme. Editing ~/.termdeck/config.yaml
// and restarting the server did not change existing terminals' themes — they
// kept whatever the wizard had written into SQLite at create time.
// (Brad, 2026-04-26: "ignores changes to config.yaml and is stuck in tokyo night.")
//
// v0.7.0 separates "the user explicitly chose a theme for this terminal" from
// "fall back to whatever the config currently says is the default":
//
//   sessions.theme_override  →  user's explicit choice via the dropdown (NULL = no override)
//   config.projects[p].defaultTheme → per-project default in YAML
//   config.defaultTheme       →  global default in YAML
//   'tokyo-night'             →  hard-coded floor
//
// resolveTheme(session, config) walks that ladder. Called at *read time*
// (every metadata broadcast), so editing config.yaml + restarting the server
// — or just editing it, since getCurrentConfig() invalidates on file mtime —
// propagates to all un-overridden sessions immediately.

const fs = require('fs');
const path = require('path');
const os = require('os');

let _configCache = { mtimeMs: 0, value: null, frozen: false };

function getCurrentConfig() {
  // Used as the second-arg fallback when the caller doesn't pass an explicit
  // config (production path: meta.theme getter inside Session). Keyed off the
  // YAML file's mtime so a Brad-style "edit config.yaml + restart" — and even
  // an edit *without* restart — picks up the new defaults on the next read.
  if (_configCache.frozen) return _configCache.value;
  try {
    const cfgPath = path.join(os.homedir(), '.termdeck', 'config.yaml');
    const stat = fs.statSync(cfgPath);
    if (_configCache.value && stat.mtimeMs === _configCache.mtimeMs) {
      return _configCache.value;
    }
    const { loadConfig } = require('./config');
    _configCache = { mtimeMs: stat.mtimeMs, value: loadConfig(), frozen: false };
    return _configCache.value;
  } catch (_err) {
    return _configCache.value || {};
  }
}

function resolveTheme(session, config) {
  const cfg = config || getCurrentConfig();
  const project = session && session.project;
  const projectDefault = cfg && cfg.projects && project && cfg.projects[project] && cfg.projects[project].defaultTheme;
  return (
    (session && session.theme_override) ||
    projectDefault ||
    (cfg && cfg.defaultTheme) ||
    'tokyo-night'
  );
}

// Test seam: freezes the cache so the disk-mtime check is bypassed. Lets unit
// tests inject a config without an actual ~/.termdeck/config.yaml on disk (or
// while the user *does* have one — important: the dev box typically has a real
// config.yaml that would otherwise leak into tests). Production never calls this.
function _setCachedConfigForTests(value) {
  _configCache = { mtimeMs: Number.MAX_SAFE_INTEGER, value, frozen: true };
}

function _resetCacheForTests() {
  _configCache = { mtimeMs: 0, value: null, frozen: false };
}

module.exports = {
  resolveTheme,
  getCurrentConfig,
  _setCachedConfigForTests,
  _resetCacheForTests
};
