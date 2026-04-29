// PTY orphan reaper (Sprint 42 T2).
//
// Each TermDeck session spawns one shell PTY (`term.pid` from node-pty). That
// shell typically forks Claude Code, which in turn forks MCP children
// (rag-system, imessage-mcp, …). When the user closes a panel TermDeck calls
// `term.kill()`, which delivers SIGHUP to the leader's process group — but
// some MCPs `setsid` to detach, escape the pgroup, and survive the parent.
// Reparented to launchd, those processes keep holding their PTY file
// descriptors, and on macOS that drains `kern.tty.ptmx_max` (511 by default).
// Joshua's 2026-04-28 morning incident: 585 PTY refs, `forkpty: Device not
// configured` blocking new terminals.
//
// This module periodically (every 30s by default) walks the live process tree
// and, for each known session, tracks descendants of its PTY leader. When the
// leader is gone or the session has transitioned to `exited`, any descendants
// that survived get SIGTERM'd and recorded to a ring buffer surfaced via
// /api/pty-reaper/status.
//
// All side-effects (`ps`, `kill`, `now`, the timer) are injectable so the
// tests in tests/pty-reaper.test.js can drive deterministic orphan scenarios
// without forking real processes.
//
// Public surface:
//   createPtyReaper({ sessions, intervalMs?, ps?, kill?, now?, logger? })
//     → { start(), stop(), tick(), status(), _resetForTest() }

const { execFileSync } = require('child_process');

const RING_SIZE = 200;
const DEFAULT_INTERVAL_MS = 30000;

// Default `ps` boundary — execFileSync is sandbox-friendly (no shell).
// `-e` lists every process; the trailing `=` on each column header suppresses
// the header row, so the output is one process per line: "<pid> <ppid> <cmd>".
function defaultPs() {
  const stdout = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePsOutput(stdout);
}

function parsePsOutput(stdout) {
  const out = [];
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Two leading whitespace-separated integers, then the rest is command.
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    out.push({ pid, ppid, command: m[3] });
  }
  return out;
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

function createPtyReaper({
  sessions,
  intervalMs = DEFAULT_INTERVAL_MS,
  ps = defaultPs,
  kill = defaultKill,
  now = Date.now,
  logger = console,
} = {}) {
  if (!sessions) {
    throw new Error('createPtyReaper: sessions (SessionManager) is required');
  }

  // Per-session registry: sessionId → { ptyPid, descendants:Set<pid>,
  // firstSeenAt, lastSeenAliveAt }. Refreshed each tick while the leader is
  // alive so when it dies we still know which descendants to chase.
  const registry = new Map();
  let reapedHistory = [];
  let tickCount = 0;
  let lastTickAt = null;
  let lastError = null;
  let timer = null;

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function recordReap(entry) {
    reapedHistory.push(entry);
    if (reapedHistory.length > RING_SIZE) {
      reapedHistory = reapedHistory.slice(-RING_SIZE);
    }
  }

  function bfsDescendants(rootPid, childrenByPpid) {
    const out = new Set();
    const stack = [rootPid];
    const seen = new Set([rootPid]);
    while (stack.length) {
      const cur = stack.pop();
      const kids = childrenByPpid.get(cur);
      if (!kids) continue;
      for (const kid of kids) {
        if (seen.has(kid.pid)) continue;
        seen.add(kid.pid);
        out.add(kid.pid);
        stack.push(kid.pid);
      }
    }
    return out;
  }

  function iterSessions() {
    // SessionManager.sessions is a Map<id, Session>; iterate the values
    // directly so we get the live Session instances (not toJSON copies).
    if (sessions.sessions && typeof sessions.sessions.values === 'function') {
      return Array.from(sessions.sessions.values());
    }
    return [];
  }

  function tick() {
    tickCount += 1;
    lastTickAt = isoNow();

    let snapshot;
    try {
      snapshot = ps();
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (logger && logger.error) {
        logger.error('[pty-reaper] ps() failed:', lastError);
      }
      return { reaped: 0, refreshed: 0, error: lastError };
    }

    if (!Array.isArray(snapshot)) snapshot = [];
    const livePids = new Set();
    const procByPid = new Map();
    const childrenByPpid = new Map();
    for (const proc of snapshot) {
      if (!proc || !Number.isFinite(proc.pid)) continue;
      livePids.add(proc.pid);
      procByPid.set(proc.pid, proc);
      const kids = childrenByPpid.get(proc.ppid);
      if (kids) kids.push(proc);
      else childrenByPpid.set(proc.ppid, [proc]);
    }

    let refreshed = 0;
    let reaped = 0;
    const liveSessionIds = new Set();

    // Pass 1: refresh registry for every known session whose leader is alive.
    for (const session of iterSessions()) {
      if (!session || !session.id) continue;
      liveSessionIds.add(session.id);
      const ptyPid = session.pid;
      if (!Number.isFinite(ptyPid)) continue;

      const leaderAlive = livePids.has(ptyPid);
      const exited = session.meta && session.meta.status === 'exited';

      if (leaderAlive && !exited) {
        const descendants = bfsDescendants(ptyPid, childrenByPpid);
        const existing = registry.get(session.id);
        registry.set(session.id, {
          ptyPid,
          descendants,
          firstSeenAt: existing ? existing.firstSeenAt : isoNow(),
          lastSeenAliveAt: isoNow(),
        });
        refreshed += 1;
      }
    }

    // Pass 2: for each registry entry whose leader has died OR whose session
    // has transitioned to 'exited' (or whose Session has been removed from
    // the manager entirely), kill any descendants still alive and drop the
    // entry. We rely on the descendant snapshot captured by the most recent
    // refresh — once the leader is reaped we can't BFS from a dead pid.
    for (const [sessionId, entry] of Array.from(registry.entries())) {
      const session = sessions.get ? sessions.get(sessionId) : null;
      const stillRegistered = liveSessionIds.has(sessionId);
      const leaderAlive = livePids.has(entry.ptyPid);
      const exited = session && session.meta && session.meta.status === 'exited';

      if (stillRegistered && leaderAlive && !exited) continue;

      const reason = !leaderAlive
        ? 'leader_dead'
        : exited
          ? 'session_exited'
          : 'session_removed';

      for (const descPid of entry.descendants) {
        if (!livePids.has(descPid)) continue;
        const meta = procByPid.get(descPid) || { pid: descPid, ppid: null, command: '' };
        try {
          kill(descPid, 'SIGTERM');
          recordReap({
            ts: isoNow(),
            sessionId,
            ptyPid: entry.ptyPid,
            pid: descPid,
            ppid: meta.ppid,
            command: (meta.command || '').slice(0, 200),
            reason,
            outcome: 'signaled',
          });
          reaped += 1;
        } catch (err) {
          // ESRCH = already dead; anything else we record but don't throw.
          const code = err && err.code ? err.code : null;
          recordReap({
            ts: isoNow(),
            sessionId,
            ptyPid: entry.ptyPid,
            pid: descPid,
            ppid: meta.ppid,
            command: (meta.command || '').slice(0, 200),
            reason,
            outcome: code === 'ESRCH' ? 'already_dead' : 'kill_failed',
            error: err && err.message ? err.message : String(err),
          });
        }
      }
      registry.delete(sessionId);
    }

    return { reaped, refreshed, error: null };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
        if (logger && logger.error) {
          logger.error('[pty-reaper] tick() threw:', lastError);
        }
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status() {
    const registrySnapshot = [];
    for (const [sessionId, entry] of registry) {
      registrySnapshot.push({
        sessionId,
        ptyPid: entry.ptyPid,
        descendantPids: Array.from(entry.descendants),
        firstSeenAt: entry.firstSeenAt,
        lastSeenAliveAt: entry.lastSeenAliveAt,
      });
    }
    return {
      tickCount,
      lastTickAt,
      intervalMs,
      lastError,
      registry: registrySnapshot,
      reapedCount: reapedHistory.length,
      reapedHistory: reapedHistory.slice(),
    };
  }

  function _resetForTest() {
    stop();
    registry.clear();
    reapedHistory = [];
    tickCount = 0;
    lastTickAt = null;
    lastError = null;
  }

  return { start, stop, tick, status, _resetForTest };
}

module.exports = {
  createPtyReaper,
  parsePsOutput,
  RING_SIZE,
  DEFAULT_INTERVAL_MS,
};
