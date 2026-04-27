// Detection helper for default-entry routing — does plain `termdeck`
// (no subcommand) route through stack.js? Pure function, isolated for
// testability — the dispatcher in index.js still owns the actual
// routing decision.
//
// Sprint 24 policy (original): only auto-orchestrate when both
// ~/.termdeck/secrets.env and ~/.termdeck/config.yaml exist AND either
// mnestra.autoStart or rag.enabled is true. Fresh boxes fell through to
// Tier-1-only.
//
// Sprint 36 policy (current): always orchestrate by default. Acceptance
// criterion #2 of Sprint 36 (`docs/sprint-36-launcher-ui-parity/PLANNING.md`)
// requires `npx @jhizzard/termdeck` to match `scripts/start.sh` step-by-step
// on every machine, fresh or configured. stack.js handles the fresh-machine
// case via `ensureFirstRunConfig()` — it auto-writes a minimal
// ~/.termdeck/config.yaml on first run, then proceeds through Step 1/4–4/4
// with mostly-SKIP statuses (no secrets → SKIP, no mnestra binary → SKIP,
// no DATABASE_URL → SKIP, BOOT). That output mirrors what start.sh produces
// on a fresh box.
//
// The escape hatch is the explicit `--no-stack` flag handled in index.js.
//
// The function signature stays the same so callers and tests don't break;
// the body is just a constant now. Keeping the function (rather than
// inlining the boolean) leaves a hook for future telemetry — e.g., emitting
// "why we orchestrated" reasons — without another dispatcher rewrite.

function shouldAutoOrchestrate(_homeDir) {
  return true;
}

module.exports = { shouldAutoOrchestrate };
