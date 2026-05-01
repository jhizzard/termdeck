'use strict';

// Two-stage submit pattern for the in-dashboard 4+1 sprint runner.
//
// Sprint 37 T4 baseline: Claude-only, bracketed-paste + lone-CR.
// Sprint 47 T3 extension: per-lane agent dispatch via the adapter registry.
//   Each lane may declare an `agent` name (claude/codex/gemini/grok). The
//   helper looks up the adapter and selects the inject shape:
//     • acceptsPaste: true  → bracketed-paste payload (`\x1b[200~…\x1b[201~`)
//                              followed by a lone `\r` after the settle window.
//     • acceptsPaste: false → chunked stdin fallback (line + `\r` per chunk
//                              with `chunkedDelayMs` between). Chunked lanes
//                              self-submit on their last line; the stage-2
//                              `\r` is skipped for them so we don't fire a
//                              duplicate empty submit.
//
// The cardinal rule from the global 4+1 inject mandate (paste path):
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

const { AGENT_ADAPTERS } = require('./agent-adapters');

const DEFAULTS = {
  gapMs: 250,
  settleMs: 400,
  verifyTimeoutMs: 8000,
  verifyPollMs: 500,
  postPokeWaitMs: 500,
  chunkedDelayMs: 20,
};

// Resolve the per-lane inject shape from the adapter registry.
// Returns a discriminated payload:
//   { kind: 'paste',   bytes: string }
//   { kind: 'chunked', lines: string[] }
// When `agent` is null/undefined or the adapter is absent from the registry,
// defaults to bracketed-paste (the Sprint 37 baseline). Unknown agent names
// are not an error here — they just fall through to the bracketed-paste path
// so a typo in a lane brief degrades to "works for Claude-shaped TUIs"
// rather than throwing mid-inject. Validation belongs at lane-frontmatter
// parse time (Sprint 47 T1).
function buildPayload(prompt, agent, adapters) {
  const registry = adapters || AGENT_ADAPTERS;
  const adapter = agent ? registry[agent] : null;
  const acceptsPaste = adapter ? adapter.acceptsPaste !== false : true;
  if (acceptsPaste) {
    return { kind: 'paste', bytes: `\x1b[200~${prompt}\x1b[201~` };
  }
  return { kind: 'chunked', lines: prompt.split('\n') };
}

// Normalize the three accepted input shapes into a single internal lane list.
//   1. { sessionIds, prompts }                    — Sprint 37 baseline (claude only)
//   2. { sessionIds, prompts, agents }            — parallel agents array
//   3. { lanes: [{ sessionId, prompt, agent }] }  — Sprint 47 lanes shape
function normalizeLanes({ sessionIds, prompts, agents, lanes }) {
  if (Array.isArray(lanes)) {
    if (lanes.length === 0) {
      throw new Error('at least one lane required');
    }
    return lanes.map((l, i) => {
      if (!l || typeof l !== 'object') {
        throw new Error(`lanes[${i}] must be an object`);
      }
      if (typeof l.sessionId !== 'string' || !l.sessionId) {
        throw new Error(`lanes[${i}].sessionId must be a non-empty string`);
      }
      if (typeof l.prompt !== 'string') {
        throw new Error(`lanes[${i}].prompt must be a string`);
      }
      return {
        sessionId: l.sessionId,
        prompt: l.prompt,
        agent: l.agent || null,
      };
    });
  }
  if (!Array.isArray(sessionIds) || !Array.isArray(prompts)) {
    throw new Error('sessionIds and prompts must be arrays (or pass lanes[])');
  }
  if (sessionIds.length !== prompts.length) {
    throw new Error('sessionIds and prompts must be the same length');
  }
  if (sessionIds.length === 0) {
    throw new Error('at least one session required');
  }
  if (agents !== undefined && agents !== null) {
    if (!Array.isArray(agents) || agents.length !== sessionIds.length) {
      throw new Error('agents must be an array of the same length as sessionIds');
    }
  }
  return sessionIds.map((sessionId, i) => ({
    sessionId,
    prompt: prompts[i],
    agent: agents ? agents[i] || null : null,
  }));
}

async function injectSprintPrompts({
  sessionIds,
  prompts,
  agents,
  lanes,
  writeBytes,
  getStatus,
  sleep,
  options,
}) {
  if (typeof writeBytes !== 'function') {
    throw new Error('writeBytes(sessionId, bytes) callback required');
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep(ms) callback required');
  }

  const opts = { ...DEFAULTS, ...(options || {}) };
  const registry = (options && options.adapters) || AGENT_ADAPTERS;

  const internal = normalizeLanes({ sessionIds, prompts, agents, lanes });

  const enriched = internal.map((l) => ({
    sessionId: l.sessionId,
    prompt: l.prompt,
    agent: l.agent,
    dispatch: buildPayload(l.prompt, l.agent, registry),
    paste: null,
    submit: null,
    verified: false,
    poked: false,
    finalStatus: null,
  }));

  // Stage 1: per-lane payload. Paste lanes get one PTY write; chunked lanes
  // get N writes (one per line) with `chunkedDelayMs` between. `gapMs`
  // separates lanes from each other so stages stay deterministically ordered.
  for (let i = 0; i < enriched.length; i++) {
    const lane = enriched[i];
    if (lane.dispatch.kind === 'paste') {
      try {
        const r = await writeBytes(lane.sessionId, lane.dispatch.bytes);
        lane.paste = {
          ok: true,
          bytes: (r && r.bytes) || lane.dispatch.bytes.length,
          mode: 'paste',
        };
      } catch (err) {
        lane.paste = {
          ok: false,
          error: err && err.message ? err.message : String(err),
          mode: 'paste',
        };
      }
    } else {
      // chunked
      let totalBytes = 0;
      let firstError = null;
      for (let j = 0; j < lane.dispatch.lines.length; j++) {
        const chunk = lane.dispatch.lines[j] + '\r';
        try {
          const r = await writeBytes(lane.sessionId, chunk);
          totalBytes += (r && r.bytes) || chunk.length;
        } catch (err) {
          firstError = err && err.message ? err.message : String(err);
          break;
        }
        if (j < lane.dispatch.lines.length - 1) {
          await sleep(opts.chunkedDelayMs);
        }
      }
      lane.paste = firstError
        ? { ok: false, error: firstError, mode: 'chunked' }
        : { ok: true, bytes: totalBytes, mode: 'chunked' };
    }
    if (i < enriched.length - 1) await sleep(opts.gapMs);
  }

  // Settle window — long enough for the PTY to flush each paste to the TUI's
  // input handler before the trailing CR lands.
  await sleep(opts.settleMs);

  // Stage 2: submit-only (\r alone, guaranteed its own PTY write).
  // Chunked-mode lanes already self-submitted on their last line — skip.
  for (let i = 0; i < enriched.length; i++) {
    const lane = enriched[i];
    if (!lane.paste || !lane.paste.ok) {
      lane.submit = { ok: false, skipped: 'paste-failed' };
      continue;
    }
    if (lane.paste.mode === 'chunked') {
      lane.submit = { ok: true, bytes: 0, skipped: 'chunked-already-submitted' };
      if (i < enriched.length - 1) await sleep(opts.gapMs);
      continue;
    }
    try {
      const r = await writeBytes(lane.sessionId, '\r');
      lane.submit = { ok: true, bytes: (r && r.bytes) || 1 };
    } catch (err) {
      lane.submit = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (i < enriched.length - 1) await sleep(opts.gapMs);
  }

  // Verify: poll each lane's status until it reads `thinking` or we hit the
  // deadline. Lanes that never thinking → auto-/poke (cr-flood).
  if (typeof getStatus === 'function') {
    const deadline = Date.now() + opts.verifyTimeoutMs;
    while (Date.now() < deadline) {
      let anyPending = false;
      for (const lane of enriched) {
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
    for (const lane of enriched) {
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

  const ok = enriched.every((l) => l.paste && l.paste.ok && l.submit && l.submit.ok);
  return { ok, lanes: enriched };
}

module.exports = {
  injectSprintPrompts,
  buildPayload,
  normalizeLanes,
  DEFAULTS,
};
