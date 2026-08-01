'use strict';

// Best-effort live-port registry — ~/.termdeck/ports.json.
//
// Written by the server at listen-time so OUT-OF-PROCESS consumers — chiefly
// the MCP bridge's panel tools (list_panels / recent_activity / panel_status,
// see packages/mcp-bridge/src/clients/termdeck-base.js) — can discover which
// port(s) a live deck is actually serving on instead of assuming :3000.
// (Bug fixed 2026-07-31: a deck on :3001 made the bridge report "no visible
// panels" because nothing on disk recorded the real port.)
//
// Shape: { version: 1, decks: [ { port, pid, startedAt } ] }
//   - one entry per live deck (multiple decks on one host are legal);
//   - a write REPLACES any prior entry for the same port and PRUNES entries
//     whose pid is no longer alive;
//   - readers (the bridge) also skip dead-pid entries AND verify candidates
//     with a live probe, so a stale entry can never misdirect anyone.
//
// FAIL-SOFT: registry trouble must NEVER block startup — recordLivePort
// catches everything and returns false. Two decks booting at the exact same
// instant can race the read-merge-write and drop each other's entry; that is
// accepted best-effort (the bridge's port-probe fallback still finds both).

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultPortsPath() {
  return path.join(os.homedir(), '.termdeck', 'ports.json');
}

// pid liveness via signal 0. EPERM = alive but owned by someone else; any
// other error (ESRCH) = dead. killImpl is a test seam.
function isPidAlive(pid, killImpl) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kill = killImpl || process.kill.bind(process);
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

// Tolerant read: missing / corrupt file → []; accepts the canonical
// { version, decks } wrapper or a bare array.
function readPortsFile(portsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(portsPath || defaultPortsPath(), 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.decks)) return parsed.decks;
  } catch { /* start fresh */ }
  return [];
}

// recordLivePort(port, { portsPath?, pid?, startedAt?, killImpl? }) → boolean
// Merge-write this deck's { port, pid, startedAt } into the registry:
// replaces any prior entry for the same port, prunes dead-pid entries,
// tmp-then-rename so a reader never sees a torn write (pid-suffixed tmp so
// two decks booting at once cannot clobber each other's tmp file).
function recordLivePort(port, opts = {}) {
  try {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false;
    const portsPath = opts.portsPath || defaultPortsPath();
    const pid = opts.pid || process.pid;
    const startedAt = opts.startedAt || new Date().toISOString();
    const decks = readPortsFile(portsPath)
      .filter((d) => d && Number.isInteger(d.port))
      .filter((d) => d.port !== port)                   // replaced by this write
      .filter((d) => isPidAlive(d.pid, opts.killImpl)); // prune dead decks
    decks.push({ port, pid, startedAt });
    fs.mkdirSync(path.dirname(portsPath), { recursive: true });
    const tmp = `${portsPath}.${pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, decks }, null, 2) + '\n');
    fs.renameSync(tmp, portsPath);
    return true;
  } catch (err) {
    try {
      console.error('[ports-file] best-effort write failed:', err && err.message);
    } catch { /* never throw from a fail-soft path */ }
    return false;
  }
}

module.exports = { recordLivePort, readPortsFile, defaultPortsPath, isPidAlive };
