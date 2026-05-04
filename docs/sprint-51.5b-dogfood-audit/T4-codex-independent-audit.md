# T4 — Codex independent audit (Brad-shape reproduction + adversarial verification)

You are T4 (Codex auditor) in Sprint 51.5b (v1.0.5 dogfood audit, 3+1+1, audit-only).

**As of 2026-05-04 ~11:00 ET, Codex CLI HAS Mnestra MCP wired** (`codex mcp add mnestra` ran this morning per `~/.claude/projects/.../memory/reference_mcp_wiring.md`). You can call `memory_recall` directly. STATUS.md remains the canonical durable substrate.

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.8 Class N settings.json migration Sprint 52.1 match_memories do$$ guard v1.0.4 v1.0.5")` (verify MCP works; if recall fails, fallback to file-only substrate)
2. `memory_recall(query="Sprint 51.6 Sprint 51.7 Codex audit Class M Class A migration replay drift Brad jizzard-brain")`
3. Read `~/.claude/CLAUDE.md` (especially § "Three hardening rules" — checkpoint discipline applies to YOU)
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
6. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
7. Read this brief end-to-end.
8. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` (your prior audit work — durable record of what v1.0.3 fixed vs deferred).
9. Read `docs/INSTALLER-PITFALLS.md` ledger entries #15 (Class M, 51.6), #16 (Class N, 51.8), #17 (Class A, 52.1) — your closing brief on the v1.0.x onion.

## MANDATORY: Compaction-checkpoint discipline

Per CLAUDE.md hardening rule 1 (added 2026-05-04 after Codex compacted mid-Sprint-51.6 AND mid-Sprint-51.7): **post a `### [T4-CODEX] CHECKPOINT 2026-05-04 HH:MM ET` to STATUS.md at every phase boundary AND at least every 15 minutes of active work.**

Each CHECKPOINT post includes:
- (a) Phase number + name (e.g., "Phase 1 — Brad-shape fixture provisioning")
- (b) What's verified so far (file:line evidence)
- (c) What's pending
- (d) Most recent worker FIX-LANDED reference you were about to verify

Why: STATUS.md is your only durable substrate. On compaction, the orchestrator re-injects pointing at your most recent CHECKPOINT. Self-orientation post-compact: read your own most recent CHECKPOINT, continue from where pending becomes verified.

## Pre-sprint intel — the v1.0.x onion you've been auditing across three sprints

Sprint 51.6 closed Class M (bundled hook write-path absence). Sprint 51.7 closed wizard wire-up bug (Class M follow-up) + metadata completeness. Sprint 51.8 closed Class N (settings.json wiring lockstep — Brad's 14:00 ET repro). Sprint 52.1 closed Class A (match_memories signature-drift guard — your own 11:38 ET deferred side-finding from Sprint 51.7).

v1.0.5 ships:
- `runHookRefresh()` upstream of DB phase (51.7)
- `runSettingsJsonMigration()` immediately after (51.8) — auto-migrates Stop → SessionEnd
- mig 001 has a do$$ guard that drops all `public.match_memories` overloads regardless of arg list before CREATE OR REPLACE (52.1)
- Bundled hook v2 with transcript-derived metadata (51.7)

Joshua's petvetbid was init'd against v1.0.5 at 14:26 ET — clean exit 0, 17 migrations applied (mig 001 took 9.4s rebuilding match_memories), 6,340 active memories.

T4's job: **independently reproduce T1/T2/T3 findings using a Brad-shape fixture** (NOT petvetbid) AND specifically validate that the v1.0.5 do$$ guard handles a v0.6.x-era drift signature cleanly. Catch any over-claim before the orchestrator sends Brad the v1.0.5 WhatsApp.

## Phase 1 — Brad-shape fixture provisioning

Create a fixture that resembles Brad's jizzard-brain shape:
- Fresh tmp HOME with NO `~/.claude.json` (so no MCP wiring)
- A stale 508-LOC pre-Sprint-50 hook at `<tmpHOME>/.claude/hooks/memory-session-end.js` (use the bundled hook from a v0.10.0 git checkout OR craft a stale fixture that has TermDeck-managed markers but no v1/v2 stamp)
- A `<tmpHOME>/.claude/settings.json` with `hooks.Stop[0].hooks[0].command` pointing at the memory hook (Brad's pre-v1.0.4 wiring shape)
- A long-lived Supabase project shape: use T3's throwaway `termdeck-dogfood-2026-05-04` AFTER T3 finishes Phase E, OR provision your own. Critically: **manually pre-create a drift-shape `match_memories` function** in this fixture before running the wizard, so you can probe whether the do$$ guard drops it cleanly:

```sql
-- Run against your fixture DB BEFORE termdeck init --mnestra:
create or replace function match_memories (
  query_embedding   vector(1536),
  match_threshold   float,
  match_count       int,
  filter_project    text default null
)
returns table (
  id          uuid,
  content     text,
  metadata    jsonb,
  source_type text,
  category    text,
  project     text,
  created_at  timestamptz,
  similarity  float
)
language sql stable
as $$ select null::uuid, null::text, null::jsonb, null::text, null::text, null::text, null::timestamptz, null::float where false $$;
```

Note the column order — `metadata` BEFORE `source_type`, plus a trailing `created_at`. This is the v0.6.x-era drift shape Joshua's petvetbid had (and Brad's jizzard-brain has).

Post `### [T4-CODEX] CHECKPOINT — Phase 1 fixture ready` when complete.

## Phase 2 — Independent reproduction of T1's claims (do$$ guard verification)

Run the canonical user path against your Brad-shape fixture:

```bash
HOME=$T4_FIXTURE_HOME DATABASE_URL=$BRAD_SHAPE_DB termdeck init --mnestra --yes 2>&1 | tee /tmp/t4-codex-init-mnestra.log
echo "exit=$?"
```

Independently verify (do NOT trust T1's stdout):
- `→ Refreshing... ✓ refreshed v? → v2 (backup: ...)` appears (the stale 508-LOC fixture had no v stamp; if it has TermDeck-managed markers it gets refreshed; otherwise `custom-hook-preserved`)
- `→ Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ migrated Stop → SessionEnd (was firing on every turn; backup: ...)` — Brad's pre-v1.0.4 wiring shape gets migrated on first run
- Architectural ordering: refresh + reconcile BOTH appear BEFORE `→ Connecting to Supabase...`
- `→ Applying migration 001_mnestra_tables.sql... ✓ (~9000-10000ms)` — slow because the do$$ guard finds your pre-created drift signature, drops it, and recreates the canonical. Time on this step is the SMOKING GUN that the do$$ guard fired (vs ~50ms on a true fresh DB or ~50ms on a re-run).
- Exit 0 (NOT 5 — that was the pre-v1.0.5 failure mode for this exact drift shape)

Probe the recreated function:

```bash
psql "$BRAD_SHAPE_DB" -c "select oid::regprocedure as sig from pg_proc where proname='match_memories' and pronamespace='public'::regnamespace"
# expect: exactly 1 row with sig = match_memories(vector,double precision,integer,text)

psql "$BRAD_SHAPE_DB" -c "
  select column_name, ordinal_position 
  from information_schema.routines r
  join information_schema.parameters p on p.specific_name = r.specific_name
  where r.routine_name='match_memories' and parameter_mode='OUT'
  order by ordinal_position"
# expect: id, content, source_type, category, project, metadata, similarity (canonical order)
# NOT the v0.6.x drift order with metadata before source_type
```

Cross-check: if exit 0 + canonical signature in pg_proc + 9-10s mig 001 timing, T1's claim that v1.0.5 closes the v0.6.x→v1.0.x upgrade path is VERIFIED. Document the visible mig 001 timing as evidence.

Verify settings.json migration:

```bash
cat $T4_FIXTURE_HOME/.claude/settings.json
grep -E '"Stop"|"SessionEnd"' $T4_FIXTURE_HOME/.claude/settings.json
# expect: SessionEnd entry exists; no Stop entry for memory-session-end.js
ls $T4_FIXTURE_HOME/.claude/settings.json.bak.*
# expect: at least one timestamped backup with the original Stop wiring shape
```

Post `### [T4-CODEX] AUDIT — T1 claims (do$$ guard + Stop→SessionEnd + wire-up + metadata) <PASS|FAIL>` with file:line evidence.

Post `### [T4-CODEX] CHECKPOINT — Phase 2 complete`.

## Phase 3 — Audit T2's metadata claims

After T2 posts DONE (poll with tolerant regex `^(### )?\[T2\] DONE\b`), independently verify the parser claims using YOUR fixture:

- Trigger a `/exit` against the Brad-shape fixture (or use a synthetic transcript from `~/.claude/projects/`)
- Query the resulting `memory_sessions` row
- Verify `started_at IS NOT NULL`, `duration_minutes > 0`, `facts_extracted >= 0`
- Cross-check `facts_extracted` against manual count of all three tool_use names in the transcript
- Edge case: a transcript with ONLY `mcp__memory__memory_remember` (legacy prefix) — verify count is correct (your 11:09 ET catch from Sprint 51.7)
- Edge case: empty transcript — verify NULL/NULL/0
- Edge case: malformed JSONL line — verify graceful skip
- **Sprint 51.8 invariant:** EXACTLY 1 `session_summary` row in `memory_items` per session_id (count > 1 is a Class N regression).

Post `### [T4-CODEX] AUDIT — T2 parser + Class N invariant <PASS|FAIL>` with file:line evidence.

Post `### [T4-CODEX] CHECKPOINT — Phase 3 complete`.

## Phase 4 — Audit T3's fresh-project + Brad outreach claims

After T3 posts DONE with their Brad WhatsApp draft (poll with tolerant regex):

- Verify T3's `init --mnestra` on tmp HOME actually wrote a `v2` hook (status = `installed`, not `refreshed`) AND a SessionEnd entry in settings.json (status = `installed`, not `migrated-from-stop`) — independently re-run the test from T3's stdout sample
- Verify the GRAPH_LLM_CLASSIFY Y-path landed both secrets (independently query `supabase secrets list`)
- Verify the Vault deeplink is correctly URL-encoded — paste it into a clean browser window, confirm SQL Editor opens with vault.create_secret(...) pre-filled (NOT truncated, NOT broken on `&` characters)
- **Audit T3's WhatsApp draft for accuracy.** Does it claim things dogfood actually verified? Does it accurately represent the v1.0.5 do$$ guard story (mig 001 will run slow on Brad's first run as the guard rebuilds match_memories — ~9s; subsequent runs are sub-200ms)? Does it correctly note that Brad must upgrade through v1.0.4 → v1.0.5 (or directly install v1.0.5) to clear the migration-001 exit-5 he'd have hit on v1.0.4?

If T3's draft is accurate: post `### [T4-CODEX] AUDIT — T3 + Brad draft PASS, orchestrator green to send`.
If T3 over-claims: post `### [T4-CODEX] AUDIT — T3 over-claim on <X>, REOPEN T3 for redraft`.

Post `### [T4-CODEX] CHECKPOINT — Phase 4 complete`.

## Phase 5 — Final disposition

If all phases PASS: `### [T4-CODEX] DONE — VERIFIED 2026-05-04 HH:MM ET — sprint clean, v1.0.x onion fully closed, orchestrator green to send Brad`.

If any phase FAILS: `### [T4-CODEX] DONE — REOPEN T<n> 2026-05-04 HH:MM ET` with concrete fix recommendation. Orchestrator triggers Sprint 51.9 hotfix.

## Lane discipline + post shape

- You do NOT write production code. You write probes, you write STATUS.md posts.
- You do NOT bump versions, edit CHANGELOG, commit, or send Brad anything.
- **Post shape:** every STATUS.md post starts with `### [T4-CODEX] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED (uniform shape across all lanes per CLAUDE.md hardening rule 2).
- **CHECKPOINT discipline (rule 1):** every 15 min OR at every phase boundary. Non-negotiable. Pre-empt compaction by posting state to STATUS.md.
- Verbose STATUS.md posts. Quote stdout/stderr verbatim. Cite file:line on every claim.

## When you're done

Post `### [T4-CODEX] DONE — VERIFIED` (sprint clean) or `### [T4-CODEX] DONE — REOPEN T<n>` (specific lane has unresolved gap, with concrete recommendation).

Begin.
