# T1 — petvetbid post-v1.0.5 verification + idempotency probe

You are T1 in Sprint 51.5b (v1.0.5 dogfood audit, 3+1+1, audit-only).

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.8 Class N settings.json migration Sprint 52.1 match_memories do$$ guard v1.0.4 v1.0.5")`
2. `memory_recall(project="termdeck", query="Sprint 51.7 v1.0.3 wizard wire-up runHookRefresh init-mnestra petvetbid Phase B")`
3. `memory_recall(query="3+1+1 hardening rules checkpoint discipline post shape uniform idle-poll regex")`
4. Read `~/.claude/CLAUDE.md` — note the three hardening rules at the top.
5. Read `./CLAUDE.md`
6. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
7. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
8. Read this brief end-to-end.
9. Read `docs/INSTALLER-PITFALLS.md` ledger entries #15 (Class M, 51.6), #16 (Class N, 51.8), #17 (Class A, 52.1).

## Pre-sprint intel — the v1.0.x onion is closed

The full v1.0.x cascade landed in five sprints today:

- **v1.0.1 (Sprint 51.5):** mig sync + Vault UI removal + Edge Function templating + Rumen secrets shape.
- **v1.0.2 (Sprint 51.6):** Class M — bundled hook gained `postMemorySession()` write path; mig 017 reconciles canonical schema.
- **v1.0.3 (Sprint 51.7):** Wizard wire-up bug closed — `runHookRefresh()` runs UPSTREAM of DB phase; transcript metadata parser populates `started_at` / `duration_minutes` / `facts_extracted`; bundled hook v1 → v2.
- **v1.0.4 (Sprint 51.8):** Class N — settings.json wiring lockstep — `migrateSettingsJsonHookEntry()` runs alongside the file refresh; auto-migrates `Stop` → `SessionEnd` on every wizard pass; idempotent + atomic + best-effort backup.
- **v1.0.5 (Sprint 52.1):** Class A — match_memories signature-drift guard — `do $$` block in mig 001 drops all `public.match_memories` overloads regardless of arg list before `CREATE OR REPLACE`. Closes the only remaining v0.6.x→v1.0.x upgrade-path blocker.

**Joshua's petvetbid was freshly init'd at 14:26 ET against v1.0.5 with clean exit 0** (full log in PLANNING.md substrate). Hook v2 + settings.json SessionEnd-wired + 6,340 active memories.

T1's job: verify (a) the post-v1.0.5 petvetbid state is structurally correct, (b) re-runs are fully idempotent (every helper says "up-to-date" / "already wired" — none say "refreshed" / "migrated" / "installed"), (c) memory_sessions writes carry the v2 metadata, (d) the v1.0.x test suite holds. **You are NOT writing code. This is audit-only.**

## Probe sequence

Pre-state baseline:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Confirm v1.0.5 globally installed
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# expect: 1.0.5

# Pre-state hook stamp (should already be v2 from 14:26 ET wizard run)
grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js
# expect: line ~64 = "v2"

# Pre-state settings.json wiring (should already be SessionEnd from Sprint 51.8 install)
grep -E '"Stop"|"SessionEnd"' ~/.claude/settings.json
# expect: "SessionEnd": [...] only (NO "Stop" entry for memory-session-end.js)

# Pre-state memory_sessions baseline + metadata fill rate
psql "$DATABASE_URL" -c "select count(*) total, max(ended_at) last, count(*) filter (where started_at is not null) any_started, count(*) filter (where duration_minutes is not null) any_duration, count(*) filter (where facts_extracted > 0) any_facts from memory_sessions"
```

Phase A — `termdeck init --mnestra` re-run idempotency:

```bash
termdeck init --mnestra --yes 2>&1 | tee /tmp/sprint-51.5b-t1-init-mnestra.log
echo "exit=$?"
```

Verify in stdout (this is a re-run, NOT a fresh install — petvetbid was just init'd at 14:26 ET):
- `→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ up-to-date (v2)` — NOT `refreshed`. Bundled v2 == installed v2; the version-aware short-circuit at `init-mnestra.js:550` should fire.
- `→ Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ already wired (SessionEnd)` — NOT `migrated`. `_mergeSessionEndHookEntry` should detect the existing SessionEnd entry and short-circuit.
- `→ Applying migration 001_mnestra_tables.sql... ✓ (~50ms)` — fast on the second run because match_memories now matches the canonical signature; the do$$ loop iterates ONCE and drops the canonical version, then CREATE OR REPLACE recreates it. Should be sub-200ms total.
- Audit-upgrade: 6 probes all present.
- Exit 0.

Verify on disk:
- `ls ~/.claude/hooks/memory-session-end.js.bak.*` → exactly the backup files from earlier (no NEW backup written this run; v1.0.5 should not write a backup when up-to-date)
- `ls ~/.claude/settings.json.bak.*` → no NEW backup file from this run (already-wired path skips backup)
- `diff ~/.claude/hooks/memory-session-end.js /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js` → empty diff (byte-identical)

Phase B — fresh `/exit` writes a metadata-rich row:

Trigger a fresh Claude Code session end (any panel `/exit`). Wait 30s. Then:

```bash
psql "$DATABASE_URL" -c "select id, session_id, project, started_at, ended_at, duration_minutes, messages_count, facts_extracted, summary_len from memory_sessions where ended_at >= now() - interval '5 minutes' order by ended_at desc limit 3"
```

Verify the most recent row has:
- `started_at IS NOT NULL` (parser-derived from earliest transcript timestamp)
- `duration_minutes IS NOT NULL` (computed `(ended_at - started_at) / 60`)
- `facts_extracted >= 0` (count of `memory_remember` / `mcp__mnestra__memory_remember` / `mcp__memory__memory_remember` tool_use blocks)

Cross-check `memory_items.session_summary` row:

```bash
psql "$DATABASE_URL" -c "select source_agent, source_type, source_session_id from memory_items where source_type='session_summary' and created_at >= now() - interval '5 minutes' order by created_at desc limit 1"
```

Verify `source_agent='claude'` (mig 015 column, populated by v2 bundled hook).

**v1.0.4 invariant check:** there should be EXACTLY 1 `session_summary` row per session (not N — Brad's bug). Count `session_summary` rows per session_id over the past hour:

```bash
psql "$DATABASE_URL" -c "select source_session_id, count(*) from memory_items where source_type='session_summary' and created_at >= now() - interval '1 hour' group by source_session_id order by count(*) desc limit 5"
```

Verify every session_id has count = 1. If any has count > 1, that's a regression of Brad's Class N bug — post `### [T1] FINDING — Class N regression` immediately.

Phase C — Sprint 52.1 mig 001 do$$ guard idempotency:

The do$$ block iterates `pg_proc` for `public.match_memories` overloads, drops them, then `CREATE OR REPLACE` recreates the canonical signature. On any re-run after 14:26 ET, the loop finds exactly 1 overload (the one we just created), drops it, and recreates the same canonical. Verify:

```bash
psql "$DATABASE_URL" -c "select oid::regprocedure as sig, prosrc from pg_proc where proname='match_memories' and pronamespace = 'public'::regnamespace"
```

Verify exactly 1 row. The `sig` column should be `match_memories(vector,double precision,integer,text)`. The `prosrc` should be the canonical body (joins `memory_items m` with `embedding <=> query_embedding` ordering).

```bash
psql "$DATABASE_URL" -c "select count(*) from match_memories(array_fill(0::double precision, ARRAY[1536])::vector, 0.0, 5, null)"
```

Verify it returns a sane integer (likely 0 or small — the all-zero vector won't match much). Validates the function is callable end-to-end with the canonical signature.

Phase D — full hook + migration test matrix:

```bash
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
node --test \
  tests/init-mnestra-settings-migration.test.js \
  tests/init-mnestra-hook-refresh.test.js \
  tests/init-mnestra-cli-refresh.test.js \
  tests/stack-installer-hook-merge.test.js \
  tests/migration-001-shape.test.js \
  tests/project-taxonomy.test.js \
  2>&1 | tail -10
```

Verify ALL pass — expect ~145 tests / 145 pass / 0 fail (17 + 16 + 6 + 72 + 8 + 25 = 144, ±1 for any minor counts).

Phase E — deliberately-broken side branch:

Use the throwaway project T3 provisions (`termdeck-dogfood-2026-05-04`). Coordinate via STATUS.md with T3 — do NOT mutate petvetbid.

```bash
DOGFOOD_DB=$(... # get from T3's provisioned project; T3 will post the connection string in STATUS.md)
psql "$DOGFOOD_DB" -c "alter table memory_relationships drop column weight"
psql "$DOGFOOD_DB" -c "select cron.unschedule('graph-inference-tick')"
DATABASE_URL=$DOGFOOD_DB termdeck init --rumen 2>&1 | tee /tmp/sprint-51.5b-t1-broken.log
```

Verify audit-upgrade detects + applies M-009 + TD-003 cleanly (exit 0).

## Lane discipline + post shape

- **No code changes.** No version bumps. No CHANGELOG edits. No commits.
- **Post shape (CLAUDE.md hardening rule 2):** every STATUS.md post starts with `### [T1] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED.
- Post FINDING when probe sequence starts. Post DONE with PASS/FAIL verdict per phase. Cite file:line evidence + raw psql/stdout output verbatim.
- If any phase RED-fails, post `### [T1] DONE — RED on Phase X` with concrete failure mode; orchestrator triggers Sprint 51.9 hotfix.
- Stay in lane: do NOT touch the bundled hook, init-mnestra.js, mnestra doctor (T2's surface), or fresh-project setup (T3's surface).

## When you're done

Post `### [T1] DONE 2026-05-04 HH:MM ET — <PASS or RED on phase X>` with full evidence dump.

Begin.
