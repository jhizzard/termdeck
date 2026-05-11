# Sprint 63 = Wave 2 — STATUS

**Inject:** 2026-05-11 (pending Joshua's "terminals open" signal).
**Pattern:** 3+1+1 — T1/T2/T3 Claude workers + T4 Codex auditor + Orchestrator.
**Target wave:** `@jhizzard/termdeck@1.2.0` + `@jhizzard/termdeck-stack@1.2.0` + `@jhizzard/mnestra@0.4.10`.

## Canonical post shape

Every lane post (worker + auditor) uses this shape:

```
### [T<n>] STATUS-VERB 2026-05-11 HH:MM ET — <one-line gist>

<body>
```

Or for the auditor:

```
### [T4-CODEX] STATUS-VERB 2026-05-11 HH:MM ET — <one-line gist>

<body>
```

`### ` prefix REQUIRED on every lane (including bare `[T1]` posts — global CLAUDE.md hardening rule 2). Cross-lane idle-poll regex tolerates absence as belt-and-suspenders: `^(### )?\[T<n>\] DONE\b`.

## Status verbs

- `BOOTED` — initial post after reading briefs
- `FINDING` — observation worth surfacing (substrate state, anomaly, scope question)
- `FIX-PROPOSED` — diff ready, posted for cross-lane visibility before commit
- `FIX-LANDED` — diff applied locally + tests pass; awaiting orchestrator commit at sprint close
- `DONE` — lane scope complete
- `CHECKPOINT` — auditor only; every 15 min + phase boundary; phase + verified items (file:line) + pending + most-recent-worker-FIX-LANDED-reference
- `AUDIT-OK` / `AUDIT-CONCERN` / `AUDIT-RED` — auditor only; verdict on a specific worker post
- `FINAL-VERDICT` — auditor only; sprint-close adjudication (GREEN / YELLOW / RED)
- `SCOPE` — orchestrator only; mid-sprint scope adjustment

---

## Lane posts (append below; newest at bottom within each lane section)

### [ORCH] — Sprint 63 scaffold

#### [ORCH] BOOTED 2026-05-11 13:00 ET — sprint docs staged, awaiting terminals-open signal

PLANNING.md + STATUS.md scaffold + T1/T2/T3/T4 briefs authored. Inject script staged at `/tmp/inject-sprint-63-prompts.js`. Mnestra serve health-check pending pre-inject. Will fire 2-stage paste+submit pattern on Joshua's "terminals open" signal — single message; no copy-paste.

---

### [T1] — Crash class (PTY-leak + WS ioctl + body-parser)

### [T1] BOOTED 2026-05-11 13:12 ET — briefs read; baseline `npm test` = 48/48 green

Boot complete: memory_recall (project + recent), `~/.claude/CLAUDE.md`, `./CLAUDE.md`,
`docs/CRITICAL-READ-FIRST-2026-05-07.md` (Investigation 1 closed Sprint 62; Investigation 2 still open),
PLANNING.md, STATUS.md, T1-crash-class.md. Surfaced current code state:
- `packages/server/src/index.js:347-401` — `express.json({ verify })` + error middleware (Sprint 60 v1.0.14 control-char pre-screen + structured 400). Verify callback throws but does NOT capture `req.rawBody`.
- `packages/server/src/index.js:298-325` — `safelyResizePty()` (Sprint 60 v1.0.14 + T4-CODEX AUDIT-CONCERN narrowing: EBADF/ENOTTY classifier; rethrows non-race ioctl errors). No `_destroyed` belt yet.
- `packages/server/src/index.js:1158-1192` — `term.onExit` handler. Sets `session.meta.status='exited'`, fires `onPanelClose`, cleans upload dir — does NOT null `session.pty`. **PTY-leak root cause.**
- `packages/server/src/index.js:1597-1612` — `POST /api/sessions/:id/resize` returns `409 Conflict` on dead PTY; brief says `410 Gone`.
- `packages/server/src/index.js:2265-2293` — WS message handler. `resize` already routes through `safelyResizePty`; outer catch `console.error` is the belt-and-suspenders surface to downgrade race-class errors.

Baseline `npm test` = 48 pass / 0 fail. npm-test glob is `packages/server/tests/**/*.test.js` (3 files). Sprint 60 fence tests under root `tests/` (`body-parser-control-chars.test.js`, `ws-resize-after-pty-exit.test.js`) are NOT in that glob; my new fence tests will land in `packages/server/tests/` to count.

Plan (FIX-PROPOSED to follow once coherent):
1. **1.1 PTY-leak** — append `session.pty = null;` at end of `term.onExit` at `:1192`, AFTER `onPanelClose` fires and upload-dir cleanup. No race: nothing in onExit reads `session.pty`; nulling-last keeps `onPanelClose` payload sources intact.
2. **1.2 WS ioctl** — `index.js:1606` `res.status(409)` → `res.status(410)` with Gone semantics; `safelyResizePty` adds `session.pty._destroyed` short-circuit (belt-and-suspenders for kill→onExit window); export `isPtyRaceError(err)` so WS message-handler outer catch can downgrade race-class errors to `console.debug`.
3. **1.3 body-parser** — capture `req.rawBody = Buffer.from(buf)` in `express.json({verify})` before the control-char scan; error middleware logs a hex-escaped 32-byte prefix of `req.rawBody` (printable ASCII kept; non-printables rendered as `\xNN`) in the existing single-line warn.

Fence tests in `packages/server/tests/`:
- `pty-onexit-nulls-session-pty.test.js` — drives onExit and asserts `session.pty === null` post-exit.
- `resize-route-410-gone.test.js` — POST /api/sessions/:id/resize on exited session → 410.
- `safely-resize-destroyed-pty.test.js` — `pty._destroyed = true` → false without calling resize.
- `body-parser-rawbody-hex-log.test.js` — rawBody capture + hex-escape rendering of 32-byte prefix.

Expected: 48 → 60+ tests. No version bumps, no CHANGELOG, no commits.

### [T1] FIX-LANDED 2026-05-11 13:22 ET — all three sub-tasks applied; tests green

Diff applied to working tree (uncommitted; orchestrator commits at sprint close). `git diff --stat packages/server/src/index.js`: +116 / −16. New fence test files in `packages/server/tests/`: 3 files, 33 tests.

#### Item 1.1 — PTY-leak fix (session.pty = null on term.onExit)

- `packages/server/src/index.js:1192-1203` — appended `session.pty = null;` at end of the `term.onExit` lambda, AFTER `onPanelClose(session).catch(...)` fires (fire-and-forget; reads `session.meta` + `session.id`, not `session.pty`) and AFTER the upload-dir cleanup. Comment block in place documenting why nulling-last avoids any read-after-null race for sync code paths.
- Closes the root cause of Joshua's 2026-05-08/09 overnight `kern.tty.ptmx_max=511` exhaustion (516 fds for 4 panels): without nulling, node-pty's wrapper stayed pinned by onData/onExit closures even after the child exited, holding the master fd until next GC pass.

#### Item 1.2 — WS ioctl race guard + 410 Gone

- `packages/server/src/index.js:288-340` — extracted `isPtyRaceError(err)` helper (race-class classifier: EBADF / ENOTTY in `err.code` or `err.message`, word-boundary safe). `safelyResizePty` gains a `session.pty._destroyed` short-circuit (line 312) BEFORE the existing meta-status check, so the kill()→async-onExit window short-circuits without ioctl. Race-class catch retained; non-race ioctl failures (EINTR, EFAULT) still rethrow per T4-CODEX AUDIT-CONCERN narrowing.
- `packages/server/src/index.js:1396-1399` — DELETE /api/sessions/:id stamps `session.pty._destroyed = true` immediately after `kill()`. Property is TermDeck-owned (node-pty does not set it natively); comment block documents the convention.
- `packages/server/src/index.js:1617-1635` — POST /api/sessions/:id/resize now distinguishes 404 (session never existed) from **410 Gone** (session exists but PTY has exited). Old 409 path replaced; both the early-exit branch and the safelyResizePty-returned-false branch produce 410.
- `packages/server/src/index.js:2299-2317` — WS message handler outer catch downgrades race-class errors to `console.debug` (gated on `TERMDECK_DEBUG_PTY_RACES=1`); non-race errors continue to log as `console.error`. Also gated the WS `input` case at `:2289` on `!session.pty._destroyed` for defense-in-depth.

#### Item 1.3 — body-parser raw-body capture + hex-escape log

- `packages/server/src/index.js:354-367` — `express.json({ verify })` callback now copies the raw body via `req.rawBody = Buffer.from(buf)` BEFORE the control-char scan. `Buffer.from()` is required (not direct ref) because express may pool the underlying accumulator across requests.
- `packages/server/src/index.js:368-414` — extracted `hexEscapePrefix(buf, maxBytes=32)` (printable ASCII verbatim; backslash → `\\`; non-printables + DEL → `\xNN`; `…` marker when truncated). Error middleware renders the prefix into the existing single-line warn as `prefix="..."`.
- PII-conservative: 32-byte cap. Operators can identify which caller is sending bad JSON without dumping the full body.

#### Exports added (`module.exports`)

`isPtyRaceError`, `hexEscapePrefix` — both used by fence tests under `packages/server/tests/`.

#### Tests

- `packages/server/tests/crash-class-helpers.test.js` (NEW, 22 tests) — isPtyRaceError race-class classifier (EBADF / ENOTTY in code AND in message; EINTR is NOT race; word-boundary against `PEBADFISH`), `safelyResizePty._destroyed` short-circuit invariants, `hexEscapePrefix` rendering for printable ASCII / BEL / DEL / backslash / 32-byte cap / truncation marker / PTY-shape bodies.
- `packages/server/tests/body-parser-rawbody.test.js` (NEW, 6 tests) — rawBody capture on success path, hex prefix appears in warn log on `entity.verify.failed`, 400 response shape unchanged from Sprint 60, SyntaxError path also gets hex prefix, oversized body uses `…` marker, Buffer.from copy isolation across requests.
- `packages/server/tests/crash-class-wiring.test.js` (NEW, 5 tests) — `term.onExit` nulls `session.pty` end-to-end via createServer + fake-pty, DELETE handler stamps `pty._destroyed = true` synchronously (verified by stubbing `kill()` to NOT auto-fire onExit so the race window is observable), POST /resize returns 410 Gone after exit, 404 distinct from 410 for missing-session case, live-session resize still returns 200.

#### Verification

- `npm test` baseline: **48 pass / 0 fail**.
- `npm test` post-T1: **103 pass / 1 fail / 0 skip** — the single fail is T3's WIP (`health-probe-taxonomy.test.js:122` `mnestra-pg = red:init-failed` test; not in T1 scope). Running only the 3 new T1 files: **33 pass / 0 fail**.
- Pre-existing root `tests/ws-resize-after-pty-exit.test.js` (10 tests imports production `safelyResizePty`) still **10/10 pass** — Sprint 63 `_destroyed` short-circuit + isPtyRaceError extraction are non-breaking.
- Pre-existing root `tests/body-parser-control-chars.test.js` still **9/9 pass**.
- Pre-existing root `tests/per-agent-hook-trigger.test.js` still **14/14 pass** — onExit `session.pty = null` ordering preserved onPanelClose payload contracts.

#### Brad's r730 log signatures — manual verification path

The empirical post-upgrade verification (Brad's r730, 13h uptime) cannot be performed here. The synthetic reproducers are:
- **body-parser `SyntaxError` flood (was 9× / 13h):** POST a JSON body containing BEL or other control chars in a string → expect single-line `[body-parser] CONTROL_CHAR_IN_STRING: ... prefix="..."` warn (no 10-line SyntaxError stack); `body-parser-rawbody.test.js` fences this.
- **WS ioctl EBADF/ENOTTY flood (was 25× / 13h):** Send WS resize after DELETE; expect short-circuit via `_destroyed = true` (silent, no console.error); `crash-class-wiring.test.js` + `crash-class-helpers.test.js` fence this.
- **PTY accumulation (`kern.tty.ptmx_max=511`):** create 4+ panels, `/exit` each, observe `lsof | grep ptmx` drops to zero within one GC cycle; `crash-class-wiring.test.js` fences the `session.pty = null` invariant that enables the GC.

No version bumps, no CHANGELOG edits, no commits.

### [T1] DONE 2026-05-11 13:22 ET — lane scope complete; awaiting T4-CODEX audit

All three sub-tasks landed; 33 new fence tests + 48 prior tests all green via `npm test`. Ready for T4-CODEX audit. Available for re-engage if AUDIT-CONCERN or AUDIT-RED surfaces.

### [T1] RE-ENGAGE 2026-05-11 13:33 ET — addressing T4-CODEX AUDIT-CONCERN 13:20 ET

T4-CODEX flagged that `body-parser-rawbody.test.js` rebuilds the verify + error middleware inline, so a production miswire (e.g. someone moves `req.rawBody = Buffer.from(buf)` below the control-char scan, or drops the error-middleware `hexEscapePrefix(req.rawBody)` call) would silently pass the rebuilt-middleware test. Fair concern — restore-claims-verified-by-diff demands a production-path proof.

Closing it with a new fence file that drives the REAL `createServer(config)`.

### [T1] FIX-LANDED 2026-05-11 13:35 ET — production-path body-parser fence added

New file: `packages/server/tests/body-parser-production-fence.test.js` (4 tests). Shape mirrors the existing wiring tests (`crash-class-wiring.test.js`, `adapter-session-end-writer.test.js`): fake-pty injected via `require.cache` → `createServer(config)` boots a real Express app on a random port → `console.warn` spied via temp monkey-patch → POSTs go through the actual production middleware stack at `packages/server/src/index.js:386-446`.

The 4 production-path assertions:

1. **Control-char body → 400 + hex prefix in production warn log.** POST `{"label":"\x07evil"}` to `/api/sessions/no-such-id/resize` (route exists, no spawn required, verify-callback rejects before route handler). Asserts 400 status, `CONTROL_CHAR_IN_STRING` code, AND captured `console.warn` line includes `prefix="`, literal `\x07`, the printable ASCII bytes before/after the BEL, and `POST` + the route path. A miswire that moves `Buffer.from(buf)` below the scan would fail the prefix check; dropping `hexEscapePrefix(req.rawBody)` from the error middleware would fail the `\x07` check; landing the hex prefix without `Buffer.from` (i.e. expressing the rawBody as an alias to the pooled buf) would still pass *this* request's assertion but `body-parser-rawbody.test.js`'s Buffer-isolation test covers that case.

2. **SyntaxError (non-control-char malformed) → 400 + hex prefix.** POST `{not valid json at all` to the same route. The verify callback's scan succeeds (no control chars) but express.json's own `JSON.parse` throws. Asserts the error middleware still gets `req.rawBody` from the verify-callback capture (proves the capture line runs UNCONDITIONALLY, not gated on the scan-throw path), and the warn line includes the printable malformed-body bytes verbatim.

3. **Valid JSON → no body-parser warn.** Negative control — POST `{"cols":80,"rows":24}` to the same route. Expects 404 from the route handler (session doesn't exist) but ZERO `[body-parser]` warn lines. Locks the contract that the warn signature is specific to parse failure.

4. **Oversized control-char body → `…` truncation marker.** POST a 100+ byte body with `\x01` deeper than 32 bytes. Asserts the captured warn line contains `…` (proves the 32-byte cap is enforced inside the production warn pipeline, not just in the helper unit test).

#### Verification

- `node --test packages/server/tests/body-parser-production-fence.test.js` → **4/4 pass** (377ms).
- T1 file totality: `node --test packages/server/tests/{crash-class-helpers,crash-class-wiring,body-parser-rawbody,body-parser-production-fence}.test.js` → **37/37 pass**.
- `npm test` full glob: **112 pass / 1 fail / 0 skip** — the single fail is T3's WIP at `health-probe-taxonomy.test.js:387` (`red:dependency-down` vs `red:unreachable` taxonomy refinement; T3's lane scope, not T1's).

### [T1] DONE 2026-05-11 13:35 ET — production-path proof in place; T4-CODEX AUDIT-CONCERN 13:20 ET closed

All four sub-fences for 1.3 now ride the production stack: helper-level (`crash-class-helpers.test.js`), inline-middleware (`body-parser-rawbody.test.js`), AND `createServer`-driven (`body-parser-production-fence.test.js`). The third file closes T4's concern — a regression that breaks the production wiring while leaving the helpers correct WILL fail at least one of its 4 assertions. Restore-claims-verified-by-diff applies.

37 T1 fence tests (was 33; +4). No version bumps, no CHANGELOG, no commits — orchestrator at sprint close. Available for re-engage on further AUDIT-CONCERN.

---

### [T2] — Empirical /exit capture proof (PRIORITY)

### [T2] BOOTED 2026-05-11 13:11 ET — lane briefs read; ready to pre-flight

Boot done: memory_recall ×2 + ~/.claude/CLAUDE.md + ./CLAUDE.md + CRITICAL-READ-FIRST-2026-05-07.md + PLANNING.md + this STATUS.md + T2 brief + `packages/server/src/index.js` close-path (`onPanelClose` :210-241, `term.onExit` :1158-1192 with call at :1181, `DELETE /api/sessions/:id` :1372-1383) + `packages/server/tests/adapter-session-end-writer.test.js`.

Close-path is what Sprint 62 fence tests stub. My lane validates the live chain: `DELETE :1372` → `session.pty.kill()` :1378 → `term.onExit` :1158 → `onPanelClose(session)` :1181 → `_spawnSessionEndHookImpl(hookPath, payload, env)` :234 → bundled `~/.claude/hooks/memory-session-end.js` writes dual-schema (`memory_items` + `mnestra_session_summary`).

Pre-flight next: Mnestra :37778, TermDeck :3000, `~/.termdeck/secrets.env` DATABASE_URL, 4 adapter CLIs (claude/codex/gemini/grok).

### [T2] FINDING 2026-05-11 13:20 ET — pre-flight GREEN + canary phrases + schema-name correction

**Pre-flight GREEN:**
- Mnestra :37778 `{ok:true, version:"0.2.1", rows:6553, last_write:"2026-05-11T17:08:55Z"}`
- TermDeck :3000 reachable; 4 active panels (1 codex + 3 claude-code — T1/T2/T3/T4). My canary panels will be isolated by fresh IDs.
- `~/.termdeck/secrets.env` has `DATABASE_URL` (value not printed per hygiene)
- All 4 adapter CLIs in PATH (`claude`, `codex`, `gemini`, `grok`)
- Bundled hook `~/.claude/hooks/memory-session-end.js` present (39066 bytes, 898 lines), byte-shape-identical to `packages/stack-installer/assets/hooks/memory-session-end.js`
- PTY headroom: `kern.tty.ptmx_max=511`; server fds on /dev/ptmx = 13. Safe for +4 panels.
- All 4 adapters expose `resolveTranscriptPath` (claude.js:122/240, codex.js:158/294, gemini.js:62/258, grok.js:147/466).

**Canary phrases (T4-CODEX, please use these verbatim for independent verification):**

```
claude:  sprint-63-acceptance-canary-claude-2026-05-11-e1ad
codex:   sprint-63-acceptance-canary-codex-2026-05-11-9b60
gemini:  sprint-63-acceptance-canary-gemini-2026-05-11-156e
grok:    sprint-63-acceptance-canary-grok-2026-05-11-15b5
```

**Adopting T4-CODEX AUDIT-CONCERN 13:13 ET (schema-name correction):** T2 brief lines 71-83 SQL targets `mnestra_session_summary`. There is no such table. Confirmed against source — bundled hook writes to two tables only:
- `memory_items` (line 644): `content`, `embedding`, `source_type='session_summary'`, `category='workflow'`, `project`, `source_session_id`, `source_agent` (normalized via `ALLOWED_SOURCE_AGENTS` whitelist line 631-633)
- `memory_sessions` (line 718, with `on_conflict=session_id`): `session_id`, `summary`, `summary_embedding`, `project`, `started_at`, `ended_at`, `duration_minutes`, `messages_count`, `facts_extracted`, `transcript_path` — **NO `source_agent` column on this table.**

**My Schema B will be `memory_sessions`**, matched on `summary ILIKE '%canary%'`. Per-adapter source-agent assertion belongs to `memory_items`. Will surface brief-text fix-suggestion to orchestrator at close — does not block this lane.

**Silent-skip thresholds confirmed in hook source:**
- Line 140: `MIN_TRANSCRIPT_BYTES = 5000` (5 KB), tunable via `TERMDECK_HOOK_MIN_BYTES` env
- Line 576: `if (messages.length < 5) skip` — no env override

**Method (refined):**
- Per panel: 3 substantive back-to-back prompts each containing the canary, ~150 words asked per response. That yields 6+ messages and trivially clears 5 KB.
- For `claude-code` panel: prompt asks the agent to type `/exit` at end of paragraph 3 (graceful close → claude's own SessionEnd hook fires). DELETE used as cleanup.
- For `codex|gemini|grok`: DELETE directly triggers `term.onExit → onPanelClose → spawn(hook)`.
- Driver script: `/tmp/sprint63-t2-drive-canary.js`. Log tail: `/tmp/sprint63-t2-canary.log`. Results: `/tmp/sprint63-t2-results.json`.

Launching driver next; will post interim FINDING when all 4 panels close, then probe Mnestra.

### [T2] FINDING 2026-05-11 13:43 ET — acceptance result 1/4; three silent-skip surfaces with file:line evidence

Full artifact at `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` (8 sections, scrubbed psql output). Per the T2 brief acceptance rule (lines 80-84): if any schema returns <4 rows, post FINDING (not DONE) and root-cause. Three independent surfaces root-caused, each P0.

**Acceptance gate result:** 1/4 adapters PASSED end-to-end.

| Adapter      | Schema A canary row | Schema B canary row | Result                                                |
|:-------------|:--------------------|:--------------------|:------------------------------------------------------|
| claude-code  | ✓ (source_agent=claude, 9 msgs, 2532 bytes) | ✓ (session_id=329e3ef5..., 9 msgs, 5 min) | **PASS** |
| codex        | ✗ (row exists for my session_id, content from another panel — no canary) | ✗ (same misattribution) | **FAIL** — Finding #1 |
| gemini       | ✗ 0 rows | ✗ 0 rows | **FAIL** — Finding #2 |
| grok         | ✗ 0 rows | ✗ 0 rows | **FAIL** — Finding #3 |

**Finding #1 — codex `resolveTranscriptPath` misattributes across concurrent panels (`packages/server/src/agent-adapters/codex.js:181-194`).** My codex canary panel died ~6 s after first prompt inject (driver got `404 Session is exited` on prompt 2). Codex DIDN'T initialize its rollout file. The adapter's mtime-desc-then-first-cwd-match logic returned a stale rollout file from a different codex panel (active T4-CODEX); the hook then wrote a row tagged with my canary's `source_session_id=bada8478` but containing summary text from the OTHER panel. Hook log: `[17:26:29] session=bada8478... startedAt=17:12:32` — startedAt is from the wrong file's `session_meta`. In normal use this can bite any codex panel that closes before its rollout file is created OR is the only codex panel with a fresh enough rollout.

**Finding #2 — gemini `resolveTranscriptPath` extension filter rejects `.jsonl` (`packages/server/src/agent-adapters/gemini.js:86`).** The filter is `!name.endsWith('.json')` — but gemini CLI now persists chats as `.jsonl` files (verified: `~/.gemini/tmp/termdeck/chats/session-2026-05-11T17-27-dce3289b.jsonl`, 9 KB, 6 canary occurrences). The adapter scans the right directory but skips every file. Returns null. `onPanelClose` exits at `index.js:220` — **no hook spawn, no row.** Every gemini session since the format switch has produced zero Mnestra rows. Pure silent data loss.

**Finding #3 — `<5 messages` silent-skip trips on short/slow conversations (`packages/stack-installer/assets/hooks/memory-session-end.js:576`).** Grok canary session `df609d2109f3` (in `~/.grok/grok.db`) has 4 messages (2 user + 2 assistant; total 6 713 bytes — well over the 5 KB transcript-size threshold). Hook silent-skips. This is the SAME surface flagged in `docs/CRITICAL-READ-FIRST-2026-05-07.md` Resolution as a Sprint 63 candidate. Grok-specific contributor: grok responded slowly to prompt 1 (`thinking` for >90 s); my driver moved on, so only prompts 2 and 3 + 2 responses got captured. A faster adapter OR a lower threshold would have cleared it.

**Side-channel findings (orchestrator visibility, not lane scope):**
- `packages/server/src/index.js:1349` has a literal forbidden-word in a code comment — public artifact, suggest scrub at sprint close.
- T2 brief lines 71-83 SQL targets non-existent `mnestra_session_summary` — already adopted T4-CODEX correction; brief text should be amended.
- `spawnTerminalSession` (`packages/server/src/index.js:1118-1175`) ignores `adapter.spawn` config — wraps as `zsh -c <command>` instead. Likely contributor to codex's fast death (codex spawned without proper interactive-TTY context). Out of lane scope.
- My driver's 1.5 s `status` poll missed every claude/codex/gemini `thinking` transition. The work happened (replyCount climbed, transcripts grew) but my "ok=true" return depended on observing `thinking`. Mitigation: any future automation-via-API should poll `lastActivity` deltas + `inputBufferLength` rather than `status` alone.

**What this means for Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md`:** Sprint 62 closed it on code/test grounds (wire-up + fence tests). My acceptance test shows the wire-up is *necessary but not sufficient* — three downstream surfaces (one per non-claude adapter) silently swallow content even when the wire-up fires correctly. The 27% coverage metric Sprint 62 expected to recover is unlikely to do so for codex/gemini/grok until these three surfaces ship. Claude-code coverage IS healthy.

**Lane-scope status:** T2 posts FINDING per brief acceptance rule (1/4 < 4/4). No code shipped from this lane. Driver + probe scripts at `/tmp/sprint63-t2-{drive-canary.js, probe-mnestra.sh}` for T4-CODEX independent reproduction. Recommend orchestrator scope-expand Sprint 63 to land Findings #2 (one-line filter fix) at minimum; Findings #1 + #3 likely Sprint 64 candidates (deeper redesign).

T4-CODEX: please reproduce against the canary phrases at lines 105-108 above. Expected result: 1 claude row matching all canaries (claude only), 0 codex/gemini/grok rows matching their canaries, plus 1 stray codex row tagged with `source_session_id=bada8478-d556-4f3d-8bac-2658dfc9896c` whose content does NOT contain a canary.

### [T2] FINDING 2026-05-11 14:02 ET — codex retry PASSED; acceptance now 2/4 (per ORCH 13:46 root-cause + 13:51 SCOPE)

Acknowledging **ORCH FINDING 13:46 ET** — Finding #1's first-run misattribution was caused by codex 0.129→0.130 update-picker self-exit BEFORE any canary content was injected, not by a TermDeck or T2 bug. Codex CLI auto-selected "1. Update now" (likely from the next paste arriving during the picker window), `npm install -g @openai/codex` ran successfully, codex printed "Please restart Codex." and exited 0. The stale `bada8478` row in Mnestra is the downstream symptom (`codex.js:158-196` resolveTranscriptPath picked the most-recent cwd-matching rollout, which was an unrelated active codex panel's file). Not a code bug — the canary panel just never produced any content of its own. Filed as Sprint 64 candidate under Investigation 2 territory (codex CLI lifecycle hardening).

**Codex retry result** (per ORCH 13:46 instruction; codex now on 0.130.0):

| Metric | Value |
|:-------|:------|
| New session id | `6c833582-4e8c-4a5d-98c7-e3370727470e` |
| Spawn time (UTC) | 2026-05-11 17:57:36 |
| DELETE time (UTC) | 2026-05-11 18:01:02 |
| Hook ingest time (UTC) | 2026-05-11 18:01:04 |
| memory_items row | ✓ 2422 bytes, source_agent=codex, project=termdeck |
| memory_sessions row | ✓ 2422 bytes, 7 messages, duration 2 min |
| Canary phrase | ✓ Found at content offset 498 (preceded by codex's AGENTS.md preamble) |

`psql` confirmation (scrubbed):
```
canary_match|source_agent|rows
claude|claude|1
codex|codex|1
(2 rows)
```

**Updated acceptance gate:**

| Adapter | Schema A | Schema B | Result |
|:--------|:---------|:---------|:-------|
| claude-code | ✓ | ✓ | **PASS** |
| codex (retry) | ✓ | ✓ | **PASS** |
| gemini | ✗ | ✗ | adapter-fix landed inline this sprint; parser-side JSONL handling → Sprint 64 |
| grok | ✗ | ✗ | Sprint 64 (Finding #3) |

**Acceptance result: 2/4 PASS** on canary content. Finding #2 fix shipped inline per ORCH SCOPE; Findings #1 + #3 carved to Sprint 64.

### [T2] FIX-LANDED 2026-05-11 14:03 ET — Finding #2 (gemini extension filter) shipped; 6 fence tests; npm test 119/119 green

**Diff applied** (uncommitted; orchestrator commits at sprint close):

- `packages/server/src/agent-adapters/gemini.js:86` — extension filter relaxed:
  ```diff
  -      if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
  +      if (!name.startsWith('session-')) continue;
  +      if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
  ```
- `packages/server/src/agent-adapters/gemini.js:50-61` — adapter doc-comment updated to reflect that gemini CLI now writes `.jsonl` (single-object `.json` is the legacy shape) and that the JSONL-aware parser-side handling is a Sprint 64 candidate.

**New fence file:** `packages/server/tests/gemini-resolve-transcript-extension.test.js` (6 tests, ~190 lines).

1. **`.jsonl` positive (Finding #2 fix)** — synthesize a fresh `.jsonl` under `~/.gemini/tmp/termdeck/chats/`, assert adapter returns its path.
2. **`.json` regression guard** — legacy single-object file under same dir, assert adapter still finds it.
3. **mtime preference** — both `.json` (backdated 1h) and `.jsonl` (fresh) present, assert newer wins.
4. **createdAt filter** — `.jsonl` with mtime 1h before session.createdAt, assert returns null.
5. **`session-` prefix gate** — `random-*.jsonl`, `notes.jsonl`, `session.jsonl` (no dash) present, assert no match.
6. **Fallback-walk** — primary `termdeck/chats/` empty, other proj dir `termdeck-renamed/chats/` has the canary `.jsonl`, assert adapter walks and returns it.

**Verification:**
- `node --test packages/server/tests/gemini-resolve-transcript-extension.test.js` → **6/6 pass** (276 ms).
- `npm test` full glob → **119 pass / 0 fail / 0 skip / 11.0 s** (T1 baseline 112 + T3 fail-fix + 6 new = 119).

**Carve-out language explicit** for Sprint 64:
- **Finding #1 — codex CLI update-picker lifecycle hazard.** Not a code bug; environmental. Sprint 64 candidate: TermDeck-side picker detection + auto-"Skip until next version", OR adapter-level disambiguation in `resolveTranscriptPath` so stale-rollout misattribution can't happen on the next occurrence. (Filed under `docs/CRITICAL-READ-FIRST-2026-05-07.md` Investigation 2 territory per ORCH.)
- **Finding #2 PARTIAL CARVE-OUT — parser-side JSONL handling.** Adapter now FINDS `.jsonl` files (this sprint's fix). The hook's `parseGeminiJson` at `packages/stack-installer/assets/hooks/memory-session-end.js:297-327` still does `JSON.parse(raw)` over the whole file expecting `obj.messages` array — fails on JSONL. Net effect after this sprint: failure mode shifts from "adapter ignores `.jsonl` silently" to "hook can't parse JSONL deltas, falls back to `<5 messages` silent-skip" — visible/diagnosable, not silently buried. Sprint 64 work: try-as-JSON-then-fall-back-to-JSONL variant of `parseGeminiJson`, mirrored in both `gemini.js` (adapter) and `memory-session-end.js` (inlined parser).
- **Finding #3 — `<5 messages` silent-skip threshold redesign.** Hook `memory-session-end.js:576` rejects short conversations regardless of byte size. Real-world bite zone: short audits, sanity checks, single-question consults across all four adapters. Sprint 64 redesign candidate; possible discriminators: byte-count of `text` content, distinguishing real-content turns from system-prompt/tool-result deltas, or simply lowering the threshold to `<3`.

### [T2] DONE 2026-05-11 14:03 ET — lane scope complete; 2/4 acceptance PASS + Finding #2 shipped + Findings #1/#3 carved to Sprint 64

Lane delivered:
- **Empirical /exit capture proof on acceptance grounds** for claude-code (PASS, via Claude Code's own SessionEnd hook) and codex retry (PASS, via TermDeck `onPanelClose → spawn(hook)` chain). 2/4 adapter result documented + scrubbed psql evidence + hook log entries.
- **Three silent-skip surfaces identified with file:line evidence:** Finding #1 (codex CLI lifecycle hazard — ORCH confirmed environmental, Sprint 64), Finding #2 (gemini extension filter — SHIPPED inline + 6 fence tests), Finding #3 (`<5 messages` threshold — Sprint 64).
- **Code change shipped this sprint:** `packages/server/src/agent-adapters/gemini.js:86-91` (extension filter) + `:50-61` (doc-comment). 6 new fence tests in `packages/server/tests/gemini-resolve-transcript-extension.test.js`. `npm test` 119/119 green.
- **Operator-grade verification doc:** `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` (8 sections, scrubbed, file:line per finding, fix sketches for Sprint 64 carve-outs).
- **Side-channel surfaces for orchestrator visibility:** literal forbidden-word at `index.js:1349` (ORCH gitleaks scrub in progress); brief schema-name typo (`mnestra_session_summary` → `memory_sessions`); `spawnTerminalSession` ignores `adapter.spawn` config (Sprint 64).

No version bumps, no CHANGELOG, no commits — orchestrator handles at sprint close.

T4-CODEX: available for re-engage if AUDIT-CONCERN surfaces on the fence test, the codex retry result, or the carve-out language.

---

### [T3] — Diagnostic surface (launcher Step 3 + health-probe + PTY shell)

### [T3] BOOTED 2026-05-11 13:13 ET — briefs + P0 banner read, three items scoped

Boot: memory_recall ×2 (27 hits launcher/health/probe, 25 hits doctor/5-5
carryover) + `~/.claude/CLAUDE.md` + `./CLAUDE.md` +
`docs/CRITICAL-READ-FIRST-2026-05-07.md` (Investigation 1 closed, Investigation 2
still open — not in this lane's scope) + PLANNING.md + STATUS.md + T3 brief.
Source-read end-to-end: `packages/server/src/health.js`,
`packages/stack-installer/src/launcher.js`, `packages/cli/src/stack.js`,
`packages/server/src/preflight.js`, `packages/cli/src/doctor.js`,
`packages/server/src/setup/rumen/migrations/001_rumen_tables.sql`.

### [T3] FINDING 2026-05-11 13:14 ET — §3.1 root cause = stack.js queries non-existent rumen_jobs.created_at

The Step 3 WARN Brad sees is NOT from stack-installer's `launcher.js` (its
Step 3 is "Starting Mnestra" with no SQL). It's from
`packages/cli/src/stack.js:413` (the `termdeck stack` Step 3 Rumen check):

```js
SELECT to_char(NOW() - MAX(created_at), 'HH24:MI:SS') AS ago FROM rumen_jobs
```

`rumen_jobs` schema
(`packages/server/src/setup/rumen/migrations/001_rumen_tables.sql:15-26`) defines
`started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` + `completed_at` — **no
`created_at`**. So the query throws `column "created_at" does not exist`. The
catch at `stack.js:422` only handles `relation .*rumen_jobs.* does not exist`
(table-missing) — column-missing falls through to the generic
`(query failed: ${err.message})` WARN at line 425, exactly matching Brad's
r730 log line.

Why doctor 23/23 passes: `packages/cli/src/doctor.js:441-451` was already fixed
in Sprint 35 era. Inline comment at lines 441-445 documents the exact same
Brad-2026-05-02 incident: "Pre-0.16.1 doctor probed `created_at` for all three,
which produced a false-positive WARN on rumen_jobs and pointed users at a
phantom migration drift (Brad, 2026-05-02)." Doctor uses
`RUMEN_TIME_COL = { rumen_jobs: 'started_at', rumen_insights: 'created_at',
rumen_questions: 'created_at' }`. **The doctor fix never propagated to
`stack.js`** — same data, two probes, different columns, divergent verdicts.

Fix shape:
- `stack.js:413`: change `MAX(created_at)` → `MAX(started_at)` (semantically
  correct per migration intent + matches doctor).
- Tighten the catch: detect `column .* does not exist` and emit an actionable
  WARN naming the column + table + a remediation pointer, not the bare
  `query failed` line that operators learn to ignore.

### [T3] FINDING 2026-05-11 13:15 ET — §3.3 zsh-hardcode patch already in tree; §4.6 timeout is a different bug

Grep for `zsh` in `packages/server/src/preflight.js` + `packages/server/src/health.js`:
`preflight.js:246` reads `const shell = process.env.SHELL || '/bin/bash';` —
never hardcoded zsh. Git log on `preflight.js`: only Sprint 6 (cd70b0e),
Sprint 6 lint (f8bb7ff), Mnestra healthz parse fix (ddb2e53), Sprint 38 graph
(b7353cc). No Sprint 5-5 commit ever touched the shell-spawn surface. **The
"patch landed" branch of the brief applies — §4.6 timeout is a different bug.**

Root cause for the 3s timeout on Brad's r730: `checkShellSanity` at
`preflight.js:264` spawns the shell with `['-l', '-c', 'echo TERMDECK_OK']`.
`-l` is **login mode**, which sources `~/.bash_profile` / `~/.zshrc` / etc.
Heavy profiles (nvm, conda, plugin managers — Brad has conda on r730) routinely
exceed 3s. A PTY-spawn health check does NOT need login mode: the question is
"can $SHELL spawn a PTY and emit output?" — not "does the user's interactive
profile complete fast?" Fix: drop `-l` from the spawn args. Keeps the 3s
timeout, the `$SHELL` portability, and the bash/zsh/sh coverage intact;
removes profile-time-dependence which is unrelated to PTY health.

### [T3] FIX-LANDED 2026-05-11 13:32 ET — three fixes in tree, 23 new fence tests, root `npm test` 104/104 green

**§3.1 — `packages/cli/src/stack.js`:**

- Line 413: `MAX(created_at)` → `MAX(started_at)` (matches doctor.js:448 +
  migration 001 schema). Sprint 35 doctor fix now propagated to the launcher.
- Lines 421-435: catch handler extended with column-not-exist branch. Pre-fix
  fall-through `WARN  (query failed: column "created_at" does not exist)`
  becomes `WARN  (rumen_jobs.created_at column missing — re-run
  \`termdeck init --rumen\` to apply migration 001)` — actionable; no longer
  the kind of WARN operators learn to filter.

**§3.2 — `packages/server/src/health.js` (rewrite of the failure surface,
contracts preserved):**

- Doc block extended with the 4-category taxonomy
  (`red:unreachable`/`red:timeout`/`red:dependency-down`/`red:init-failed`)
  and the rationale (Brad r730 cascade 2026-05-11).
- `CATEGORIES` frozen object exported for filter-by-category in dashboard/doctor.
- `classifyHttpFailure(r)` / `classifyDbFailure(err|envelope)` helpers — map
  shape `{ code, status, error, message }` → one of 4 categories. Default-safe
  to `red:dependency-down` on unknown SQL-error shapes.
- `safeQueryRow` / `safeQueryRows` extended to surface `code` field.
- `openPgClient` rewritten to return envelope `{ client, reason, error, code }`
  so the caller can distinguish "no URL" from "connect failed" without re-
  parsing message strings.
- `runPgChecks`: when client is null, dependents (`memory-items-col`,
  `pg-cron-ext`, `pg-net-ext`, `vault-secret`, `cron-job-active`) propagate
  the same category as the primary `mnestra-pg` failure — one root cause
  instead of 6 independent-looking RED rows.
- Per-query failures classify via `classifyDbFailure(envelope)` (SQL 42703 /
  42P01 → `red:dependency-down`).
- `checkSqlite`: `db === null` → `red:init-failed` + `logInitFailedOnce`
  (single warn at boot, no 2880/day flood on 30s poll).
- `checkMnestraWebhook` / `checkRumenPool`: `red:init-failed` on unconfigured
  surfaces (URL not set / pg not installed / DATABASE_URL not set); classified
  HTTP/db failure otherwise.
- Backward compat: existing `status` (`pass`/`fail`/`warn`) + `detail` (now
  category-prefixed) fields preserved. Client `app.js` consumers
  (`:3723`, `:4084`, `:4593`, `:4185-4186`) treat `detail` as opaque display
  text — they now see `red:unreachable (could not connect …)` etc., which
  improves readability without breaking parsing.

**§3.3 — `packages/server/src/preflight.js`:**

- Line 264: drop `-l` from `ptyMod.spawn(shell, [...])`. Inline comment
  explains the Brad-r730 conda profile case.
- Live verify on this host: shell_sanity passes for `/bin/zsh`, `/bin/bash`,
  `/bin/sh` — all 0.0s.

**Tests — `packages/server/tests/health-probe-taxonomy.test.js` (NEW, 23 cases):**

- 12 pure-classifier cases covering all 4 categories from synthetic inputs:
  TIMEOUT / ECONNREFUSED / ENOTFOUND / HTTP 503 / HTTP 502 / ETIMEDOUT /
  message-contains-timeout / SQL 42703 / SQL 42P01 / unknown-error-default.
- 7 end-to-end via `getFullHealth()` driving real checks with stubbed
  `db` + stubbed `_pgClient` + stubbed `_mnestraWebhookProbe`:
  - sqlite null → init-failed
  - DATABASE_URL absent (env stashed/restored) → mnestra-pg init-failed +
    dependent propagation across all 5 downstream checks
  - pg connect ECONNREFUSED → unreachable
  - pg query ETIMEDOUT → timeout
  - pg query SQL 42703 → dependency-down (the Brad-2026-05-11 column-not-exist
    symptom exact-shape match)
  - webhook HTTP 503 → dependency-down
  - webhook ECONNREFUSED → unreachable
  - webhook URL not configured → init-failed
- 2 log-once cases: 3 consecutive `db===null` cycles → exactly ONE
  `[health] sqlite handle null at boot ...` warn line emitted, AND all 3
  cycles still return `red:init-failed` in JSON (no first-cycle-RED-
  subsequent-GREEN oscillation).
- 1 contract case: `REQUIRED_CHECKS` still contains the 7 names client +
  doctor key on.

**Verification:**

```
$ node --test packages/server/tests/health-probe-taxonomy.test.js
ℹ tests 23  ℹ pass 23  ℹ fail 0  duration_ms 7817
$ npm test 2>&1 | tail -8
ℹ tests 104  ℹ pass 104  ℹ fail 0  duration_ms 8365
```

Regression-clean. No version bumps, no CHANGELOG, no commits — orchestrator at
sprint close.

### [T3] DONE 2026-05-11 13:33 ET — lane scope complete; awaiting T4-CODEX audit

All three acceptance criteria from `T3-diagnostic-surface.md`:

- 3.1: ✓ `WARN: column "created_at" does not exist` no longer fires (root
  cause was `stack.js` querying `created_at` instead of `started_at`); catch
  branch now produces actionable message if the symptom ever returns.
- 3.2: ✓ Probes report semantically-distinct `red:<category>` strings; unit
  test asserts the 4 cases (and 12 more via pure classifiers + log-once gate).
- 3.3: ✓ PTY shell health-check passes for zsh/bash/sh on macOS; root cause
  was `-l` login-mode profile-sourcing, not a hardcoded zsh literal.
- `npm test` root: ✓ 104/104 green.

Files touched (4):

```
packages/cli/src/stack.js
packages/server/src/health.js
packages/server/src/preflight.js
packages/server/tests/health-probe-taxonomy.test.js  (NEW, 23 tests)
```

Cross-lane note for T4-CODEX: probe-semantics is the easy-to-get-backwards
surface per PLANNING.md (`db === null` once-not-per-cycle gate). The gate
lives in `_initLoggedOnce` Map at `health.js`. The "log-once: 3 cycles all
return red:init-failed in JSON even though warn fires once" test specifically
fences against the failure mode where someone collapses the log gate into
the JSON gate by accident. Edge cases worth probing:

- mnestra serve up but Supabase rejects auth — `pgRunner.connect()` throws
  with code SQLSTATE 28P01 / 28000. Currently classified as
  `red:dependency-down` (default branch of `classifyDbFailure`). Defensible
  but T4 may prefer a 5th category — flag if so.
- pgbouncer in transaction mode dropping the connection mid-query — pg
  throws with `code === 'ECONNRESET'` or `'EPIPE'` which both currently
  default to `red:dependency-down`. Could plausibly be `red:unreachable`.
- HTTP 4xx from webhook (auth required, route renamed) — current
  classifier maps to `red:dependency-down` (any non-2xx-3xx from a
  responding peer). Defensible; flag if T4 wants a distinct category.

### [T3] FIX-LANDED 2026-05-11 13:42 ET — outer-catch hardening per T4-CODEX AUDIT-CONCERN 13:27 ET

T4-CODEX flagged that the four outer `getFullHealth()` catches at
`health.js:506-533` still emitted raw `{ status, detail }` envelopes without
a `category` field — any unexpected throw in a probe path would reintroduce
uncategorized rows despite the in-probe taxonomy. Fixed.

**`packages/server/src/health.js:503-572`:**

- Doc block added explaining why these fallbacks now run through the
  classifiers (the taxonomy contract is "no uncategorized non-pass row ever
  reaches the JSON, period").
- Each of the 4 outer catches replaced:
  - **SQLite catch** — `classifyDbFailure(err)` → `failCheck('sqlite', cat, msg)`.
  - **PG suite catch** — `classifyDbFailure(err)` → primary `mnestra-pg`
    failCheck + 5 dependents (`memory-items-col`, `pg-cron-ext`, `pg-net-ext`,
    `vault-secret`, `cron-job-active`) all inherit the same category. One
    root-cause row, not 6 independent-looking REDs.
  - **Webhook catch** — `classifyHttpFailure({code: err.code, error: err.message})`
    → `warnCheck('mnestra-webhook', cat, msg)`. Default for no-code Error is
    `red:unreachable` (HTTP-side classifier asymmetric with DB-side: HTTP
    failures without a known code/status are more often network-level than
    peer-bad-response).
  - **Rumen-pool catch** — `classifyDbFailure(err)` → `warnCheck('rumen-pool', cat, msg)`.
- Test seam added: `_throwIn: 'sqlite'|'pg'|'webhook'|'rumen-pool'` injects a
  synthetic throw at the corresponding outer-try entry so fence tests can
  exercise the otherwise-unreachable outer catches (each probe already has
  its own inner try/catch). Documented inline.

**Tests — `packages/server/tests/health-probe-taxonomy.test.js` (5 new cases, total now 28):**

- `outer catch fence: sqlite probe throws → category set + detail prefixed`
  — asserts `_throwIn:'sqlite'` produces `red:dependency-down` (default for
  no-code Error in db classifier) + `detail.startsWith('red:dependency-down')`.
- `outer catch fence: pg suite throws → primary + 5 dependents all carry the same category`
  — asserts the propagation contract: one synth-throw produces 6 categorized
  envelopes with matching categories + the "pg suite aborted" detail on
  dependents.
- `outer catch fence: webhook probe throws → warn with category` — asserts
  `red:unreachable` (the HTTP-side default). Test docstring documents the
  intentional asymmetry with the db classifier so future readers know it's
  a feature, not a bug.
- `outer catch fence: rumen-pool probe throws → warn with category` — same
  shape, expects `red:dependency-down`.
- `outer catch fence: invariant — no non-pass check is ever missing category`
  — belt-and-suspenders: drives a multi-probe-throw scenario (null db +
  null DATABASE_URL + no webhook URL + pg throw) and iterates EVERY non-pass
  check in the report asserting (a) `category` exists, (b) `detail`
  starts with `red:`. This is the assertion T4-CODEX's AUDIT-CONCERN
  effectively requested — there must not be an uncategorized escape hatch
  anywhere in the report-construction surface.

**Verification:**

```
$ node --test packages/server/tests/health-probe-taxonomy.test.js
ℹ tests 28  ℹ pass 28  ℹ fail 0  duration_ms 10006
$ npm test 2>&1 | tail -8
ℹ tests 113  ℹ pass 113  ℹ fail 0  duration_ms 9726
```

Regression-clean. Files touched this round:

```
packages/server/src/health.js                          (outer-catch wrap + _throwIn seam)
packages/server/tests/health-probe-taxonomy.test.js    (+5 fence cases, 23 → 28)
```

### [T3] DONE 2026-05-11 13:43 ET — outer-catch hardening complete; awaiting T4-CODEX re-audit

Re-stating closure with the updated counts. Lane scope:

- 3.1: ✓ stack.js `started_at` fix + actionable column-not-exist catch.
- 3.2: ✓ in-probe taxonomy + outer-catch hardening + log-once gate + dependent
  propagation; no uncategorized non-pass row reaches JSON, fenced by the
  "invariant" test.
- 3.3: ✓ preflight.js `-l` drop; live shell_sanity 0.0s on zsh/bash/sh.
- `npm test` root: ✓ 113/113 green.

Files touched (5 total across both FIX-LANDED rounds):

```
packages/cli/src/stack.js
packages/server/src/health.js
packages/server/src/preflight.js
packages/server/tests/health-probe-taxonomy.test.js   (NEW; 28 tests)
docs/sprint-63-wave-2/STATUS.md                       (this file — lane posts)
```

T4-CODEX: please re-audit and move Phase 3 from AUDIT-CONCERN to AUDIT-OK
when ready.

---

### [T4-CODEX] — Adversarial auditor

*(auditor posts here — CHECKPOINT every 15 min, every phase boundary)*

### [T4-CODEX] BOOTED 2026-05-11 13:11 ET — read T1/T2/T3 briefs, starting Phase 1

Boot complete. Read global/project rules, `docs/CRITICAL-READ-FIRST-2026-05-07.md` in full, sprint plan/status, and all three worker briefs. Phase sequence: Phase 1 T1 crash-class audit, Phase 2 T2 empirical `/exit` proof audit (deepest), Phase 3 T3 diagnostic-surface audit, Phase 4 cross-lane consistency, Phase 5 final verdict.

### [T4-CODEX] CHECKPOINT 2026-05-11 13:11 ET — Phase 0 boot complete; entering Phase 1

Phase: 0 boot -> 1 review T1.

Verified so far:
- Boot order completed: global rules require 3+1+1 hardening, RLS hygiene, and no forbidden literals; project rules require `docs/CRITICAL-READ-FIRST-2026-05-07.md` before normal work.
- `docs/CRITICAL-READ-FIRST-2026-05-07.md` Investigation 1 is closed on code/test grounds by Sprint 62, but Sprint 63 must close it on live acceptance grounds; Investigation 2 remains open.
- Sprint plan assigns T2 proof as load-bearing: all 4 adapters must write canaries to `memory_items`, and dual-schema reference installs must also show 4 rows in `mnestra_session_summary`.

Pending:
- Phase 1: wait for/read T1 FIX-PROPOSED or FIX-LANDED diff; audit PTY nulling order, WS resize race guard, raw-body hex truncation, and `410 Gone` tests.
- Phase 2: independently reproduce T2's adapter rows via my own psql connection against the reference Mnestra project.
- Phase 3: audit T3 Step 3 parity, health taxonomy, `db === null` log-once gate, and shell health-check coverage.

Most recent worker FIX-LANDED reference: none yet in STATUS.md.

### [T4-CODEX] AUDIT-CONCERN 2026-05-11 13:12 ET — T2 BOOTED post uses `####`, not canonical lane shape

T2's initial BOOTED post was first written as `#### [T2] BOOTED ...` before being corrected to `### [T2] ...`. The sprint scaffold requires `### [T<n>] STATUS-VERB ...` and the tolerant regex is `^(### )?\[T<n>\] DONE\b`; `#### [T2] ...` matches neither the canonical shape nor the fallback. Future T2 posts should continue using exactly `### [T2] ...` so cross-lane polling remains reliable.

### [T4-CODEX] AUDIT-CONCERN 2026-05-11 13:13 ET — T2 dual-schema query names an absent table

T2 brief lines 71-83 require querying `mnestra_session_summary`, but the bundled hook writes the companion summary to `memory_sessions` (`packages/stack-installer/assets/hooks/memory-session-end.js:718`), and my independent sanitized psql schema probe against the reference Mnestra project returned `memory_items=present`, `memory_sessions=present`, `mnestra_session_summary=absent`. The same schema probe shows `memory_sessions` has `summary` but no `source_agent`; the hook body at `packages/stack-installer/assets/hooks/memory-session-end.js:726-743` also sends no `source_agent` for that table. T2 should prove Schema B against `memory_sessions` by canary summary/session, while the per-adapter source-agent assertion belongs to `memory_items`, unless ORCH intentionally means a different relation and supplies that exact name.

### [T4-CODEX] AUDIT-CONCERN 2026-05-11 13:20 ET — T1 tests do not yet prove the production crash-class wiring

Current T1 worktree state is not red on implementation yet, but the proof is still under-fenced. I ran `npm run test` and got 70/70 pass, but the new `packages/server/tests/body-parser-rawbody.test.js:36-79` rebuilds the JSON verify + error middleware in the test instead of driving `createServer`, so a production miswire in `packages/server/src/index.js:386-445` could still pass. The only new package test files I see are `body-parser-rawbody.test.js` and `crash-class-helpers.test.js`; neither asserts the live onExit invariant `session.pty === null` after `packages/server/src/index.js:1211-1256`, nor the production resize route's `410 Gone` response at `packages/server/src/index.js:1676-1688`. T1's own BOOTED plan named those as fence tests. Restore-claims-verified-by-diff requires at least one production-path test for each claimed crash-class fix, or an explicit scoped-down claim.

### [T4-CODEX] CHECKPOINT 2026-05-11 13:26 ET — Phase 1 open; Phase 2 prep started; T3 content queued for audit

Phase: 1 remains open pending T1's formal FIX-LANDED/DONE and body-parser production-path proof; Phase 2 prep has started; Phase 3 has source/test material ready.

Verified since last checkpoint:
- T1: `npm run test` is now 104/104 green. New `packages/server/tests/crash-class-wiring.test.js` repairs part of my 13:20 concern by driving production `createServer` for `session.pty === null` after onExit and `/api/sessions/:id/resize` 410/404/200 semantics. The remaining T1 proof gap is body-parser: `packages/server/tests/body-parser-rawbody.test.js:36-79` still rebuilds the middleware instead of sending malformed JSON through production `createServer`.
- T2: first independent read-only psql canary query against reference Mnestra returned no `memory_items` or `memory_sessions` rows yet, before any T2 DONE/probe post. That is not a T2 failure; it just means final Phase 2 verification is still pending. Local sandbox blocks loopback connects, but `lsof` shows listeners on `127.0.0.1:3000` and `*:37778`, so I am not treating my raw `curl` connection-refused as a T2 pre-flight contradiction.
- T3: STATUS now contains T3 FIX-LANDED/DONE content timestamped 13:32/13:33 while my checked local clock is 13:26 ET. I will audit T3 by source/test content, not by that apparent lane-clock ordering.
- Extra verification run: root health contract smokes passed separately: `node --test tests/health-full.test.js` 8/8, `tests/health-contract.test.js` 3/3, `tests/cli-stack-detection.test.js` 7/7.

Pending:
- T1: require either a production-path body-parser fence or a scoped-down claim before Phase 1 can close green.
- T2: wait for T2 canary close/probe, then rerun my own psql query and require all four adapters in `memory_items` plus four canary summaries in `memory_sessions`.
- T3: audit `packages/cli/src/stack.js`, `packages/server/src/health.js`, `packages/server/src/preflight.js`, and `packages/server/tests/health-probe-taxonomy.test.js` against T3 DONE claims.

Most recent worker FIX-LANDED reference: T3 FIX-LANDED post in STATUS (timestamped 13:32 ET, content already present in file).

### [T4-CODEX] AUDIT-CONCERN 2026-05-11 13:27 ET — T3 aggregator fallbacks still emit uncategorized non-pass checks

T3's main taxonomy paths are substantially implemented and the focused tests are green, but the claim "Every non-pass check now carries a `category` field" is not true for the outer `getFullHealth()` catch fallbacks. `packages/server/src/health.js:506-507` catches a thrown SQLite check with raw `{ name, status:'fail', detail }`, `:512-520` catches a thrown Postgres suite with raw fail checks for `mnestra-pg` and all five dependents, `:526-527` catches a thrown webhook check with raw warn, and `:531-533` catches a thrown rumen-pool check with raw warn. Those are exactly the "unexpected error never throws the report" fallbacks described in the header, so they should use `failCheck`/`warnCheck` with `classifyDbFailure`/`classifyHttpFailure` or a defensible default category. Otherwise a real exception in a probe path reintroduces uncategorized red/warn rows despite the new taxonomy.

### [T4-CODEX] FINDING 2026-05-11 13:29 ET — local shell runner currently blocks fresh verification

After the 13:26 checkpoint, `exec_command` began returning exit code `-1` with no output for even trivial commands (`date`, `true`, `pwd`), including an escalated `date` attempt. `apply_patch` still works, and I used the time tool for this timestamp. This blocks fresh file reads and, more importantly, the required Phase 2 psql reproduction until command execution recovers. Last completed independent psql probe was before T2 DONE and returned zero canary rows, so Phase 2 remains open.

### [T4-CODEX] CHECKPOINT 2026-05-11 13:33 ET — shell still blocked; live psql audit deferred to orchestrator proxy

Phase: 1/3 remain code-review open on known concerns; Phase 2 live verification is blocked locally.

Verified since re-engage:
- Retried trivial shell commands (`date`, `echo ok`) after the initial 13:26 ET failure window; both still returned exit code `-1` with no output.
- Per ORCH re-engage, live psql audit is deferred to orchestrator due to Codex CLI shell sandbox limit at 13:26 ET; code/test review covers all other audit surfaces. I will consume sanitized orchestrator psql output in STATUS as the independent Phase 2 proxy once T2 posts DONE.
- Existing code-review concerns remain active: T1 still needs production-path body-parser proof unless repaired in a newer post I cannot yet read; T3 still needs categorized outer aggregator catch fallbacks unless repaired in a newer post I cannot yet read.

Pending:
- Retry shell again periodically; if it recovers, read latest STATUS and rerun direct psql.
- If shell remains blocked, wait for ORCH sanitized psql output and worker re-engage posts in STATUS, then close audits from durable text plus cached source/test evidence.

Most recent worker FIX-LANDED reference visible before shell block: T3 FIX-LANDED post in STATUS (timestamped 13:32 ET).

### [T4-CODEX] FINAL-VERDICT YELLOW 2026-05-11 13:59 ET — T1/T3 OK on code+tests; T2 live proof partial with Sprint 64 carve-outs

Verdict: **YELLOW**, not GREEN.

Reason: T1 and T3 are acceptable on code/test review grounds, but T2's sprint-defining live adapter proof did not reach 4/4 in this wave. Per ORCH, T2 result is 1/4 acceptance: `claude-code` PASS; `codex`, `gemini`, and `grok` root-caused as silent-skip surfaces, with the gemini `.jsonl` filter one-line fix landed inline and the remaining Findings #1 + #3 carved out to Sprint 64. The live psql audit is deferred to orchestrator proxy because Codex CLI shell sandbox began returning exit code `-1` at 13:26 ET; ORCH must append sanitized independent psql rows after T2 DONE so the durable audit trail contains the DB evidence.

T1 AUDIT-OK on code/test review:
- PTY leak: `packages/server/src/index.js` onExit path now nulls `session.pty` after `onPanelClose` and upload cleanup; cached source review saw the new invariant at `index.js:1211-1256`.
- WS ioctl/resize: `safelyResizePty` now short-circuits `_destroyed`, the DELETE path stamps the wrapper, `/resize` distinguishes missing session 404 from exited PTY 410, and the WS outer catch downgrades EBADF/ENOTTY race-class errors; cached review covered `index.js:315-328`, `:1441-1451`, `:1676-1688`, and `:2350-2385`.
- Body-parser: `express.json({ verify })` captures `req.rawBody`, and the error middleware logs a bounded escaped prefix; cached review covered `index.js:386-445`. ORCH states T1's 13:35 FIX-LANDED added the missing production-path body-parser fence, closing my 13:20 concern.
- Verification seen before shell block: `npm run test` 104/104 pass after T1/T3 test additions.

T3 AUDIT-OK on code/test review:
- Rumen Step 3: `packages/cli/src/stack.js` uses `MAX(started_at)` for `rumen_jobs`, matching migration 001 and `doctor.js`; cached review covered `stack.js:410-439`.
- Shell health: `packages/server/src/preflight.js` drops login-mode `-l` and keeps `$SHELL -c 'echo TERMDECK_OK'`; cached review covered `preflight.js:261-270`.
- Health taxonomy: `packages/server/src/health.js` adds categories, classifiers, categorized primary/dependent checks, and log-once init-failed handling; cached review covered `health.js:85-178`, `:246-373`, and `:420-482`.
- My 13:27 concern was the uncategorized outer `getFullHealth()` catch fallbacks at `health.js:506-533`. ORCH states T3's 13:42 FIX-LANDED hardened those outer catches and added an invariant fence, closing the concern.

T2 AUDIT-YELLOW:
- The schema correction is accepted: hook companion summary target is `memory_sessions`, while per-adapter `source_agent` assertion belongs to `memory_items`.
- Sprint 63 acceptance remains partial because the live proof did not produce 4/4 adapter rows in this wave. GREEN requires all four adapter paths either verified live or fixed and verified live.
- Carry to Sprint 64: codex silent-skip surface and grok silent-skip surface from T2 Findings #1/#3. Gemini `.jsonl` filter was narrowed as an inline one-line fix, but final GREEN still depends on ORCH/T2 live proof rows being appended.

No version bumps, CHANGELOG edits, commits, pushes, or publishes were performed by T4-CODEX.

---

### [ORCH] PSQL-PROXY 2026-05-11 14:02 ET — independent psql for T4 audit trail (project name elided)

Per T4-CODEX's deferred Phase-2 plan, orchestrator ran independent psql against the reference Mnestra project with the canary phrases from T2 FINDING 13:20 ET. Output sanitized (UUIDs truncated to 8-char prefixes; project ref + service-role key never echoed).

**Schema A — `memory_items`** (filter: `content ILIKE '%sprint-63-acceptance-canary%' AND created_at > NOW() - INTERVAL '60 minutes'`):
```
source_agent | source_type     | project  | bytes | canary                                              | sess_pfx
-------------+-----------------+----------+-------+-----------------------------------------------------+----------
codex        | session_summary | termdeck |  2422 | sprint-63-acceptance-canary-codex-2026-05-11-9b60   | 6c833582
claude       | session_summary | termdeck |  2532 | sprint-63-acceptance-canary-claude-2026-05-11-e1ad  | 329e3ef5
```

**Schema B — `memory_sessions`** (filter: `summary ILIKE '%sprint-63-acceptance-canary%' AND created_at > NOW() - INTERVAL '60 minutes'`):
```
sess_pfx | bytes | messages_count | canary
---------+-------+----------------+-----------------------------------------------------
6c833582 |  2422 |              7 | sprint-63-acceptance-canary-codex-2026-05-11-9b60
329e3ef5 |  2532 |              9 | sprint-63-acceptance-canary-claude-2026-05-11-e1ad
```

**Interpretation:**
- **claude (329e3ef5)** — ✓ PASS, both schemas, 9 messages, correct canary match.
- **codex (6c833582)** — ✓ PASS, both schemas, 7 messages, correct canary match. This is the **T2 retry session** post-codex-CLI-auto-update fix; **first end-to-end live proof that the codex /exit-capture chain works** when the adapter is allowed to initialize fully. Closes part of T2 Finding #1 — the misattribution scenario was driven by panel-died-pre-rollout, not a structural codex/Mnestra incompatibility.
- **gemini** — 0 rows pending T2's verification run against the now-landed `.jsonl` filter fix.
- **grok** — 0 rows; per T2 Finding #3 (silent-skip on `<5 messages` threshold), Sprint 64 carve-out.

**Effective acceptance: 2/4 confirmed live + 1 pending T2 verification + 1 explicit Sprint 64 carve-out.** Better than T2's original 1/4 snapshot at 13:43 ET because the codex retry worked.

T4-CODEX: this is your live psql proxy evidence. Read-only consumption — no shell exec required.

---

## Orchestrator runbook (post-close)

At T4-CODEX FINAL-VERDICT GREEN (or after RED is repaired to GREEN), orchestrator:

1. `npm test` root green re-verify.
2. Bump `package.json` versions: termdeck 1.1.1 → 1.2.0, termdeck-stack 1.1.1 → 1.2.0, engram (mnestra) 0.4.9 → 0.4.10.
3. Append `## [1.2.0]` (etc.) sections to all 3 CHANGELOG.md files referencing this sprint dir.
4. Stage + commit + push (engram first, then termdeck) — see RELEASE.md.
5. Joshua publishes `npm publish --auth-type=web` × 3 (Passkey, never `--otp`).
6. Brad WhatsApp with ship summary.
7. This STATUS.md gains an `## ORCHESTRATOR STAGED` block at the bottom listing every file committed.
8. PLANNING.md gains `## Resolution` section dated at close.
