# T3 — Materialize + ratify (termdeck)

**cwd:** `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` · **Model:** Claude Sonnet · **Repo:** termdeck (**vanilla JS / CommonJS / zero-build — LOCKED**).

You own the **ratify side**: the default-OFF worktree poller that renders doctrine PRs, the `termdeck doctrine` CLI, and the **direct-INSERT flow-back** that makes ratified doctrine a recallable memory row. You also own the two cross-repo edits that touch termdeck files.

## Boot
1. `memory_recall(project="termdeck", query="Sprint 79 doctrine-sync materialize ratify flow-back worktree gitleaks scrub status enum")`
2. `memory_recall(query="doctrine registry.jsonl status enum active proposed deprecated pty-submit")`
3. Read `~/.claude/CLAUDE.md` + `./CLAUDE.md` + `docs/INSTALLER-PITFALLS.md` (you touch init-rumen.js).
4. Read `docs/sprint-79-elevation-capture/PLANNING.md` + `DISPATCH-GUIDE.md` §3-T3 + §2 + `../sprint-78-memory-doctrine-loop/ULTRAPLAN-2026-06-12.md` §3.4.
5. **Re-verify anchors — HIGH drift risk.** Sprint 80 (v1.12.0, 07-01) rewrote `packages/server/src/index.js` (input API, PTY guard, context telemetry, inject queue) + touched `packages/cli/src/index.js`. **Your guide line anchors (`cli/src/index.js:59,348`, index.js references) WILL have moved — re-grep, don't trust the numbers.** `git checkout main && git pull`, branch `sprint-79-materialize-ratify`.

## `packages/server/src/doctrine-sync.js` (NEW, CJS, zero-build, fail-soft)
- **Default-OFF:** register the hourly unref'd timer ONLY when `TERMDECK_DOCTRINE_REPO=<abs path>` is set AND a boot preflight passes (git repo + expected remote + `gh auth status` + gitleaks present). Preflight failure = one info log, timer never registered. **Brad's install must simply never run this.**
- Operate in a **`git worktree add` under `~/.termdeck/doctrine-work/`** — a background timer must NEVER leave Josh's live checkout on a `doctrine/*` branch or stage into a dirty tree. All git/gh failures swallow-and-log; row stays `'drafted'` for retry.
- **Scrub via `doctrine/index.js::screenEntries`** (REUSE — gitleaks shell-out with local `~/.gitleaks.toml`; **zero hardcoded forbidden strings** — the scrub IS the leak if you inline them).
- Render `docs/doctrine/D-<seq>-<slug>.md` (front-matter + Principle / Why-evidence-ledger / How-to-apply / Machine-checkable-hook / Provenance). Update repo `doctrine/registry.jsonl` (shipped); `origin='local'` rows go to `~/.termdeck/doctrine-local/` only. `gh pr create` with the PR template (trigger shadow-match samples: count + 3 example lines, + the "is this ONE principle?" line). Set `status='proposed'` + `pr_url`.

## ⚠ STATUS-ENUM BRIDGE — resolve as a boot FINDING before landing flow-back
Repo `doctrine/registry.jsonl` statuses = `['active','proposed','deprecated']` (`doctrine/index.js` validator ~L64/L172). The rumen `doctrine_registry` table uses `candidate|drafted|proposed|ratified|rejected|superseded`. When you materialize a rumen `'ratified'` row INTO registry.jsonl, write repo-status **`'active'`** (or `'proposed'` pre-merge) — **NOT `'ratified'`** (the validator rejects it). Decide explicitly: map at the boundary (preferred) OR extend the repo enum + `doctrine/SCHEMA.md`. Post the decision as a FINDING.

## `termdeck doctrine list|ratify|reject|promote <id>`
- Register in `packages/cli/src/index.js` KNOWN_SUBCOMMANDS / SKIP_SUBCOMMANDS (**re-find the line numbers — Sprint 80 moved them**).
- `ratify`: verify the PR **merged** via `gh pr view --json state` BEFORE flipping status (AMEND-9, single source of truth).
- **Flow-back = DIRECT INSERT** a `memory_items` row `source_type='doctrine'` + explicit `stripPrivate` (engram `src/privacy.ts`) + `memory_link 'elevated_to'` edges. **NEVER through `memoryRemember`** (its >0.95 path returns 'skipped' → row never created; its 0.88–0.95 path corrupts a cluster member in place). **Regression test:** a doctrine row stays recallable even when ≥0.88-similar to a cluster member.

## Cross-repo edits YOU own (HANDOFF-ACK to T1/T2)
- **engram migration `029`** — the Mnestra `'doctrine'` ×1.5 recall boost (AMEND-14; never edit shipped 023). **HANDOFF with T1: T1=028, you=029.** (This is an engram edit from the termdeck lane — coordinate, or hand the SQL to T1 to apply under 029.)
- **`init-rumen.js` `SCHEDULE_MIGRATIONS`** — add the doctrine-scan cron matcher (T2 HANDOFF-REQUESTs it) + the **`init-rumen.js:965`** README-flow-back wording fix (T2 flags it). Trace both to an INSTALLER-PITFALLS class.

## Tests + health
- `packages/server/tests/doctrine-registry-shape.test.js` (NEW) — registry↔docs bijection + budgets (≤200-char principle) + front-matter schema. **The npm glob is `packages/*/tests/**` — a root `tests/` file silently never runs.** Sprint 78's `doctrine-registry.test.js` / `doctrine-throttle.test.js` must keep passing.
- `health.js`: doctrine-flatline + `proposed>7d` flags, surfaced in the ORCH preflight output path.
- **DO NOT re-author** `sprint-frontmatter.js`, `pty-submit.js`, or the `memory_propose` bridge tool (flag OFF).

## Acceptance (end-to-end dry-run)
- Seed a synthetic `'drafted'` row → PR appears from a throwaway worktree, **live checkout untouched** (`git status` clean + branch unchanged).
- `ratify` refuses while PR open, succeeds after merge.
- Flow-back row **recallable** via memory_recall AND survives despite ≥0.88 similarity (AMEND-1 regression).
- Poller **never registers** without `TERMDECK_DOCTRINE_REPO`.
- A synthetic memory containing a denylisted string is **BLOCKED by the scrub** (T4 supplies the fixture via local config, string never committed).

Post `### [T3] VERB 2026-07-05 HH:MM ET — gist`. No commits / version bumps / CHANGELOG — ORCH closes out.
