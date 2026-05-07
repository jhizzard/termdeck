# Sprint 60 — v1.0.14 Hotfix Bundle

**Status:** Stub authored 2026-05-07 ~16:55 ET, immediately after Sprint 59 v1.0.13 ship. Five focused items, all single-orchestrator (no 3+1+1 ceremony), same-day-cadence after surfacing during Sprint 59 close-out + Brad's 2026-05-07 crash forensic.

**Pattern:** Single-orchestrator (Joshua Izzard via Claude orchestrator). NOT 3+1+1 — these are 5 independent small fixes, each tightly scoped, no audit-blocking dependencies. Each item gets its own commit; ship wave is one npm publish for `@jhizzard/termdeck@1.0.14` + audit-trail bump for `@jhizzard/termdeck-stack@0.6.14`. Mnestra/Rumen unchanged.

**Target ship:** Same-day or next-morning cadence after Sprint 59 v1.0.13 close. Wall-clock estimate 1.5-2 hours (5 items × ~20-25 min each).

## Why this sprint exists

Two parallel signals collided during Sprint 59 close-out:

1. **Brad's 2026-05-07 16:30 ET crash forensic** on his r730/Ubuntu v1.0.12 install — two server crashes in one day, both terminating clusters of sessions with `exit_code=-1`. Brad's analysis found two recurring noise patterns (9× body-parser SyntaxError + 25× WS ioctl EBADF/ENOTTY) plus an operational gap (stderr not redirected separately, log file stops 36s before crash with no traceback captured). Brad's distribution updated mid-day: **3+ external testers, not 1**. Crash hardening is a release-quality issue, not a backlog item.
2. **Sprint 59 in-flight friction** — the orchestrator's API-based status detection mis-reported Codex (and Claude) panels as `reasoning` for many minutes after they parked at end-of-turn, requiring manual operator observation to unblock. Bit Sprint 59 TWICE in 90 min wall-clock. Promoted from § C to § P0 in BACKLOG mid-sprint.

Both classes of signal compound in a way that 3+1+1 ceremony would over-spend on. Single-orchestrator hotfix is the right shape.

## The five items

### Item 1 — Per-adapter idle/parked status detection

**Severity:** P0 (sprint-orchestration efficiency blocker).

**Symptom:** When a Codex panel finishes its turn and parks at the prompt, `GET /api/sessions` reports `meta.status: "active"` with `meta.statusDetail: "Codex is reasoning..."` and a recently-updated `lastActivity` — indistinguishable from genuine mid-reasoning. Same false-positive on Claude panels (status `active`/`Using tools` or `thinking`/`reasoning` with stale `lastActivity`). The orchestrator can't reliably tell when a long-running auditor lane has finished its turn.

**Fix area:**
- `packages/server/src/session.js` PATTERNS or per-adapter hook in `packages/server/src/agent-adapters/`
- Codex adapter: detect `─ Worked for Xm Ys ─` end-of-turn terminator in transcript output; flip to `status: 'active'` with empty `statusDetail` (canonical idle shape)
- Claude Code adapter: detect idle-prompt cursor shape (the input-box prompt with no spinner)
- Generic safety net: 30-60s `lastActivity`-stale heuristic that flips any panel with no PTY output for that window to idle, regardless of adapter

**Test:** new `tests/per-adapter-idle-detection.test.js` covering each adapter's end-of-turn pattern + the stale-lastActivity fallback. Use `/api/transcripts/:sessionId` content as input to a `detectIdle(transcript, adapter)` helper that returns boolean.

**Verification:** spawn a Codex panel, wait for it to /exit, observe `meta.status` flips to `active` with empty `statusDetail` within 30s of the `Worked for` line.

### Item 2 — Body-parser control-character hardening

**Severity:** MEDIUM (noise pollution + indicates API hygiene gap; not directly fatal but Brad logged 9× per 13h uptime).

**Symptom:** Brad's r730 log shows repeated `SyntaxError: Bad control character in string literal in JSON at position 9` from `body-parser/lib/types/json.js:92`. Express receives PTY output as JSON body without sanitization. Express normally returns 400 on parse failure but the recurring noise pollutes diagnostics and may indicate a path that's accidentally feeding raw PTY bytes to a JSON endpoint.

**Fix area:**
- Custom `verify` callback on `express.json()` that strips/rejects control chars before parse, OR
- Per-route raw-body parser with explicit `JSON.parse` in try/catch returning structured 400
- Audit grep: which client paths POST JSON containing terminal output? Likely `/api/transcripts/search` or a similar endpoint. Identify and add input sanitization at the boundary.

**Test:** `tests/body-parser-control-chars.test.js` — POST a JSON body containing `\x00`, `\x07`, `\x1b[A`, etc. Assert 400 with structured error message, not unhandled rejection or process kill.

### Item 3 — WebSocket ioctl EBADF/ENOTTY race guard

**Severity:** MEDIUM (Brad logged 25× per 13h uptime; pty-reaper race against WS resize).

**Symptom:** `[ws] message handler error: Error: ioctl(2) failed, EBADF` and `ENOTTY` from the WS message handler when a `resize`/`setSize` message arrives for a PTY that the reaper (30s interval) has already closed.

**Fix area:**
- WS resize handler in `packages/server/src/index.js`: check `session.pty && !session.pty._destroyed` (or equivalent liveness probe) before calling `pty.resize`
- Downgrade EBADF/ENOTTY to `console.debug` instead of `console.error` (these are race-expected, not bugs once guarded)
- Optional: track and log the count of skipped-resize-on-reaped events at server stop for observability

**Test:** `tests/ws-resize-after-pty-exit.test.js` — drive a PTY to exit, then send a `setSize` WS message; assert no thrown error, debug-level log only.

### Item 4 — Launcher stderr separation in `~/start-termdeck.sh`

**Severity:** MEDIUM (operational observability gap — Brad's crash forensic found log file stops 36s before crash because nohup mixes stderr into the same fd as stdout, and abrupt process death may leave the final traceback in an unflushed buffer).

**Fix area:**
- The bundled `~/start-termdeck.sh` (or the equivalent installer-emitted file) must redirect stderr to a separate file: `nohup termdeck > ~/.termdeck/termdeck.log 2> ~/.termdeck/termdeck.err &`
- Add a per-boot banner with timestamp to BOTH files so concurrent log files are correlatable across restarts
- Update `docs/GETTING-STARTED.md` § "Running TermDeck under nohup" to document the new layout

**Test:** lint check that the emitted script has separate stdout/stderr redirects; manual smoke test on Joshua's box.

### Item 5 — Log rotation / per-boot banner

**Severity:** LOW-MEDIUM (Brad's 260KB log spans Apr 25 → May 7 with one boot banner — single file growing unbounded across reboots makes diagnosis 30 minutes instead of 30 seconds).

**Fix area:**
- Per-boot banner with ISO timestamp emitted on server start (in `packages/server/src/index.js` startup banner block)
- Document a logrotate config at `docs/examples/termdeck.logrotate` (daily rotate, 14-day retention, copy-truncate to avoid fd reopen)
- Optional: add a `[server] starting at <iso>` line as the FIRST log write so each restart leaves a fingerprint

**Test:** manual — restart the server, verify a new banner appears with the current timestamp, and the prior banner is preserved (not truncated).

## Out of scope for Sprint 60

- Phase B for Sprint 58 catch-net (operator action, ~15 min — separate atomic task)
- Mnestra 0.4.7+ schema bug (RLS-on baseline migration for fresh installs)
- Cost-monitoring panel (Sprint 51 deferred vision)
- Install-polish (interactive setup wizard, OS-detection — earlier sketched)
- Brad's actual crash root cause investigation if his diagnostic data points elsewhere (these 5 items address the noise + the observability gap; if root cause is something else, it gets its own item)

## Acceptance criteria

1. All 5 items have a `### [ORCH] FIX-LANDED 2026-05-XX HH:MM ET — <gist>` post in this sprint's STATUS.md (to be authored at sprint open).
2. New tests for items 1, 2, 3 pass.
3. CHANGELOG.md `## [1.0.14]` block documents each item + cross-references to Brad's crash forensic + Sprint 59 idle-detection trigger.
4. `npm publish` wave: termdeck 1.0.13 → 1.0.14 + termdeck-stack 0.6.13 → 0.6.14 (audit-trail).

## Cross-references

- Brad's 2026-05-07 crash forensic: memory entry under `project=termdeck, source_type=bug_fix` dated 2026-05-07 ~16:35 ET.
- BACKLOG.md § P0 v1.0.14 hotfix bundle entry.
- Sprint 59 v1.0.13 ship: commit `e7cf46c`, `@jhizzard/termdeck@1.0.13`, `@jhizzard/termdeck-stack@0.6.13`.

## Sprint queue beyond Sprint 60

Priority-ordered for fresh-context handoff:

| # | Sprint | Effort | Trigger |
|---|---|---|---|
| 1 | **Sprint 60 / v1.0.14 hotfix bundle** (this doc) | 1.5-2h single-orchestrator | Brad crash + idle-detection |
| 2 | **Phase B for Sprint 58 catch-net** — operator-coordinated atomic task: create test Supabase project, apply 18 Mnestra + 3 Rumen migrations, add 10 GH Actions secrets, install canary row, verify reset script | ~15 min operator | Activates the catch-net's CI verification path |
| 3 | **Mnestra 0.4.7 RLS-on baseline migration** for fresh installs | 30 min | Cross-Mnestra hygiene; Brad's RLS sweep flagged the gap on 2026-05-06 |
| 4 | **Sprint 61+ install-polish** (proposed, not yet authored) — interactive setup wizard, OS detection (macOS vs Linux), schema-generation auto-detection | 1-2 days | Closes gap to "external-mass-ready" install path; 3+ tester distribution makes this urgent |
| 5 | **Sprint 51 cost-monitoring panel** (deferred vision) | 1 day | Per-agent subscription-vs-per-token billing exposure; reads adapter `costBand` field |
| 6 | **Vestigial mnestra_* tables on reference project + TermDeck historical internal-project-name scrub via filter-repo** | 1-2 hours destructive each | Hygiene; mirror backups make this safe |
| 7 | **Catch-net fixture refinement** (Sprint 58 deferred items) | 1-2 hours | Sprint 58 T4-CODEX flagged structural fixture flaws on Brad #1, #2, #5, #6, #7, #8 — refine after Phase B is wired |

The 3+1+1 pattern stays the default for any sprint that crosses 4+ independent surfaces. Single-orchestrator is right for tight bundles (this Sprint 60) or single-lane direct fixes (like Sprint 51.8 / 51.9).
