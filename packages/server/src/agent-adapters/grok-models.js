// Grok model selection — Sprint 45 T3
//
// `grok-dev` (the superagent-ai CLI) ships an 11-model lineup spanning
// $0.2/$0.5 cheap-fast tiers up to $3/$15 flagship. The wrong default
// silently 10x's a bill on routine tasks: a "look at this file and tell me
// what's wrong" lane on `grok-4.20-0309-reasoning` (Heavy, $2/$6) costs the
// same as ten lanes on `grok-4-1-fast-non-reasoning`. The orchestrator picks
// per-lane via `chooseModel(taskHint)` at boot-prompt construction time
// (see SPRINT-45-PREP-NOTES.md § "Concern 2: Model selection heuristic").
// The adapter's `spawn.env.GROK_MODEL` defaults to the cheap-fast model and
// is overridden per-lane by the launcher.
//
// Tier table (price = USD per 1M tokens, in/out):
//
//   tier               | model id                          | price    | use case
//   ───────────────────┼───────────────────────────────────┼──────────┼──────────────────────
//   fast-non-reasoning | grok-4-1-fast-non-reasoning       | $0.2/0.5 | DEFAULT — routine
//   fast-reasoning     | grok-4-1-fast-reasoning           | $0.2/0.5 | light CoT under budget
//   code               | grok-code-fast-1                  | $0.2/1.5 | code gen / refactor
//   reasoning-deep     | grok-4.20-0309-reasoning          | $2/6     | hard problems, audit
//   reasoning-non-cot  | grok-4.20-0309-non-reasoning      | $2/6     | high-quality non-CoT
//   multi-agent        | grok-4.20-multi-agent-0309        | $2/6     | parallel sub-agent fan-out
//   flagship           | grok-4-0709                       | $3/15    | when Heavy isn't enough
//   budget-compact     | grok-3-mini                       | $0.3/0.5 | rare — usually wrong
//
// `grok-4-fast-non-reasoning`, `grok-4-fast-reasoning`, and `grok-3` are
// legacy aliases retained for completeness but not in the heuristic switch.

'use strict';

// Canonical model ids. Use the symbolic key in code; the heuristic resolves
// to the live id below. Keep these as data, not constants — Sprint 46+ may
// gain a `taskHint -> model` override file in `~/.termdeck/`.
const MODELS = {
  'fast-non-reasoning': 'grok-4-1-fast-non-reasoning',
  'fast-reasoning': 'grok-4-1-fast-reasoning',
  'code': 'grok-code-fast-1',
  'reasoning-deep': 'grok-4.20-0309-reasoning',
  'reasoning-non-cot': 'grok-4.20-0309-non-reasoning',
  'multi-agent': 'grok-4.20-multi-agent-0309',
  'flagship': 'grok-4-0709',
  'budget-compact': 'grok-3-mini',
};

// Legacy aliases — accepted as input to chooseModel for back-compat with
// Joshua's earlier `grok models` outputs. Resolution table:
const LEGACY_ALIASES = {
  'grok-4-fast-non-reasoning': MODELS['fast-non-reasoning'],
  'grok-4-fast-reasoning': MODELS['fast-reasoning'],
  'grok-beta': MODELS['reasoning-deep'],
  'grok-4.20-multi-agent': MODELS['multi-agent'],
  'grok-3': MODELS['flagship'],
};

// chooseModel — orchestrator-side heuristic. Pass `taskHint` from the lane
// brief (Sprint 46 frontmatter `model-hint: code|reasoning-deep|...`) or omit
// for the cheap-fast default. Unknown hints fall back to the default rather
// than throwing — the bill consequence of a typo silently routing to Heavy
// is worse than the latency hit of cheap-fast on a hard task.
function chooseModel(taskHint) {
  switch (taskHint) {
    case 'code':
      return MODELS.code;
    case 'multi-agent':
      return MODELS['multi-agent'];
    case 'reasoning-deep':
      return MODELS['reasoning-deep'];
    case 'reasoning-quick':
    case 'fast-reasoning':
      return MODELS['fast-reasoning'];
    case 'reasoning-non-cot':
      return MODELS['reasoning-non-cot'];
    case 'flagship':
      return MODELS.flagship;
    case 'budget-compact':
      return MODELS['budget-compact'];
    case 'fast-non-reasoning':
    case undefined:
    case null:
    case '':
      return MODELS['fast-non-reasoning'];
    default:
      // Accept legacy aliases verbatim; otherwise fall back to cheap-fast.
      if (LEGACY_ALIASES[taskHint]) return LEGACY_ALIASES[taskHint];
      return MODELS['fast-non-reasoning'];
  }
}

// getModelInfo — for the launcher / dashboard cost annotations (Sprint 46).
// Returns the price band so the UI can render a $-tier indicator alongside
// the model name without each caller knowing the table.
function getModelInfo(modelId) {
  const cheap = new Set([
    MODELS['fast-non-reasoning'],
    MODELS['fast-reasoning'],
    MODELS.code,
  ]);
  const heavy = new Set([
    MODELS['reasoning-deep'],
    MODELS['reasoning-non-cot'],
    MODELS['multi-agent'],
  ]);
  if (cheap.has(modelId)) return { tier: 'cheap', priceIn: 0.2, priceOut: modelId === MODELS.code ? 1.5 : 0.5 };
  if (heavy.has(modelId)) return { tier: 'heavy', priceIn: 2, priceOut: 6 };
  if (modelId === MODELS.flagship) return { tier: 'flagship', priceIn: 3, priceOut: 15 };
  if (modelId === MODELS['budget-compact']) return { tier: 'budget', priceIn: 0.3, priceOut: 0.5 };
  return { tier: 'unknown', priceIn: null, priceOut: null };
}

module.exports = {
  MODELS,
  LEGACY_ALIASES,
  chooseModel,
  getModelInfo,
};
