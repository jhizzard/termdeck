# T3 — Diagnostic surface (launcher Step 3 + health-probe semantics + PTY shell health-check)

You are T3 in Sprint 63 = Wave 2. Your lane closes three diagnostic-truth-telling bugs from Brad's 2026-05-08 §4.4/§4.5/§4.6 and his 2026-05-11 §3 #3 (health-probe semantics reframe). **Theme: probes are lying to operators.** Brad's r730 incident this morning surfaced the cost — `red: timeout` masked `red: init-failed` from a SQLite ABI mismatch, leading him to chase the wrong symptom.

## Boot sequence

1. `mcp__mnestra__memory_recall(project="termdeck", query="launcher Step 3 column created_at health probe dashboard drift")`
2. `mcp__mnestra__memory_recall(query="termdeck doctor probes 5-5 carryover health.js")`
3. Read `~/.claude/CLAUDE.md` (global rules)
4. Read `./CLAUDE.md`
5. Read `docs/sprint-63-wave-2/PLANNING.md`
6. Read `docs/sprint-63-wave-2/STATUS.md`
7. Read this file in full
8. Read `packages/server/src/health.js` end-to-end — understand the existing probe shape
9. Read `packages/stack-installer/src/stack.js` — look for the Step 3 column-existence check

Then begin.

## Scope

### 3.1 — Launcher Step 3 `column "created_at" does not exist` WARN

Brad's r730 (confirmed still present 2026-05-11): the launcher's `stack.js` Step 3 logs:
```
WARN: column "created_at" does not exist
```
while `termdeck doctor` reports 23/23 green for the same database.

Two checks disagree about whether a column exists. Possibilities:
- Launcher querying the wrong schema (`public` vs `mnestra`).
- Launcher checking a legacy table name that was renamed in a migration.
- Launcher's query uses unquoted identifier; doctor uses quoted.
- Probe runs before a migration that creates the column.

Find the disagreement and fix the launcher. **Do not silently swallow the WARN** — the failure mode that bit Brad today was exactly this: noise that operators learn to ignore.

### 3.2 — Health-probe error semantics (Brad's §3 #3 + §4.5)

`packages/server/src/health.js` currently reports `red: timeout` for many distinct failure modes. Operator can't distinguish:
- `unreachable` (network/socket level)
- `timeout` (request issued, no response in window)
- `dependency-down` (HTTP responded but the dependency is unhealthy — e.g. mnestra serve up but Supabase down)
- `init-failed` (the LOCAL handle the probe needs was never initialized — e.g. `db === null` from Brad's 2026-05-11 SQLite cascade)

Fix shape:
- Introduce a `red:<category>` taxonomy with stable strings. Document in `health.js` header comment.
- For probes that depend on `db` (sqlite / mnestra-pg / memory-items-col / etc.): detect `db === null` once at boot and switch to a no-op mode that logs **once** ("[health] sqlite handle null at boot; probes return `red: init-failed`"), NOT per-cycle.
- Distinguish `unreachable` (`ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`) from `timeout` (`AbortController` fired) from `dependency-down` (HTTP 5xx from a healthy peer).
- The Brad 2026-05-11 scenario: SQLite ABI mismatch leaves `db = null` at boot (now `process.exit(1)` per the v1.1.1 fail-fast, so this surface SHOULD never fire — but probes should still handle the `db === null` case correctly because future deps may be optional).

Files: `packages/server/src/health.js`.

### 3.3 — PTY shell health-check 3s timeout (§4.6)

Brad's r730 reports the shell health-check timing out at 3s. Verify whether the 5-5 sprint T3 client-hardcoded-zsh patch landed in v1.1.0/v1.1.1:
- Grep for `zsh` literal in `packages/server/src/health.js` and `packages/server/src/preflight.js`.
- Check `git log --oneline --all -- packages/server/src/health.js | head -20` for a 5-5-sprint commit.

Two cases:
- **If the patch landed:** §4.6 is a DIFFERENT bug; root-cause separately.
- **If the patch DID NOT land:** §4.6 is a 5-5 regression; ship the patch.

## Files of interest

- `packages/server/src/health.js` — probe semantics + shell-check
- `packages/stack-installer/src/stack.js` — Step 3 column-existence check
- `packages/server/src/preflight.js` — if shell-check lives here, not health.js

## Acceptance criteria

For this lane to close:
- 3.1: `WARN: column "created_at" does not exist` no longer fires when the launcher runs against a healthy install (or, if the warning is structurally necessary, it produces an actionable message naming the column + the migration that would create it).
- 3.2: `health.js` probes report semantically-distinct categories. Add a unit test that asserts the `red:<category>` taxonomy across at least the 4 cases listed. T4-CODEX will probe edge cases (e.g. what does the probe report if mnestra serve is up but Supabase rejects auth?).
- 3.3: PTY shell health-check passes on a typical macOS + Linux shell environment (zsh + bash + sh). Test path: `node -e "require('./packages/server/src/health.js').runShellCheck()"` or equivalent.
- `npm test` root green (regression-clean).

## Post discipline

`### [T3] STATUS-VERB 2026-05-11 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING → FIX-PROPOSED → FIX-LANDED → DONE.

Idle-poll regex: if you're waiting on T1 or T2 for cross-lane state, use `^(### )?\[T<n>\] DONE\b` per global hardening rule 3.

No version bumps / CHANGELOG / commits — orchestrator handles at sprint close.
