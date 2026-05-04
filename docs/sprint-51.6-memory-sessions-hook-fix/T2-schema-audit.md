# Sprint 51.6 — T2 (Claude): memory_sessions schema audit + manual SQL reproduction

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T2):**

Determine whether the bundled hook's memory_sessions INSERT can succeed against `petvetbid`'s actual table schema. Run the EXACT INSERT statement the hook uses with verbose error output. If it fails, capture the failure mode for T3.

## Steps

1. **Probe `memory_sessions` schema on petvetbid.** Use the autoMode-allowed psql pattern:
   ```bash
   DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)
   psql "$DATABASE_URL" <<'SQL'
   \d memory_sessions
   SQL
   ```
   Capture column names, types, NULL constraints, defaults, foreign keys.

2. **Read the bundled hook's INSERT statement.** The hook is at `packages/stack-installer/assets/hooks/memory-session-end.js`. Find the SQL or REST call that writes to `memory_sessions`. Capture exact column list + value shapes.

3. **Cross-check.** For each column the hook writes:
   - Does it exist in the actual schema?
   - Is its type compatible with what the hook sends (UUID vs text, timestamp vs ISO string, etc)?
   - Are there NOT NULL columns the hook isn't populating?
   - Are there generated columns the hook is trying to populate (a write-side error)?

4. **Reproduce manually.** Run the hook's exact INSERT via psql with verbose errors:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
   set client_min_messages = debug2;
   -- Hook's exact INSERT, with placeholder values that match what the hook would send.
   -- If the hook posts via Supabase REST instead of SQL, simulate the equivalent INSERT.
   INSERT INTO memory_sessions (...) VALUES (...) RETURNING id;
   SQL
   ```
   Capture the full error output.

5. **Compare against successful Sprint 47 writes.** The 289 existing rows in memory_sessions are from Sprint 47 close (last 2026-05-01). Look at the most recent successful row:
   ```sql
   select * from memory_sessions order by created_at desc limit 1;
   ```
   Compare which columns it populated vs what the current hook tries to populate. This tells us whether a NEW column was added that the hook isn't handling, or vice versa.

6. **Probe `memory_items` writes for comparison.** memory_items writes ARE working (33 new rows this session). Pull a recent row:
   ```sql
   select * from memory_items where created_at > '2026-05-03 23:00:00+00' and source_agent = 'claude' order by created_at desc limit 1;
   ```
   Note: that row was written by the SAME hook firing that should have written memory_sessions. So the hook DID fire and DID write items. Why is it skipping the sessions write?

## What to capture in FINDING

- Full `\d memory_sessions` output.
- The hook's INSERT statement (or REST call body) verbatim.
- Cross-check result: which columns mismatch, if any.
- Manual psql reproduction output (success or specific error).
- Whether the hook's memory_items writes succeed via the SAME path that memory_sessions fails on (single transaction vs separate, REST endpoint vs direct SQL, etc).

## Hypothesis grid (for T3)

If T2 finds:
- **Schema gap (column missing in DB):** ship migration 017 + extend audit-upgrade probe set. T3 path.
- **Schema gap (column added by a migration the hook hasn't been updated for):** fix hook to omit/handle the column. T3 path.
- **NOT NULL column without default the hook doesn't populate:** fix hook to populate. T3 path.
- **Generated column the hook tries to write:** fix hook to omit. T3 path.
- **No schema gap, INSERT works manually but fails via the hook's runtime:** dig into the hook's auth/transaction/timeout. T3 path; deeper investigation.
- **No schema gap, manual INSERT also fails with the same error:** the bug is at a deeper layer (RLS policy, trigger, etc). Out-of-scope for the mini; escalate to a full sprint.

## Coordination

- Post FINDING with the manual SQL reproduction result so T3 can converge on the fix path.
- T1's instrumentation (which line failed) + T2's schema diff (why that line failed) together give T3 enough to fix.
- T4 (Codex) re-runs the manual SQL repro independently from a fresh psql session.

## Boot

```
1. date '+%Y-%m-%d %H:%M ET'
2. memory_recall(project="termdeck", query="Sprint 51.6 T2 memory_sessions schema petvetbid bundled hook INSERT manual SQL reproduction")
3. memory_recall(query="Mnestra schema migrations 001-016 memory_sessions memory_items source_agent")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/PLANNING.md + STATUS.md + T1-hook-instrumentation.md
7. Read this brief
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (find the memory_sessions INSERT)
9. Read ~/Documents/Graciella/engram/migrations/001_mnestra_tables.sql + 015_source_agent.sql (schema baseline)
```

Stay in your lane. Post FINDING / DONE in `STATUS.md`. **Read-only psql probes are autoMode-allowed; no schema mutations from T2.** T3 owns any DB changes.
