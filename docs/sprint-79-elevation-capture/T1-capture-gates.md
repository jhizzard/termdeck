# T1 — Capture gates (engram / Mnestra)

**cwd:** `~/Documents/Graciella/engram` · **Model:** Claude Sonnet · **Repo:** engram (native TS — no-TS lock is termdeck-only).

You own the **capture side** of the elevation loop: make repeated kitchen lessons *reinforce* instead of clobber-or-duplicate, and put real provenance on the deliberate write path. Your output is the clean signal T2's doctrine-scan clusters over.

## Boot (do all of this first)
1. `memory_recall(project="termdeck", query="Sprint 79 capture gates reinforcement dedup provenance content_hash granularity")`
2. `memory_recall(query="Mnestra remember.ts dedup band clobber reinforcement_count")`
3. Read `~/.claude/CLAUDE.md` (§ RLS hygiene — five gates) + engram `./CLAUDE.md` if present.
4. Read `docs/sprint-79-elevation-capture/PLANNING.md` + `DISPATCH-GUIDE.md` §2 + §3-T1 + `../sprint-78-memory-doctrine-loop/ULTRAPLAN-2026-06-12.md` §3.2.
5. **Re-verify your anchors** (all predate Sprint 78; the DISPATCH-GUIDE re-anchored them 06-13 but re-confirm): `git checkout main && git pull`, then branch `sprint-79-capture-gates`. **Working tree is DIRTY** (untracked `024_email_assistant_recall.sql` + `docs/sprint-privacy-tags/`) — leave them untracked or stash-aware-branch; they do NOT collide with your 028.

## Migration = `028_capture_gates.sql` (VERIFIED next-free on disk 2026-07-05)
Add to `memory_items`, **all `ADD COLUMN IF NOT EXISTS`**:
- `reinforcement_count int DEFAULT 1`, `sprint_ref text`, `rule_ref text` — these are genuinely new.
- **`content_hash` ALREADY EXISTS LIVE** (generated `md5(content)`, applied out-of-band, in no on-disk migration). **Verify first** (`\d memory_items`); only `ADD COLUMN IF NOT EXISTS content_hash ... GENERATED ...` if somehow absent — **re-declaring a generated column ERRORS.**
- **MUST NOT re-add `recall_count` / `last_recalled_at`** — owned by 027.
- Partial-unique-active index on `content_hash` (no existing unique index on memory_items — clean).
- **56-group dup backfill collapse:** keep-oldest, sum `reinforcement_count`, supersede — **reversible, never DELETE** (mark superseded / is_active=false).
- **`ingest_capture(jsonb)` RPC** — both ON-CONFLICT paths: `ON CONFLICT (content_hash) WHERE is_active DO NOTHING` (hook idempotency) + `(source_session_id) WHERE source_type='pre_compact_snapshot' DO UPDATE` (rolling snapshots). **Five RLS gates** — copy 027's hard-failing receipt DO-block pattern (`027_recall_telemetry.sql` ~L476-487): SECURITY DEFINER, `SET search_path=public,pg_catalog`, `REVOKE EXECUTE FROM PUBLIC`, `GRANT service_role`, `ENABLE ROW LEVEL SECURITY` on any new table.

## Dedup rewrite — `src/remember.ts` (~L88-134; re-anchor, file is ~151 lines)
- The 0.88–0.95 band **merges, does not clobber**: shallow-merge metadata (NO metadata loss), `reinforcement_count++`, append `{ts, source_agent, sprint_ref}` to `metadata.reinforcements[]` (**cap 10**), record rejected-restatement hash+length for audit.
- **Keep-canonical unless `refresh:true`** (auto-captured restatements are systematically more verbose — longer-wins lets noise overwrite signal).
- Cross-project **second dedup pass** for kitchen-granularity rows (same lesson currently coexists per-project forever).
- Preserve the `'inserted'|'updated'|'skipped'` `RememberResult` union. On RPC error keep the silent-disable path but stamp `dedup_bypassed`.

## MCP provenance expansion — `mcp-server/index.ts` (schema ~L224-243, handler ~L245-252)
- Thread `metadata` + `source_agent` (**already on `RememberInput`**, `types.ts` ~L81/93 — just expose in the tool inputSchema + handler) + net-new `sprint_ref / rule_ref / supersedes / force`.
- Same expansion on the **webhook ingest path** (`webhook-server.ts`) for parity.
- `rule_ref` auto-creates an `'amends-rule'` `memory_link` edge (`relationships.ts`).

## New consumers (mandatory same-sprint — an unread label is pure fatigue cost)
- `src/granularity.ts` — regex-tier classifier (Haiku tier-2 **OFF**, env-gated). Echo includes matched markers; recipe echo fires only above marker-DENSITY absent kitchen markers; `force:true` rate tracked.
- **`recall.ts` TYPE_RANK downweight** for `granularity='recipe'` — tiebreaker in `smartRank` (~L74, after the TYPE_RANK/importance compare). This is the consumer that makes the classifier real.
- `summarize.ts` importance floor — default `'minor'` = **no-op** this sprint (droppedCount surfaced only).
- `mnestra_capture_health` view — `WITH (security_invoker=true)`.

## Acceptance (behavior, not file-existence)
- Supabase advisors 0011/0013 **clean** on 028 (run against the live store).
- Writing a near-dup of a known kitchen row → **reinforcement_count increment, NOT a new row, NOT content loss** (live dry-run).
- MCP write with `source_agent='orchestrator'` lands **non-NULL** provenance.
- Rumen's next ticks **don't flatline** post-migration (`insights_generated` path intact).
- Backfill is reversible (show the supersede, not a DELETE).

## Seams
- **028/029 split with T3** — you take 028, T3 takes 029 (the ×1.5 doctrine boost). Post `HANDOFF-ACK` confirming.
- Post `### [T1] VERB 2026-07-05 HH:MM ET — gist` to STATUS.md. No commits / version bumps / CHANGELOG — ORCH closes out.
