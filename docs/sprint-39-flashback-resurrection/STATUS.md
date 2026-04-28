# Sprint 39 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

## Pre-sprint context (orchestrator, 2026-04-27 evening)

- Joshua flashback-blind in daily flow since ~2026-04-18 (Sprint 21 close, last verified-working flashback). 9+ days of regression silence.
- Sprint 21 (`a1e3f92`, v0.4.3) and Sprint 33 (`6c46725`, v0.7.1) both shipped Flashback fixes that passed `tests/flashback-e2e.test.js` but missed the production-flow regression. Sprint 39 explicitly does NOT trust the existing synthetic e2e test — T4 ships a new production-flow test.
- Current failing test: `tests/flashback-e2e.test.js:526` — "proactive_memory frame.memories is empty even though 5 termdeck-tagged memories match the probe — the bridge is filtering on a different project tag than the session was created with." That's T3's hypothesis articulated as a test failure.
- Two converging hypotheses for the production silence:
  - **T2:** PATTERNS.error matches zsh/bash rcfile noise, burning the 30s rate limit before real errors fire.
  - **T3:** project-tag mismatch between session creation and bridge query, so memories exist but get filtered out.
- Both could be true. T1's instrumentation makes the actual production-flow rejection point visible.

Format:
```
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

---

## T1 — Daily-flow Flashback instrumentation

### FINDING — 2026-04-27 21:36 ET

Confirmed the pre-sprint state: today the Flashback pipeline runs effectively blind in production. Pre-instrumentation visibility was limited to scattered `console.log` lines (`[flashback] error detected …`, `[mnestra-bridge] query project=…`, `[flashback] proactive_memory sent …`). They land in the server stdout stream, with no structured shape, no per-session filter, no event-type filter, no in-process retention. So when Joshua trips a real-shell error and no toast appears, the only diagnostic move is to scroll the server log and try to correlate by timestamp — and the rcfile-noise / project-tag mismatch hypotheses both predict that the relevant signal is *several events back* (e.g., a `pattern_match` from rcfile noise that already burned the rate limit before the real error fired). That signal is unrecoverable from the current logging.

Code map confirmed against the briefing's six decision points:

- `pattern_match` site — `packages/server/src/session.js:_detectErrors`. The current code chooses primary pattern by session type (`PATTERNS.errorLineStart` for `claude-code`, else `PATTERNS.error`) and falls through to `PATTERNS.shellError` (Sprint-33 fix). Three patterns in play; `pattern_index` per the briefing collapses to a `pattern` name field for greppability.
- `error_detected` + `rate_limit_blocked` sites — same `_detectErrors`, around the `now - this._lastErrorFireAt < 30000` gate at the original `session.js:374`.
- `bridge_query` + `bridge_result` sites — `packages/server/src/mnestra-bridge/index.js:queryMnestra`. Three backend modes (direct, webhook, mcp). Wrapping at the queryMnestra outer boundary catches all three without per-mode duplication; this is also where `effectiveProject` and `projectSource` are resolved, which T3 needs.
- `proactive_memory_emit` site — `packages/server/src/index.js:849`, the `session.onErrorDetected` callback inside `spawnTerminalSession`. Four outcome branches today: success WS send, send-threw, dropped-because-no-WS, dropped-because-no-hit. All four need diag emits with distinct `outcome` values.

Confirmed there are two queryMnestra call sites (`index.js:852` Flashback, `index.js:1576` `/api/ai/query`). Threading `sessionId` through queryMnestra means the Flashback path gets fully session-attributable diag entries while the `/api/ai/query` path produces unattributed entries (sessionId undefined) — fine, T3 cares about Flashback.

### FIX-PROPOSED — 2026-04-27 21:36 ET

Ship the observability layer T2/T3/T4 are waiting on:

1. NEW `packages/server/src/flashback-diag.js` — in-memory ring buffer (size 200) with `log({sessionId, event, ...fields})` / `snapshot({sessionId?, eventType?, limit?})` / `_resetForTest()`. ISO-stamped `ts` auto-attached. Lost on restart by design (cheap; persistence is Sprint-40+).
2. Instrument `session.js:_detectErrors` for `pattern_match` (every PATTERNS hit, even ones rate-limited downstream), `error_detected` (before the rate-limit gate so the [error_detected − rate_limit_blocked] count tells T2 exactly how many real errors got dispatched), `rate_limit_blocked` (when the 30s gate rejects). Restructure pattern selection from `pattern.test(clean)` to `clean.match(pattern)` so the matched line is captured for the diag entry without re-running the regex.
3. Instrument `mnestra-bridge/index.js:queryMnestra` for `bridge_query` (with `project_tag_in_filter`, `query_text`, `mode`, `rpc_args`, `duration_ms`) and `bridge_result` (with `result_count`, `error_message?`, `top_3_project_tags` aggregated from the returned memories). Add `sessionId` as an optional queryMnestra param.
4. Instrument `index.js` `session.onErrorDetected` callback for `proactive_memory_emit` with four outcomes: `emitted`, `dropped_no_ws`, `dropped_empty`, `error`. Capture `ws_ready_state`, `frame_size_bytes`, `result_count_in_frame`. Pass `sessionId: sess.id` into the `mnestraBridge.queryMnestra` call.
5. Register `GET /api/flashback/diag` in `index.js`, sibling to `/api/rag/status`. Query params: `sessionId`, `eventType`, `limit` (capped at RING_SIZE = 200). Returns `{ count, events }`.
6. NEW `tests/flashback-diag.test.js` — 17 tests pinning ring semantics (timestamp stamping, filters, ring cap, limit clamp), route shape, route filtering. Mirror the route handler in the test rather than booting all of `index.js`, so the test stays hermetic (no pty/sqlite/Supabase init).

Out of scope per briefing — leaving alone: the actual rcfile-noise PATTERNS.error fix (T2), the project-tag write-path / chopin-nashville backfill (T3), the production-flow e2e test (T4). T1 is observability only; the diag log is what tells the other lanes whether their fixes worked.

### DONE — 2026-04-27 21:36 ET

Shipped:

- NEW `packages/server/src/flashback-diag.js` (53 lines) — ring buffer with `log` / `snapshot` / `_resetForTest` / `RING_SIZE` exported.
- `packages/server/src/session.js` — added `flashbackDiag` require; restructured `_detectErrors` pattern selection to capture the matched line; emits `pattern_match` / `error_detected` / `rate_limit_blocked` at the three documented gates. No behavior changes — same status transition, same rate-limit semantics, same `onErrorDetected` dispatch.
- `packages/server/src/mnestra-bridge/index.js` — added `flashbackDiag` require; wrapped `queryMnestra` mode-dispatch in a try/catch that captures `duration_ms` and the result; emits `bridge_query` (with mode-agnostic `rpc_args` summary) and `bridge_result` (with `result_count`, `error_message`, `top_3_project_tags`). Added optional `sessionId` parameter; threaded through from the Flashback call site. The `/api/ai/query` call site is unchanged — its diag entries land with `sessionId: undefined`, which is fine because T3 cares about Flashback.
- `packages/server/src/index.js` — added `flashbackDiag` require; instrumented all four outcome branches in the `session.onErrorDetected` callback with `proactive_memory_emit` events (`emitted` / `dropped_no_ws` / `dropped_empty` / `error`); registered `GET /api/flashback/diag` next to `/api/rag/status`. Added `sessionId: sess.id` to the `mnestraBridge.queryMnestra` call.
- NEW `tests/flashback-diag.test.js` — 17 tests, all passing locally.

Verification:

- `node --test tests/flashback-diag.test.js` → 17/17 pass.
- `node --test packages/server/tests/session.test.js` → same 3 pre-existing failures Joshua flagged in PLANNING.md (`stripAnsi CSI`, `ENOENT errno`, `HTTP 5xx server log`). No new failures.
- `node --test tests/analyzer-error-fixtures.test.js` → 4/4 pass.
- `node --test tests/project-tag-resolution.test.js tests/project-tag-invariant.test.js` → 16/16 pass (2 skipped, no failures).
- `node --test tests/flashback-e2e.test.js` → 2/3 pass; the 1 failing case is the documented `project-bound flashback` test from `flashback-e2e.test.js:526` that PLANNING.md explicitly named as the T3-shaped regression.
- Smoke probe via `node -e` confirms the full event sequence on a 3-error burst: `pattern_match → error_detected → pattern_match → error_detected → rate_limit_blocked → pattern_match → error_detected → rate_limit_blocked`. `onErrorDetected` fires once. The `(error_detected − rate_limit_blocked)` invariant T2 needs (= 1 dispatch) holds.

What downstream lanes can now do:

- **T2:** `GET /api/flashback/diag?eventType=pattern_match` returns each rcfile-noise hit with `pattern` (`error` / `errorLineStart` / `shellError`), `matched_line` (200 chars), and `output_chunk_size`. The false-positive count comes from filtering `pattern_match` events whose `matched_line` is rcfile-noise rather than real error output. Combined with `rate_limit_blocked` count vs `error_detected` count, T2 has both: how often noise burns the limiter, and which exact lines do it.
- **T3:** `GET /api/flashback/diag?eventType=bridge_query` returns the actual `project_tag_in_filter` the bridge sent, plus `rpc_args.project_source` (`explicit` / `cwd` / `none` / `searchAll`). `bridge_result` then returns `top_3_project_tags` from the memories that came back. The mismatch hypothesis is true iff `project_tag_in_filter` differs from the dominant `top_3_project_tags` entry, or the result is empty.
- **T4:** the production-flow e2e test asserts on `GET /api/flashback/diag?sessionId=<test-session-id>` after each scenario. The expected sequence for a successful Flashback is `pattern_match → error_detected → bridge_query → bridge_result → proactive_memory_emit{outcome: emitted}`. Any missing event in that chain pinpoints the gate that dropped the toast.

Files touched (line counts approximate):
- `packages/server/src/flashback-diag.js` — NEW, 53 lines.
- `packages/server/src/session.js` — +35 lines instrumentation; pattern-selection restructured (no behavior change).
- `packages/server/src/mnestra-bridge/index.js` — +40 lines instrumentation; `sessionId` param added; mode-dispatch wrapped in try/catch.
- `packages/server/src/index.js` — +35 lines (instrumentation) + 14 lines (route registration); +1 line (`sessionId` in queryMnestra call).
- `tests/flashback-diag.test.js` — NEW, ~250 lines.

Per sprint contract: no version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

---

## T2 — zsh/bash rcfile-noise filter audit

### FINDING — 2026-04-27 21:46 ET

Built an empirical capture rig (`tests/rcfile-noise-fixtures/capture.js`) that spawns interactive shells under the same `@homebridge/node-pty-prebuilt-multiarch` binding the production server uses, mirrors TermDeck's exact prod spawn env (`TERM=xterm-256color`, `COLORTERM=truecolor`, `TERMDECK_SESSION`, `TERMDECK_PROJECT`, `SHELL_SESSION_HISTORY=0`), and captures the first 5 seconds of output. ANSI is stripped via the same `stripAnsi` semantics `session.js` applies before pattern matching. Output is redacted for known secret prefixes (`sk-proj-…`, `sbp_…`, `OPENAI_API_KEY=…`, `SUPABASE_ACCESS_TOKEN=…`) before the fixture is committed. Eight variants captured: `zsh-termdeck-prod`, `bash-termdeck-prod`, `zsh-josh-interactive`, `zsh-josh-login`, `bash-josh-interactive`, `bash-josh-login`, `zsh-vanilla`, `bash-vanilla`.

Ran each fixture through `PATTERNS.error`, `PATTERNS.errorLineStart`, and `PATTERNS.shellError` (the analyzer's three current matchers). Verdict — see `tests/rcfile-noise-fixtures/analyze.js`:

| Fixture | error | errorLineStart | shellError | Shell session would-fire |
|---|---|---|---|---|
| zsh-termdeck-prod (Joshua's actual flow) | — | — | — | **silent** |
| zsh-josh-interactive | — | — | — | silent |
| zsh-josh-login | — | — | — | silent |
| zsh-vanilla | — | — | — | silent |
| bash-termdeck-prod | — | — | — | silent |
| bash-josh-interactive | — | — | — | silent |
| bash-vanilla | — | — | — | silent |
| bash-josh-login | — | — | YES | 🔴 fires once |

The single trigger in `bash-josh-login` is `bash: only: command not found` — emitted by Apple's `/etc/profile.d` chain when sourced under `bash -il`. That's a structurally legitimate `<sh>: <cmd>: command not found` shape; `PATTERNS.shellError` is correct to fire on it. TermDeck's prod spawn does NOT use login mode (`args=[]` at `packages/server/src/index.js:765`), so this code path doesn't fire on Joshua's flashback flow today.

**Verdict on the strong hypothesis (PATTERNS matches zsh/bash rcfile noise, burning the 30s rate limit):**

- For Joshua's actual zsh prod-spawn fingerprint: **REFUTED.** Zero pattern hits in the 5-second startup window. His shell startup is silent under all three matchers. The "rcfile noise burns the rate limit" mechanism cannot be the cause of his 9+ days of flashback-blindness.
- For a synthetic adversarial corpus modeling other dev environments: **CONFIRMED for at least one real-world case.** The line `pyenv: pyenv-virtualenv-init: command not found in path` matches `PATTERNS.shellError` because the regex's `command not found` branch was unified with the `No such file or directory` / `Permission denied` / `Is a directory` / `Not a directory` branches and accepts a `\b` word boundary after the keyword. The pyenv message has the colon-prefix shape (`pyenv: pyenv-virtualenv-init: command not found ...`) and the keyword followed by ` in path` — so `\b` matches and the false positive fires. Any pyenv user with this misconfiguration would burn the rate limit on every fresh shell.

**Implication for T1's diag (now landed per T1's DONE entry):** Joshua's flashback silence is NOT explained by rcfile noise on his machine. Point his `/api/flashback/diag` stream at the OTHER decision points: did `error_detected` ever fire at all on a real-shell error? If yes, did `bridge_query` follow? If yes, did `bridge_result.result_count` come back > 0? If yes, did `proactive_memory_emit{outcome: emitted}` land? T1's five-event chain is the right diagnostic ladder.

**Convergence with T3:** T3's parallel finding is that the project-mismatch hypothesis is REFUTED at the code level (bridge filters faithfully) but CONFIRMED at the corpus level (1,090+ chopin-nashville-tagged rows are actually termdeck/mnestra/rumen/podium content). T2's REFUTATION of the rcfile-noise hypothesis on Joshua's box increases the prior on T3's corpus-mis-tag finding being the active root cause. The 011 backfill is now load-bearing for resolving Joshua's flashback silence.

**Pre-existing failures in `packages/server/tests/session.test.js` (3, mentioned in PLANNING.md):**

- `stripAnsi removes standard CSI sequences (SGR colors)` — input strips to `ERROR: not found`. `PATTERNS.error` only includes `Error:` / `error:` (mixed-case + lowercase), not `ERROR:` (uppercase). Case-sensitivity gap.
- `Error detection: common Node errno codes` — input `ENOENT: no such file or directory`. The `ENOENT:` shape isn't in `PATTERNS.error`, and `PATTERNS.shellError`'s `No such file or directory` branch is case-sensitive (input has lowercase `no such…`). Two case-sensitivity gaps in one fixture.
- `Error detection: HTTP 5xx from server log` — input `"GET /api/broken HTTP/1.1" 503 -`. `_detectErrors` has no HTTP-status-code path. Missing-feature gap.

**These are NOT the same root cause as the rcfile-noise hypothesis.** They're orthogonal correctness gaps — broadening the analyzer to catch MORE real errors. The rcfile-noise hypothesis is about FALSE positives during startup. The session.test.js failures are about FALSE negatives on legitimate errors. Fixing the latter is out-of-scope for T2's lane (would broaden, not tighten). Reporting them as findings; recommend a Sprint-40+ "analyzer broadening" follow-up.

### FIX-PROPOSED — 2026-04-27 21:46 ET

Two changes:

1. **Tighten `PATTERNS.shellError` command-not-found branch** to require the keyword to be followed by either `:` (the zsh `command not found: <cmd>` form) or end-of-line (the bash `<sh>: <cmd>: command not found` form). This silences rcfile-noise lines like `pyenv: pyenv-virtualenv-init: command not found in path` while preserving every canonical real-error fixture in `tests/analyzer-error-fixtures.test.js`. Trade-off (documented in the regex comment): custom `command_not_found_handler` output that adds `, did you mean X` suggestions is silenced — those are cosmetic suggestions, not the error itself, which the analyzer already saw fire.

2. **Lock the verdict with a regression suite.** New `tests/rcfile-noise.test.js` covers:
   - Captured corpus (real zsh/bash startups) under both shell-session and claude-code matchers — must stay silent.
   - Synthetic adversarial corpus (~30 lines covering oh-my-zsh, p10k, version managers, conda, direnv, ssh-agent, brew, Apple shell-deprecation banner, Apple bash typeset glitch, the pyenv shim case) — must stay silent.
   - Real-error regression — 16 canonical error shapes that MUST keep firing on the shell-session path (`PATTERNS.error || PATTERNS.shellError`). Includes the e2e canonical `cat: /nonexistent/file/path: No such file or directory`.
   - Subset that the claude-code path (`PATTERNS.errorLineStart || PATTERNS.shellError`) supports today, with two known gaps explicitly documented as out-of-scope for this lane (`npm ERR!` and mixed-case `Fatal:` — see DONE notes).

Out of scope (per briefing):
- Don't add diag instrumentation (T1 owns it; landed already).
- Don't audit project-tag write path (T3 owns it; landed already).
- Don't write production-flow e2e (T4 owns it).
- Don't bump version, edit CHANGELOG, or commit (orchestrator handles at close).

### DONE — 2026-04-27 21:46 ET

Shipped:

- `packages/server/src/session.js` — `PATTERNS.shellError` regex tightened. The unified `(?:No such file or directory|Permission denied|Is a directory|Not a directory|command not found)\b` branch is split: the four phrasal branches keep their original `\b` terminator, while `command not found` gets a dedicated branch with `(?::|\s*(?:[\r\n]|$))` instead — must end the keyword with a colon or whitespace-then-newline-or-EOL. Comment block above the regex (~22 lines) documents the why, the matched cases, the silenced cases, and the trade-off. NO change to the other six branches in `PATTERNS.shellError`. NO change to `PATTERNS.error` or `PATTERNS.errorLineStart`. NO change to `_detectErrors` flow.
- NEW `tests/rcfile-noise.test.js` (~245 lines, 8 tests). All 8 pass.
- NEW `tests/rcfile-noise-fixtures/capture.js` (~140 lines) — empirical capture rig, runnable standalone (`node tests/rcfile-noise-fixtures/capture.js`) to refresh the corpus on any developer machine.
- NEW `tests/rcfile-noise-fixtures/analyze.js` (~60 lines) — replays the corpus through current `PATTERNS` and prints a markdown verdict table. Useful for future regex-tightening sprints.
- NEW `tests/rcfile-noise-fixtures/*.raw.txt` + `*.clean.txt` — 8 captured pairs (raw PTY bytes + ANSI-stripped, secret-redacted). Committed as fixtures.

Verification (run from repo root):

- `node --test tests/rcfile-noise.test.js` → **8/8 pass**.
- `node --test tests/analyzer-error-fixtures.test.js` → 4/4 pass (no regression from the tightening).
- `node --test packages/server/tests/session.test.js` → 32/35 pass; the 3 failing are the **same** pre-existing case-sensitivity / missing-feature gaps PLANNING.md flagged. No new failures from T2.
- `node --check packages/server/src/session.js` → syntax OK.

Files touched:
- `packages/server/src/session.js` — +22 comment lines, regex tightened (1 logical line, slightly longer).
- `tests/rcfile-noise.test.js` — NEW, 245 lines.
- `tests/rcfile-noise-fixtures/capture.js` — NEW, 140 lines.
- `tests/rcfile-noise-fixtures/analyze.js` — NEW, 60 lines.
- `tests/rcfile-noise-fixtures/*.raw.txt` + `*.clean.txt` — NEW, 16 fixture files.

Findings for downstream:

- **T1:** the new corpus + capture rig in `tests/rcfile-noise-fixtures/` is the production smoke harness your DONE notes mentioned. After your `/api/flashback/diag` is live, fire `node tests/rcfile-noise-fixtures/capture.js` then `GET /api/flashback/diag?eventType=pattern_match` — the count should be **0** for the zsh and bash-non-login fixtures, and **1** for `bash-josh-login.clean.txt` (the documented Apple-bash-3.2 quirk).
- **T1's diagnostic priority shift:** since rcfile noise is REFUTED for Joshua's actual zsh, his flashback silence is downstream of the analyzer. Look at the `bridge_query` / `bridge_result` / `proactive_memory_emit` events first, not the `pattern_match` count.
- **T3:** the rcfile-noise hypothesis being silent on Joshua's box increases the prior on the project-tag-mismatch corpus pollution being the active root cause. T3's chopin-nashville backfill (011_project_tag_backfill.sql) is now load-bearing for resolving Joshua's flashback silence.
- **T4:** the production-flow e2e you're authoring can use `tests/rcfile-noise-fixtures/capture.js` as a known-clean shell-bootstrap baseline. After your test triggers `cat /nonexistent/file/path` on a real PTY, T1's diag should show ZERO `pattern_match` events from the shell startup phase (rcfile noise) and EXACTLY ONE `pattern_match` event from your trigger command.
- **Sprint 40+ analyzer broadening:** the 3 pre-existing `session.test.js` failures (uppercase `ERROR:`, lowercase `no such file or directory` / `ENOENT:` shape, HTTP 5xx) plus two claude-code-matcher gaps (`npm ERR!` not in `errorLineStart`, mixed-case `Fatal:` not covered) are documented but unfixed. They broaden the matcher; they do NOT cause Joshua's flashback silence (those are false-negative gaps, not false-positive triggers).

Per sprint contract: no version bumps, no CHANGELOG edits, no commits.

---

## T3 — Project-tag write-path verification

### FINDING — 2026-04-27 21:43 ET

**Summary: the bridge-side project-mismatch hypothesis is REFUTED. The actual root cause is corpus-side mis-tagging from an out-of-repo writer (Joshua's harness session-end hook). T3 ships the backfill that heals the historical pollution.**

Audit covered every project-tag write path that lands in `memory_items` (Flashback's read target) and every read path that filters on `project`:

**Read paths (TermDeck-side, all CORRECT — bridge forwards `session.meta.project` faithfully):**

1. `packages/server/src/index.js:849-885` — Flashback `onErrorDetected` handler passes `project: sess.meta.project` directly to `mnestraBridge.queryMnestra`. T1's working-tree edits add `sessionId` for diag, but the `project` slot is unchanged.
2. `packages/server/src/mnestra-bridge/index.js:229-265` — `queryMnestra({question, project, searchAll, sessionContext, cwd, sessionId})`. Computes `effectiveProject = project` (or, if null, `resolveProjectName(cwd, config)` via top-level `cwd` or `sessionContext.cwd`). Passes `effectiveProject` straight through to `queryDirect` / `queryWebhook` / `queryMcp` as `filter_project: searchAll ? null : (project || null)`.
3. `packages/server/src/mnestra-bridge/index.js:57-76` `queryDirect` — POSTs `{filter_project: searchAll ? null : (project || null)}` to `/rest/v1/rpc/memory_hybrid_search`. Exact-string match in the SQL function (`packages/server/src/setup/mnestra-migrations/002_mnestra_search_function.sql:57`: `(filter_project is null or m.project = filter_project)`).
4. `packages/server/src/index.js:1576` `/api/ai/query` handler (the route the failing e2e test pre-flights against) — same passthrough: `await mnestraBridge.queryMnestra({question, project, searchAll, sessionContext})`. The pre-flight succeeds with 5 termdeck-tagged hits, confirming the bridge-side filter is correctly applied.
5. `~/Documents/Graciella/engram/src/recall.ts:81-106` (Mnestra MCP `memory_recall`) — `filter_project: input.project ?? null` straight to the same RPC. Same exact-match semantics.

**Write paths to `memory_items` (the read target):**

1. **Joshua's harness hook `~/.claude/hooks/memory-session-end.js` — THE OFFENDER.** Its `PROJECT_MAP` (lines 14-28) tests `/ChopinNashville|ChopinInBohemia/i` and has **no entries for termdeck, mnestra/engram, rumen, podium, or dor**. Result: any session whose cwd lives under `~/Documents/Graciella/ChopinNashville/...` gets stamped `project='chopin-nashville'`. TermDeck lives at `ChopinNashville/SideHustles/TermDeck/termdeck` (matches), Podium lives at `ChopinNashville/2026/ChopinInBohemia/podium` (matches). The hook then spawns `rag-system/src/scripts/process-session.ts --project chopin-nashville`, which extractFacts → embed → `match_memories` dedup → `memory_items` insert with the wrong tag. **This file is OUT OF REPO and is Joshua's responsibility per the briefing — T3 does not patch it.**
2. **Bundled hook `packages/stack-installer/assets/hooks/memory-session-end.js`** (vendored to `~/.claude/hooks/memory-session-end.js` on stack install) — has an EMPTY `PROJECT_MAP` and writes `project = detectProject(cwd) || 'global'`. This is the path Brad uses; it doesn't pollute chopin-nashville (defaults to 'global').
3. **rag-system `src/lib/deduplication.ts:80-89` `deduplicateAndInsert`** — inserts `{project}` from the caller. Caller is process-session.ts which receives `--project` from whichever hook spawned it. Faithful passthrough.
4. **TermDeck `rag.js`** writes only to legacy `mnestra_session_memory` / `mnestra_project_memory` / `mnestra_developer_memory` tables (lines 252-302 `_pushEvent`). **NOT to `memory_items`.** Flashback queries `memory_items`. So TermDeck's own telemetry path does not influence Flashback's hit set; it's a separate parallel ingestion.

**Why the e2e test on `tests/flashback-e2e.test.js:526` fails:** the pre-flight at line 397-419 confirms 5 termdeck-tagged memories match the probe text, then session creation echoes back `project='termdeck'` (line 453-457), the bridge sends `filter_project='termdeck'` to the RPC, and the RPC honors it. But the corpus has 1,090+ rows tagged `chopin-nashville` that ARE TermDeck content (sprint orchestration notes, server architecture, debug logs — all the rows that should be tagged `termdeck`). With `filter_project='termdeck'`, the RPC excludes those rows. The result count for the Flashback question phrasing falls below the 5 the pre-flight saw — likely to zero because the Flashback question text is more specific than the pre-flight probe and the small set of legitimately-termdeck-tagged rows doesn't include strong matches for the runtime error context.

**Live corpus baseline (probed read-only against `petvetbid` Supabase 2026-04-27 21:35 ET):**

```
project='chopin-nashville': 1,191 rows total
  termdeck/mnestra signal:  133 rows (ILIKE %termdeck% OR %mnestra% OR %4+1 sprint%)
  rumen signal:              81 rows (after termdeck/mnestra claims overlapping rows)
  podium signal:             56 rows (after earlier buckets)
  pvb signal:                 3 rows (after earlier buckets)
  dor/openclaw signal:        2 rows (after tightening; original heuristic had 33% false-positive rate)
  legitimate signal:         ~71 rows (Acceptd / NICPC / Bohemia / laureate / applicant / repertoire)
  other/uncertain:          ~845 rows (no clear single-project keyword)
```

**Sequential UPDATE order matters** because 19 of 271 single-bucket-matching rows match >1 bucket. Largest bucket (`termdeck/mnestra`) runs first — multi-project rows like `"... using OpenClaw + DOR + Mnestra"` end up tagged `termdeck` (via `mnestra` keyword), which is acceptable.

**Spot-check: the `dor` bucket needed tightening.** The briefing's draft heuristic `content ILIKE '%dor%'` matched 6 rows in the live corpus, of which ~33% were false positives ("dormant", "vendored"). Tightened to:
- POSIX word boundary `\mDOR\M` (case-sensitive uppercase DOR as a standalone word; rules out "dormant", "vendored", "indoor", "Dorm", etc.)
- path/identifier markers: `/DOR/`, `~/Documents/DOR`, `dor.config`, "Rust LLM gateway"
- `openclaw` substring (separate identifier, no false-positive risk)

After tightening: 3 candidate rows → 2 actually re-tagged (one row with mixed Mnestra+DOR content gets claimed by bucket 1 first). Zero false positives observed.

**Defensive forward-fix (NOT shipped this lane to avoid colliding with T1's instrumentation, FIX-PROPOSED only):** the Flashback `onErrorDetected` handler at `packages/server/src/index.js:849-885` passes `sessionContext` but does NOT include `cwd`. The bridge's cwd-based fallback at `mnestra-bridge/index.js:236-242` therefore never fires for project-less sessions. For Joshua's daily flow this is a no-op (sessions are created with explicit `project`), but a session created without `project` would have its cwd-based fallback path silently broken. Two-line fix at sprint close:

```js
// in packages/server/src/index.js onErrorDetected (line ~852)
mnestraBridge.queryMnestra({
  question,
  project: sess.meta.project,
  searchAll: false,
  cwd: sess.meta.cwd,                 // ADD: enable cwd-based fallback in bridge
  sessionId: sess.id,                 // (T1 already adds this)
  sessionContext: {
    type: sess.meta.type,
    project: sess.meta.project,
    cwd: sess.meta.cwd,               // ADD: secondary fallback source
    lastCommands: sess.meta.lastCommands.slice(-5),
    status: 'errored'
  }
})
```

Same two-line addition applies to the `/api/ai/query` handler at `packages/server/src/index.js:1568-1581`. Orchestrator can apply at close after T1's edits land — they're additive in the same call sites and won't fight T1's instrumentation diff.

### FIX-PROPOSED — 2026-04-27 21:43 ET

1. **Backfill SQL: `packages/server/src/setup/mnestra-migrations/011_project_tag_backfill.sql`** — five sequential bucketed UPDATEs (termdeck/mnestra, rumen, podium, pvb, dor) wrapped in BEGIN/COMMIT, with `RAISE NOTICE` count probes via `GET DIAGNOSTICS ROW_COUNT` (psql `\gset` is unavailable through the bundled migration runner because `pg-runner.js:applyFile` uses `client.query(sql)` from node-postgres — confirmed read-only). Idempotent — every WHERE clause includes `project='chopin-nashville'`, so re-runs are no-ops. **Lane did NOT execute live.** Verified by dry-run: applied within a single transaction with `COMMIT` swapped for `ROLLBACK`, all six DO blocks parsed cleanly, NOTICE output matched expectations, no rows persisted.

2. **Bridge regression test: `tests/mnestra-bridge.test.js`** — 5 tests pinning the project-tag passthrough invariant (explicit project → RPC filter; cwd fallback via top-level + via sessionContext; searchAll override; null-no-cwd → null filter). Stubs global.fetch, no live IO. Future T1-style instrumentation refactors can't silently mutate the filter shape and re-introduce the project-mismatch hypothesis.

3. **Optional cwd propagation fix** (described above under FINDING) — orchestrator's call at sprint close. Two lines in `packages/server/src/index.js`. Defensive only; not the smoking gun.

### DONE — 2026-04-27 21:43 ET

**Files written by lane:**

- `packages/server/src/setup/mnestra-migrations/011_project_tag_backfill.sql` — 230 lines incl. header. Dry-run results (ROLLBACK, no commit) on the live `petvetbid` corpus:
  - BEFORE: chopin-nashville=1191, termdeck=458, rumen=16, podium=65, pvb=1602, dor=0
  - bucket 1 (termdeck/mnestra): **133 rows** re-tagged
  - bucket 2 (rumen): **81 rows**
  - bucket 3 (podium): **56 rows**
  - bucket 4 (pvb): **3 rows**
  - bucket 5 (dor, tightened): **2 rows**
  - AFTER: chopin-nashville=916, termdeck=591, rumen=97, podium=121, pvb=1605, dor=2
  - **275 rows total moved from chopin-nashville → correct project tag.** 916 remain under chopin-nashville (~71 legitimate signal + ~845 ambiguous, deferred to future LLM-classification pass per briefing scope).

- `tests/mnestra-bridge.test.js` — 130 lines, 5 tests, all PASS against the working-tree bridge (T1's instrumentation included).

**Tests run by lane (all green):**

```
node --test tests/mnestra-bridge.test.js              # 5/5 pass
node --test tests/project-tag-resolution.test.js      # 11/11 pass
node --test tests/project-tag-invariant.test.js       # 5/5 pass + 2 deferred-skip
```

**Files NOT touched by lane (deliberate, to avoid T1 collision):**

- `packages/server/src/index.js` — T1 is editing the Flashback handler for `flashbackDiag` instrumentation. The cwd-propagation fix is documented as FIX-PROPOSED for orchestrator to apply at close.
- `packages/server/src/mnestra-bridge/index.js` — T1 is adding bridge_query / bridge_result diag emit blocks here. The bridge is functionally correct; my regression test pins its current behavior so T1's changes (already in working tree) won't regress the project passthrough.
- `packages/server/src/session.js` — T1 is adding pattern_match / error_detected / rate_limit_blocked diag events. Out of T3's scope.
- `~/.claude/hooks/memory-session-end.js` — out-of-repo, Josh's harness, briefing-flagged as out-of-scope for T3.

**Hand-off to orchestrator at sprint close:**

1. Review `011_project_tag_backfill.sql` RAISE NOTICE counts on the live apply. Expect roughly: bucket 1 ≈ 130-140, bucket 2 ≈ 80-95, bucket 3 ≈ 55-60, bucket 4 ≈ 3-7, bucket 5 ≈ 2-3 (subject to drift between dry-run and apply time).
2. Optionally apply the two-line cwd-propagation fix to `packages/server/src/index.js` at lines ~852 (onErrorDetected) and ~1568-1581 (/api/ai/query). Defensive, not blocking.
3. Communicate to Joshua that the harness hook PROJECT_MAP at `~/.claude/hooks/memory-session-end.js:14-28` still needs entries for `termdeck`, `mnestra`, `rumen`, `podium`, `dor`. Without that forward-fix, the backfill heals the historical rows but new mis-tagged rows will continue to land. Add it before hand-off or note in the next-session restart prompt.

**Hypothesis disposition for the rest of the sprint:**

- **Project-mismatch hypothesis (T3 owned): REFUTED at the code level.** The bridge filters on `session.meta.project` exactly as the audit predicts. The failing e2e test on `flashback-e2e.test.js:526` is corpus-driven, not code-driven — once the backfill applies, the 130+ termdeck-content rows currently masked under `chopin-nashville` become visible to `filter_project='termdeck'`, the assertion's pre-condition holds for the Flashback question text, and the toast surfaces.
- **Rcfile-noise hypothesis (T2): UNAFFECTED by this lane.** Both could still be contributors. T1's `pattern_match` + `rate_limit_blocked` diag events will discriminate at runtime. T3 only confirms there's no bridge-side mismatch.

Per sprint contract: no version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

---

## T4 — Production-flow Flashback e2e test

### FINDING — 2026-04-27 21:42 ET (server-side WS-push path is intact)

New `tests/flashback-production-flow.test.js` ships and passes both cases (zsh + bash) against the live server (HEAD `876ecae`, Sprint 38 close). The brief expected baseline failure; actual outcome contradicts that expectation. Specifically:

- Pre-flight `POST /api/ai/query` with `project='termdeck'` + the cat-error-shaped question returned 5 termdeck-tagged memories on the current corpus — bridge filter is correct (matches T3's read-side audit).
- Real `/bin/zsh -i` and `/bin/bash` spawned with rcfile loading; pre-trigger transcript probe captured **0 PATTERNS.error and 0 PATTERNS.shellError matches** in the rcfile-init output for both shells on Joshua's runner. The 30 s rate limiter was therefore NOT burned by rcfile noise prior to the cat trigger. **T2's strong hypothesis is disproved on this runner.**
- After `cat /nonexistent/file/path`: `proactive_memory` WS frame arrived in ~1.5 s (zsh) and ~0.7 s (bash). Frame shape: `{ type: 'proactive_memory', hit: { content, source_type, project, similarity, created_at } }` — single hit object, NOT a wrapping frame with `.memories[]`. `hit.project ∈ {'termdeck', null}` — no chopin-nashville leak in the post-T3-bridge-filter path. Server-side end-to-end pipeline works.

### FINDING — 2026-04-27 21:43 ET (the actual user-facing regression is client-side)

Mapped the client's flashback architecture against `packages/client/public/app.js`:

- `app.js:230 ws.onmessage` switch handles `'output' | 'meta' | 'exit' | 'status_broadcast' | 'config_changed'`. **There is NO `case 'proactive_memory':`** branch. Server-push frames are emitted into the void.
- `app.js:2434 updateGlobalStats` (called from the periodic `status_broadcast` handler) calls `updatePanelMeta(s.id, s.meta)` per session at `2448`.
- `app.js:2366 updatePanelMeta` checks `meta.status !== entry.lastKnownStatus`, and on transition to `'errored'` calls `triggerProactiveMemoryQuery(id)` at line 2374.
- `triggerProactiveMemoryQuery(id)` at line 466 issues its OWN POST `/api/ai/query` and renders a toast via `showProactiveToast`. **This is the actually-functional client path on Joshua's box**, NOT the WS-push path.

Server-side timing of the chain that path depends on:

- `session.js _detectErrors` flips `meta.status='errored'` and IMMEDIATELY fires `onStatusChange(...,'errored')` (no debounce).
- `session.js _updateStatus` flips status back to `'idle'` (default shell branch line 271) on the next prompt chunk; the field is written immediately, only the *callback* for that transition is debounced 3 s.
- `index.js:1740` periodic `setInterval(..., 2000)` emits `{ type: 'status_broadcast', sessions: allMeta }` to every WS client.
- `errored` is therefore live in `meta.status` for ~10–50 ms inside a 2000 ms broadcast cycle. The broadcast catches `'errored'` ~2.5 % of the time. The other ~97 % of broadcasts catch the post-flip `'idle'` state, lastKnownStatus on the client jumps directly from `'active'` to `'idle'` without ever passing through `'errored'`, and `triggerProactiveMemoryQuery` is never invoked. **This is the mechanism behind 9 days of silence.**

Test diagnostic confirms the race in vivo: `[T4] status_broadcast frames captured: 1; frames showing this session as 'errored': 0` for both zsh and bash. Every test run, every shell, the broadcast frames sampled during the test window show this session as `idle` or `active`, never `errored`.

### FINDING — 2026-04-27 21:43 ET (frame-shape contract drift in `flashback-e2e.test.js:526`)

T3's audit identified the failing assertion at `tests/flashback-e2e.test.js:526` as corpus-driven (insufficient termdeck-tagged content). Independent T4 finding: that assertion is ALSO structurally unreachable. Test code reads `proactiveMemoryFrame.memories[]` (line 521-524), but the production emit shape (`packages/server/src/index.js:872`) is `{ type: 'proactive_memory', hit: <single memory object> }`. The line at 466 sets `proactiveMemoryFrame = msg.hit`, so `proactiveMemoryFrame.memories` is `undefined` → `memories = []` → `length > 0` always false. Even after T3's backfill grows the termdeck corpus, this specific assertion will still fail until the test reads `proactiveMemoryFrame.content` (single memory) instead of `.memories[]` (array). T4 leaves the existing assertion alone per lane brief; flagging here for follow-up.

### FIX-PROPOSED — 2026-04-27 21:44 ET

T4 ships only the lane deliverable (production-flow test + helpers). Two follow-up fixes for the actual user-facing regression, both server- or client-side architectural changes outside T2/T3 scope:

1. **Smallest, most-reliable fix** (recommend): add to `packages/client/public/app.js:233` switch:
   ```js
   case 'proactive_memory':
     showProactiveToast(id, msg.hit);
     break;
   ```
   Uses the WS-push frame the bridge already emits correctly (T4 test proves it works), bypasses the `status_broadcast` polling race entirely, makes the toast deterministic. `showProactiveToast(id, hit)` already takes a single hit. ~3 lines.

2. **Server-side alternative**: `index.js onStatusChange` should emit a per-session `{ type: 'meta', session: session.toJSON() }` frame to `session.ws` whenever `newStatus === 'errored'`. Keeps the existing client-pull contract but eliminates the polling race.

Either change closes the loop. Sprint 39 should pivot — T2's PATTERNS-tightening is defensible defense-in-depth but not load-bearing for Joshua's silence, and T3's backfill is corpus hygiene but also not load-bearing for the WS-push path.

### DONE — 2026-04-27 21:45 ET

Files added/changed (no version bump, no CHANGELOG, no commit):

- NEW `tests/flashback-production-flow.test.js` — 357 lines. Two test cases (zsh + bash). Pre-flight server/Mnestra/SQLite probe, corpus probe with `needs-backfill` skip directive, real interactive shell spawn, 2.5 s rcfile-settle window, transcript probe for rcfile-noise observability, cat trigger, 5 s WS frame budget. Asserts: frame received, `hit.content` non-empty, `hit.project ∈ {'termdeck', null}`. Diagnostics: pre-trigger rcfile-noise count, status_broadcast race count, T1 diag dump (gracefully skips when `/api/flashback/diag` returns non-JSON, automatically activates once T1's working-tree changes are loaded by the running server). Out-of-test-reach assertion (browser toast rendering) explicitly documented in the header comment.

- NEW `tests/_flashback-helpers.js` — 219 lines. Extracted shared utilities used by both `flashback-e2e.test.js` and `flashback-production-flow.test.js`: constants, `sleep`, `fetchWithTimeout`, `pollUntil`, `probeServer`, `preflightProbeProject`, `createSession`, `deleteSession`, `sendInput`, `attachWS` (WS frame collector + cleanup), `fetchDiag` (graceful null on non-JSON for pre-T1-restart fallthrough).

- MODIFIED `tests/flashback-e2e.test.js` — light-touch refactor only. Replaced inline utility constants/functions with `require('./_flashback-helpers')`; replaced the 45-line `before()` block with a 7-line wrapper around `probeServer()`. **Zero assertion changes** — every existing test body byte-identical to HEAD. Per lane brief.

- NEW `tests/fixtures/flashback-production-flow/README.md` — 56 lines. Documents test deps (live server, Mnestra reachable, SQLite present, termdeck-tagged corpus non-empty, `/bin/zsh` + `/bin/bash` present) and what the test asserts vs. what's out of reach (browser DOM). Links the diagnostic-data interpretation to the client-side regression mechanism for future readers.

Test execution against live HEAD-baseline server (Sprint 38 close, T1/T2/T3 working-tree changes NOT loaded by the running process):

```
✔ production-flow flashback (zsh): real /bin/zsh -i + rcfile + cat error → toast within 5s (4015ms)
ℹ preflight: 5 termdeck-tagged memories matched "shell error cat no such file or directory"
ℹ [T4] pre-trigger transcript: 0 bytes, 0 PATTERNS.error/shellError match(es)
ℹ [T4] status_broadcast frames captured: 1; frames showing this session as 'errored': 0
ℹ [T4] /api/flashback/diag unavailable — server is pre-T1-restart. Skipping diag-cross-check assertions.
✔ production-flow flashback (bash): real /bin/bash + rcfile + cat error → toast within 5s (3276ms)
ℹ tests 2  pass 2  fail 0  duration_ms 7469
```

When the orchestrator restarts the server with T1's working-tree changes loaded, the `fetchDiag` helper returns JSON instead of HTML, and the diag-cross-check assertions in step 11 of the test automatically activate (asserting on `pattern_match` for the cat error line, `bridge_query` with `project_tag_in_filter='termdeck'`, and `proactive_memory_emit` with `outcome='emitted'`). No follow-up edits to T4 needed.

Per sprint contract: no version bumps, no CHANGELOG edits, no commits.
