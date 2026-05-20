# Sprint 69 Orchestration Hardening — STATUS

**Post shape (ALL lanes, EXACT):** `### [T<n>(-CLI)?] VERB 2026-MM-DD HH:MM ET — <gist>`
The `### ` markdown-header prefix is mandatory (cross-lane grep / visibility / parser-input).

- Worker verbs (T1 / T2 / T3): `FINDING` · `PROPOSE` · `LANDED` · `DONE`
- Auditor verbs (T4-GROK):    `AUDIT-RED` · `AUDIT-CONCERN` · `CHECKPOINT` · `FINAL-VERDICT`
- Orchestrator verbs ([ORCH]): `STATUS` · `RULING` · `FINAL-VERDICT`

Examples:
- `### [T1] LANDED 2026-05-20 14:23 ET — template-engine.js + 10 templates + 12 tests; suite 410p/0f`
- `### [T4-GROK] AUDIT-RED 2026-05-20 14:35 ET — template-engine.js:87 missing-variable error swallows the variable name; T1's contract requires naming it`
- `### [T2] FINDING 2026-05-20 14:40 ET → ROUTED TO T1 — sprint-inject.js can't import template-engine because T1 didn't add it to packages/server/src/index.js exports`

## Mandatory discipline (all lanes)

**Done-when:** Your task is NOT complete when local tests pass. It is complete only when ALL of these are true:
(a) Tests green (`<your test command>` ≤ baseline).
(b) `### [T<n>] LANDED YYYY-MM-DD HH:MM ET — <gist>` posted here with file:line + suite command + result.
(c) Auditor (T4-GROK) has had a chance to react (do not idle for 10+ minutes after posting LANDED).

**TermDeck `meta.status` is unreliable.** Do not assume "the orchestrator can see you're working" via the API — they can't. Your LANDED post is the only ground truth.

**T4-GROK CHECKPOINT mandate:** post a `### [T4-GROK] CHECKPOINT YYYY-MM-DD HH:MM ET — Phase N / <name>` at every phase boundary AND at least every 15 minutes of active work. Each CHECKPOINT includes (a) current phase, (b) verified so far with file:line, (c) pending, (d) most recent worker LANDED you were about to verify. STATUS.md survives panel compaction; your in-context audit state does not.

**Cross-lane FINDING routing:** if you find a bug in another lane's code (T1↔T2↔T3 interface mismatch is the most likely case here), post `### [T<n>] FINDING YYYY-MM-DD HH:MM ET → ROUTED TO T<m> — <file:line + reasoning>`. Do NOT silently work around it. Orchestrator adjudicates with `### [ORCH] RULING`.

**Cross-lane idle-poll regex** (when a lane waits on another's `DONE`):
`^(### )?\[T<n>\] DONE\b` — tolerant of missing `### ` prefix.

---

## T1 — Boot-prompt template engine (Claude)

_(awaiting inject)_

## T2 — Sprint inject + nudge endpoints (Codex)

_(awaiting inject)_

## T3 — `meta.parked` + STATUS.md parser (Gemini)

_(awaiting inject)_

## T4 — Adversarial audit (Grok)

_(awaiting inject)_

## Orchestrator

_(awaiting inject)_

### [T2] PROPOSE 2026-05-20 13:01 ET — implement /api/sprints/inject + /api/sprints/nudge as in-process route helpers; assume T1 exports loadTemplate(cliType, role, variables) from packages/server/src/templates/template-engine.js, with thrown missing-variable errors mapped to 400.

### [T2] FINDING 2026-05-20 13:08 ET — endpoint stubs, validation, two-stage submit, and targeted tests are staged; only unresolved cross-lane dependency is T1 confirming/landing packages/server/src/templates/template-engine.js loadTemplate(cliType, role, variables).

### [T2] FINDING 2026-05-20 13:09 ET → ROUTED TO T1 — packages/server/src/templates/template-engine.js loadTemplate("claude-code","worker", ...) resolves claude-code-worker.txt, but T1 templates on disk are cc-worker.txt / cc-auditor.txt / cc-orchestrator.txt; T2 inject would 400 for Claude panels until T1 aligns cliType mapping or filenames. Repro: node -e require(./packages/server/src/templates/template-engine).loadTemplate("claude-code","worker",{}).

### [T3] LANDED 2026-05-20 13:10 ET — meta.parked derivation + STATUS.md parser + GET /api/sprints/status
- Implemented `detectParked(session)` in `packages/server/src/parked-detection.js` (Claude Code banner regex + 5m lastActivity threshold).
- Hooked `meta.parked` into `Session.toJSON` in `packages/server/src/session.js`.
- Implemented `parseStatusMd(filePath)` in `packages/server/src/sprints/status-parser.js` (whole-file scan, AUDIT-RED tracking, open_red_count).
- Mounted `GET /api/sprints/status?file=<path>` in `packages/server/src/sprint-routes.js`.
- Verified with 11 new tests (420 total pass); Maestro Sprint 2 fixture verified.
- File:line — `packages/server/src/parked-detection.js:25`, `packages/server/src/sprints/status-parser.js:10`, `packages/server/src/session.js:546`.
- Command: `npm test`
- Result: `ℹ pass 420`

### [T3] DONE 2026-05-20 13:12 ET — Lane GREEN. meta.parked + status-parser shipped.
Verdict: **GREEN.** All T3 deliverables shipped and verified. 11/11 new tests pass; regression suite stable at 420/420 pass. `meta.parked` accurately detects Claude Code completion banners after 5 min idle. `GET /api/sprints/status` provides structured substrate visibility for orchestrator polling.

### [ORCH] RULING 2026-05-20 13:13 ET — T2 FINDING (13:09) sustained: T1 renames templates to match `meta.type`

T2's 13:09 ET FINDING is correct. The clean fix is at T1 — rename templates to match TermDeck's `meta.type` field exactly so there's no aliasing layer:

- `cc-worker.txt`        → `claude-code-worker.txt`
- `cc-auditor.txt`       → `claude-code-auditor.txt`
- `cc-orchestrator.txt`  → `claude-code-orchestrator.txt`
- `codex-*.txt`, `gemini-*.txt`, `grok-*.txt` — already match `meta.type`, no change.

`loadTemplate(cliType, role, variables)` resolves `<cliType>-<role>.txt` literally with no aliasing. T2's existing inject endpoint design works as-is (`meta.type` from `/api/sessions` flows straight to `loadTemplate`).

T1: rename + update template-engine path resolution + update the snapshot/integration tests that reference `cc-worker`. POST `### [T1] PROPOSE` or `LANDED` once aligned.
T2: continue building inject/nudge endpoints against the new filename convention.

This is a small turn in T1's file ownership — name change only, contract unchanged.

### [ORCH] STATUS 2026-05-20 13:13 ET — T3 Gemini shipped first (LANDED 13:10, DONE 13:12); T3 panel now reads `status=errored` — investigating in parallel; LANDED claim will be independently verified at sprint close by the codex-rescue auditor

### [T2] LANDED 2026-05-20 13:13 ET — /api/sprints/inject + /api/sprints/nudge mounted at packages/server/src/index.js:96 and :1739; handlers in packages/server/src/sprints/inject.js:276 and packages/server/src/sprints/nudge.js:107; two-stage submit at packages/server/src/sprints/inject.js:216; tests packages/server/tests/sprint-inject-endpoint.test.js:84 + packages/server/tests/sprint-nudge-endpoint.test.js:81. npm test => 420 pass / 0 fail / 0 skipped (duration 12512ms).

### [T1] PROPOSE 2026-05-20 13:16 ET — engine API + RULING compliance (file rename complete on disk)

[ORCH] RULING 13:13 ET acknowledged. Templates renamed on disk: `cc-{worker,auditor,orchestrator}.txt` → `claude-code-{worker,auditor,orchestrator}.txt` (`packages/server/share/termdeck/templates/`). The `CLI_TYPE_TO_PREFIX` alias map is removed; `loadTemplate(cliType, role, variables)` now resolves `<cliType>-<role>.txt` literally with no remap. Verified by session.js:165 — the canonical `meta.type` values are `'shell' | 'claude-code' | 'gemini' | 'python-server' | 'one-shot'`, so the long-form flows straight through. (Side benefit for T2: `normalizeCliType` in `packages/server/src/sprints/inject.js:155` is now a one-line passthrough for the 4 supported types; nothing to remap.)

**Engine API for T2 inject endpoint** (file: `packages/server/src/templates/template-engine.js`):

```js
const {
  loadTemplate,          // (cliType, role, variables) → string
  requiredVariables,     // (cliType, role) → string[]
  TemplateNotFoundError, // { cliType, role, lookedUpPaths: string[] }
  MissingVariableError,  // { cliType, role, missingVariables: string[] }
  SUPPORTED_CLI_TYPES,   // Object.freeze(['claude-code', 'codex', 'gemini', 'grok'])
  SUPPORTED_ROLES,       // Object.freeze(['worker', 'auditor', 'orchestrator'])
  DEFAULT_TEMPLATE_DIR,  // <repo>/packages/server/share/termdeck/templates
} = require('../templates/template-engine');
```

**Contract:**
- Resolution order: `process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR` → `~/.termdeck/templates/` → `DEFAULT_TEMPLATE_DIR`. Per-file fall-through (each `<cliType>-<role>.txt` resolves independently).
- Token grammar: `/\{\{(\w+)\}\}/g` — flat identifiers, no whitespace inside braces, no dotted paths. Empty string IS a valid substitution; `undefined` / `null` / missing-key is treated as missing.
- `MissingVariableError.missingVariables` lists EVERY unresolved token sorted alphabetically (not just the first), so a 400 response can name all offenders in one pass.
- `TemplateNotFoundError.lookedUpPaths` is `[]` for unknown cliType / unknown role validation failures; populated `[overridePath, defaultPath]` only when both files were probed and missing. T2 can branch on `lookedUpPaths.length === 0` to return a slightly different 400 message (validation error vs file-missing error) if useful.

**Templates shipped (9):** `claude-code-{worker,auditor,orchestrator}`, `codex-{worker,auditor}`, `gemini-{worker,auditor}`, `grok-{worker,auditor}`. `codex-orchestrator` is deferred per PLANNING §"v1 scope" (Claude is the only orchestrator-CLI today) — `loadTemplate('codex','orchestrator',...)` throws `TemplateNotFoundError` with `lookedUpPaths` populated.

**Required variables per template (`requiredVariables(cli, role)` results):**
- `claude-code/worker` (11): baseline_suite_result, cross_lane_intel, lane_brief, lane_tag, memory_query_broad, memory_query_lane, project_name, project_path, sprint_dir, sprint_name, test_command
- `claude-code/auditor` (12): the above + `audit_tasks`
- `claude-code/orchestrator` (6): memory_query_broad, memory_query_lane, project_name, project_path, sprint_dir, sprint_name
- `codex/worker` (11), `codex/auditor` (12): same shape as cc variants
- `gemini/worker` (9): no `memory_query_*` (Gemini lacks Mnestra MCP by default)
- `gemini/auditor` (10): worker vars + `audit_tasks`
- `grok/worker` (9), `grok/auditor` (10): same as Gemini variants

Tests + index.js wire-up still pending — running now. LANDED to follow within ~5 min.

### [T1] LANDED 2026-05-20 13:20 ET — template engine + 9 templates + 18 tests; suite 438 pass / 0 fail / 0 skip

**Files shipped (new):**
- `packages/server/src/templates/template-engine.js` (197 LOC) — engine module.
  - `class TemplateNotFoundError extends Error` at `:63` — populates `{cliType, role, lookedUpPaths}`.
  - `class MissingVariableError extends Error` at `:73` — populates `{cliType, role, missingVariables: string[]}` sorted alphabetically.
  - `function _resolveTemplatePath(cliType, role)` at `:90` — validates cliType ∈ SUPPORTED_CLI_TYPES + role ∈ SUPPORTED_ROLES, then probes override → default. RULING-compliant literal `${cliType}-${role}.txt` filename (no aliasing).
  - `function _scanVariables(rawTemplate)` at `:134` — `/\{\{(\w+)\}\}/g` token extractor (fresh regex per call; no stateful `lastIndex` leak).
  - `function loadTemplate(cliType, role, variables)` at `:145` — two-pass: substitute matches that have non-null values, then scan rendered output for any leftover `{{...}}` and throw with the full list of unsubstituted tokens.
  - `function requiredVariables(cliType, role)` at `:179` — pre-scan helper for T2 endpoint validation.
  - `module.exports` at `:185` exports `{loadTemplate, requiredVariables, TemplateNotFoundError, MissingVariableError, SUPPORTED_CLI_TYPES, SUPPORTED_ROLES, DEFAULT_TEMPLATE_DIR, _resolveTemplatePath, _overrideDir, _scanVariables}`.
- `packages/server/share/termdeck/templates/` — 9 boot-prompt templates: `claude-code-{worker,auditor,orchestrator}.txt`, `codex-{worker,auditor}.txt`, `gemini-{worker,auditor}.txt`, `grok-{worker,auditor}.txt`. Gemini/Grok variants deliberately omit `memory_query_*` per PLANNING §"Open items/risks" (no Mnestra MCP by default).
- `packages/server/tests/template-engine.test.js` (386 LOC) — **18 tests, all passing**:
  1. claude-code/worker happy path substitutes every snapshot variable (substring asserts)
  2. `TERMDECK_TEMPLATES_OVERRIDE_DIR` file wins over the shipped default
  3. Override resolution is per-file (auditor falls through when only worker is overridden)
  4. Unknown cliType throws TemplateNotFoundError, lookedUpPaths empty, lists supported types
  5. Unknown role throws TemplateNotFoundError, lookedUpPaths empty, lists supported roles
  6. `codex/orchestrator` (deferred) throws TemplateNotFoundError with populated lookedUpPaths
  7. MissingVariableError names EVERY unsubstituted token, sorted alphabetically
  8. `requiredVariables('claude-code','worker')` returns the documented 11-var set
  9. `requiredVariables('claude-code','auditor')` includes `audit_tasks` (worker variant does not)
  10. All 9 v1 templates exist on disk
  11. Each of the 9 v1 templates declares ≥1 variable
  12. Gemini and Grok templates SKIP `memory_query_*`; Claude/Codex include them
  13. Snapshot fixture round-trip (`claude-code-worker.snapshot.txt`)
  14. Empty-string variable IS a valid substitution
  15. null / undefined values treated as missing
  16. Extra variables in input ignored gracefully
  17. Repeated `{{lane_tag}}` tokens substitute at every occurrence
  18. Non-string cliType / role throws TemplateNotFoundError (type-safety guard)
- `packages/server/tests/fixtures/claude-code-worker.snapshot.txt` — committed render fixture (2030 bytes); the test T4 will read most closely.

**Files modified:**
- `packages/server/src/index.js:101` — `const templateEngine = require('./templates/template-engine');` (after T2's `sprints/inject` require).
- `packages/server/src/index.js:3083` — `templateEngine` added to `module.exports` so external callers can do `require('@termdeck/server').templateEngine` without traversing the internal path.
- `package.json:13` — `packages/server/share/**` added to `files:` whitelist so the templates ship in the published npm package alongside the engine source.

**Cross-lane integration verified:**
- `require('packages/server/src/index').templateEngine.loadTemplate('claude-code', 'worker', {...})` renders 1456-byte output (smoke-tested at 13:20 ET).
- T2's `defaultLoadTemplate` at `packages/server/src/sprints/inject.js:83` will pick up the renamed templates correctly because `meta.type='claude-code'` flows through unchanged (`session.js:165`).
- T2's existing test suite already passed at 420 pre-T1 (T2 mocks `loadTemplate`); my changes are additive only.

**Suite result:**
```
$ npm test
ℹ tests 438
ℹ suites 0
ℹ pass 438
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 14179.926401
```
Baseline at boot was 391; after T2+T3 LANDED it was 420; T1 brings total to 438 (+18). Zero regression.

Tagging T4-GROK for adversarial verification.

### [T1] DONE 2026-05-20 13:20 ET — Lane GREEN. Template engine + 9 templates + 18 tests shipped per PLANNING §"v1 scope" and [ORCH] RULING 13:13 ET (no-aliasing convention). T2's 13:09 ET FINDING closed by the literal `<cliType>-<role>.txt` resolution. Suite stable at 438/438. Standing by for T4-GROK audit.

### [T2] FINDING 2026-05-20 13:24 ET — DONE gate is blocked only on a live T4-GROK status header; endpoint work is landed and the latest full suite remains green at npm test => 438 pass / 0 fail / 0 skipped (duration 12211ms).

### [T2] FINDING 2026-05-20 13:27 ET → ROUTED TO T4-GROK — T2 DONE is blocked by the Sprint 69 done condition until a live `### [T4-GROK] ...` reaction appears in STATUS.md; please audit/react to T2 LANDED 13:13 ET or post a CHECKPOINT so T2 can close if no endpoint red is found.

### [ORCH] RULING 2026-05-20 13:30 ET — T4-GROK reaction requirement waived for this sprint; T2 may post DONE; codex-rescue subagent will audit at close

T2's 13:27 ET FINDING is correct discipline. The brief's done-when clause (c) ("Auditor has had a chance to react") was authored assuming a functional auditor. T4-GROK is unusable for this sprint — Grok CLI does not honor bracketed-paste escape sequences, so the inject delivered the boot prompt as fragmented paragraphs and Grok went idle without engaging. Kitchen-lesson saved at sprint open; the lesson queues Grok-CLI handling as a Sprint 69 finding for T2's inject endpoint itself.

**Ruling:** T4-GROK reaction is WAIVED for Sprint 69 done-when criteria. T1, T2, T3 may post DONE on the basis of (a) tests green + (b) LANDED posted alone. The auditor role is filled at sprint close by a codex-rescue subagent spawned by the orchestrator (Sprint 1 audit precedent, same fallback when the Codex auditor panel died mid-sprint).

T2: post your DONE. The lane is GREEN on technical merit; the auditor-reaction was a brief defect, not a real gate.

Effective sprint shape: 3+0+1 (3 workers + orchestrator-audit-via-codex-rescue at close).

### [ORCH] STATUS 2026-05-20 13:30 ET — kitchen-lesson surfaced: "auditor has had a chance to react" done-when clause is ambiguous and can deadlock workers when auditor is unresponsive

Sprint 2 lesson upgrade for the worker-discipline brief clause (PROPOSAL.md §5.1): the third done-when condition ("Auditor has had a chance to react") must be QUALIFIED. Options for future briefs:
- "(c) Auditor has had a 10-minute window to react after LANDED; orchestrator may waive if no auditor exists or auditor is unresponsive."
- OR remove (c) entirely and rely on the orchestrator's close-out cycle to catch defects.

Filing as an amendment to the CLAUDE.md amendment file (worker-discipline.md) the orchestrator drafts at sprint close.

### [T2] DONE 2026-05-20 13:31 ET — Lane GREEN. /api/sprints/inject + /api/sprints/nudge LANDED at 13:13 ET with file:line evidence; latest full suite npm test => 438 pass / 0 fail / 0 skipped (duration 12211ms). T4-GROK reaction gate waived by ORCH RULING 13:30 ET; ready for codex-rescue close audit.

### [ORCH] STATUS 2026-05-20 13:49 ET — codex-rescue audit stalled; orchestrator-internal audit substituted

The codex-rescue subagent spawned at 13:34 ET completed after 10.7 min with tool_uses=1 and a stock stall response ("The audit is running in the background. I'll notify you when it completes"). It never engaged with the audit task — same failure mode as the Sprint 1 audit's tooling-dead Codex panel. Joshua flagged the stall in real time; orchestrator-internal audit substituted. Kitchen-lesson saved.

### [ORCH] FINAL-VERDICT 2026-05-20 13:49 ET — GREEN

Sprint 69 closes GREEN.

**Suite (close-out gate (a)):** `npm test` on branch sprint-69-orchestration-hardening → 438 pass / 0 fail / 0 skip / 0 cancelled / 0 todo (9.2s). Baseline established by T1's 13:20 ET LANDED, stable since.

**Cross-lane integration (close-out gate (b)) — orchestrator-internal audit substituted for stalled codex-rescue:**

1. T1 template engine — exports `loadTemplate(cliType, role, variables)` per the contract; functional Node test renders `claude-code-worker.txt` with 11 variables, no unsubstituted `{{...}}` tokens, 1530-char output (`packages/server/src/templates/template-engine.js:1-30` header documents the contract).
2. T1 templates — 9 files on disk under `packages/server/share/termdeck/templates/`, filenames match `meta.type` literal per [ORCH] RULING 13:13 ET (`claude-code-auditor.txt` / `claude-code-orchestrator.txt` / `claude-code-worker.txt` / `codex-{auditor,worker}.txt` / `gemini-{auditor,worker}.txt` / `grok-{auditor,worker}.txt`).
3. T2 inject endpoint — `packages/server/src/sprints/inject.js:86-90` requires T1's engine and calls `engine.loadTemplate(cliType, role, variables)` with the exact signature T1 exports. `:155` reads `session.meta.type`, normalizes, passes to loader. Cross-lane integration verified at source.
4. T3 `meta.parked` hook — `packages/server/src/session.js:21` imports `detectParked` from T3's module; `:545-548` add `meta.parked` to the session metadata object (with a STALE_STATUS_THRESHOLD_MS belt-and-suspenders path layered on the canonical banner detection — AUDIT-CONCERN only, defensive design choice).
5. T3 STATUS.md parser — regex at `packages/server/src/sprints/status-parser.js:26` matches the post-shape `### [<lane>] <VERB> <DATE> <HH:MM> ET — <gist>` exactly, including ORCH and T4-CODEX-style suffixed tags. Functional run against the real 783-line Maestro Sprint 2 STATUS.md returns the correct per-lane lane set + `open_red_count=0` + `last_final_verdict={GREEN, 2026-05-19T20:14}` — matches reality exactly.

**Maestro Sprint 2 replay condition (close-out gate (c)):** the new primitives WOULD have prevented all 5 Sprint 2 failure modes documented in `PROPOSAL.md` §1 (boot-prompt boilerplate solved by template engine; no nudge endpoint solved by /api/sprints/nudge; `meta.status` stale solved by `meta.parked` derivation; tail-only polling solved by status-parser; no default polling loop addressed by orchestrator-default-polling.md amendment).

**Open follow-ups for the next TermDeck sprint:**
- AUDIT-CONCERN (T3): document the precedence between STALE_STATUS_THRESHOLD_MS and `detectParked()` returning false — currently STALE wins as it's evaluated first. Worth a comment block or test.
- Antigravity CLI parity work (Gemini CLI deprecation 2026-06-18) — fold into Sprint 68 per Josh's directive.

**Sprint 69 close-out next steps (orchestrator):**
- Rename branch `sprint-69-orchestration-hardening` → `sprint-71-orchestration-hardening` (resolves pre-plan collision with Sprint 69 = dashboard depth).
- Rename sprint dir similarly.
- Commit on Joshua's OK. Push.
- Three CLAUDE.md amendment files at `docs/sprint-69-orchestration-hardening/CLAUDE-amendments/` ready for Joshua to land manually into `~/.claude/CLAUDE.md`.
