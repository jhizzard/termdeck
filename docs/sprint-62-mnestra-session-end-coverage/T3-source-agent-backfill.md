# T3 — Source-agent backfill

## Boot sequence

1. `mcp__mnestra__memory_recall(query="source_agent Sprint 50 NULL silent drop memory_recall filter")`
2. `mcp__mnestra__memory_recall(project="termdeck", query="Sprint 50 multi-agent adapter session_summary")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-62-mnestra-session-end-coverage/PLANNING.md`
6. Read `docs/sprint-62-mnestra-session-end-coverage/STATUS.md`
7. Read `docs/sprint-62-mnestra-session-end-coverage/SOURCE-BRIEF-from-claimguard-sprint-8.0.md` (especially §2 problem 3, §4 T3)
8. Read this brief.

Post `### [T3] BOOT 2026-05-08 HH:MM ET — booted, surveying NULL source_agent rows` when done.

## Mission

Backfill `source_agent` for pre-Sprint-50 rows where inferable; document residuals. Currently `mcp__mnestra__memory_recall(source_agents=[...])` silently excludes NULL-source rows per its own docstring — likely 3,000+ historical rows invisible.

## Surfaces

- `~/Documents/Graciella/engram/migrations/022_source_agent_backfill.sql` — new file. Predicate-based backfill.
- `~/Documents/Graciella/engram/src/recall.ts` — **optional** addition of `include_null_source: boolean` flag (default `false` to preserve existing semantics). If you add it, also update its tests + docstring.

## Migration shape (mandatory)

Predicates, in order of confidence (highest first):

1. **session_summary rows with adapter-identifying content/path** → infer adapter:
   - content matches `~/.codex/sessions/` or has `[T<n>-CODEX]` markers → `source_agent='codex'`
   - same for gemini, grok.
2. **Decision/bug_fix/preference/architecture rows authored by orchestrator pattern** (look for invariants — e.g., embedding consolidation pattern, "session-end" phrasing, etc.) → `source_agent='claude'` IF the orchestrator was the writer. Be conservative; only infer when high-confidence.
3. **Rows produced by the bundled hook** (Sprint 38+) where the hook's signature is recognizable → `source_agent='claude'`.
4. **Residual** — leave NULL. Document in CHANGELOG (orchestrator writes; you leave a structured FIX-LANDED note in STATUS with the per-predicate row counts).

Migration template:

```sql
-- 022_source_agent_backfill.sql
-- Sprint 62 T3 — backfill source_agent for pre-Sprint-50 NULL rows.
-- Pre-Sprint-50 (Sprint 50 introduced source_agent), so older rows have NULL.
-- mcp__mnestra__memory_recall silently excludes NULL-source rows when source_agents
-- filter is set. ~3000+ rows currently invisible to filtered queries.
-- Predicate-based, conservative: leave residuals NULL with documented rationale.

do $$
declare
  inferred_codex integer;
  inferred_gemini integer;
  inferred_grok integer;
  inferred_claude integer;
  remaining_null integer;
begin
  -- Predicate 1a: session_summary with codex path/marker
  update public.memory_items
     set source_agent = 'codex'
   where source_agent is null
     and source_type = 'session_summary'
     and (content ilike '%~/.codex/sessions/%' or content ~ '\[T[0-9]+-CODEX\]');
  get diagnostics inferred_codex = row_count;

  -- Predicate 1b: session_summary with gemini path/marker
  update public.memory_items
     set source_agent = 'gemini'
   where source_agent is null
     and source_type = 'session_summary'
     and (content ilike '%~/.gemini/%' or content ~ '\[T[0-9]+-GEMINI\]');
  get diagnostics inferred_gemini = row_count;

  -- Predicate 1c: session_summary with grok path/marker
  update public.memory_items
     set source_agent = 'grok'
   where source_agent is null
     and source_type = 'session_summary'
     and (content ilike '%~/.grok/%' or content ~ '\[T[0-9]+-GROK\]');
  get diagnostics inferred_grok = row_count;

  -- Predicate 2: orchestrator-authored decision/bug_fix/preference/architecture
  -- rows with high-confidence Claude markers. Adjust ILIKE patterns based on
  -- inspection of actual NULL-source rows in the corpus.
  update public.memory_items
     set source_agent = 'claude'
   where source_agent is null
     and source_type in ('decision', 'bug_fix', 'preference', 'architecture', 'fact')
     and (
       content ilike '%session-end%'
       or content ilike '%orchestrator%'
       or content ilike '%[T4-CODEX]%' -- orchestrator quoting Codex
     );
  get diagnostics inferred_claude = row_count;

  select count(*) into remaining_null
    from public.memory_items
   where source_agent is null;

  raise notice '[022] backfill complete: codex=% gemini=% grok=% claude=% remaining_null=%',
    inferred_codex, inferred_gemini, inferred_grok, inferred_claude, remaining_null;
end$$;

-- Post-apply audit
select source_agent, count(*)
  from public.memory_items
 group by source_agent
 order by source_agent nulls last;
```

**Adjust ILIKE/regex patterns** based on actual row inspection BEFORE writing the final migration. Sample the NULL-source rows first (`select content from memory_items where source_agent is null limit 50`) and tune predicates to what's actually there.

## Optional: `include_null_source` flag in recall.ts

If you add it:
- Default `false` so existing call sites preserve behavior.
- When `true`, the WHERE-clause builder skips the source_agent filter for NULL rows even when source_agents=[...] is supplied.
- Add a unit test for the new flag.

## Acceptance

1. Migration file at `migrations/022_source_agent_backfill.sql`.
2. Migration applies cleanly; row-count audit reported via `raise notice`.
3. Post-apply NULL-source rows < 5% of corpus.
4. STATUS.md FIX-LANDED post lists per-predicate row counts (orchestrator copies into CHANGELOG at close).
5. If `include_null_source` flag added: `npm test` passes, including a new test for the flag.

## Post shape

`### [T3] STATUS-VERB 2026-05-08 HH:MM ET — <gist>` to STATUS.md.

## What NOT to touch

- No version bumps, CHANGELOG narrative, or commits.
- Do NOT touch project-tag (T2 owns).
- Do NOT touch adapter writer (T1 owns).
- Do NOT change `memory_recall`'s default semantics — additive flag only.
