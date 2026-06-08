// Grok model selection — Sprint 45 api.x.ai lineup + Sprint 70 Grok Build, MERGED (additive).
//
// TWO Grok families are BOTH retained on purpose (per Joshua's directive: do NOT
// drop the reasoning models — keep the legacy lineup, add Grok Build as an option):
//
//   A) api.x.ai models  — the Sprint-45 lineup INCLUDING the reasoning tiers.
//      Auth: GROK_API_KEY / XAI_API_KEY (per-token billing). These ACCEPT a
//      `reasoningEffort` knob. Reachable via the raw xAI REST API or a CLI that
//      honors GROK_MODEL + GROK_API_KEY (the older `grok-dev`).
//   B) Grok Build models — `grok-build` (coding) + `grok-composer-2.5-fast`.
//      Auth: grok.com login (subscription). These REJECT `reasoningEffort`
//      (grok-build → HTTP 400). The current `grok` binary (Grok Build 0.2.33)
//      exposes ONLY these two.
//
// ─── REACHABILITY CAVEAT (read before assuming a model just "works") ──────────
// The adapter (grok.js) currently spawns the `grok` binary, which on this machine
// is Grok Build — so out of the box only family (B) actually runs. To EXECUTE a
// family-(A) reasoning model as a lane, the adapter must dispatch it to the
// api.x.ai path / `grok-dev` instead of the Grok Build CLI. That family-dispatch
// is a follow-up; this module restores the model OPTIONS, not the wiring that
// routes each family to the right runtime.
//
// AUTH do-nots: don't pipe GROK_API_KEY into a Grok Build spawn (it ignores it —
// log into grok.com); conversely the reasoning models need GROK_API_KEY and an
// api.x.ai-targeting caller — the Grok Build CLI will not run them.
//
// NOTE: the family-(A) ids are the Sprint-45 lineup (~2 months old). xAI rotates
// model ids; validate against the current api.x.ai model list before relying on a
// specific reasoning id.

'use strict';

// Canonical model ids, keyed by a short symbolic name. Use the key in code; the
// live id is the value. Kept as data so a future ~/.termdeck/ override file can
// extend it without touching call sites.
const MODELS = {
  // ── A) api.x.ai tiers (per-token billing; reasoningEffort-capable) ──
  'fast-non-reasoning': 'grok-4-1-fast-non-reasoning',   // DEFAULT — routine
  'fast-reasoning': 'grok-4-1-fast-reasoning',           // light CoT under budget
  'code': 'grok-code-fast-1',                            // code gen / refactor
  'reasoning-deep': 'grok-4.20-0309-reasoning',          // hard problems, audit
  'reasoning-non-cot': 'grok-4.20-0309-non-reasoning',   // high-quality non-CoT
  'multi-agent': 'grok-4.20-multi-agent-0309',           // parallel sub-agent fan-out
  'flagship': 'grok-4-0709',                             // when Heavy isn't enough
  'budget-compact': 'grok-3-mini',                       // rare — usually wrong
  // ── B) Grok Build (grok.com subscription; reasoningEffort REJECTED → 400) ──
  'build': 'grok-build',                                 // Grok Build coding model
  'composer-fast': 'grok-composer-2.5-fast',             // fast / lightweight compose
};

// Default stays the cheap-fast api.x.ai model (the Sprint-45 default) — legacy
// remains the base; Grok Build is opt-in via a `build`/`composer` hint or an
// explicit GROK_MODEL. (If you'd rather default to grok-build now that the
// installed binary is Grok Build, flip this one line — flagged for Joshua.)
const DEFAULT_MODEL = MODELS['fast-non-reasoning'];

// Legacy aliases accepted as chooseModel input for back-compat with earlier
// `grok models` outputs.
const LEGACY_ALIASES = {
  'grok-4-fast-non-reasoning': MODELS['fast-non-reasoning'],
  'grok-4-fast-reasoning': MODELS['fast-reasoning'],
  'grok-beta': MODELS['reasoning-deep'],
  'grok-4.20-multi-agent': MODELS['multi-agent'],
  'grok-3': MODELS['flagship'],
};

// The Grok Build family rejects a reasoning-effort knob (grok-build → HTTP 400).
// Every api.x.ai model accepts it. Unknown ids default to "accepts" (legacy-
// permissive) — only the explicitly-known Grok Build models are stripped.
const NO_REASONING_EFFORT = new Set([MODELS['build'], MODELS['composer-fast']]);

// chooseModel — resolve a coarse task hint to a model id. Defaults to the
// cheap-fast api.x.ai model for anything unrecognized (incl. no/empty/null hint).
// Signature-compatible with the Sprint-45 chooseModel() grok.js calls no-arg.
function chooseModel(taskHint) {
  switch (taskHint) {
    // family A — api.x.ai
    case 'code': return MODELS.code;
    case 'multi-agent': return MODELS['multi-agent'];
    case 'reasoning-deep': return MODELS['reasoning-deep'];
    case 'reasoning-quick':
    case 'fast-reasoning': return MODELS['fast-reasoning'];
    case 'reasoning-non-cot': return MODELS['reasoning-non-cot'];
    case 'flagship': return MODELS.flagship;
    case 'budget-compact': return MODELS['budget-compact'];
    // family B — Grok Build (opt-in)
    case 'build':
    case 'grok-build': return MODELS['build'];
    case 'composer':
    case 'composer-fast':
    case 'compose':
    case 'fast':
    case 'grok-composer-2.5-fast': return MODELS['composer-fast'];
    // default
    case 'fast-non-reasoning':
    case undefined:
    case null:
    case '': return MODELS['fast-non-reasoning'];
    default:
      if (LEGACY_ALIASES[taskHint]) return LEGACY_ALIASES[taskHint];
      return MODELS['fast-non-reasoning'];
  }
}

// getModelInfo — capability + cost lookup for callers/dashboards. Returns
// { tier, priceIn, priceOut, reasoningEffort, role, known }. Grok Build models
// are subscription-billed (priceIn/priceOut null). Unknown ids return a safe
// record. (Back-compatible with the Sprint-45 shape: tier/priceIn/priceOut are
// still present for any existing cost-annotation caller.)
function getModelInfo(modelId) {
  const reasoningEffort = !NO_REASONING_EFFORT.has(modelId);
  const cheap = new Set([MODELS['fast-non-reasoning'], MODELS['fast-reasoning'], MODELS.code]);
  const heavy = new Set([MODELS['reasoning-deep'], MODELS['reasoning-non-cot'], MODELS['multi-agent']]);
  if (cheap.has(modelId)) return { tier: 'cheap', priceIn: 0.2, priceOut: modelId === MODELS.code ? 1.5 : 0.5, reasoningEffort, role: 'api.x.ai cheap-fast', known: true };
  if (heavy.has(modelId)) return { tier: 'heavy', priceIn: 2, priceOut: 6, reasoningEffort, role: 'api.x.ai reasoning/heavy', known: true };
  if (modelId === MODELS.flagship) return { tier: 'flagship', priceIn: 3, priceOut: 15, reasoningEffort, role: 'api.x.ai flagship', known: true };
  if (modelId === MODELS['budget-compact']) return { tier: 'budget', priceIn: 0.3, priceOut: 0.5, reasoningEffort, role: 'api.x.ai budget', known: true };
  if (modelId === MODELS['build']) return { tier: 'subscription', priceIn: null, priceOut: null, reasoningEffort: false, role: 'Grok Build coding', known: true };
  if (modelId === MODELS['composer-fast']) return { tier: 'subscription', priceIn: null, priceOut: null, reasoningEffort: false, role: 'Grok Build fast-compose', known: true };
  return { tier: 'unknown', priceIn: null, priceOut: null, reasoningEffort, role: 'unknown', known: false };
}

// acceptsReasoningEffort — true only if the model supports a reasoning-effort
// knob. Use it to GUARD request construction so a Grok Build model never gets a
// reasoningEffort field (grok-build → 400).
function acceptsReasoningEffort(modelId) {
  return getModelInfo(modelId).reasoningEffort === true;
}

// sanitizeModelOptions — strips reasoning-effort fields (both spellings) when the
// target model rejects them (the Grok Build family), so a caller that blindly
// forwards options can't trigger the grok-build 400. Shallow copy; never mutates.
function sanitizeModelOptions(modelId, options) {
  const opts = { ...(options || {}) };
  if (!acceptsReasoningEffort(modelId)) {
    delete opts.reasoningEffort;
    delete opts.reasoning_effort;
  }
  return opts;
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  LEGACY_ALIASES,
  NO_REASONING_EFFORT,
  chooseModel,
  getModelInfo,
  acceptsReasoningEffort,
  sanitizeModelOptions,
};
