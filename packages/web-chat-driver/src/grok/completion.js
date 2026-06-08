// Layered completion detection for grok.com — Sprint 72 T3
//
// CONTRACT (ORCH Blocker-2 decision, 2026-06-08): runs on a real Playwright
// Page at `handle.page` (T1 supplies it via connectOverCDP). Uses Playwright
// locators + page.evaluate — NOT raw CDP.
//
// GOAL: know when Grok has FINISHED streaming a reply, WITHOUT a fixed sleep.
// Fixed sleeps are the classic chat-automation bug — too short truncates the
// answer, too long wastes wall-clock, and neither survives variable reasoning
// time. (Carried lesson: the cib_acceptd_tagger `networkidle`-as-primary-gate
// mis-fire — recall "networkidle mis-fires completion gate". Network idleness
// is NOT generation completion.)
//
// THREE LAYERS, combined:
//   Layer 1 — PRIMARY, portable: the composer's send↔stop button FLIP. When a
//     turn starts, grok swaps Send for a Stop-generating button; when the turn
//     ends, Stop disappears (Send returns). The appearance→disappearance of
//     Stop is tied to the actual generation state machine, not DOM heuristics,
//     so it is the most reliable signal and survives restyling.
//   Layer 2 — BACKSTOP: a MutationObserver on a STABLE response ancestor that
//     resolves when no mutations land for `quietMs` (~600ms). Covers the case
//     where the Stop button can't be located (selector drift) or the reply was
//     so short the button flip was missed. Quiet alone is NOT authoritative
//     (reasoning pauses look quiet), so it must be corroborated.
//   Layer 3 — CONFIRMATION: the copy/regenerate affordance grok renders under
//     a finished message. Its presence corroborates "quiet" into "done".
//
// decideComplete() below is the PURE truth-table that fuses the three signals;
// it is unit-tested. waitForComplete() is the Playwright glue that gathers the
// signals (integration-tested by T1's live bring-up).

'use strict';

const selectors = require('./selectors');

// ──────────────────────────────────────────────────────────────────────────
// decideComplete() — PURE. Fuse the three layered signals into a verdict.
//
//   generationStarted : did we ever observe the Stop button appear?
//   stopVisible       : is the Stop button currently visible?
//   quiet             : has the response container been mutation-quiet ≥quietMs?
//   affordancePresent : is a copy/regenerate control present under the message?
//
// Rules:
//   • Primary: if generation was observed to start and Stop is now gone → done.
//   • Backstop: if quiet AND a copy/regenerate affordance is present → done
//     (covers selector drift / missed button flip).
//   • Otherwise: not done.
// ──────────────────────────────────────────────────────────────────────────
function decideComplete(signals) {
  const {
    generationStarted = false,
    stopVisible = false,
    quiet = false,
    affordancePresent = false,
  } = signals || {};

  if (generationStarted && !stopVisible) return true;
  if (quiet && affordancePresent) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// IN-PAGE quiet waiter. Serialized into the page via page.evaluate(); MUST be
// self-contained (no outer-scope refs). Installs a MutationObserver on the
// element matching `selector`, resolving `true` once no mutations land for
// `quietMs`, or `false` if `maxMs` elapses first. Observes subtree+character
// data so it survives the inner re-render churn of streaming tokens.
//
// Exported as a named function so page.evaluate(quietWaiterInPage, args) can
// serialize it; we keep it here (not inlined) for readability + a smoke check.
// ──────────────────────────────────────────────────────────────────────────
function quietWaiterInPage(args) {
  const { selector, quietMs, maxMs } = args;
  return new Promise((resolve) => {
    const target = document.querySelector(selector) || document.body;
    let quietTimer = null;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      try { obs.disconnect(); } catch (e) { /* noop */ }
      resolve(val);
    };
    const arm = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    };
    const obs = new MutationObserver(() => arm());
    obs.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
    // Start the quiet timer immediately; any mutation re-arms it.
    arm();
    // Hard ceiling so a perpetually-mutating page can't hang the wait.
    setTimeout(() => finish(false), maxMs);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// waitForComplete() — GLUE. Run the layered detection against a live page.
//
// Phase A: confirm generation started by waiting (bounded by `startTimeout`)
//          for the Stop button to become visible. If it never appears, the
//          reply may have been instant or the selector drifted → skip to the
//          backstop instead of failing.
// Phase B (primary): if generation started, wait for Stop to become hidden
//          (bounded by `maxTimeout`). Success → done.
// Backstop: MutationObserver-quiet on the stable response container, then
//          corroborate with the copy/regenerate affordance.
//
// Returns { complete, via }. `complete` is true ONLY for a CONFIRMED completion
// (via 'button-flip' or 'quiet+affordance'); 'quiet-only' and 'timeout' are
// DEGRADED (complete:false) so a long reasoning turn or selector drift can never
// be mistaken for a finished turn.
//
// No fixed sleeps anywhere. Generous `maxTimeout` (default 180s) carries the
// "don't copy a too-short timeout" lesson from the Acceptd tagger.
// ──────────────────────────────────────────────────────────────────────────
async function waitForComplete(page, opts = {}) {
  const startTimeout = opts.startTimeout != null ? opts.startTimeout : 8000;
  const maxTimeout = opts.maxTimeout != null ? opts.maxTimeout : 180000;
  const quietMs = opts.quietMs != null ? opts.quietMs : 600;

  // Resolve the Stop button locator (optional — may not be findable).
  let stop = null;
  try { stop = await selectors.resolveLocator(page, 'stop', { timeout: 1500 }); }
  catch { stop = null; }

  // ── Phase A: did generation start? ──
  let generationStarted = false;
  if (stop) {
    try {
      await stop.waitFor({ state: 'visible', timeout: startTimeout });
      generationStarted = true;
    } catch {
      generationStarted = false; // instant reply or selector miss → backstop
    }
  }

  // ── Phase B (primary): Stop disappears. ──
  if (generationStarted) {
    try {
      await stop.waitFor({ state: 'hidden', timeout: maxTimeout });
      return { complete: true, via: 'button-flip' };
    } catch {
      // fall through to backstop — primary timed out / selector drifted
    }
  }

  // ── Backstop: quiet + affordance corroboration. ──
  // Only 'quiet+affordance' is a CONFIRMED completion. 'quiet-only' (stream
  // paused but no copy/regenerate to corroborate — could be a reasoning pause)
  // and 'timeout' (no reliable signal within maxTimeout) are DEGRADED:
  // complete:false, so consumers keep the panel non-final and do NOT capture the
  // possibly-partial/stale text as the final turn. This keeps waitForComplete
  // consistent with decideComplete() (quiet without affordance = NOT done).
  // (Fix for T4-CODEX FINDING 2026-06-08 13:16 — timeout-as-success / partial-text.)
  const via = await waitForQuietAndAffordance(page, { quietMs, maxTimeout });
  return { complete: via === 'quiet+affordance', via };
}

// Backstop helper: install the in-page quiet waiter on the stable response
// container, then corroborate with the copy/regenerate affordance.
async function waitForQuietAndAffordance(page, { quietMs, maxTimeout }) {
  // Find a stable selector string for the response container to hand into the
  // page. We try the catalog CSS strategies first (cheap, serializable); the
  // observer falls back to <body> in-page if the selector matches nothing.
  let containerSelector = 'main';
  for (const s of selectors.GROK_SELECTORS.responseContainer) {
    if (s.kind === 'css') { containerSelector = s.value; break; }
  }

  let quietReached = false;
  try {
    quietReached = await page.evaluate(quietWaiterInPage, {
      selector: containerSelector,
      quietMs,
      maxMs: maxTimeout,
    });
  } catch {
    quietReached = false;
  }

  // Corroborate: is a copy/regenerate affordance present? Best-effort — its
  // absence does not veto a clean quiet result (some grok states hide it).
  let affordancePresent = false;
  try {
    const aff = await selectors.resolveLocator(page, 'copyAffordance', { timeout: 1500 });
    affordancePresent = (await aff.count()) > 0;
  } catch {
    affordancePresent = false;
  }

  if (decideComplete({ quiet: quietReached, affordancePresent })) return 'quiet+affordance';
  // Quiet was reached but no affordance found — still our best completion
  // estimate under selector drift; report it honestly via the `via` tag.
  return quietReached ? 'quiet-only' : 'timeout';
}

module.exports = {
  decideComplete,
  quietWaiterInPage,
  waitForComplete,
  waitForQuietAndAffordance,
};
