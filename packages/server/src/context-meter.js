'use strict';

// Sprint 80 T2 — context telemetry + enforcement pure core (FR-5 + FR-6).
//
// WHY THIS EXISTS: on 2026-06-26 four of Brad's five orchestrator panels rode
// their Claude context to 356K–999K tokens unseen and crashed the host. Claude-
// side self-monitoring provably fails at high context (the model is exactly the
// component that has run out of room to notice). This module is the TermDeck-
// layer answer: read the true context size off the on-disk transcript and let
// the server enforce a ceiling.
//
// Everything here is PURE and side-effect-free (except reading a file in
// computeContextK) so the compute, threshold classification, and — critically —
// the FR-6 hysteresis + kill-guard state machine are 100% unit-testable with no
// server, no PTY, and no timers. The index.js wiring supplies the fs.watch, the
// meta broadcast, and the action side-effects (notify/inject/kill); this module
// supplies the decisions.

const fs = require('fs');

// Read only the tail of the transcript. A high-context Claude JSONL is many MB;
// re-reading the whole file on every fs.watch tick would be wasteful. The last
// assistant turn (which carries the cumulative `usage` block we want) is a
// single JSONL line near the end, so a 256 KB tail reliably contains at least
// one complete assistant turn even when individual lines carry large tool
// results. Overridable for tests via computeContextK's opts.tailBytes.
const DEFAULT_TAIL_BYTES = 256 * 1024;

// ──────────────────────────────────────────────────────────────────────────
// computeContextK(transcriptPath, opts?) →
//   { contextTokens, contextK } | null
//
// Scans the tail of a Claude Code JSONL transcript backwards for the most
// recent assistant turn carrying a `usage` block, and returns the effective
// context size:
//
//   context = usage.input_tokens
//           + usage.cache_read_input_tokens
//           + usage.cache_creation_input_tokens
//
// This is the same figure Claude Code's own /context view and the 1M-context
// wall track — the cache-read tokens dominate (see the sampled 309K above), so
// omitting them would under-report by ~99% and defeat the whole feature.
//
// Returns null (NOT 0) when the file is unreadable, empty, or contains no usage
// block yet (fresh panel, non-Claude transcript, truncated tail). Callers MUST
// treat null as "no new reading — retain the prior value" so a transient
// mid-write truncated tail never clobbers a good contextK with a stale/zero one.
//
// NEVER throws.
// ──────────────────────────────────────────────────────────────────────────
function computeContextK(transcriptPath, opts = {}) {
  const tailBytes = (typeof opts.tailBytes === 'number' && opts.tailBytes > 0)
    ? opts.tailBytes
    : DEFAULT_TAIL_BYTES;

  let fd;
  try {
    if (!transcriptPath) return null;
    const stat = fs.statSync(transcriptPath);
    if (!stat.size) return null;

    const readBytes = Math.min(stat.size, tailBytes);
    const start = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readBytes, start);
    const text = buf.toString('utf8');

    // Split into lines. When we read a tail (start > 0) the first element may be
    // a partial line whose head was cut off — that's fine, we scan backwards and
    // JSON.parse simply fails on it, so it's skipped like any other bad line.
    const lines = text.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Cheap pre-filter: only JSON.parse lines that could carry usage. Avoids
      // parsing every user turn / tool-result / summary line in the tail.
      if (!line || line.indexOf('"usage"') === -1) continue;

      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || typeof obj !== 'object') continue;

      // Skip sub-agent / sidechain turns: their usage reflects the sub-agent's
      // own context, not the main panel's, and could report a smaller number
      // than the real conversation size.
      if (obj.isSidechain) continue;

      const usage = obj.message && obj.message.usage;
      if (!usage || typeof usage !== 'object') continue;

      const tokens = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
      if (!(tokens > 0)) continue;

      return { contextTokens: tokens, contextK: Math.round(tokens / 1000) };
    }
    return null;
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_c) { /* noop */ } }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// classifyContext(contextK, warnK, overK) → 'ok' | 'warn' | 'over' | 'unknown'
//
// Header colour band for FR-5. 'unknown' when contextK isn't a number yet
// (fresh Claude panel with no usage, or a non-Claude panel) — the client
// renders no ctx chip in that state (no header noise when unknown).
// ──────────────────────────────────────────────────────────────────────────
function classifyContext(contextK, warnK, overK) {
  if (typeof contextK !== 'number' || !Number.isFinite(contextK)) return 'unknown';
  if (typeof overK === 'number' && contextK >= overK) return 'over';
  if (typeof warnK === 'number' && contextK >= warnK) return 'warn';
  return 'ok';
}

const VALID_ACTIONS = new Set(['notify', 'inject', 'kill']);

function normalizeAction(action) {
  return VALID_ACTIONS.has(action) ? action : 'notify';
}

// ──────────────────────────────────────────────────────────────────────────
// evaluateEnforcement({ contextK, maxContextK, warnK, action, midToolUse,
//                       state, maxDeferrals }) → decision
//
// The FR-6 state machine, expressed as a pure transition so the tricky parts —
// (1) one firing per breach episode (hysteresis), (2) re-arm only after context
// falls back below WARN (i.e. after a rotation), (3) NEVER kill mid-tool-use:
// defer up to maxDeferrals then act — are all testable without timers or a PTY.
//
// `state` is a plain object owned by the caller (session._contextEnforce),
// mutated in place: { armed: bool, deferrals: number }. First call may pass
// {} — missing fields default (armed=true, deferrals=0).
//
// Returns one of:
//   { kind: 'none' }                         — nothing to do
//   { kind: 'reset' }                        — dropped below WARN; re-armed
//   { kind: 'defer', deferrals }             — kill deferred (mid-tool-use)
//   { kind: 'fire', action }                 — run the action now
//
// Only `kill` defers on mid-tool-use. `notify`/`inject` fire immediately on
// breach: nudging a force-rotate paste into the input box mid-tool-use is
// harmless (it queues and lands after the tool call); terminating the process
// mid-tool-use is the only genuinely destructive case, so that is the one the
// grace pass guards (PLANNING §3.3).
// ──────────────────────────────────────────────────────────────────────────
function evaluateEnforcement(params) {
  const {
    contextK,
    maxContextK,
    warnK,
    action,
    midToolUse = false,
    state = {},
    maxDeferrals = 3,
  } = params || {};

  if (state.armed === undefined) state.armed = true;
  if (typeof state.deferrals !== 'number') state.deferrals = 0;

  // No reading yet, or enforcement disabled → nothing to decide.
  if (typeof contextK !== 'number' || !Number.isFinite(contextK)) return { kind: 'none' };
  if (typeof maxContextK !== 'number' || !(maxContextK > 0)) return { kind: 'none' };

  // Hysteresis re-arm: once the panel drops back below WARN, a rotation has
  // happened — re-arm so the NEXT breach fires again. Reset deferral counter too.
  // (If WARN isn't configured below the cap, fall back to the cap itself as the
  // re-arm floor so we still re-arm after a drop.)
  const rearmFloor = (typeof warnK === 'number' && warnK > 0 && warnK < maxContextK)
    ? warnK
    : maxContextK;
  if (contextK < rearmFloor) {
    const wasFired = state.armed === false;
    state.armed = true;
    state.deferrals = 0;
    return wasFired ? { kind: 'reset' } : { kind: 'none' };
  }

  // Between the re-arm floor and the cap: hold (no action, but don't re-arm —
  // stay latched if we already fired this episode).
  if (contextK < maxContextK) return { kind: 'none' };

  // At/over the cap.
  if (state.armed === false) return { kind: 'none' }; // already handled this breach

  const act = normalizeAction(action);

  if (act === 'kill' && midToolUse && state.deferrals < maxDeferrals) {
    state.deferrals += 1;
    return { kind: 'defer', deferrals: state.deferrals };
  }

  // Fire. Latch so we don't re-fire every subsequent write above the cap.
  state.armed = false;
  state.deferrals = 0;
  return { kind: 'fire', action: act };
}

module.exports = {
  computeContextK,
  classifyContext,
  evaluateEnforcement,
  normalizeAction,
  DEFAULT_TAIL_BYTES,
  VALID_ACTIONS,
};
