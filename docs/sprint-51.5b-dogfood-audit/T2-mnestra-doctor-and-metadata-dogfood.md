# T2 — mnestra doctor + metadata completeness dogfood

You are T2 in Sprint 51.5b (v1.0.3 dogfood audit, 3+1+1, audit-only).

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.5 mnestra doctor cron-all-zeros schema-drift MCP path parity v1.0.1")`
2. `memory_recall(query="Sprint 51.7 transcript metadata parser facts_extracted started_at duration_minutes")`
3. Read `~/.claude/CLAUDE.md` (note new § "Three hardening rules")
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
6. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
7. Read this brief end-to-end.
8. Read `packages/cli/src/mnestra-doctor.js` (the v1.0.1 deliverable you're exercising — Sprint 51.5 T2 wrote it).

## Pre-sprint intel

`mnestra doctor` shipped in v1.0.1 (Sprint 51.5 T2). It probes for:
- Schema drift (memory_relationships.weight, memory_items.source_agent, mig 016's SECURITY DEFINER wrappers)
- Cron-all-zeros (rumen-tick / graph-inference-tick: ≥6 consecutive ticks with `sessions_processed=0`)
- MCP path parity (~/.claude.json vs ~/Library/Application Support/Claude/claude_desktop_config.json)
- Vault secret presence (rumen_service_role_key, graph_inference_service_role_key)

T2's job in 51.5b: verify the doctor probes are accurate against Joshua's POST-v1.0.3 petvetbid AND surface the new metadata-completeness verification (Sprint 51.7 T2's parser work). **Audit-only.**

## Probe sequence

Pre-state:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)
mnestra --version  # expect 0.4.2 (unchanged from Sprint 51.6)
which mnestra && head -3 $(readlink $(which mnestra) || which mnestra)
```

Phase A — `mnestra doctor` against petvetbid (post-T1-refresh):

**Coordinate via STATUS.md:** wait until T1 posts `### [T1] DONE` confirming `init --mnestra` ran successfully. THEN run:

```bash
mnestra doctor 2>&1 | tee /tmp/sprint-51.5b-t2-doctor-petvetbid.log
echo "exit=$?"
```

Document:
- Schema-drift probe: should show NOTHING (audit-upgrade healed it). If RED, that's a T1-territory regression — post `### [T2] CROSS-LANE` and let T4-CODEX adjudicate.
- Cron-all-zeros probe: depends on Rumen recovery state (see Phase D below). May still show YELLOW or RED if rumen-tick hasn't caught up.
- MCP path parity: should identify `~/.claude.json` as canonical. **NEW for 51.5b:** the doctor should ALSO see the codex/gemini/grok mnestra entries wired this morning (see `~/.claude/projects/.../memory/reference_mcp_wiring.md`). If doctor only knows about Claude, that's a Sprint 52+ feature gap to flag — not a 51.5b RED.
- Vault secrets: both keys present.

Phase B — `mnestra doctor` against deliberately-broken project:

Use T3's throwaway `termdeck-dogfood-2026-05-04`. Coordinate via STATUS.md.

```bash
DOGFOOD_DB=$(... # get from T3)
psql "$DOGFOOD_DB" -c "alter table memory_relationships drop column weight"
psql "$DOGFOOD_DB" -c "select cron.unschedule('graph-inference-tick')"
DATABASE_URL=$DOGFOOD_DB mnestra doctor 2>&1 | tee /tmp/sprint-51.5b-t2-doctor-broken.log
```

Verify TWO RED items with specific recommendations:
- "missing column memory_relationships.weight — apply mig M-009"
- "graph-inference-tick cron not scheduled — apply TD-003 (re-run `termdeck init --rumen`)"

Phase C — false-positive guard (cold-boot tolerance):

Use a brand-new fresh project (also T3's throwaway, but BEFORE T3 mutates it for Phase B above — or coordinate timing).

```bash
DATABASE_URL=$FRESH_DB mnestra doctor 2>&1 | tee /tmp/sprint-51.5b-t2-doctor-fresh.log
```

Verify cron-all-zeros probe is GREEN or YELLOW (NOT RED) — fresh project has < 6 cron ticks accumulated, threshold should not fire.

Phase D — Sprint 51.7 metadata verification (NEW for 51.5b):

After T1 confirms hook v2 landed AND a fresh `/exit` triggered:

```bash
psql "$DATABASE_URL" -c "select 
  count(*) total_v2_rows,
  count(*) filter (where started_at is not null) with_started,
  count(*) filter (where duration_minutes is not null) with_duration,
  count(*) filter (where facts_extracted > 0) with_facts,
  avg(facts_extracted) filter (where facts_extracted > 0) avg_facts,
  max(duration_minutes) max_dur_min
  from memory_sessions 
  where ended_at >= '2026-05-04 11:00 ET'"
```

Verify:
- `total_v2_rows` ≥ 1 (T1's fresh /exit landed at minimum 1 row)
- `with_started == total_v2_rows` (every v2 row has started_at populated)
- `with_duration == total_v2_rows` (every v2 row has duration_minutes)
- `with_facts >= 1` (at least one row has counted facts; if zero, parser may be undercounting — investigate which tool_use names appeared)
- `avg_facts` and `max_dur_min` are sane (not 9999)

Cross-check parser correctness against actual transcript:

```bash
# Pick one of T1's recent sessions; find the transcript file
RECENT=$(psql "$DATABASE_URL" -t -c "select source_session_id from memory_items where source_type='session_summary' and created_at >= '2026-05-04 11:00 ET' order by created_at desc limit 1" | xargs)
TRANSCRIPT=$(find ~/.claude/projects -name "${RECENT}.jsonl" 2>/dev/null | head -1)
# Manual count of memory_remember tool_use blocks
grep -oE '"name":"(mcp__mnestra__memory_remember|mcp__memory__memory_remember|memory_remember)"' "$TRANSCRIPT" | wc -l
# Compare against facts_extracted in the corresponding memory_sessions row
psql "$DATABASE_URL" -c "select facts_extracted from memory_sessions where session_id='${RECENT}'"
```

Verify the two counts match. If they DON'T, parser has a bug — post `### [T2] FINDING — parser undercount`.

Phase E — Rumen recovery delta (Joshua's 233-insights flatline check):

```bash
psql "$DATABASE_URL" -c "select count(*) total, max(created_at) last_insight from rumen_insights"
```

Compare against the pre-sprint baseline (PLANNING.md substrate probe). If `last_insight` is NEWER than the pre-sprint baseline, Rumen has recovered. If still flat, post `### [T2] FINDING — Rumen not yet recovering` with `rumen_jobs` last-10-rows inspection. **Not a sprint blocker** — Rumen has 15-min tick cadence and may need an hour to fully catch up; just document.

## Lane discipline + post shape

- **No code changes.** No version bumps. No CHANGELOG edits. No commits.
- **Post shape:** every STATUS.md post starts with `### [T2] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED.
- Post FINDING when probe sequence starts; one DONE per phase OR a single consolidated DONE at the end. Cite file:line evidence + raw psql output.
- Stay in lane: do NOT touch the wizard (T1's surface), do NOT provision the throwaway project (T3 owns), do NOT draft Brad outreach (T3 owns).

## When you're done

Post `### [T2] DONE 2026-05-04 HH:MM ET — <PASS or RED on phase X>` with full evidence dump.

Begin.
