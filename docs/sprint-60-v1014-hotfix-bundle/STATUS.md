# Sprint 60 — STATUS

**Sprint:** v1.0.14 hotfix bundle. Five focused items, single-orchestrator, no 3+1+1 ceremony.
**Pattern:** Single-orchestrator (Joshua via Claude Opus 4.7 1M-ctx). Optional Codex spot-check audit on Items 1-3 (the code-quality-sensitive ones).
**Date:** Started 2026-05-07 ~17:20 ET, immediately after Sprint 59 v1.0.13 ship + CONVERGENCE-PLAN.md authored.
**Target ship:** `@jhizzard/termdeck@1.0.14` + `@jhizzard/termdeck-stack@0.6.14` (audit-trail bump). Mnestra/Rumen unchanged. Wall-clock estimate 1.5-2 hours.

## Pre-sprint substrate (verified)

```
@jhizzard/termdeck             1.0.13 (Sprint 59 close)
@jhizzard/termdeck-stack       0.6.13
@jhizzard/mnestra              0.4.6
@jhizzard/rumen                0.5.3
origin/main commit             e7cf46c (Sprint 59 ship — pushed 2026-05-07 16:52 ET)
```

## Lane post shape (uniform)

```
### [ORCH] STATUS-VERB 2026-MM-DD HH:MM ET — <one-line gist>
<body>
```

If Joshua opens a Codex panel for spot-check audit:
- Codex posts as `### [T4-CODEX] AUDIT-OK` or `AUDIT-CONCERN` per item
- Codex reads only items 1-3 (code-sensitive); items 4-5 (launcher script + log rotation docs) skip audit

## Five items

| # | Item | Severity | Files | Audit? |
|---|---|---|---|---|
| 1 | Per-adapter idle/parked status detection | P0 | `packages/server/src/session.js` (or new `agent-status-detection.js`) + tests | ✓ |
| 2 | Body-parser control-character hardening | MED | `packages/server/src/index.js` (express.json verify callback) + tests | ✓ |
| 3 | WS ioctl EBADF/ENOTTY race guard | MED | `packages/server/src/index.js` (WS resize handler) + tests | ✓ |
| 4 | Launcher stderr separation | MED | `packages/stack-installer/assets/start-termdeck.sh` (or whichever path emits) | — |
| 5 | Log rotation / per-boot banner | LOW | `packages/server/src/index.js` startup banner + `docs/examples/termdeck.logrotate` | — |

## Lane discipline (universal)

1. Each item gets its own `### [ORCH] FIX-LANDED 2026-05-07 HH:MM ET — <gist>` post.
2. No version bumps, no CHANGELOG edits, no `git commit` until ALL 5 items + tests pass — single-orchestrator close at end.
3. Append-only STATUS.md.
4. New tests added for items 1, 2, 3. Items 4 and 5 verified via manual smoke (script lint + restart-and-check-banner).

## Cross-references

- Sprint 59 close: commit `e7cf46c`, `@jhizzard/termdeck@1.0.13`
- Brad's 2026-05-07 crash forensic (memory): `project=termdeck`, `source_type=bug_fix`, dated 2026-05-07 ~16:35 ET
- BACKLOG § P0 v1.0.14 hotfix bundle entry
- Sprint 59 idle-detection promotion (P0): `docs/BACKLOG.md`
- Convergence path: `docs/CONVERGENCE-PLAN.md` § Sprint 60
- Project rules: `CLAUDE.md`
- Global rules: `~/.claude/CLAUDE.md`

---

## Lane posts (append below — newest at bottom)

### [ORCH] BOOT 2026-05-07 17:20 ET — Sprint 60 starts; Item 1 (per-adapter idle detection) first

Beginning with Item 1 (the P0 — surfaced + bit Sprint 59 twice). Plan: extract end-of-turn detection into a dedicated helper module, add per-adapter pattern tables (Codex `Worked for Xm Ys`, Claude idle-prompt cursor + new-prompt textarea state), wire into `session.js` `meta.status` flip logic, plus a 30-60s `lastActivity`-stale safety net. New tests in `tests/per-adapter-idle-detection.test.js`. Once Item 1 lands, Items 2-3 in parallel since they touch independent areas of `index.js`. Items 4-5 close the bundle.

### [ORCH] FIX-LANDED Item-1 2026-05-07 17:30 ET — per-adapter idle detection complete

Two-layer defense, ~25 LOC + 11 tests passing:

**Layer 1 — Codex adapter end-of-turn pattern.** New `END_OF_TURN = /─\s*Worked for\s+(?:\d+m\s*)?\d+s\s*─/` regex in `packages/server/src/agent-adapters/codex.js` matches the unicode-box-drawing terminator the TUI prints when a turn closes (`─ Worked for 2m 50s ─`). Inserted at the TOP of the `statusFor` cascade so it wins over `THINKING` even when both fire in the same data chunk (the exact failure mode that bit Sprint 59 — a final "Working" spinner update riding on the same write as the closing terminator). Returns `{status: 'idle', statusDetail: ''}` (canonical empty-detail idle shape). Also exported on `patterns.endOfTurn` for cross-test parity with `patterns.thinking`.

**Layer 2 — Session-level stale-status guard.** Added in `Session.toJSON()` at `packages/server/src/session.js`. If `meta.status` is in `STICKY_STATUSES = {'thinking', 'editing'}` AND `Date.now() - new Date(meta.lastActivity)` > `STALE_STATUS_THRESHOLD_MS` (30000ms), the serialized output reports `status: 'idle'` with empty `statusDetail`. The in-memory `meta` is NOT mutated — next real PTY chunk continues from where the analyzer left off without confusion. Both constants are exposed as class statics (`Session.STICKY_STATUSES`, `Session.STALE_STATUS_THRESHOLD_MS`) so tests can stub them and the threshold can be tuned in one place.

This catches Codex (precise via Layer 1) AND Claude / Gemini / Grok / any future adapter (general via Layer 2). Lazy: zero timer cost — only evaluated on `GET /api/sessions` or `GET /api/sessions/:id` reads.

**Test results:** `node --test tests/per-adapter-idle-detection.test.js` → 11/11 pass, 419ms.

**Files touched:**
- `packages/server/src/agent-adapters/codex.js` — `END_OF_TURN` regex + statusFor branch + `patterns.endOfTurn` export
- `packages/server/src/session.js` — `Session.toJSON()` guard + `Session.STICKY_STATUSES` + `Session.STALE_STATUS_THRESHOLD_MS` class statics
- `tests/per-adapter-idle-detection.test.js` — NEW, 11 tests

Moving to Item 2 (body-parser control-character hardening).

### [T4-CODEX] AUDIT-OK Item-1

Independent spot-check clean.

- Regex check: `echo '─ Worked for 2m 50s ──' | grep -E '─[[:space:]]*Worked for[[:space:]]+([0-9]+m[[:space:]]*)?[0-9]+s[[:space:]]*─'` matched the actual Codex terminator line.
- Cascade order: `packages/server/src/agent-adapters/codex.js:95` checks `END_OF_TURN` before `THINKING` at `packages/server/src/agent-adapters/codex.js:102`; live `statusFor('Working 2m 49s\n─ Worked for 2m 50s ──')` returned `{"status":"idle","statusDetail":""}`.
- Stale guard: `Session.toJSON()` clones `meta` at `packages/server/src/session.js:519` and only mutates the clone at `packages/server/src/session.js:534`, so `session.meta` is not changed.
- Threshold: 30s is reasonable for the hotfix because it is a lazy serialization guard, and `Session.STALE_STATUS_THRESHOLD_MS` at `packages/server/src/session.js:556` is a single exposed tune point if real-world false-idle signal appears. Per-adapter tuning can wait for evidence.
- Verification: `node --test tests/per-adapter-idle-detection.test.js` passed 11/11.

### [T4-CODEX] AUDIT-OK Item-2

Independent spot-check clean against the landed code/test files. Note: at audit time `STATUS.md` did not yet contain an `[ORCH] FIX-LANDED Item-2` marker, but `packages/server/src/index.js` and `tests/body-parser-control-chars.test.js` already contain the Item 2 implementation and test coverage.

- Escaped backslashes: the string-state scanner clears `escape` immediately after consuming the escaped byte at `packages/server/src/index.js:302`, so `\\` followed by a raw control byte does not leave the control byte protected. The dedicated test at `tests/body-parser-control-chars.test.js:120` covers this and passes.
- Keys and values: the scanner tracks every double-quoted JSON string, not object-value positions only, via `inString` at `packages/server/src/index.js:294`; the key test at `tests/body-parser-control-chars.test.js:140` passes.
- Large bodies: the verify hook is one O(N) pass over the already-buffered body at `packages/server/src/index.js:296`; with `express.json()`'s normal request-size cap this is acceptable for the hotfix and cheaper than letting `JSON.parse` throw noisy stacks.
- Allowed bytes: escaped JSON controls still pass, structural `\n`/`\t` outside strings pass, and UTF-8 multibyte content is not rejected because the guard only rejects bytes `< 0x20` plus `0x7f` inside strings at `packages/server/src/index.js:307`.
- Verification: `node --test tests/body-parser-control-chars.test.js` passed 8/8.

### [ORCH] FIX-LANDED Item-2 2026-05-07 17:42 ET — body-parser control-char hardening (audit-trail post)

(Codex's `AUDIT-OK Item-2` above audited directly off the working tree before this post landed; this entry exists for STATUS.md narrative completeness.) `verify` callback added to `express.json()` in `packages/server/src/index.js`. Single-pass O(N) byte scan inside double-quoted regions; rejects unescaped control chars (0x00-0x1f, 0x7f) with structured `entity.verify.failed` error + `code: 'CONTROL_CHAR_IN_STRING'`. Existing error handler extended to log a single-line `console.warn` instead of letting Express dev-mode dump a 10-line stack. **Tests:** 8/8 pass in `tests/body-parser-control-chars.test.js`.

### [ORCH] FIX-LANDED Item-3 2026-05-07 17:48 ET — WS ioctl EBADF/ENOTTY race guard

New `safelyResizePty(session, cols, rows)` helper at file-level in `packages/server/src/index.js`. Skips when `!session.pty` or `meta.status === 'exited'`. Catches EBADF/ENOTTY/`/ioctl\(\d+\)\s+failed/` race errors silently; rethrows non-race errors. Two call sites updated: WS `resize` handler + `POST /api/sessions/:id/resize`. Set `TERMDECK_DEBUG_PTY_RACES=1` for diagnostic console.debug output. **Tests:** 10/10 pass in `tests/ws-resize-after-pty-exit.test.js`. T4-CODEX please audit when ready.

### [ORCH] PROGRESS 2026-05-07 17:50 ET — Items 1-3 all FIX-LANDED + Item 1 + 2 audited; starting Items 4-5

Items 4 (launcher stderr separation) and 5 (log rotation + per-boot banner) starting now in parallel. Both are scope-skip for Codex audit per the inject prompt — observability/script-edit territory, not behavioral. Will close with version bump + CHANGELOG + commit once Items 4-5 land.

### [T4-CODEX] AUDIT-CONCERN Item-3: `packages/server/src/index.js:289` suppresses any `ioctl(...) failed` message, not just EBADF/ENOTTY

The main guard shape is right: `safelyResizePty()` skips missing/exited PTYs at `packages/server/src/index.js:281`, both REST and WS resize paths route through it at `packages/server/src/index.js:1577` and `packages/server/src/index.js:2254`, and EBADF/ENOTTY races no longer fall through to the outer WS `console.error`.

Gap: the race classifier is broader than the sprint ask. `packages/server/src/index.js:289` treats any `/ioctl\(\d+\)\s+failed/` message as race-expected even when `err.code` is absent and the message does not say EBADF or ENOTTY. The test locks this behavior in at `tests/ws-resize-after-pty-exit.test.js:84` with `"ioctl(2) failed for unknown reason"`. That means a non-race ioctl failure would be silently dropped unless `TERMDECK_DEBUG_PTY_RACES=1` is set. Safer classifier: downgrade only `err.code in {EBADF, ENOTTY}` or message text containing EBADF/ENOTTY; rethrow other ioctl failures.

Secondary test gap: `tests/ws-resize-after-pty-exit.test.js:10` reimplements the helper instead of importing the production helper, so future production drift would not fail the unit test. Current copied behavior matches the code, and `node --test tests/ws-resize-after-pty-exit.test.js` passes 10/10, but this weakens the acceptance signal.

### [ORCH] FIX-LANDED Item-4 2026-05-07 17:55 ET — canonical start-termdeck.sh with stderr separation

NEW `docs/examples/start-termdeck.sh` (similar pattern to Sprint 59's `docs/examples/termdeck.service`). Brad's `~/start-termdeck.sh` is custom; we don't ship one today. This canonical reference shows the post-Sprint-59-fix shape: `nohup termdeck --no-stack > ~/.termdeck/termdeck.log 2> ~/.termdeck/termdeck.err </dev/null &` — stdout and stderr go to SEPARATE files, so an abrupt-death final traceback survives instead of getting lost in nohup's merged-fd default. Also: per-script-boot banner with ISO timestamp into both files, secrets.env source-aware, single-instance pid-file guard, runnable-from-anywhere. Brad (and the 3+ other testers) can drop this into `~/start-termdeck.sh` directly. `bash -n` lint-pass clean. Doc cross-reference: install guide gets a "Running TermDeck under nohup" section in a follow-up doc PR (out of code scope).

### [ORCH] FIX-LANDED Item-5 2026-05-07 17:57 ET — per-boot banner + canonical logrotate config

Two-part observability win:

1. **Server-side per-boot banner** in `packages/server/src/index.js` `server.listen` callback — every TermDeck server boot now writes `════ TermDeck server boot · <ISO-timestamp> · pid <N> ════` as the first console line. Crash → restart leaves a unique greppable fingerprint. Pairs with the log-rotation config below so even on a long-running install, finding "the most recent crash" is a 30-sec operation.

2. **NEW `docs/examples/termdeck.logrotate`** — canonical logrotate config (daily, 14-day retention, copytruncate so the running fd doesn't need SIGHUP). Path globs cover both `/home/*/` (Linux) and `/Users/*/` (macOS) `.termdeck/termdeck.{log,err}`. System-wide install: `sudo cp docs/examples/termdeck.logrotate /etc/logrotate.d/termdeck`. Per-user install option documented in the file header.

**Verification:** server boot banner emits ISO-timestamped line; manual lint of logrotate config (no `logrotate --test` in this run because the config writes outside the working tree). `bash -n` clean on start-termdeck.sh.

### [ORCH] PROGRESS 2026-05-07 17:58 ET — All 5 items FIX-LANDED; running full test sweep then close

29/29 tests passing across the 3 new test files (Items 1+2+3). Items 4+5 verified manually. Sprint-touched regression sweep next, then version bump + CHANGELOG + commit.

### [ORCH] FIX-LANDED Item-3-revision 2026-05-07 18:00 ET — addressing T4-CODEX AUDIT-CONCERN Item-3

Two clean fixes per Codex's two findings:

**1. Narrowed race classifier.** Pre-revision, `/ioctl\(\d+\)\s+failed/` matched ANY ioctl failure message — would have silently dropped EINTR / EFAULT / etc. Post-revision: `/\b(?:EBADF|ENOTTY)\b/` requires explicit EBADF or ENOTTY in the message OR `err.code in {EBADF, ENOTTY}`. Other ioctl failures rethrow and surface in logs (where they belong — they may indicate real bugs we haven't seen yet).

**2. Test imports production helper.** Pre-revision, `tests/ws-resize-after-pty-exit.test.js` re-implemented `safelyResizePty` locally — code drift in production wouldn't fail tests. Post-revision: `safelyResizePty` exported from `packages/server/src/index.js`; test does `const { safelyResizePty } = require('../packages/server/src/index')`. New test added: `safelyResizePty rethrows generic "ioctl failed" without EBADF/ENOTTY` — pins the narrowing.

**Test results:** 11/11 pass (was 10; +1 new rethrow test). T4-CODEX please re-verify Item-3.
