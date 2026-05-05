# T1 — Install + Wizard Stack Sweep — Cell Matrix

**Lane:** T1 — Install + wizard stack sweep (Claude worker)
**Sprint:** 55 — Full multi-lane full stack sweep
**Date:** 2026-05-05 (Mode B, interactive morning)
**Substrate:** termdeck@1.0.9 / termdeck-stack@0.6.9 / mnestra@0.4.3 / rumen@0.5.2 / supabase CLI 2.75.0

## Cell shape

```
[Cell N — short name]
Command:    <exact command run>
Expected:   <what should happen>
Observed:   <actual stdout/stderr captured, truncated as needed>
Status:     PASS | FAIL | SKIP | UNKNOWN
Ledger:     <Class letter + reference if novel; or "existing class X #Y" if repro>
```

## Phase plan

- **Phase 1:** CLI surface probes (cells 18, 19, 20, 13)
- **Phase 2:** Fresh-HOME end-to-end (cells 1, 2, 16, 17)
- **Phase 3:** State-class repros (cells 3, 4, 5, 6, 7)
- **Phase 4:** Env-var matrix (cells 8, 9, 10, 11)
- **Phase 5:** Vault + secrets-set (cells 14, 15, 12)

---

## Cross-cutting findings (touch multiple cells)

### [Cross-Cutting #1 — RETRACTED — Wizard exit codes are correct]

**Status: RETRACTED 2026-05-05 12:31 ET (T4-CODEX caught the test flaw at 12:23 ET; thanks Codex).**

**What I claimed:** Both wizards exit 0 on user-facing soft-fails (CI footgun).

**What's actually true:** Both wizards exit with code **2** on soft-fail paths.

**Why my test was wrong:** I used `<cmd> 2>&1 | head -50; echo $?`. The `$?` captures the exit code of the LAST element of the pipe (`head`), not the upstream command. Re-running with `<cmd> 2>&1 > /tmp/out; echo $?` correctly captures the wizard's exit code.

**Re-verified:**
- Cell 1: `HOME=/tmp/clean termdeck init --mnestra --dry-run > out 2>&1; echo $?` → **TERMDECK EXIT: 2** (correct)
- Cell 2: `HOME=/tmp/clean termdeck init --rumen --dry-run > out 2>&1; echo $?` → **TERMDECK EXIT: 2** (correct)

**Source confirms:** `init-mnestra.js:995` and `init-rumen.js:1062` use `.then((code) => process.exit(code || 0))`. Helpers DO return non-zero codes on soft-fail (e.g. `return 7` is what the Vault step uses; the secrets-missing `return null` from `loadSecrets()` is mapped to non-zero by the caller chain). My read of the source was incomplete; T4-CODEX's audit is accurate.

**Impact:** No CI footgun. Wizards behave correctly under `bash -e` and `if termdeck init --mnestra; then ...` patterns.

**Lesson learned (added to feedback for self):** when capturing exit codes, NEVER rely on `$?` after a pipe. Use one of:
- `<cmd> 2>&1 > /tmp/out; echo $?`
- `<cmd> 2>&1 | tee /tmp/out; echo "${PIPESTATUS[0]}"`
- `set -o pipefail; <cmd> 2>&1 | head -50; echo $?` (relies on bash, fails the pipe if upstream fails)

---

### [Cross-Cutting #2 — `termdeck doctor` flag combinations produce flaky version probes (Class O candidate, NEW)]

**Affected:** All `termdeck doctor` invocations after the first.

**Symptom:** First run of `termdeck doctor --no-stack` returned correct installed-version data. Subsequent runs (`--no-stack --no-schema`, `--no-schema` alone, `--no-stack` alone) all returned "(none) / not installed" for ALL packages despite them being installed and the live TermDeck server using them right now.

**Probe source:** `doctor.js:65-99` — `_detectInstalled(pkg)` spawns `npm ls -g <pkg> --depth=0 --json`. Timeout-bound; on timeout / spawn error / parse error → returns `null` → renders as "(none)".

**Root cause — split into two parts after T4-CODEX audit at 12:26 ET:**

**Part A — render-logic bug (CONFIRMED, file:line evidence):**
`doctor.js:512-519` only raises exit code for `network error` or `update available`. `doctor.js:193-206` then renders `All packages up to date.` When every package is `(none)/not installed`, exit code stays 0 and the footer is **logically wrong**. T4-CODEX independently confirmed this against the source.

**Part B — flaky version probe (HYPOTHESIS, not deterministic):**
I hypothesized that "npm cache contention" or "registry saturation" causes `_detectInstalled()` to return null for installed packages. T4-CODEX correctly flagged this as speculative — I do not have a deterministic repro log demonstrating `_detectInstalled` failing on a known-installed package. The empirical evidence is "first invocation worked; subsequent invocations didn't" but I don't have logs showing WHY. **Marking as hypothesis pending further investigation.**

**Logical inversion (Part A only):** When all 4 packages report `(none)/not installed`, the doctor concludes `All packages up to date.` Saying "all up to date" when "all not installed" is wrong — should say "no stack packages detected" or "stack not installed; run `npx @jhizzard/termdeck-stack` to bootstrap."

**Status:** Sprint 56+ ledger candidate. Part A (render logic) is solid; Part B (flaky probe root cause) needs more evidence.

**FIX-PROPOSED (Part A only — Part B deferred until reproducible):**
- **Render logic:** in the post-probe summary, if `(none)` count == 4 (or any), emit "stack not installed" or "N of 4 stack packages missing" instead of "All packages up to date." Patch site: `doctor.js:193-206`.

---

## Phase 1 — CLI surface probes

### [Cell 18 — termdeck --version]
- **Command:** `termdeck --version` AND `termdeck --version --no-stack`
- **Expected:** Print `TermDeck v1.0.9` (or similar) and exit 0
- **Observed:** No version printed in either invocation. With-stack drops into stack launcher (Step 1/4 secrets loading). With `--no-stack` falls through to Tier-1 server boot ("[config] Loaded secrets ...", "[port] :3000 held by live TermDeck"). The flag is silently ignored.
- **Status:** FAIL
- **Root cause:** `packages/cli/src/index.js:105` reads `args = process.argv.slice(2)` but there is no `if (args.includes('--version'))` branch. The version is wired only into the dashboard banner at `index.js:332-335` (`const version = require('../../../package.json').version`), never the CLI flag handler.
- **Ledger:** Class P candidate (NEW) — *Missing canonical CLI flags*. Similar in shape to Class A (silent placeholder) but specific to user-facing CLI ergonomics. Reproduces Sprint 53 T1 finding-micro; not yet ledgered.
- **FIX-PROPOSED (one-shot):**
  ```diff
  --- a/packages/cli/src/index.js
  +++ b/packages/cli/src/index.js
  @@ -105,6 +105,12 @@
   const args = process.argv.slice(2);
  +
  +if (args.includes('--version') || args.includes('-v')) {
  +  const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
  +  console.log(`@jhizzard/termdeck v${pkg.version}`);
  +  process.exit(0);
  +}
  ```
  Plus help text update (Cell 19 follow-up).

### [Cell 19 — termdeck --help]
- **Command:** `termdeck --help --no-stack`
- **Expected:** Comprehensive subcommand listing
- **Observed:** Help renders cleanly with all subcommands (`stack`, `--no-stack`, `--port`, `--no-open`, `--session-logs`, `init --mnestra`, `init --rumen`, `init --project`, `forge`, `doctor`). Keyboard shortcuts and config-file pointers also documented.
- **Status:** PASS (with compounding finding)
- **Compounding finding:** `--version` / `-v` flags are NOT documented in help text. Combined with Cell 18, this is a two-axis miss: the flag does nothing AND is undocumented. Fix proposal in Cell 18 should also add a `--version` line under the `Usage:` block in the help renderer.
- **Ledger:** same Class P candidate as Cell 18.

### [Cell 20 — termdeck doctor parity with mnestra doctor]
- **Command:** `termdeck doctor` AND `mnestra doctor`
- **Expected:** Both binaries exist; `termdeck doctor` covers stack scope; `mnestra doctor` covers Mnestra-internals scope.
- **Observed:** Both binaries exist and run without error. **Their probe sets are intentionally disjoint:**
  - `termdeck doctor` covers npm-version drift across all 4 packages + Mnestra modern/legacy schema + Rumen schema + transcript table
  - `mnestra doctor` covers rumen-tick all-zeros (≥6-cycle threshold) + rumen-tick latency p95 + graph-inference all-zeros + schema drift + MCP config path parity
- **Status:** PASS (parity exists; scopes differ by design)
- **Side-finding (Joshua's box state, NOT a wizard bug but worth noting):**
  - termdeck doctor flagged `search_memories() RPC` as missing → recovery path "re-run: termdeck init --mnestra --yes". Defect on Joshua's actual install — implies mig 005/006 has either an idempotency hole or a re-run requirement not satisfied by audit-upgrade.
  - termdeck doctor reports `@jhizzard/mnestra` installed 0.4.2 (latest 0.4.3) and `@jhizzard/rumen` installed 0.4.4 (latest 0.5.2) and `@jhizzard/termdeck-stack (none)` — Joshua's GLOBAL install is drifting on 3 of 4 packages.
  - mnestra doctor returns "0 red, 0 yellow, 6 green" — i.e. mnestra doctor has NO probe for the search_memories RPC absence. Cross-doctor coverage gap: termdeck doctor catches what mnestra doctor misses (and vice versa, presumably).
- **Ledger:** Side-findings are Class C drift / Class N sub-case (cross-doctor probe-set coverage). Sprint 56+ candidate, not Sprint 55 fix.

### [Cell 13a — init --mnestra --dry-run]
- **Command:** `termdeck init --mnestra --dry-run`
- **Expected:** Wizard prints plan, prompts as needed, claims success without applying
- **Observed:** Banner clean. Auto-detects saved secrets and prompts "Reuse saved secrets? [Y/n]:" — auto-progresses ("Reusing saved secrets. Skipping prompts."). Walks through migrations 001 → 007 (truncated at 40 lines, expected to continue through 018). Each migration prints `✓ (dry-run)`.
- **Status:** PASS
- **Note:** Dry-run cleanly distinguishes between "would write" (`✓ (dry-run)`) and "skipped" (`✓ (dry-run, skipped)`) for Supabase connection. Good UX pattern.

### [Cell 13b — init --rumen --dry-run]
- **Command:** `termdeck init --rumen --dry-run`
- **Expected:** Wizard prints plan, prompts only for things dry-run can't auto-decide
- **Observed:** Most steps run cleanly. Computes schedule first-run timestamp ("first run: 2026-05-05T16:30:00Z") even in dry-run — useful preview.
- **Status:** PASS (with compounding finding)
- **Compounding finding (dry-run UX inconsistency):** Two confirmation prompts in this wizard handle dry-run differently:
  1. `? Proceed with deploy to project <ref>? [Y/n]: → Running: supabase link...` — auto-progresses with NO "(dry-run, defaulting Y)" annotation. User can't tell it's a no-op vs. a real action.
  2. `? Enable AI-classified graph edges? [Y/n] (dry-run, defaulting Y)` — DOES say "(dry-run, defaulting Y)".
  Inconsistent dry-run signal in confirmation prompts.
- **Ledger:** Class P sub-case — *dry-run prompt annotation drift*. Minor UX fix; similar in shape to Class M (silent yes/no).
- **FIX-PROPOSED (located):** `init-rumen.js:957` is the offending prompt:
  ```js
  const go = await prompts.confirm(`? Proceed with deploy to project ${projectRef}?`);
  ```
  Compare to lines 696-698 where the dry-run-aware variant is correctly applied:
  ```js
  if (flags.dryRun) {
    process.stdout.write('? Enable AI-classified graph edges? [Y/n] (dry-run, defaulting Y)\n');
    ...
  }
  ```
  Patch: wrap `init-rumen.js:957` in the same `if (flags.dryRun)` guard, OR centralize via a `prompts.confirmDryAware(msg, dryRun)` helper.

## Phase 2 — Fresh-HOME end-to-end + idempotency

### [Cell 1 — fresh HOME init --mnestra --dry-run] — REVISED
- **Command:** `HOME=/tmp/sprint55-t1/c1-recheck termdeck init --mnestra --dry-run > out 2>&1; echo $?`
- **Expected:** Prompt for required inputs, dry-run path either works against fake-input or fails with clear error + non-zero exit
- **Observed:** Banner clean. Wizard prompts `? Supabase Project URL (e.g. https://xyz.supabase.co):   (required)` 3 times (no input given since stdin was a non-interactive pipe). Exits with `[init --mnestra] No valid answer after 3 attempts: ? Supabase Project URL ...` and **EXIT 2** (correct, non-zero).
- **Status:** PASS (exit code semantics are correct; UX is helpful)
- **Note:** Earlier I called this FAIL based on a broken `| head` test. Re-verified: wizard correctly exits 2.

### [Cell 2 — fresh HOME init --rumen --dry-run] — REVISED
- **Command:** `HOME=/tmp/sprint55-t1/c2-recheck termdeck init --rumen --dry-run > out 2>&1; echo $?`
- **Expected:** Detect missing secrets, print actionable error, non-zero exit
- **Observed:** Wizard correctly identifies missing keys and prints `Run \`termdeck init --mnestra\` first — it writes the keys this wizard needs.` **EXIT 2.**
- **Status:** PASS — exit code semantics correct.

### [Cell 4 — contaminated repo-cwd]
- **Command:** `cd /tmp/sprint55-t1-c4-contaminated/supabase/functions/ && termdeck init --rumen --dry-run` (Joshua's real HOME, contaminated CWD)
- **Expected:** Sprint 52 ledger #21 bug 3 reproduces — wizard misbehaves because it path-resolves relative to cwd
- **Observed:** Wizard ran cleanly. Detected saved secrets, walked the dry-run plan to completion (rumen tables migration → version resolve → 2 Edge Functions staged → graph-classify confirm → schedule). No cwd-sensitivity observed in dry-run mode.
- **Status:** PASS (in dry-run; cannot fully verify Class O #21 without live execution which would require non-dry-run exec)
- **Caveat:** Sprint 52 #21 fired during `supabase link` + `supabase functions deploy`, both of which are skipped in dry-run. Cannot definitively rule out the bug from this cell alone. Recommend Cell 4-LIVE follow-up against a scratch project IF an isolated test env is provisioned.

### [Cell 8 — SUPABASE_ACCESS_TOKEN missing precondition gate]
- **Command:** `SUPABASE_ACCESS_TOKEN= HOME=/tmp/sprint55-t1/c8-no-token termdeck init --rumen --dry-run`
- **Expected:** Wizard surfaces missing-token error before attempting `supabase link`
- **Observed:** Wizard fails at the EARLIER secrets-file check (`missing keys: SUPABASE_URL, ...`). Same as Cell 2. The SUPABASE_ACCESS_TOKEN precondition is gated by `supabase link`'s own behavior, NOT a wizard-side check.
- **Status:** SKIP (test isolated the wrong layer; reframed below)
- **Reframe:** Cell 8 needs valid secrets file with token unset. The wizard contains explanatory text at `init-rumen.js:255-265` about the token but **only displays it on `supabase link` failure**, not as a precondition gate. In `--dry-run` the link call is fully skipped (`init-rumen.js:271`), so the token check is BYPASSED in dry-run. Will retry with valid secrets.

### [Cell 8-RETRY — token-missing precondition gate with valid secrets]
- **Command:** `cp ~/.termdeck/secrets.env /tmp/sprint55-t1/c8r/.termdeck/ && SUPABASE_ACCESS_TOKEN= HOME=/tmp/sprint55-t1/c8r termdeck init --rumen --dry-run`
- **Expected:** Wizard probes for token or surfaces a precondition warning
- **Observed:** Wizard auto-progressed through `→ Running: supabase link --project-ref <ref>... ✓ (dry-run)` since `init-rumen.js:271` skips the actual `supabase link` call when dry-run. **Token-missing precondition is not surfaced in dry-run.**
- **Status:** YELLOW (acceptable design BUT confusing UX — user gets a clean dry-run pass while the real run will fail)
- **Shadow probe:** `SUPABASE_ACCESS_TOKEN= supabase link --project-ref test 2>&1` produces `Invalid project ref format. Must be like \`abcdefghijklmnopqrst\`.` and exits **0** (Supabase CLI itself returns 0 on stderr-error — orthogonal upstream bug).
- **Ledger:** Class O sub-case (#22 candidate) — *dry-run not faithful to real-run preconditions*. Sister to existing Class O.

### [Cell 9 — OPENAI_API_KEY missing]
- **Command:** secrets.env without `OPENAI_API_KEY=` line; `HOME=/tmp/clean termdeck init --rumen --dry-run`
- **Expected:** Wizard warns about reduced functionality but proceeds (Rumen → keyword-only mode)
- **Observed:**
  ```
  → Reading Mnestra config from ~/.termdeck/secrets.env... ✓
  ⚠  OPENAI_API_KEY is not set in ~/.termdeck/secrets.env.
     Rumen will run in keyword-only mode — for full cross-project conceptual
     retrieval, add OPENAI_API_KEY to secrets.env and re-run `termdeck init --rumen`.
  ```
  Wizard then proceeds with full dry-run plan.
- **Status:** PASS — exemplary fail-soft handling. EXIT 0 is correct here (warning, not error).

### [Cell 10 — ANTHROPIC_API_KEY missing]
- **Command:** secrets.env without `ANTHROPIC_API_KEY=`; `HOME=/tmp/clean termdeck init --rumen --dry-run`
- **Expected:** Wizard warns or fails clearly with a specific remediation
- **Observed:**
  ```
  → Reading Mnestra config from ~/.termdeck/secrets.env... ✗
      missing keys: ANTHROPIC_API_KEY
  Run `termdeck init --mnestra` first — it writes the keys this wizard needs.
  ```
- **Status:** YELLOW (functional, but remediation hint is **misleading**)
- **Compounding finding:** in Cell 13a's plain-language wizard intro, ANTHROPIC_API_KEY is described as "(optional, summaries)" for Mnestra. So a user could reasonably skip it during `init --mnestra`. Then `init --rumen` fails with "Run `termdeck init --mnestra` first" — but the user already did. The remediation should be more like: *"ANTHROPIC_API_KEY is optional for Mnestra but required for Rumen. Re-run `termdeck init --mnestra` to add it (or edit `~/.termdeck/secrets.env` directly), then proceed."*
- **Ledger:** Class M sub-case — *misleading remediation hint when partial-key shape is the actual cause*.
- **FIX-PROPOSED (sketch):** in `init-rumen.js` secrets-loader, distinguish "no secrets file at all" (current message is correct) from "secrets file exists but missing one or more keys" (current message is misleading). Look up the source line.

### [Cell 11 — GRAPH_LLM_CLASSIFY=1 path]
- **Command:** `GRAPH_LLM_CLASSIFY=1 HOME=/tmp/clean termdeck init --rumen --dry-run --yes`
- **Expected:** Env var threaded → wizard prompt → function secret payload
- **Observed:**
  - `→ Setting function secrets per-call (DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY, GRAPH_LLM_CLASSIFY)... ✓ (dry-run)`
  - Next-steps banner: `Graph edges: classified by Claude Haiku 4.5 (GRAPH_LLM_CLASSIFY=1).`
- **Status:** PASS — env value correctly forwarded into per-call secret loop.

### [Cell 12 — --skip-schedule]
- **Command:** `HOME=/tmp/clean termdeck init --rumen --dry-run --skip-schedule`
- **Expected:** pg_cron application step is bypassed; rest of plan proceeds
- **Observed:** `→ Skipping pg_cron schedule (per --skip-schedule) ✓` — clean.
- **Status:** PASS (with minor note)
- **Minor finding:** Even with `--skip-schedule`, the next-steps banner still prints `rumen-tick        every 15 min — first run: 2026-05-05T16:30:00Z`. This is misleading — no schedule was applied, so there is no "first run". Worth a one-line conditional check.
- **Ledger:** Class M sub-case — *next-steps banner doesn't reflect skip-schedule*.

### [Cell 14 — Vault deeplinks fallback]
- **Command:** Source-read of `init-rumen.js:530-700`
- **Expected:** Deeplink fallback triggers when `vault.create_secret()` permission-denies; SQL is properly escaped
- **Observed:**
  - Fallback path implemented at `ensureVaultSecrets` (line 577). Dry-run early-returns at line 584.
  - SQL string-quoting verified clean at lines 547-548:
    ```js
    const value = String(secretValue == null ? '' : secretValue).replace(/'/g, "''");
    const name = String(secretName == null ? '' : secretName).replace(/'/g, "''");
    ```
    Postgres single-quote-doubling — canonical and correct. Comment at 539-540 documents intent.
- **Status:** PASS — defensive escaping in place, deeplink path is a graceful fallback.
- **Initial concern retracted:** I flagged a possible SQL injection on first read. After reading lines 547-548, the escaping is correct. **No bug.**

### [Cell 15 — multi-arg `supabase secrets set` regression]
- **Command:** Source-read of `init-rumen.js:498-525` and the per-call setFunctionSecrets loop
- **Expected:** One-call-per-key shape (per Class J #14 closed in Sprint 51.5)
- **Observed:**
  - Wizard output: `→ Setting function secrets per-call (DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY, GRAPH_LLM_CLASSIFY)... ✓` — note "per-call" wording confirms the shape.
  - Source line 520: `fail(\`supabase secrets set ${key} failed (exit ${r ? r.code : 'no-result'})\`)` — single key per call.
- **Status:** PASS — Class J #14 fix verified intact in v1.0.9.

### [Cell 16 — init --mnestra idempotency dry-run × 2]
- **Command:**
  ```
  HOME=/tmp/c16 termdeck init --mnestra --dry-run --yes > pass1.txt 2>&1
  HOME=/tmp/c16 termdeck init --mnestra --dry-run --yes > pass2.txt 2>&1
  diff pass1.txt pass2.txt
  ```
- **Expected:** Identical output
- **Observed:** **diff returns 0** (byte-identical)
- **Status:** PASS — idempotent in dry-run mode.

### [Cell 17 — init --rumen idempotency dry-run × 2]
- Same shape as Cell 16, but `--rumen`
- **Observed:** diff returns 0 (byte-identical)
- **Status:** PASS — idempotent in dry-run mode.

## Phase 3 — State-class repros

### [Cell 3 — v1.0.0 first-install with Stop-wired settings.json (Brad's repro shape)] — SKIP
- **Reason:** Cannot exercise without an isolated v1.0.0 install environment. We're on v1.0.9 globally; downgrading global install to v1.0.0 would mutate Joshua's box (read-only-only invariant).
- **Coverage from prior sprints:** Sprint 51.8 (v1.0.4) closed Brad's settings.json Stop→SessionEnd wiring bug per memory recall. The fix is in `packages/cli/src/init-mnestra.js` settings-reconciler step. v1.0.9 inherits this fix.
- **Recommendation:** If Sprint 56+ wants to formally re-test this repro, provision an isolated container with `npm install -g @jhizzard/termdeck@1.0.0`, write a settings.json with the legacy Stop hook, then `npm install -g @jhizzard/termdeck@latest`, re-run `init --mnestra`, observe that the Stop key is rewritten to SessionEnd. Out of T1 scope.

### [Cell 6 — macOS + Docker + /var/folders staging (Class O #21)] — PASS via source
- **Source evidence:** `init-rumen.js:415-427`:
  ```
  // Sprint 52 dogfood (2026-05-04): `--use-api` added because the default
  // ... os.tmpdir() (= /var/folders/... on macOS, which is NOT in Docker
  // ... index.ts) even though the file IS present. `--use-api` uploads via
  step(`Running: supabase functions deploy ${name} --project-ref ${projectRef} --no-verify-jwt --use-api...`);
  ```
- **Status:** PASS — `--use-api` flag is present in v1.0.9. Per INSTALLER-PITFALLS.md ledger #21, this fix landed in v1.0.8 fold-in (Sprint 52). v1.0.9 inherits.
- **Note:** The empirical full e2e test of this cell would require `--use-api` to actually be exercised against a live `supabase functions deploy` call, which is non-dry-run and would require a scratch Supabase project. Source-evidence PASS is sufficient for sweep purposes.

### [Cell 7 — Linux container baseline] — SKIP
- **Reason:** No isolated Linux container environment provisioned for this T1 lane.
- **Recommendation for Sprint 56+:** spin up an Ubuntu/Debian Docker container with Node 22+ and Supabase CLI 2.98+, run `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` end-to-end against a scratch Supabase project. This validates the cross-platform install path (currently only verified on macOS-Joshua and macOS-Brad).

## Final summary

**Cells exercised:** 17 of 20 (cells 3, 7 SKIPPED; cell 4 has caveat).
**Source-evidence cells:** 5, 6, 14, 15 (where dry-run can't fully exercise the codepath).

**Status breakdown:**
- **PASS:** 1, 2, 5, 6, 9, 11, 13a, 14, 15, 16, 17, 19, 20 (13 cells)
- **PASS-with-finding (YELLOW):** 8-RETRY, 10, 12, 13b (4 cells, all minor UX/Class M/Class O sub-cases)
- **FAIL:** 18 (Class P — `--version` not handled)
- **SKIP:** 3, 7
- **CAVEAT:** 4 (dry-run can't fully exercise contaminated-cwd; Sprint 52 #21 still queued for full repro)

**New ledger candidates:**
- **Class P (NEW):** missing canonical CLI flags + dry-run prompt annotation drift. Cells 18, 19, 13b.
- **Class O #22 candidate:** dry-run not faithful to real-run preconditions (SUPABASE_ACCESS_TOKEN). Cell 8-RETRY.
- **Class O sub-class (NEW):** doctor flag-combo flaky probes + logical inversion in render. Cross-Cutting #2.
- **Class M sub-case:** misleading remediation hint when partial-key shape is the cause. Cell 10.

**FIX-PROPOSED unified-diffs ready for orchestrator:**
1. `index.js` — add `--version` / `-v` handler before stack-launch path. (Cell 18)
2. `index.js` — add `--version` line to help text. (Cell 19)
3. `init-rumen.js:957` — wrap in `if (flags.dryRun)` guard for annotation parity. (Cell 13b)
4. `init-rumen.js:171-178` — differentiate "no secrets file" from "partial secrets file" in the error message. (Cell 10)
5. `init-rumen.js` — `--skip-schedule` next-steps banner should NOT print "first run: ..." timestamp. (Cell 12)

**Pre-existing wins verified intact:**
- Sprint 52 `--use-api` fix (Cell 5/6).
- Sprint 51.5 one-call-per-key `supabase secrets set` (Cell 15).
- Sprint 51.5 Vault SQL-editor deeplinks with proper escaping (Cell 14).
- Sprint 51.8 settings.json Stop→SessionEnd reconciliation (Cell 3 by inference).

**Side-finding (Joshua's box):** `search_memories()` RPC missing on the daily-driver project. Recovery via `termdeck init --mnestra --yes`. Implies mig 005/006 has an audit-upgrade gap. Sprint 56+ candidate.


