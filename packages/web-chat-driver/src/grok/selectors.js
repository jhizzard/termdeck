// grok.com selector catalog + accessibility self-heal — Sprint 72 T3
//
// CONTRACT (ORCH Blocker-2 decision, 2026-06-08): `handle.page` is a REAL
// Playwright Page supplied by T1 via connectOverCDP. We therefore use the
// Playwright locator API (getByRole/getByTestId/getByLabel/locator) + an
// ARIA-snapshot self-heal — NOT raw CDP. This is the sanctioned approach.
//
// WHY THIS SHAPE: grok.com is a React app whose class names and (sometimes)
// data-testid values churn between deploys. A single hard-coded selector is a
// time bomb. So every UI target is an ORDERED LIST of strategies tried in
// priority order — stable `data-testid` first, then semantic `getByRole`/
// `getByLabel` (resilient to restyling), then structural CSS, and finally an
// accessibility-snapshot SELF-HEAL that reconstructs a locator from the live
// ARIA tree when every hand-authored strategy misses.
//
// CONTRACT BOUNDARY: this module operates on the Playwright `Page` handed to us
// by T1's CDP layer (`driver.cdp.attach()` → handle; we use `handle.page`).
// It NEVER `require('playwright')` itself — zero npm deps, so the package can
// stay CommonJS with no `"type":"module"` and T1 owns the playwright dep.
//
// STALE-LOCATOR LESSON (carried from the Acceptd virtualized-table bug, recall
// "Acceptd virtualized table stale Locator"): grok's response container
// re-renders on EVERY streamed token. Therefore:
//   • Completion detection observes a STABLE ANCESTOR (responseContainer),
//     never the volatile assistant-message node.
//   • Extraction RE-QUERIES the last assistant message at read time; we never
//     cache a message Locator across the stream.
//
// data-testid values below are best-effort placeholders pending live
// confirmation by T1's integration bring-up (browser launch approved). The
// role/label/CSS fallbacks + self-heal are precisely what make a wrong testid
// non-fatal — see STATUS.md FINDING.

'use strict';

// ──────────────────────────────────────────────────────────────────────────
// Selector catalog. Each key maps to an ordered strategy list. Strategy kinds:
//   { kind:'testid', value }                  → page.getByTestId(value)
//   { kind:'role',   role, nameRe }            → page.getByRole(role,{name:nameRe})
//   { kind:'label',  nameRe }                  → page.getByLabel(nameRe)
//   { kind:'placeholder', nameRe }             → page.getByPlaceholder(nameRe)
//   { kind:'css',    value }                   → page.locator(value)
// ──────────────────────────────────────────────────────────────────────────
const GROK_SELECTORS = {
  // The message composer (textarea or contenteditable).
  composer: [
    { kind: 'testid', value: 'grok-composer' },
    { kind: 'label', nameRe: /ask grok|message grok|grok/i },
    { kind: 'placeholder', nameRe: /ask|message|grok|anything/i },
    { kind: 'role', role: 'textbox', nameRe: /ask|grok|message|reply/i },
    { kind: 'css', value: 'form textarea, main textarea' },
    { kind: 'css', value: 'div[contenteditable="true"]' },
  ],

  // Send/submit button (present when idle, ready to send).
  send: [
    { kind: 'testid', value: 'send-button' },
    { kind: 'label', nameRe: /^(send|submit)/i },
    { kind: 'role', role: 'button', nameRe: /^(send|submit)/i },
    { kind: 'css', value: 'form button[type="submit"]' },
    { kind: 'css', value: 'button[aria-label*="send" i], button[aria-label*="submit" i]' },
  ],

  // Stop-generating button (present ONLY while the assistant is streaming).
  // The appear→disappear of this control is the PRIMARY completion signal.
  stop: [
    { kind: 'testid', value: 'stop-button' },
    { kind: 'label', nameRe: /stop/i },
    { kind: 'role', role: 'button', nameRe: /stop/i },
    { kind: 'css', value: 'button[aria-label*="stop" i]' },
  ],

  // STABLE ancestor that wraps the conversation/message list. We attach the
  // MutationObserver here (subtree:true) so it survives inner re-renders.
  responseContainer: [
    { kind: 'testid', value: 'conversation' },
    { kind: 'role', role: 'log' },
    { kind: 'css', value: 'main [role="log"]' },
    { kind: 'css', value: 'main' },
  ],

  // The assistant message turns. Re-queried at extraction time; `.last()`
  // is the freshly-completed response.
  assistantMessage: [
    { kind: 'css', value: '[data-message-author-role="assistant"]' },
    { kind: 'css', value: '[data-author="assistant"], [data-role="assistant"]' },
    { kind: 'css', value: 'main article, main [role="listitem"]' },
  ],

  // Copy / regenerate affordance that grok renders UNDER a completed message.
  // Used as the layer-3 confirmation that a turn is final.
  copyAffordance: [
    { kind: 'testid', value: 'copy-message' },
    { kind: 'label', nameRe: /copy|regenerate/i },
    { kind: 'role', role: 'button', nameRe: /copy|regenerate/i },
    { kind: 'css', value: 'button[aria-label*="copy" i], button[aria-label*="regenerate" i]' },
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// build() — turn one strategy into a Playwright Locator on `page`.
// Pure mapping; no awaiting. Returns a Locator (lazy).
// ──────────────────────────────────────────────────────────────────────────
function build(page, strategy) {
  switch (strategy.kind) {
    case 'testid': return page.getByTestId(strategy.value);
    case 'role': return page.getByRole(strategy.role, strategy.nameRe ? { name: strategy.nameRe } : undefined);
    case 'label': return page.getByLabel(strategy.nameRe);
    case 'placeholder': return page.getByPlaceholder(strategy.nameRe);
    case 'css': return page.locator(strategy.value);
    default: throw new Error(`[grok/selectors] unknown strategy kind: ${strategy.kind}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// parseAriaSnapshot() — PURE. Parse Playwright's YAML-ish ARIA snapshot text
// into a flat list of { role, name }. Snapshot lines look like:
//     - textbox "Ask Grok anything"
//     - button "Send"
//     - log:
//       - text "Hello"
// We tolerate leading "- ", optional trailing ":", and quoted or unquoted
// names. Unit-tested against a saved fixture (no browser needed).
// ──────────────────────────────────────────────────────────────────────────
function parseAriaSnapshot(text) {
  if (typeof text !== 'string' || !text) return [];
  const nodes = [];
  const lineRe = /^\s*-\s*([a-zA-Z][\w-]*)\s*(?:"([^"]*)"|'([^']*)')?\s*:?\s*$/;
  for (const raw of text.split('\n')) {
    const m = raw.match(lineRe);
    if (!m) continue;
    const role = m[1];
    const name = (m[2] != null ? m[2] : m[3] != null ? m[3] : '').trim();
    nodes.push({ role, name });
  }
  return nodes;
}

// Map a catalog key → the ARIA role(s) + name regex we expect, used by
// self-heal to find a matching node in the live ARIA tree.
const SELF_HEAL_HINTS = {
  composer: { roles: ['textbox', 'searchbox', 'combobox'], nameRe: /ask|grok|message|reply|anything/i },
  send: { roles: ['button'], nameRe: /send|submit/i },
  stop: { roles: ['button'], nameRe: /stop/i },
  responseContainer: { roles: ['log', 'main', 'region', 'feed'], nameRe: null },
  assistantMessage: { roles: ['article', 'listitem', 'region'], nameRe: null },
  copyAffordance: { roles: ['button'], nameRe: /copy|regenerate/i },
};

// ──────────────────────────────────────────────────────────────────────────
// selfHeal() — PURE. Given an ARIA snapshot (text or pre-parsed node list) and
// a catalog key, return a best-guess { role, name } to rebuild a getByRole
// locator, or null if nothing plausible exists. This is the resilience layer:
// when grok ships a DOM change that breaks every hand-authored strategy, we
// recover by reading the semantic tree the way a screen-reader would.
// ──────────────────────────────────────────────────────────────────────────
function selfHeal(snapshot, targetKey) {
  const hint = SELF_HEAL_HINTS[targetKey];
  if (!hint) return null;
  const nodes = Array.isArray(snapshot) ? snapshot : parseAriaSnapshot(snapshot);
  // Prefer a node whose role matches AND (if a nameRe is required) name matches.
  for (const wantNamed of [true, false]) {
    for (const role of hint.roles) {
      for (const node of nodes) {
        if (node.role !== role) continue;
        const nameOk = hint.nameRe ? hint.nameRe.test(node.name) : true;
        if (wantNamed) {
          if (hint.nameRe && nameOk && node.name) return { role: node.role, name: node.name };
        } else if (nameOk) {
          // Looser pass: role match is enough (e.g. responseContainer 'log').
          return node.name ? { role: node.role, name: node.name } : { role: node.role };
        }
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// resolveLocator() — GLUE (Playwright-bound; integration-tested, not unit).
// Try each catalog strategy; return the first Locator that matches ≥1 element.
// If all miss, capture a fresh ARIA snapshot and self-heal. Throws only when
// even self-heal fails (caller decides whether that's fatal).
//
// `opts.timeout` bounds each existence probe so a missing optional control
// (e.g. `stop` after an instant reply) fails fast instead of hanging.
// ──────────────────────────────────────────────────────────────────────────
async function resolveLocator(page, targetKey, opts = {}) {
  const strategies = GROK_SELECTORS[targetKey];
  if (!strategies) throw new Error(`[grok/selectors] no catalog entry for "${targetKey}"`);
  const probeTimeout = opts.timeout != null ? opts.timeout : 1500;

  for (const strategy of strategies) {
    let loc;
    try { loc = build(page, strategy); } catch { continue; }
    try {
      // count() resolves immediately; we don't waitFor here — strategy probing
      // must be fast. Callers that need to WAIT for an element use the returned
      // Locator's own .waitFor().
      const n = await loc.count();
      if (n > 0) return loc.first();
    } catch { /* try next strategy */ }
  }

  // Self-heal: read the semantic tree and rebuild a role+name locator.
  const healed = await trySelfHeal(page, targetKey, probeTimeout);
  if (healed) return healed;

  throw new Error(`[grok/selectors] could not resolve "${targetKey}" (all strategies + self-heal missed)`);
}

// Capture an ARIA snapshot of the page and rebuild a locator via selfHeal.
async function trySelfHeal(page, targetKey, timeout) {
  let snapshotText = '';
  try {
    // Playwright ≥1.40 exposes ariaSnapshot() on Locator; root at <body>.
    snapshotText = await page.locator('body').ariaSnapshot({ timeout });
  } catch {
    try { snapshotText = await page.accessibility.snapshot().then((t) => JSON.stringify(t)); }
    catch { return null; }
  }
  const guess = selfHeal(snapshotText, targetKey);
  if (!guess) return null;
  try {
    const loc = guess.name
      ? page.getByRole(guess.role, { name: guess.name })
      : page.getByRole(guess.role);
    if (await loc.count() > 0) return loc.first();
  } catch { /* fall through */ }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// extractLastAssistantText() — GLUE. Re-query the LAST assistant message and
// return its visible text. Never caches a node Locator (stale-locator lesson).
// Falls back through the assistantMessage strategy list, then to the last
// child of the response container if message turns aren't individually marked.
// ──────────────────────────────────────────────────────────────────────────
async function extractLastAssistantText(page) {
  for (const strategy of GROK_SELECTORS.assistantMessage) {
    let loc;
    try { loc = build(page, strategy); } catch { continue; }
    try {
      const n = await loc.count();
      if (n > 0) {
        const text = await loc.last().innerText();
        if (text && text.trim()) return text.trim();
      }
    } catch { /* next strategy */ }
  }
  // Last resort: deepest text under the response container.
  try {
    const container = await resolveLocator(page, 'responseContainer');
    const text = await container.innerText();
    return (text || '').trim();
  } catch {
    return '';
  }
}

module.exports = {
  GROK_SELECTORS,
  SELF_HEAL_HINTS,
  build,
  parseAriaSnapshot,
  selfHeal,
  resolveLocator,
  extractLastAssistantText,
};
