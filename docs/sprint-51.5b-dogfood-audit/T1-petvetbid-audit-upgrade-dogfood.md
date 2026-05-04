# Sprint 51.5b — T1 (Claude): petvetbid audit-upgrade dogfood + Sprint 51.6 smoke test absorbed

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T1):**

Run v1.0.1's audit-upgrade against Joshua's daily-driver Mnestra/Rumen project (`petvetbid`, ref `luvvbrpaopnblvxdxwzb`). Confirm it works end-to-end on real production infrastructure. **Absorbs the Sprint 51.6 smoke test** — verify the source_agent hypothesis (Codex's 2026-05-03 19:01 ET discovery) is the root cause of the memory_sessions ingestion break.

**Audit-only. No code changes. No commits. No version bumps.**

## Sequence (run in this exact order)

### 1. Substrate baseline (before any audit-upgrade)

```bash
date '+%Y-%m-%d %H:%M ET'

# Confirm package versions
npm view @jhizzard/termdeck version          # expect 1.0.1
npm view @jhizzard/mnestra version           # expect 0.4.1

# Confirm Codex's mig 015 fix held
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)
psql "$DATABASE_URL" -c "select column_name from information_schema.columns where table_name='memory_items' and column_name='source_agent'"
# Expected: 1 row showing source_agent (Codex applied mig 015 manually 2026-05-03 19:01 ET)

# Pre-test memory_sessions baseline
psql "$DATABASE_URL" -c "select count(*) as rows, max(ended_at) as last from memory_sessions"
# Expected: rows=289, last='2026-05-01 20:40:13.622+00' (per the P0 finding)

# Mnestra migration coverage probe (T1 audit-upgrade probe set)
psql "$DATABASE_URL" <<'SQL'
-- Probe 1: M-009 (memory_relationships.weight)
select 1 from information_schema.columns where table_name='memory_relationships' and column_name='weight';
-- Probe 2: M-010 (memory_recall_graph RPC)
select 1 from pg_proc where proname='memory_recall_graph';
-- Probe 3: M-013 (memory_items.reclassified_by)
select 1 from information_schema.columns where table_name='memory_items' and column_name='reclassified_by';
-- Probe 4: M-014 (explicit grants)
select has_table_privilege('service_role', 'memory_items', 'INSERT') as has_insert;
-- Probe 5: M-015 (memory_items.source_agent — already fixed by Codex)
select 1 from information_schema.columns where table_name='memory_items' and column_name='source_agent';
-- Probe 6: M-016 (mnestra_doctor_cron_runs RPC)
select 1 from pg_proc where proname='mnestra_doctor_cron_runs';
-- Probe 7: TD-002 + TD-003 (rumen-tick + graph-inference-tick crons)
select jobname from cron.job where jobname in ('rumen-tick','graph-inference-tick');
SQL
```

Document each probe result in your FINDING post — this is the "before" snapshot.

### 2. Run `termdeck init --mnestra` against petvetbid

```bash
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
termdeck init --mnestra
# Or if Joshua wants it scoped to petvetbid explicitly:
# termdeck init --mnestra --project-ref luvvbrpaopnblvxdxwzb
```

**Expected output (best case):** audit-upgrade reports "✓ install up to date" — Codex's manual mig 015 application + any other migrations that are already applied means there's nothing to do.

**Expected output (likely case):** audit-upgrade detects M-013 / M-014 / M-016 missing (Codex only applied 015), applies them in order, exits clean. Each `✓ applied <migration>` logged to stdout.

**Failure modes to watch for:**

- Audit-upgrade fails to load the bundled migration files (Class H — migration runner blindness): if it reports "bundled mnestra-migrations directory not found" or similar, the v1.0.1 release has a packaging gap. Document and fail the lane.
- Audit-upgrade applies a migration but it errors at SQL level (constraint violation, type mismatch): the migration itself has a bug or the DB state is inconsistent. Document the SQL error verbatim.
- Audit-upgrade reports "✓ install up to date" but a manual probe shows a column is still missing: the audit-upgrade probe set has a gap. Document which probe failed to detect.

### 3. Re-run probe block (the "after" snapshot)

```bash
psql "$DATABASE_URL" <<'SQL'
-- Same 7 probes as step 1
SQL
```

All probes should now return rows. Document any that still don't.

### 4. Sprint 51.6 smoke test — verify the hook hypothesis

```bash
# Pre-test memory_sessions row count
psql "$DATABASE_URL" -c "select count(*) from memory_sessions"
# Note the count.

# Open a fresh Claude Code session in any project (a quick 'memory_recall test' is enough),
# then /exit to fire the bundled session-end hook.

# Wait 5s for the hook to complete its async writes.
sleep 5

# Re-check memory_sessions row count
psql "$DATABASE_URL" -c "select count(*) from memory_sessions"
# Expected: count grew by 1.
```

**If the count grew:** the source_agent hypothesis is CONFIRMED. The hook was failing because the column didn't exist; now that it does, writes resume. Sprint 51.6 closes with a one-line "audit-upgrade fixed it; structurally prevented" note.

**If the count did NOT grow:** the source_agent hypothesis is DISPROVED. Sprint 51.6 needs the full investigation per the original BACKLOG plan: instrument the hook with a timestamp file, diff bundled vs installed, etc. Document this clearly in the FINDING post — the orchestrator will spin Sprint 51.6 out as originally scoped.

### 5. Run `termdeck init --rumen` against petvetbid

```bash
termdeck init --rumen
```

**Expected:** audit-upgrade detects any missing rumen migrations (002 / 003), applies templating (`<project-ref>` → `luvvbrpaopnblvxdxwzb`), exits clean. Same failure modes to watch for as step 2.

### 6. Deliberately broken project test

If T3 has provisioned a throwaway test project (`termdeck-dogfood-2026-05`), run the broken-project test there. If T3 hasn't yet, defer this step to the end of the lane and run it after T3 lands the throwaway.

```bash
# On the throwaway project:
psql "$TEST_DATABASE_URL" -c "alter table memory_relationships drop column weight"
psql "$TEST_DATABASE_URL" -c "select cron.unschedule('graph-inference-tick')"

termdeck init --rumen --project-ref <test-ref>
# Expected: audit-upgrade detects both gaps, applies M-009 + TD-003, exits clean.
```

## Acceptance criteria

1. **petvetbid audit-upgrade green.** Steps 2-3 complete with no errors. All 7 probes return rows after audit-upgrade runs.
2. **Sprint 51.6 hypothesis tested.** Step 4's row-count check is documented either way (confirmed = closes 51.6 inline; disproved = 51.6 spins out).
3. **Rumen audit-upgrade green.** Step 5 complete; templating applied correctly to mig 002 + 003 if they were missing.
4. **Broken-project audit recovery green.** Step 6 (when run) detects + applies M-009 + TD-003.
5. **No regressions.** Joshua's daily-driver workflows (Claude Code session ingestion, Mnestra MCP recall, Rumen cron) work normally after the dogfood pass.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5b dogfood audit petvetbid source_agent column drift Codex hypothesis memory_sessions ingestion break")
3. memory_recall(query="Sprint 51.6 smoking gun audit-upgrade probe set petvetbid")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (Class A + Class I + ledger #13 + ledger #14)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/audit-upgrade.js (the deliverable you're exercising)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/cli/src/init-mnestra.js + init-rumen.js (the wizard surfaces that call audit-upgrade)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. **Audit-only — no code edits, no commits.**
