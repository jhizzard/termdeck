# T4 — Codex Auditor + Agent Integration Sweep — Cell Matrix

**Lane:** T4 — Codex auditor + agent integration
**Sprint:** 55 — Full multi-lane full stack sweep
**Date:** 2026-05-05 (Mode B, interactive morning)
**Boundary:** read-only verification only, except STATUS.md and this lane-owned matrix.

## Verification Summary

Focused test command:

```bash
node --test tests/per-agent-hook-trigger.test.js tests/status-merger.test.js tests/agent-adapter-parity.test.js tests/init-rumen-mcp-json.test.js tests/init-mnestra-settings-migration.test.js tests/stack-installer-hook-merge.test.js
```

Result: 148/148 pass.

Live read-only checks:
- `~/.claude/settings.json` has `hooks.SessionEnd` wired to `node ~/.claude/hooks/memory-session-end.js`.
- Installed hook has `@termdeck/stack-installer-hook v2`.
- `memory_sessions`: 313 rows, latest `ended_at=2026-05-05 16:04:07.761+00`.
- `memory_items` session summaries: 49 rows, latest `created_at=2026-05-05 16:04:08.512882+00`.
- `memory_items` session-summary source agents: `claude=44`, `codex=5`.
- `GET /api/agent-adapters` returns claude, codex, gemini, grok with cost bands.

## Cells

### Cell 1 — Claude Code SessionEnd writes memory_sessions + memory_items

Command / evidence:
- Static wiring: `~/.claude/settings.json:10-18`.
- Hook code: `~/.claude/hooks/memory-session-end.js:653-668` posts `memory_items`; `:674-735` posts `memory_sessions` with `on_conflict=session_id`; `:829-855` calls both.
- Live DB read shows recent rows in both tables.
- Test coverage: `processStdinPayload end-to-end: env present + good transcript -> embed + memory_items + memory_sessions fire`.

Expected: Claude SessionEnd fires once per session and writes one `session_summary` row plus one upserted `memory_sessions` row.

Observed: PASS by static wiring, focused tests, and live read-only DB evidence. No synthetic live write was performed in this lane.

Status: PASS

Ledger: existing Class M/N coverage retained.

### Cell 2 — Codex CLI session writes through TermDeck panel-close hook

Command / evidence:
- Server hook bridge: `packages/server/src/index.js:168-220` routes non-Claude panel close through the bundled hook and sets `source_agent`.
- PTY exit path: `packages/server/src/index.js:1017-1028`.
- Tests: `onPanelClose invokes hook with full payload (incl source_agent) for codex`.
- Live DB read: 5 `session_summary` rows have `source_agent='codex'`.

Expected: TermDeck-managed Codex panels write through the server-side panel-close hook. Standalone Codex outside TermDeck has no native Claude `SessionEnd` hook.

Observed: PASS for TermDeck-managed Codex sessions. Standalone-Codex auto-ingest remains out of scope unless Codex ships its own hook event.

Status: PASS

Ledger: no new class.

### Cell 3 — SessionEnd hook handles malformed or empty content gracefully

Command / evidence:
- Hook fail-soft contract: `~/.claude/hooks/memory-session-end.js:75-77`.
- Process path skips bad/missing input: `processStdinPayload` catches JSON parse failure, missing transcript, small transcript, and missing env without throwing.
- Focused tests cover missing transcript, small transcript, missing env, malformed/garbage parser inputs, failed OpenAI/PostgREST calls, and bad source agents.

Expected: malformed/empty hook input exits cleanly and does not block session close.

Observed: PASS in focused tests.

Status: PASS

Ledger: no new class.

### Cell 4 — settings.json wiring stays intact across init --mnestra reruns

Command / evidence:
- Current settings: `~/.claude/settings.json` has only the `SessionEnd` mapping for the TermDeck hook.
- Wizard migration code: `packages/cli/src/init-mnestra.js:638-780`.
- Focused tests: Stop-to-SessionEnd migration, already-wired no-op, idempotent second run, malformed JSON fail-soft, dry-run truthfulness, and parity with stack-installer merge primitive.

Expected: `init --mnestra` keeps the hook under `SessionEnd`, does not reintroduce `Stop`, and preserves unrelated settings.

Observed: PASS in installed settings and tests.

Status: PASS

Ledger: Class N coverage retained.

### Cell 5 — ~/.claude.json mcpServers entry preserved across init --rumen

Command / evidence:
- Actual top-level `~/.claude.json` `mcpServers` keys: adbliss, imessage, memory, mnestra, playwright, supabase.
- Preservation code: `packages/cli/src/init-rumen.js:859-899`; write path delegates through MCP config helpers to preserve non-target keys.
- Focused tests: `init-rumen-mcp-json.test.js` confirms placeholder replacement, sibling preservation, unrelated top-level key preservation, already-set behavior, no-file/no-entry behavior, and malformed JSON fail-soft.

Expected: init-rumen updates the Supabase MCP token only when needed and preserves all other MCP entries.

Observed: PASS.

Status: PASS

Ledger: Class D placeholder handling retained; no new class.

### Cell 6 — Multi-agent adapter registry exports Claude / Codex / Gemini / Grok

Command / evidence:
- Registry code: `packages/server/src/agent-adapters/index.js:15-27`.
- API projection: `GET /api/agent-adapters` returns all four adapters.
- Focused tests: `agent-adapter-parity.test.js` validates non-empty registry, unique names/sessionTypes, contract fields, matches behavior, parser shape, status shape, boot prompt, and `acceptsPaste`.

Expected: all four agent adapters are exported and visible to server/UI paths.

Observed: PASS.

Status: PASS

Ledger: no new class.

### Cell 7 — Cross-agent STATUS.md merger parses current lane shapes uniformly

Command / evidence:

```bash
node -e "const {mergeStatusLine}=require('./packages/server/src/status-merger'); for (const line of ['### [T4-CODEX] FINDING 2026-05-05 12:14 ET — lane briefs point at stale path','### [T1] DONE 2026-05-05 12:30 ET — done','[T2] FIX-PROPOSED 2026-05-05 12:31 ET — fix']) console.log(mergeStatusLine(line,{laneTag:'T4', now:new Date('2026-05-05T16:00:00')}));"
```

Expected: current hardening-rule shapes normalize or pass through.

Observed: FAIL. All three active Sprint 55 shapes return `null`. `status-merger.js` still recognizes the older `Tn: STATUS — ...` convention, while the sprint mandate is `### [Tn] STATUS-VERB YYYY-MM-DD HH:MM ET — gist`.

Status: FAIL / REOPEN

Ledger: likely Class N-adjacent lockstep drift between lane post-shape standard and parser contract.

### Cell 8 — Agent costBand declarations ready for Sprint 56 cost panel

Command / evidence:
- Adapter declarations: `packages/server/src/agent-adapters/claude.js:215`, `codex.js:278`, `gemini.js:260`, `grok.js:468`.
- API projection includes costBand for every adapter: claude pay-per-token, codex pay-per-token, gemini pay-per-token, grok subscription.
- Focused tests: `agent-adapter-parity.test.js` asserts adapter contract includes valid costBand shape.
- T2 matrix A.17/B.7 currently misstates Grok as pay-per-token; T4 STATUS finding requests T2/orchestrator correction before Sprint 56 planning consumes it.

Expected: every agent exposes a cost band for the future cost monitoring panel.

Observed: PASS.

Status: PASS

Ledger: no new class.

### Audit Addendum — T3 Bug B registry artifact drift

Command / evidence:
- `npm pack @jhizzard/rumen@0.5.2 --pack-destination /tmp/sprint55-t4-rumen-pack`
- `/tmp/sprint55-t4-rumen-pack/package/dist/relate.js:155-165` calls `memory_hybrid_search(...)` with 10 arguments, including `0.15::double precision` and `30.0::double precision`.
- Live DB signature probe returns one 8-argument `memory_hybrid_search(query_text text, query_embedding vector, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, filter_project text, filter_source_type text)`.
- Current local Rumen tree has already been rebuilt and shows the corrected 8-argument `dist/relate.js`, so the drift is the published npm artifact, not the current source tree.

Expected: published `@jhizzard/rumen@0.5.2` should match the source fix committed for the 8-argument function signature.

Observed: FAIL in the registry artifact. The deployed package can call a function signature that does not exist in the live database.

Status: ACCEPTED T3 BUG B / SHIP-BLOCKING until republish + redeploy

Ledger: Class K candidate, release-artifact drift between git source and npm `dist/`.

### Audit Addendum — Flashback negative feedback read-side gap

Command / evidence:
- `packages/client/public/app.js:699-709` sends modal feedback only to `console.log`; there is no durable endpoint for "Not relevant" or "This helped".
- `packages/client/public/app.js:653-659` posts toast dismissal to `/api/flashback/:id/dismissed`.
- `packages/server/src/flashback-diag.js:114-132` stores only `dismissed_at` on the fired event row.
- `packages/server/src/index.js:1058-1100` emits the next proactive hit with `const hit = memories[0]`; no read-side suppression checks dismissed/not-relevant history or repeated `top_hit_id`.

Expected: negative feedback on a Flashback hit should persist as user intent and suppress the same low-confidence hit on subsequent surfacing decisions.

Observed: FAIL. The product records only coarse fire/dismiss/click metrics and does not consult them before surfacing the next hit.

Status: ACCEPTED ORCHESTRATOR FINDING / SPRINT 56 FIX CANDIDATE

Ledger: Class I-adjacent silent feedback no-op; feature accepts negative feedback but read-side ignores it.

### Audit Addendum — Dashboard resize recovery

Command / evidence:
- Orchestrator live-observed dashboard grid remaining visually under-width after T2 rapid viewport resize sequence.
- `packages/client/public/app.js:4106` already wires `window.resize` to debounced `fitAll()`.
- `packages/client/public/app.js:454-467` also observes each terminal container with `ResizeObserver` and sends PTY resize frames.
- Existing code does not verify that `#termGrid` itself recovered to the usable viewport width after resize.

Expected: after rapid narrow-to-wide viewport changes, the dashboard grid and visible panels recover to fill the available viewport without manual resize.

Observed: ACCEPTED live observation; root cause not fully isolated. Source audit says the fix should be a post-resize layout-health assertion/forced reflow, not simply adding a second resize listener.

Status: ACCEPTED ORCHESTRATOR FINDING / NEEDS CONTROLLED BROWSER REGRESSION

Ledger: Class P/UX recovery candidate; responsive layout state changed but did not self-heal.

### Audit Addendum — Codename scrub hygiene

Command / evidence:
- At audit time, `docs/sprint-55-full-stack-sweep/T3-SWEEP-CELLS.md` Cell 15 listed an internal top-project shorthand in the `memory_status` evidence while the lane discipline section claimed codename scrub was maintained.
- Follow-up check shows Cell 15 now elides top-project names and states that the breakdown was omitted per codename scrub rule.

Expected: sprint artifacts intended for demo/client/investor reuse should use "daily-driver project" or omit project names/counts that are not needed for the diagnosis.

Observed: RESOLVED. The shorthand was minor but unnecessary; the matrix has been scrubbed.

Status: RESOLVED DOC HYGIENE FINDING

Ledger: no product bug; externally-facing artifact hygiene.

### Audit Addendum — T3 STATUS closeout shape

Command / evidence:
- `docs/sprint-55-full-stack-sweep/T3-SWEEP-CELLS.md` has a full sweep summary and lane discipline confirmation.
- `STATUS.md` contains T3 BOOT/FINDING/CHECKPOINT posts but no `### [T3] DONE ...` post.

Expected: each lane with a completed matrix should close with one canonical DONE post so humans and parsers can see lane state.

Observed: FINDING. Artifact is present; STATUS lane state is incomplete.

Status: STATUS HYGIENE FINDING / ORCHESTRATOR OR T3 TO POST DONE

Ledger: related to T4 Cell 7 status-shape/parser drift.

## T4 Tally

- PASS: 7
- FAIL / REOPEN: 1
- Accepted cross-lane blocking findings: T3 Bug A, T3 Bug B, T2 malformed JSON, T1 version flag, T1 doctor render inversion
- Accepted UI findings: Flashback negative feedback read-side gap, dashboard resize recovery gap
- Key finding: STATUS merger parser does not parse the current canonical lane-post shape.

## T4 Closeout

Verdict: YELLOW / REOPEN.

Sprint-close blockers:
- Rumen insight flatline requires both T3 fixes in one ship wave: picker window on `ended_at` / `COALESCE(started_at, ended_at)`, plus rebuilt and republished Rumen artifact with the 8-argument `memory_hybrid_search` call.
- STATUS merger needs parser support for the active `### [Tn] STATUS-VERB YYYY-MM-DD HH:MM ET — gist` shape before relying on dashboard status aggregation.

Sprint-close hygiene:
- T2 matrix A.17/B.7 should correct Grok cost band to `subscription`.
- T3 should add a canonical STATUS DONE post or orchestrator should synthesize one from `T3-SWEEP-CELLS.md`.

No version bumps, CHANGELOG edits, commits, or publish actions were performed by T4.
