# Sprint 81 — ORCH Resolutions (mid-flight adjudications)

ORCH-only file (no lane writes here → collision-free durable record). Lanes: re-read this after any compaction. Authored 2026-07-05 ~17:10 ET in response to T7/T8 baseline audit findings.

---

## R1 — Migration-bundle-sync (from T7 16:58, CONFIRMED) → owner: **T3**
**Problem (verified):** `packages/server/src/setup/mnestra-migrations/` stops at `022_source_agent_backfill.sql`. `packages/server/src/setup/migrations.js:196-202` (`listMnestraMigrations`) returns **bundled-FIRST** and only falls through to `node_modules/@jhizzard/mnestra` when the bundle is empty. Since the bundle is non-empty (008–022), `termdeck init --mnestra` applies ONLY 008–022 and **shadows** engram 023–029 (privacy-tags, `027` recall-telemetry, `028` capture-gates, `029` doctrine) — and would shadow Sprint 81's 030–032.
**Ruling:** Sync `engram/migrations/023..032` **byte-identical** into the bundled mirror + add matching `MIGRATION_PROBES` entries + a **drift test** asserting the bundle == engram HEAD (prevents silent re-drift). This retroactively closes the 023–029 gap.
**Severity:** NOT blocking Josh's daily-driver proof (ORCH live-applies) — but required for the DDL to reach real users (Brad, fresh installs). Prioritize **after** T3's two gates; it can become a fast-follow if the sprint runs long, but it's the correct home for it.
**Note:** if `023_privacy_tags_column.sql` is entangled with Brad's open PR #15, sync it too (it's already applied on the daily-driver) — coordinate wording, and scrub the internal project name/ref.

## R2 — G2 provenance is a TRUSTED PRODUCER, not tool args (from T7 17:02) → owners: **T1 (read) + T4 (produce)**
**Problem (correct):** threading optional `log_session_id`/`log_source_agent` through `mcp-server/index.ts` yields NULL provenance in practice — the MCP stdio server has no per-panel context, the `memory_recall` tool schema exposes no provenance args, and boot prompts call plain `memory_recall(project, query)`. Self-reported args would be blank and spoofable.
**Ruling — env-var contract (unspoofable):**
- **T4 (TermDeck, produce):** at agent spawn (`packages/server/src/agent-adapters/claude.js:~190-207`, `codex.js:~302-319`) export into the spawned agent's env: `MNESTRA_SESSION_ID=<panel session id>` and `MNESTRA_SOURCE_AGENT=<claude|codex|...>`. Reuse an existing TermDeck session-id env var if one already flows; else add these. TermDeck sets them, so the agent cannot forge another panel's id.
- **T1 (engram, read):** in the recall-log path (`recall.ts` / `recall_log.ts`), read `process.env.MNESTRA_SESSION_ID` / `MNESTRA_SOURCE_AGENT` as `source_session_id` / `source_agent` when the explicit `log_*` inputs are absent. Add a test: with the env set, a `memory_recall` writes a row carrying that non-null `source_session_id`.
**Why it matters:** this is THE enabler of the centerpiece — "which panel pulled which memory" is only provable if the producer is trusted.

## R3 — 030 `ingest_capture` must be ARBITER-FREE; index stays LAST (from T7 17:04) → owner: **T1 (RPC) + T3 (hook) + ORCH (index)**
**Problem (correct):** `028`'s `ingest_capture` pre_compact_snapshot branch uses `ON CONFLICT (source_session_id) WHERE (...)` (`028:325-345`) which REQUIRES a matching partial-unique arbiter — but that index is deferred (`028:212-219`). So the moment T3 switches the hook to `ingest_capture`, the RPC errors (no arbiter). "Index last" and "ON CONFLICT needs index" are circular.
**Ruling:** In migration **030**, T1 **redefines `ingest_capture`** so the pre_compact_snapshot branch is **arbiter-free** — explicit "SELECT active snapshot for session → UPDATE-in-place else INSERT" (under an advisory lock or `is_active`-guarded conditional), NOT `ON CONFLICT` on the deferred index. Then the ordering is non-circular:
1. collapse existing pre_compact dups keep-newest-per-session (reversible),
2. redefine `ingest_capture` arbiter-free (030),
3. **T3** switches `memory-pre-compact.js` → `/rpc/ingest_capture` (verify it round-trips — a URL change alone is NOT a valid T3 DONE),
4. **ORCH** creates the partial-unique index **LAST** as an integrity guard (now succeeds because the RPC keeps ≤1 active snapshot/session, and the old append-hook is gone).

## R4 — stale 028-hygiene test (from T7 16:59) → owner: **T1**
`tests/migration-028-hygiene.test.ts:76-90` requires `memory_items_precompact_session_uidx` inside 028, but 028 defers it. This is why the engram baseline is red before any Sprint 81 code. Update the assertion to expect the index **DEFERRED** in 028, and move the real index-present assertion to the new 030 test target. T1 cannot claim a green gate until this is reconciled.

## R5 — T2 `set_recall_boost` contract (T2 STATUS 17:01) → owner: **T1 confirms**
T2 posted the `set_recall_boost` RPC contract it needs from 032. T1: when you author 032, confirm/adjust that contract in STATUS so T2's `reinforce.ts` can target it. Column stays `memory_items.recall_boost numeric DEFAULT 1.0`, bounded no-op until populated.

---
### Assignment summary
- **T1:** R2 (env read) · R3 (arbiter-free ingest_capture in 030) · R4 (fix 028 test) · R5 (confirm 032 RPC). 031 still first.
- **T4:** R2 (env producer at spawn) — the centerpiece enabler; do alongside render.js while parked on 031.
- **T3:** R1 (bundle-sync + probes + drift test, after gates) · R3 (hook switch verified against redefined RPC).
- **T2/T5/T6/T7/T8:** unchanged; T7/T8 continue adversarial baseline.
