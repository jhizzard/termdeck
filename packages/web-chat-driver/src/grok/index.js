// driver.grok.* — the Grok web-chat automation namespace — Sprint 72 T3
//
// CONTRACT (ORCH Blocker-2 decision, 2026-06-08): operates on a real Playwright
// Page at `handle.page` (T1 supplies it via connectOverCDP). Selector + locator
// based — NOT raw CDP. T1's raw Input.* primitives (sendInput/insertText) are
// the HUMAN drive-through path; this programmatic inject uses the Playwright
// locator API (fill + click) for robustness with long/multiline prompts.
//
// This is the surface T2's `web-chat-grok` adapter consumes. It composes the
// selector catalog (./selectors) and the layered completion detector
// (./completion) into three published contracts:
//
//   inject(handle, text)      → type `text` into the composer + send, await
//                               layered completion, and resolve with
//                               { text, complete, via }. `complete` is true only
//                               for a CONFIRMED completion; on a degraded
//                               'timeout'/'quiet-only' it is false and the text
//                               is best-effort. onComplete() listeners fire ONLY
//                               on a confirmed completion. Pull = await inject;
//                               push = onComplete.
//   onComplete(handle, cb)    → register a listener fired with the final text on
//                               each CONFIRMED completed turn (never on a
//                               degraded/partial turn). Returns an unsubscribe fn.
//   extract(handle)           → re-query + return the current last-assistant
//                               text (never caches a node Locator).
//
// We never `require('playwright')`; the page is supplied via handle.page, so
// this module has zero npm deps and stays CommonJS.
//
// POSTURE: this drives a real, human-present, headful grok.com session at low
// volume — sanctioned co-pilot automation, not scraping. Nothing here is
// headless, stealth-patched, or bulk. (See PLANNING.md § Posture.)

'use strict';

const selectors = require('./selectors');
const completion = require('./completion');

// Per-handle listener registry. WeakMap so listeners are GC'd with the handle;
// no leak when a panel closes.
const _listeners = new WeakMap();

// Resolve the Playwright Page from a T1 handle (or accept a bare page).
function pageOf(handle) {
  if (!handle) throw new Error('[grok] inject/extract called with no handle');
  return handle.page ? handle.page : handle;
}

// ──────────────────────────────────────────────────────────────────────────
// inject(handle, text) — type into the composer + send, then await completion.
// ──────────────────────────────────────────────────────────────────────────
async function inject(handle, text, opts = {}) {
  const page = pageOf(handle);
  const message = String(text == null ? '' : text);

  // 1. Focus + populate the composer. fill() is robust for long/multiline text
  //    (handles textarea AND contenteditable; clears prior draft first).
  const composer = await selectors.resolveLocator(page, 'composer', { timeout: 5000 });
  await composer.click();
  try { await composer.fill(''); } catch { /* contenteditable may reject fill('') */ }
  await composer.fill(message);

  // 2. Send. Prefer the explicit send button; fall back to Enter. Grok submits
  //    on Enter (Shift+Enter = newline), so Enter is a safe fallback.
  let sent = false;
  try {
    const send = await selectors.resolveLocator(page, 'send', { timeout: 2000 });
    if (await send.count() > 0) { await send.click(); sent = true; }
  } catch { /* fall through to Enter */ }
  if (!sent) await composer.press('Enter');

  // 3. Await layered completion, extract, and — ONLY on a CONFIRMED completion —
  //    notify listeners. onComplete fires only when detection is confident the
  //    turn finished (button-flip or quiet+affordance), NOT on a degraded
  //    'timeout'/'quiet-only', so push consumers (T2 capture/broadcast) never
  //    treat partial/stale text as final. Pull callers get the confidence flags
  //    on the returned object. (Fix for T4-CODEX FINDING 2026-06-08 13:16.)
  const result = await completion.waitForComplete(page, opts);
  const finalText = await extract(handle);
  if (result.complete) _notify(handle, finalText, result);
  return { text: finalText, complete: result.complete, via: result.via };
}

// ──────────────────────────────────────────────────────────────────────────
// onComplete(handle, cb) — register a per-turn completion listener.
// ──────────────────────────────────────────────────────────────────────────
function onComplete(handle, cb) {
  if (typeof cb !== 'function') throw new Error('[grok] onComplete requires a callback');
  const arr = _listeners.get(handle) || [];
  arr.push(cb);
  _listeners.set(handle, arr);
  return function unsubscribe() {
    const cur = _listeners.get(handle);
    if (!cur) return;
    const i = cur.indexOf(cb);
    if (i >= 0) cur.splice(i, 1);
  };
}

function _notify(handle, finalText, meta) {
  const arr = _listeners.get(handle);
  if (!arr || !arr.length) return;
  for (const cb of arr.slice()) {
    try { cb(finalText, meta); }
    catch (err) { console.error('[grok] onComplete listener threw:', err && err.message); }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// extract(handle) — current last-assistant text. Re-queries every call.
// ──────────────────────────────────────────────────────────────────────────
async function extract(handle) {
  const page = pageOf(handle);
  return selectors.extractLastAssistantText(page);
}

module.exports = {
  inject,
  onComplete,
  extract,
  // re-exported for T2 / tests / diagnostics
  selectors,
  completion,
};
