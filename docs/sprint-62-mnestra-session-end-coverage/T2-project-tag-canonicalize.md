# T2 — Project-tag canonicalize migration

## Boot sequence

1. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 21 T2 gorgias claimguard rename scoped out")`
2. `mcp__mnestra__memory_recall(query="project tag invariant tests memory_items")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-62-mnestra-session-end-coverage/PLANNING.md`
6. Read `docs/sprint-62-mnestra-session-end-coverage/STATUS.md`
7. Read `docs/sprint-62-mnestra-session-end-coverage/SOURCE-BRIEF-from-claimguard-sprint-8.0.md` (especially §2 problem 2, §4 T2)
8. Read this brief.

Post `### [T2] BOOT 2026-05-08 HH:MM ET — booted, opening engram migrations dir` when done.

## Mission

Finish the Sprint 21 T2 `gorgias` + `gorgias-ticket-monitor` → `claimguard` rename that was scoped-out and never landed. Same project tagged three ways across history (claimguard 29 / gorgias-ticket-monitor 245 / gorgias 541) splits `memory_recall(project="claimguard")` to ~88% miss rate.

## Surfaces

- `~/Documents/Graciella/engram/migrations/021_project_tag_canonicalize_claimguard.sql` — new file.
- `~/Documents/Graciella/engram/tests/` — confirm existing project-tag invariant tests stay green post-migration. Read them first to understand what they assert.

## Migration shape (mandatory)

```sql
-- 021_project_tag_canonicalize_claimguard.sql
-- Sprint 62 T2 — finishes Sprint 21 T2's scoped-out rename.
-- Same project (the ClaimGuard repo + adjacent folders) was tagged three ways
-- across history: 'claimguard' (29 rows, newest), 'gorgias-ticket-monitor' (245
-- rows, mid), 'gorgias' (541 rows, oldest). memory_recall(project="claimguard")
-- misses ~88% of project history pre-migration.
--
-- Idempotent: re-running is a no-op once 'gorgias' and 'gorgias-ticket-monitor'
-- are absent from the corpus. RLS-respecting: service-role write, no policy
-- change. Reversibility: down-migration documented at the bottom (commented).

do $$
declare
  affected_count integer;
begin
  update public.memory_items
     set project = 'claimguard'
   where project in ('gorgias', 'gorgias-ticket-monitor');
  get diagnostics affected_count = row_count;
  raise notice '[021] canonicalized % memory_items rows to project=claimguard', affected_count;
end$$;

-- Post-apply diagnostic — should return one row with project='claimguard'
-- and a count >= 815 (29 + 245 + 541) on the reference Mnestra project.
-- Anything tagged 'gorgias%' post-apply means the migration didn't take.
select project, count(*)
  from public.memory_items
 where project in ('claimguard', 'gorgias', 'gorgias-ticket-monitor')
 group by project
 order by project;

/* DOWN-MIGRATION (manual, NOT auto-applied):
   Splitting the merged set back into three is non-trivial (no source-of-truth
   on which rows were originally which tag). If a roll-back is needed, restore
   from a pg_dump taken before the migration was applied. Do NOT attempt to
   reverse via heuristic — the row provenance is destroyed by the merge.
*/
```

Adjust the query above if the project-tag invariant tests require additional scoping (e.g. a `where source_type in (...)` filter). Read the tests first.

## Acceptance

1. Migration file at `migrations/021_project_tag_canonicalize_claimguard.sql`.
2. Migration applies cleanly on the reference Mnestra project (the one Joshua's daily-driver uses) — fresh apply, no errors.
3. `select project, count(*) from public.memory_items group by project` shows ~815 `claimguard` rows post-apply (29 + 245 + 541, minus invariant violators if any).
4. `mcp__mnestra__memory_recall(project="claimguard")` returns the merged set.
5. The four existing project-tag invariant tests still pass.
6. Idempotent: re-running yields zero affected rows + no error.

## Post shape

`### [T2] STATUS-VERB 2026-05-08 HH:MM ET — <gist>` to STATUS.md.

## What NOT to touch

- No version bumps, CHANGELOG narrative, or commits (orchestrator owns at close).
- Do NOT modify the writer-side PROJECT_MAP (T1 owns it). Coordinate with T1 via STATUS.md if PROJECT_MAP needs an update for `gorgias-ticket-monitor` CWD → claimguard.
- Do NOT touch other Mnestra schema beyond the project-tag rename.
- Do NOT touch source_agent (T3 owns).
