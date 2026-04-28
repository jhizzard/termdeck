'use strict';

// Shared helpers for the Flashback test suite (Sprint 39 T4).
//
// Extracted from tests/flashback-e2e.test.js so the new
// tests/flashback-production-flow.test.js can reuse the same probe / poll /
// session lifecycle plumbing. Pure utility functions — no shared mutable
// state, no test-runner dependencies. Each helper is independently
// require-able from any tests/*.test.js file.

const WebSocket = require('ws');

const BASE_URL = (process.env.TERMDECK_URL || process.env.TERMDECK_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const REQUEST_TIMEOUT_MS = 3000;
const EVENT_POLL_TIMEOUT_MS = 8000;
const EVENT_POLL_INTERVAL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pollUntil(fn, { timeoutMs, intervalMs }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

// Shape-checks server reachability + Mnestra readiness + SQLite presence.
// Returns { skip: boolean, reason?: string }. Mirrors the `before()` block
// from the original flashback-e2e.test.js so the new production-flow test
// can run the same precondition gate.
async function probeServer() {
  let healthBody;
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/health`);
    if (!res.ok && res.status >= 500) {
      return { skip: true, reason: `server health returned ${res.status}` };
    }
    healthBody = await res.json();
  } catch (err) {
    return { skip: true, reason: `server unreachable at ${BASE_URL}: ${err.message}` };
  }

  const checks = Array.isArray(healthBody?.checks) ? healthBody.checks : [];
  const mnestra = checks.find((c) => c.name === 'mnestra_reachable');
  if (!mnestra || !mnestra.passed) {
    return { skip: true, reason: `mnestra_reachable not passing (${mnestra ? mnestra.detail : 'check absent'})` };
  }

  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/rag/status`);
    if (!res.ok) {
      return { skip: true, reason: `rag status returned ${res.status}` };
    }
    const body = await res.json();
    if (body.localEvents === undefined) {
      return { skip: true, reason: 'server has no SQLite — cannot observe rag_events' };
    }
  } catch (err) {
    return { skip: true, reason: `rag status unreachable: ${err.message}` };
  }

  return { skip: false };
}

// Mnestra corpus probe — confirms there's at least one memory tagged with
// the given project that matches the question. Returns the memory count
// (number) on success, or null if the bridge probe failed (network /
// non-200). Caller decides whether zero is a "needs-backfill" skip or a
// hard failure.
async function preflightProbeProject(question, project) {
  try {
    const probe = await fetchWithTimeout(`${BASE_URL}/api/ai/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, project }),
    });
    if (!probe.ok) return null;
    const body = await probe.json();
    return Array.isArray(body.memories) ? body.memories.length : null;
  } catch {
    return null;
  }
}

// POST /api/sessions wrapper. Records the created session in `cleanupSet`
// (a Set<string>) so callers can flush them all in `after()`. Returns the
// parsed session JSON: { id, pid, meta }.
async function createSession(body, cleanupSet) {
  const res = await fetchWithTimeout(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`POST /api/sessions returned ${res.status}`);
  }
  const session = await res.json();
  if (cleanupSet && session?.id) cleanupSet.add(session.id);
  return session;
}

// Best-effort DELETE — never throws. Used in `after()` cleanup loops.
async function deleteSession(id) {
  try {
    await fetchWithTimeout(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE' });
  } catch {
    // server may already be gone; cleanup is best-effort
  }
}

// POST /api/sessions/:id/input wrapper. Returns the parsed JSON body or
// throws on non-200. The text MUST include the trailing newline if the
// caller wants the shell to execute the command (zsh/bash require LF to
// flush the input buffer).
async function sendInput(id, text) {
  const res = await fetchWithTimeout(`${BASE_URL}/api/sessions/${id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.status !== 200) {
    throw new Error(`POST /api/sessions/${id}/input returned ${res.status}`);
  }
  return await res.json();
}

// Attach a WebSocket subscribed to the session's broadcast stream and
// collect every parsed JSON frame into `frames` (an array). Returns
// { ws, opened (Promise<boolean>), frames, getProactiveHits() }.
//
// The opened promise resolves true on `open`, false on error or timeout
// (default 2s). Callers should `await opened` before sending input so the
// WS is registered with session.ws server-side.
function attachWS(sessionId, { openTimeoutMs = 2000 } = {}) {
  const ws = new WebSocket(`${WS_URL}?session=${sessionId}`);
  const frames = [];
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      frames.push(msg);
    } catch {
      // non-JSON frame — ignore
    }
  });
  const opened = new Promise((resolve) => {
    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; resolve(val); } };
    ws.once('open', () => settle(true));
    ws.once('error', () => settle(false));
    setTimeout(() => settle(false), openTimeoutMs).unref?.();
  });
  function getProactiveHits() {
    return frames.filter((f) => f && f.type === 'proactive_memory');
  }
  function close() {
    try { ws.close(); } catch { /* already closed */ }
  }
  return { ws, opened, frames, getProactiveHits, close };
}

// GET /api/flashback/diag wrapper. Sprint 39 T1 endpoint. Returns
// { count, events: [...] } on success, or null when the route isn't
// registered (server pre-T1 returns the static index.html as the catch-all
// fallback). Callers MUST handle null by skipping diag-cross-check
// assertions with a t.diagnostic — never let a stale-server diag-miss fail
// a test that's otherwise green.
async function fetchDiag({ sessionId, eventType, limit } = {}) {
  try {
    const url = new URL('/api/flashback/diag', BASE_URL);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    if (eventType) url.searchParams.set('eventType', eventType);
    if (limit != null) url.searchParams.set('limit', String(limit));
    const res = await fetchWithTimeout(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.events)) return null;
    return body;
  } catch {
    return null;
  }
}

module.exports = {
  BASE_URL,
  WS_URL,
  REQUEST_TIMEOUT_MS,
  EVENT_POLL_TIMEOUT_MS,
  EVENT_POLL_INTERVAL_MS,
  sleep,
  fetchWithTimeout,
  pollUntil,
  probeServer,
  preflightProbeProject,
  createSession,
  deleteSession,
  sendInput,
  attachWS,
  fetchDiag,
};
