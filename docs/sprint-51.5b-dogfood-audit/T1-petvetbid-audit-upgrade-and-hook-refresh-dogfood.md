# T1 — petvetbid audit-upgrade + hook-refresh dogfood

You are T1 in Sprint 51.5b (v1.0.3 dogfood audit, 3+1+1, audit-only).

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.7 v1.0.3 wizard wire-up runHookRefresh init-mnestra match_memories migration drift")`
2. `memory_recall(query="Sprint 51.6 Class M memory_sessions bundled hook v1 v2 stamp Phase B")`
3. Read `~/.claude/CLAUDE.md` (note new § "Three hardening rules" — checkpoint discipline + post-shape uniformity)
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
6. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
7. Read this brief end-to-end.
8. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` lines covering [T1] FIX-LANDED + [T4-CODEX] VERIFY (durable record of what v1.0.3 actually fixes).

## Pre-sprint intel

v1.0.3 (Sprint 51.7) shipped two structural fixes T1 must verify on Joshua's daily-driver `petvetbid`:

- **Wizard wire-up:** `runHookRefresh()` now runs at `init-mnestra.js:716`, BEFORE the DB phase. Sprint 51.6's wire-up bug — `applyMigrations()` throwing on mig-001 return-type drift stranded refresh — is closed by architectural decoupling. Joshua's hook should refresh from v1 (manually-applied at Sprint 51.6 21:19 ET) to v2 on next `init --mnestra`.
- **Metadata population:** new memory_sessions rows from the v2 hook carry `started_at` / `duration_minutes` / `facts_extracted` parsed from transcript JSONL, where v1's hook wrote NULL/NULL/0. Parser counts BOTH `mcp__mnestra__memory_remember` AND legacy `mcp__memory__memory_remember` tool_use blocks (Codex 11:09 ET catch).

T1's job: confirm these promises hold against real production infrastructure on petvetbid AND that audit-upgrade still detects deliberately-broken installs idempotently. **You are NOT writing code. This is audit-only.**

## Probe sequence

Pre-state baseline:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Confirm v1.0.3 globally installed
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# expect: 1.0.3

# Pre-state hook stamp + LOC + content
grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js
wc -l ~/.claude/hooks/memory-session-end.js
# expect (pre-Sprint-51.5b-T1): line ~54 = "v1", LOC ~740

# Pre-state memory_sessions baseline
psql "$DATABASE_URL" -c "select count(*) total, max(ended_at) last, count(*) filter (where started_at is not null) any_started, count(*) filter (where duration_minutes is not null) any_duration, count(*) filter (where facts_extracted > 0) any_facts from memory_sessions"
# capture totals; expect 290+ from Sprint 51.6 Phase B
```

Phase A — `termdeck init --mnestra` against petvetbid:

```bash
termdeck init --mnestra 2>&1 | tee /tmp/sprint-51.5b-t1-init-mnestra.log
echo "exit=$?"
```

Verify in stdout:
- "→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ refreshed v1 → v2 (backup: ...)" appears BEFORE "→ Connecting to Supabase..."
- audit-upgrade probes 10 items, 0 applied (mig 017 already healed in 51.6), 10 skipped — OR detects+applies any mig drift idempotently
- Exit 0 (NOT 5 — that was the Sprint 51.6 Phase B failure mode)

Verify on disk:
- `grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js` → line ~54 = `v2`
- `ls ~/.claude/hooks/memory-session-end.js.bak.*` → fresh backup file with today's timestamp
- `diff ~/.claude/hooks/memory-session-end.js /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js` → empty diff (byte-identical)

Phase B — fresh `/exit` writes a metadata-rich row:

Trigger a fresh Claude Code session end (any panel `/exit`). Wait 30s. Then:

```bash
psql "$DATABASE_URL" -c "select id, session_id, project, started_at, ended_at, duration_minutes, messages_count, facts_extracted, summary_len from memory_sessions where ended_at >= now() - interval '5 minutes' order by ended_at desc limit 3"
```

Verify the most recent row has:
- `started_at IS NOT NULL` (parser-derived from earliest transcript timestamp)
- `duration_minutes IS NOT NULL` (computed `(ended_at - started_at) / 60000`)
- `facts_extracted >= 0` (count of `memory_remember` / `mcp__mnestra__memory_remember` / `mcp__memory__memory_remember` tool_use blocks)

Cross-check `memory_items.session_summary` row:

```bash
psql "$DATABASE_URL" -c "select source_agent, source_type, source_session_id from memory_items where source_type='session_summary' and created_at >= now() - interval '5 minutes' order by created_at desc limit 1"
```

Verify `source_agent='claude'` (mig 015 column, populated by v2 bundled hook).

Phase C — re-run `init --mnestra` is idempotent:

```bash
termdeck init --mnestra 2>&1 | tee /tmp/sprint-51.5b-t1-init-mnestra-rerun.log
```

Verify "→ Refreshing... ✓ up-to-date (v2)" appears (NOT `refreshed`). No new backup file written.

Phase D — `tests/project-taxonomy.test.js` regression check:

```bash
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
node --test --test-reporter=tap tests/project-taxonomy.test.js 2>&1 | tail -10
```

Verify 25/25 pass (was 25/25 post-Sprint-51.6-manual-refresh; should remain 25/25 post-Sprint-51.7-wizard-refresh).

Phase E — deliberately-broken side branch:

Use the throwaway project T3 provisions (`termdeck-dogfood-2026-05-04`) — do NOT mutate petvetbid's schema. Coordinate via STATUS.md with T3.

```bash
DOGFOOD_DB=$(... # get from T3's provisioned project)
psql "$DOGFOOD_DB" -c "alter table memory_relationships drop column weight"
psql "$DOGFOOD_DB" -c "select cron.unschedule('graph-inference-tick')"
DATABASE_URL=$DOGFOOD_DB termdeck init --rumen 2>&1 | tee /tmp/sprint-51.5b-t1-broken.log
```

Verify audit-upgrade detects + applies M-009 + TD-003 cleanly (exit 0).

## Lane discipline + post shape

- **No code changes.** No version bumps. No CHANGELOG edits. No commits.
- **Post shape (NEW per CLAUDE.md hardening rule 2):** every STATUS.md post starts with `### [T1] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED — uniform shape across Claude + Codex lanes prevents the regex-mismatch idle-stall that hit Sprint 51.7 T3.
- Post FINDING when probe sequence starts. Post DONE with PASS/FAIL verdict per acceptance item (#1, #2, #3 from PLANNING.md). Cite file:line evidence + raw psql/stdout output verbatim.
- If any phase RED-fails, post `### [T1] DONE — RED on Phase X` with concrete failure mode; orchestrator triggers Sprint 51.8 hotfix.
- Stay in lane: do NOT touch the bundled hook, init-mnestra.js, mnestra doctor (T2's surface), or fresh-project setup (T3's surface).

## When you're done

Post `### [T1] DONE 2026-05-04 HH:MM ET — <PASS or RED on phase X>` with full evidence dump.

Begin.
