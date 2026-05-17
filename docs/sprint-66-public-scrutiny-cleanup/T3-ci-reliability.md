# T3 — CI reliability

**Mission:** TermDeck's CI has been red for ~6 days while `npm test` stayed 375/375, and the README badge shows "failing" to every visitor. Green the `CI` workflow end-to-end, make the secret-gated workflows skip-neutral instead of failing, and re-point the badge honestly.

You are T3 in Sprint 66 (3+1+1). Follow the boot sequence in `PLANNING.md`, then work this brief. Stay in your lane. Post `### [T3] ...` to `STATUS.md`. No version bumps, no CHANGELOG, no commits.

> This brief carries a **verified diagnosis** from the orchestrator's scouting pass. Line numbers were accurate at 2026-05-17 against `main` (commit `ebc5a4b`) — re-verify each at boot; drift is a FINDING.

---

## The diagnosis (verified)

The `CI` workflow (`.github/workflows/ci.yml`) has 4 jobs: `syntax`, `lint-conventions`, `docs-lint`, `install`. `syntax` and `install` pass. `lint-conventions` and `docs-lint` fail. The three *other* workflows (`install-smoke`, `macos-install-smoke`, `systemd-nightly`) fail on absent secrets.

### `lint-conventions` step 1 — "Check for silent catch blocks"

5 bare `catch {` blocks flagged. Fix the 4 `.js` ones; exclude the `.ts` one from the lint scope:
- `packages/server/src/orchestration-preview.js:190` — `try { return fs.readdirSync(...); } catch { return []; }` → `catch (err) { console.error('[orch-preview] readdir failed:', err); return []; }`
- `packages/server/src/index.js:427` — `catch { return '0.0.0'; }` (version fallback) → `catch (err) { console.error('[version] package.json read failed:', err); return '0.0.0'; }`
- `packages/server/src/sprint-inject.js:236` and `:260` — verify-poll catches; logging every poll iteration would spam → `catch (_err) {` (intentionally-unused binding; the `_` prefix is house style, cf. `index.js` `catch (_e)`).
- `packages/server/src/setup/rumen/functions/graph-inference/index.ts:329` — **do NOT edit this.** It is a bundled Rumen Edge Function mirror; its source of truth is the rumen repo and editing it here causes mirror drift. Instead, **scope the linter:** add `--exclude='*.ts'` to the `grep -rn` in `ci.yml` (~line 47). The TermDeck logging convention is for server JS, not bundled Deno Edge Functions.

### `lint-conventions` step 2 — "Check console.error tag prefix usage"

**This step has been hidden** — it never ran in CI because step 1 always aborted first. Once step 1 passes it runs, and it fails on ~10 pre-existing issues. Run the step's exact grep locally to confirm the current set, then:
- **6× camelCase tags** — `[onPanelClose]` / `[onPanelPeriodicCapture]` at roughly `index.js:213,219,295,370,1460,1552`. The tag regex `\[[a-z][a-z0-9:_-]*\]` rejects uppercase. **DECISION (you + T4):** (a) widen the regex to `\[[a-zA-Z][a-zA-Z0-9:_-]*\]`, or (b) rename the 6 tags to kebab-case (`[panel-close]`, `[periodic-capture]`). Orchestrator recommendation: **(b) rename** — the convention's examples (`[pty]`, `[ws]`, `[mnestra-bridge]`) are all lowercase-kebab, so kebab is the house style; widening the regex relaxes the convention. Adjudicate with T4.
- **1× comment false-match** — `index.js:435` is a `//` comment containing the literal string "console.error". The grep matches it. Fix: reword the comment (`console.error` → `stderr`), or make the grep skip comment lines. Rewording is lower-risk.
- **3× untagged user-facing messages** — `index.js:32` (a `better-sqlite3` rebuild-instruction continuation line) and `cli/src/index.js:167`+`:168` (port-in-use error). These are user-facing stderr output, not diagnostic logging — the tag convention is for diagnostic logs. **DECISION (you + T4):** broaden the workflow's existing `Usage:` / `  termdeck` exception to cover operator-facing help/error lines, OR tag them. Orchestrator recommendation: **broaden the exception** — putting `[cli]` into text the user reads is wrong. Adjudicate with T4.

### `docs-lint` — `scripts/lint-docs.sh`

Fails on 2 stale capital-"Engram" refs in `docs/RESTART-PROMPT-2026-05-09.md:51,53`. Fix: add `^\./docs/RESTART-PROMPT-` to the `excluded_paths_regex` (line 43). Restart-prompt docs are frozen historical records — the same category as the already-excluded `SESSION-STATUS-*` and `sprint-*` docs. The linter's own guidance sanctions adding intentional historical records to the exclusion list. (The CHANGELOG/`package.json` version-alignment check in the same script passes — leave it.)

### `install-smoke` / `macos-install-smoke` / `systemd-nightly` — absent secrets

`gh secret list` returns **zero secrets**. `macos-install-smoke` aborts at `scripts/test-supabase-reset.sh` → `FATAL: TEST_DATABASE_URL is required`. `systemd-nightly` aborts → `FATAL: required environment variable HETZNER_API_TOKEN is not set`. `install-smoke`'s Brad-reproducer fixtures go red without the `TEST_*` Supabase secrets. This is infrastructure, not code.

---

## Tasks

1. **Green `lint-conventions`** — step 1 (4 `.js` fixes + `--exclude='*.ts'`) and step 2 (camelCase tags, comment, user-facing messages — per the decisions above, adjudicated with T4).
2. **Green `docs-lint`** — the RESTART-PROMPT exclusion.
3. **Skip-not-fail the secret-gated workflows.** Make `install-smoke.yml`, `macos-install-smoke.yml`, `systemd-nightly.yml` detect absent required secrets and **skip-neutral** — a preflight job/step checks secret presence and sets an output; downstream jobs are gated `if:` on it; when skipped, write a clear "skipped — credentials not configured" line to `GITHUB_STEP_SUMMARY` and exit 0. **CRITICAL invariant:** skip-not-fail must skip **only** when secrets are absent. When the secrets ARE present the workflow must run fully, and a genuine install failure must still fail red. Do not blanket-`|| true` anything.
4. **Re-point the README badge.** Once `CI` is genuinely green, change `README.md` line 3 from the `install-smoke` badge to: `[![CI](https://github.com/jhizzard/termdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/jhizzard/termdeck/actions/workflows/ci.yml)`.
5. **Author `docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md`** — the runbook to restore real integration coverage: the full secret list (`TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_DATABASE_URL`, `TEST_ANTHROPIC_API_KEY`, `TEST_OPENAI_API_KEY`, `HETZNER_API_TOKEN`), what a dedicated throwaway CI test Supabase project needs (the reset script explicitly refuses a generic `DATABASE_URL`), and the `gh secret set` commands. The orchestrator/Joshua executes the provisioning later — the runbook is your deliverable.

## Verification (mandatory before claiming DONE)

A workflow-YAML change is **not** verified by reading it. Replicate the job logic locally: run the exact grep pipelines from `ci.yml`, run `bash scripts/lint-docs.sh`, run `node --check` on every edited JS file. For skip-not-fail, reason through (and where possible simulate) both the secrets-absent and secrets-present paths. Post the command output in STATUS.md.

## Files

`.github/workflows/ci.yml`, `install-smoke.yml`, `macos-install-smoke.yml`, `systemd-nightly.yml`; `scripts/lint-docs.sh`; `README.md`; `packages/server/src/orchestration-preview.js`, `index.js`, `sprint-inject.js`; the new `CI-SECRET-REPROVISIONING.md`. Do **not** touch `packages/server/src/setup/rumen/functions/*.ts`.

## Acceptance (what DONE means)

- `CI` workflow green — all 4 jobs, both `lint-conventions` steps.
- `install-smoke` / `macos` / `systemd-nightly` skip-neutral on absent secrets; still run fully (and can still fail) when secrets are present.
- README badge points at `CI`.
- `CI-SECRET-REPROVISIONING.md` authored.
- Post `### [T3] DONE ...` with local verification output.

## Lane discipline

Post `### [T3] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-05-17 HH:MM ET — <gist>` to STATUS.md (the `### ` prefix is required). T4 (Codex) audits the skip-not-fail invariant hardest — make the secrets-absent-vs-present distinction obvious and impossible to misread.
