# T1 — LAUNCHER + ENV lane (Brad #1 + Brad #2)

**Role:** Claude worker, Sprint 59.
**Scope:** Two source-code root-fixes to the launcher and env-loading path so Brad #1 + Brad #2 turn from RED to GREEN against the Sprint 58 catch-net.

## Pre-flight reads

1. `memory_recall(project="termdeck", query="Brad nohup secrets DATABASE_URL quote launcher preflight")`
2. `memory_recall(query="recent decisions and bugs")`
3. `~/.claude/CLAUDE.md` (post shape, no commits in lane, lane discipline)
4. `./CLAUDE.md` (no TypeScript, vanilla JS client, CommonJS server, no `git push` / `npm publish` in lane)
5. `docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md`
6. `docs/sprint-59-brad-bug-fixes-against-catch-net/STATUS.md`
7. `docs/sprint-58-environment-coverage/PLANNING.md` (catch-net contract — what your fix must turn GREEN)
8. `docs/sprint-58-environment-coverage/T1-ghactions-docker.md` (the install-smoke fixture you need to satisfy)
9. `CHANGELOG.md` § [1.0.12] Notes (Brad's 9-finding report)

## Goal

Ship two fixes such that, when the Sprint 58 install-smoke workflow runs against this commit, both Brad #1 and Brad #2 fixtures turn GREEN. **If the fix doesn't make the fixture green, the fix isn't done.**

## Brad #1 — nohup not inheriting secrets.env into process.env

**Severity:** HIGH (root cause of Brad's "Invalid URL" cascade).

**Symptom:** `checkRumen` (`packages/server/src/preflight.js:62`), `checkDatabase` (`preflight.js:109`), `checkGraph` (`preflight.js:156`), `stack.js:400` (Rumen check) all read `process.env.DATABASE_URL` directly. When TermDeck launches via `nohup termdeck` from a shell that hasn't sourced `~/.termdeck/secrets.env`, those probes see an empty/stale `DATABASE_URL` and fail with `Invalid URL`.

**Distinct from Sprint 51.5:** Sprint 51.5 added `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')` fallback in the bundled Edge Function only. The launcher-side direct-process.env probes were untouched. This is the launcher-side bug.

**Fix (preferred, Brad's recommendation):** the launcher injects all secrets.env values into `process.env` during Step 1 secrets loading, BEFORE any preflight probe runs.

**Where to land it:**
- `packages/cli/src/stack.js` already has `loadSecrets()` at `stack.js:160` and calls it at `stack.js:484`. Today it reads + parses but does NOT merge into `process.env`. Verify by reading the function body. Add the merge step: for each parsed key, `if (!process.env[k]) process.env[k] = parsed[k]` (don't clobber existing process.env — user-provided env wins over file).
- Also touch `packages/stack-installer/src/launcher.js` (uses `SECRETS_PATH` at line 31) — same parse-then-merge contract for the launcher binary. There's a `parseSecretsEnv` (or similar) helper at `launcher.js:47`-ish.
- Confirm `packages/server/src/config.js` `loadSecretsEnv()` at `config.js:55-70` already merges (read it; it's invoked from `loadConfig()` at line 165). If config.js merge happens early enough, the bug may be in stack.js launching the server before `config.js` runs. Check load order.

**The deliberate non-fix:** do NOT change `preflight.js` to read from a config object instead of `process.env`. Brad's option (b) is the alternative path; (a) is simpler and keeps preflight portable. Stick with (a).

**Test:**
- Add `tests/launcher-secrets-merge.test.js` (or extend an existing launcher test) that:
  1. Writes a fixture `secrets.env` to a temp dir with `DATABASE_URL=postgres://test`.
  2. Calls the launcher's load path with `process.env.DATABASE_URL` undefined.
  3. Asserts that after load, `process.env.DATABASE_URL === 'postgres://test'`.
  4. A second case: pre-set `process.env.DATABASE_URL=postgres://override` BEFORE loading, then assert it stays `postgres://override` (user env wins).

**Fixture target:** Sprint 58 `install-smoke-ubuntu` job in `.github/workflows/install-smoke.yml`. Its launch path is nohup-equivalent + immediate `termdeck doctor --json`. Pre-fix: doctor reports DATABASE_URL probe RED. Post-fix: GREEN.

## Brad #2 — DATABASE_URL with surrounding quotes breaks Node URL parser

**Severity:** MEDIUM.

**Symptom:** `pg`-based loaders strip surrounding quotes; Node `URL` constructor used by some probe paths does not. A `DATABASE_URL="postgres://..."` line in `secrets.env` (with the literal `"` chars) round-trips to `process.env.DATABASE_URL` as `"postgres://..."` (quote-included), and `new URL("...")` throws `Invalid URL`.

**Fix (defense in depth — both sites):**
1. **Wizard side:** `packages/cli/src/init-mnestra.js:445` (and the surrounding `step('Writing ~/.termdeck/secrets.env...')` block at line 445-450). When writing `DATABASE_URL: normalized.url`, the writer must NEVER add surrounding quotes. Read the current writer logic — confirm that today it doesn't quote (it probably doesn't), and either way add a unit test that pins the no-quotes contract.
2. **Read-side normalization:** the `parseSecretsEnv` function in `config.js:55-70` and the equivalent in `launcher.js:47` should strip leading/trailing matched single OR double quotes from every value. Add a test that feeds `DATABASE_URL="postgres://..."` and asserts the parsed value is the unquoted form.

**Tests:**
- `tests/secrets-env-parse-strips-quotes.test.js` — feeds 4 input shapes (no quotes, single-quoted, double-quoted, mismatched-quotes) and asserts parser behavior.
- `tests/init-mnestra-writes-no-quotes.test.js` — runs the wizard's secrets-write helper with a value that has no quotes, reads back the file, asserts no quotes were added.

**Fixture target:** Sprint 58 `install-smoke-ubuntu` deliberately writes a `DATABASE_URL="..."` value with literal quotes (per `T1-ghactions-docker.md` Task 1.1 step 5). Pre-fix: doctor probe RED. Post-fix: parser strips quotes, doctor GREEN.

## Discipline (universal)

- **Post shape:** `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Orchestrator handles close.
- **Stay in lane.** T2 owns PTY shell + systemd; T3 owns docs + example unit. Cross-lane reads OK; cross-lane writes BANNED.
- **Append-only STATUS.md.**
- **Pin the contract: every fix must turn its Sprint 58 fixture from RED to GREEN.** Document the before/after fixture state in your `### [T1] DONE` post.

## Coordination notes

- T2's `--service` flag (Brad #7) and PTY shell fallback (Brad #5) are independent — no file collision expected.
- T3 owns canonical secret names + docs; if your fix needs a new secret, post `### [T1] BLOCKED-ON-T3 ...` and wait for T3 to publish names.
- T4-CODEX will audit each fix against its Sprint 58 fixture. If T4 posts `### [T4-CODEX] FIXTURE-STILL-RED F-1` (or F-2), the fix is not done — read the evidence and iterate.

## Success criteria

1. `### [T1] FIX-LANDED` posts for Brad #1 and Brad #2.
2. Both new test files exist and pass (`npm test` from repo root).
3. T4-CODEX posts `### [T4-CODEX] FIXTURE-VERIFIED F-1` and `FIXTURE-VERIFIED F-2` (or, if Phase B isn't wired and CI-side verification is impossible, posts `LOCAL-VERIFIED F-1/F-2` with manual reproduction evidence).
4. `### [T1] DONE 2026-05-07 HH:MM ET` with summary + fixture-state-before/after.
