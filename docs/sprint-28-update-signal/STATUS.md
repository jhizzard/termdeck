# Sprint 28 — Update-Signal Mechanisms

Append-only coordination log.

## Mission

Three small mechanisms that tell users they have an update available — without being annoying. Most TermDeck users today have no signal that v0.5.0/v0.4.6/v0.4.3 of the various pieces are out. Without a nudge they stay stale, hit fixed bugs, and assume the tool is broken. Three layered touchpoints solve this: a documented "stay current" path in the README, a `termdeck doctor` subcommand for on-demand checks, and a rate-limited startup banner for passive discovery.

All three respect a single env-var kill switch (`TERMDECK_NO_UPDATE_CHECK=1`) so power users opting out flip one variable, not three.

## Terminals

| ID | Spec | Primary file ownership |
|----|------|------------------------|
| T1 | T1-readme-stay-current.md | `README.md`, `docs/SEMVER-POLICY.md` (new) — informational, no code |
| T2 | T2-doctor-subcommand.md | `packages/cli/src/doctor.js` (new), `tests/cli-doctor.test.js` (new) |
| T3 | T3-update-check.md | `packages/cli/src/update-check.js` (new), `tests/cli-update-check.test.js` (new), `~/.termdeck/update-check.json` cache schema |
| T4 | T4-cli-dispatch.md | `packages/cli/src/index.js` — wire `doctor` subcommand + lazy-call update-check in the listen callback |

## File ownership table

| File | Owner |
|------|-------|
| `README.md` | T1 |
| `docs/SEMVER-POLICY.md` (new) | T1 |
| `packages/cli/src/doctor.js` (new) | T2 |
| `tests/cli-doctor.test.js` (new) | T2 |
| `packages/cli/src/update-check.js` (new) | T3 |
| `tests/cli-update-check.test.js` (new) | T3 |
| `packages/cli/src/index.js` | T4 |

T2/T3/T4 are file-disjoint. T4 imports from T2/T3 modules — workers run in parallel; T4 writes the dispatch wiring against the documented module contracts (described in T2 and T3 specs) without needing T2/T3 to land first.

## Module contracts (so T4 doesn't have to wait)

```js
// packages/cli/src/doctor.js (T2)
module.exports = function doctor(argv) {
  // Prints a table: package, installed, latest, status. Returns Promise<exitCode>.
  // 0 = all current. 1 = at least one update available. 2 = network/registry failure.
};

// packages/cli/src/update-check.js (T3)
module.exports = {
  // Returns Promise<{ available: bool, package, installed, latest } | null>.
  // null = check skipped (cache fresh, env var set, offline). Errors are swallowed.
  // Reads/writes ~/.termdeck/update-check.json with a 24h TTL.
  checkAndPrintHint: (config, opts) => Promise<void>,
};
```

## Acceptance criteria

- [ ] `termdeck doctor` runs on a machine and prints a 4-row table (TermDeck, Mnestra, Rumen, termdeck-stack) with installed + latest versions and a status column. Exit codes 0/1/2 per the contract.
- [ ] On startup, when an update is available and the cache is stale, exactly one yellow `[hint]` line prints. Suppressed by `TERMDECK_NO_UPDATE_CHECK=1`. Suppressed when cache is fresh (< 24h). Never blocks startup.
- [ ] README has a "Stay current" section pointing at the meta-installer and `termdeck doctor`. `docs/SEMVER-POLICY.md` documents what each kind of bump means.
- [ ] All four `[Tn] DONE` in STATUS.md.

## Rules

1. Append only to STATUS.md.
2. Never edit another terminal's files.
3. Flag blockers with `[Tn] BLOCKED <reason>`.
4. Sign off with `[Tn] DONE`.
5. Workers never `git commit` / `git push` / `npm publish` — orchestrator only.

---
(append below)
