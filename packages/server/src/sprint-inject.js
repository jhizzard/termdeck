'use strict';

// Two-stage submit pattern for the in-dashboard 4+1 sprint runner (Sprint 37 T4).
//
// The cardinal rule from the global 4+1 inject mandate:
//
//   Stage 1: write `\x1b[200~<prompt>\x1b[201~` to each session in turn,
//            with a small inter-session gap. NO trailing CR.
//   Settle:  ~400ms so the PTY flushes the paste to the input handler.
//   Stage 2: write `\r` alone to each session.
//
// Single-stage `<prompt>\x1b[201~\r` is BANNED — when the close marker and the
// CR ride in one PTY write, the OS-level chunk boundary is non-deterministic;
// some lanes treat `\r` as the trailing paste byte rather than a submit
// keystroke, leaving panels visually populated but waiting on a human Enter.
// That cost Joshua broken sleep during ClaimGuard Sprints 4-5 (2026-04-26) and
// the Sprint-36 inject (2026-04-27). This module is the structural fix.
//
// After both stages, this module verifies each panel reaches `status:'thinking'`
// within `verifyTimeoutMs`. Any lane that didn't get there is auto-poked
// (single CR-flood); we never page the user.
//
// Pure logic — caller injects writeBytes/getStatus/sleep so tests don't need
// a live PTY. Wired in by sprint-routes.js.

const DEFAULTS = {
  gapMs: 250,
  settleMs: 400,
  verifyTimeoutMs: 8000,
  verifyPollMs: 500,
  postPokeWaitMs: 500,
};

async function injectSprintPrompts({
  sessionIds,
  prompts,
  writeBytes,
  getStatus,
  sleep,
  options,
}) {
  if (!Array.isArray(sessionIds) || !Array.isArray(prompts)) {
    throw new Error('sessionIds and prompts must be arrays');
  }
  if (sessionIds.length !== prompts.length) {
    throw new Error('sessionIds and prompts must be the same length');
  }
  if (sessionIds.length === 0) {
    throw new Error('at least one session required');
  }
  if (typeof writeBytes !== 'function') {
    throw new Error('writeBytes(sessionId, bytes) callback required');
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep(ms) callback required');
  }

  const opts = { ...DEFAULTS, ...(options || {}) };

  const lanes = sessionIds.map((sessionId, i) => ({
    sessionId,
    prompt: prompts[i],
    paste: null,
    submit: null,
    verified: false,
    poked: false,
    finalStatus: null,
  }));

  // Stage 1: paste-only across all lanes, gapMs between each.
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    const payload = `\x1b[200~${lane.prompt}\x1b[201~`;
    try {
      const r = await writeBytes(lane.sessionId, payload);
      lane.paste = { ok: true, bytes: (r && r.bytes) || payload.length };
    } catch (err) {
      lane.paste = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (i < lanes.length - 1) await sleep(opts.gapMs);
  }

  // Settle window — long enough for the PTY to flush each paste to the TUI's
  // input handler before the trailing CR lands.
  await sleep(opts.settleMs);

  // Stage 2: submit-only (\r alone, guaranteed its own PTY write).
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    if (!lane.paste || !lane.paste.ok) {
      lane.submit = { ok: false, skipped: 'paste-failed' };
      continue;
    }
    try {
      const r = await writeBytes(lane.sessionId, '\r');
      lane.submit = { ok: true, bytes: (r && r.bytes) || 1 };
    } catch (err) {
      lane.submit = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (i < lanes.length - 1) await sleep(opts.gapMs);
  }

  // Verify: poll each lane's status until it reads `thinking` or we hit the
  // deadline. Lanes that never thinking → auto-/poke (cr-flood).
  if (typeof getStatus === 'function') {
    const deadline = Date.now() + opts.verifyTimeoutMs;
    while (Date.now() < deadline) {
      let anyPending = false;
      for (const lane of lanes) {
        if (lane.verified) continue;
        try {
          const s = await getStatus(lane.sessionId);
          lane.finalStatus = s && s.status ? s.status : null;
          if (lane.finalStatus === 'thinking') {
            lane.verified = true;
          } else {
            anyPending = true;
          }
        } catch {
          anyPending = true;
        }
      }
      if (!anyPending) break;
      await sleep(opts.verifyPollMs);
    }

    // Auto-poke (cr-flood) any lane that didn't reach `thinking`. Best-effort —
    // never page the user; the orchestrator dashboard surfaces the result.
    for (const lane of lanes) {
      if (lane.verified) continue;
      try {
        await writeBytes(lane.sessionId, '\r\r\r');
        lane.poked = true;
      } catch (err) {
        lane.pokeError = err && err.message ? err.message : String(err);
        continue;
      }
      await sleep(opts.postPokeWaitMs);
      try {
        const s = await getStatus(lane.sessionId);
        lane.finalStatus = s && s.status ? s.status : lane.finalStatus;
        if (lane.finalStatus === 'thinking') lane.verified = true;
      } catch {
        // ignore
      }
    }
  }

  const ok = lanes.every((l) => l.paste && l.paste.ok && l.submit && l.submit.ok);
  return { ok, lanes };
}

module.exports = {
  injectSprintPrompts,
  DEFAULTS,
};
