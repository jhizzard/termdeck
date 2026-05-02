# Sprint 50.5 — Worktree-isolated mixed-agent dogfood — STATUS

**Sprint kickoff timestamp:** _(orchestrator stamps at inject time)_
**Sprint close timestamp:** _(orchestrator stamps at sprint close)_
**Wall-clock:** _(filled at close; budget ~10-15 min — each lane is minimal-scope by design.)_

## Architecture reference

Sub-sprint validates Sprint 50's three load-bearing pieces (T1 per-agent SessionEnd hook trigger, T2 `source_agent` provenance column + recall filter, T3 UX trust trio). Architecture doc: [`docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md`](../MULTI-AGENT-MEMORY-ARCHITECTURE.md). Plan: [`PLANNING.md`](./PLANNING.md).

## Pre-sprint context

- Sprint 50 close is the v1.0.0 inflection. This dogfood is the confidence test. Pass → ship `@jhizzard/termdeck@1.0.0`. Fail any lane → roll forward to `0.19.0` and queue v1.0.0 for Sprint 51.
- Each lane runs in its own `.worktrees/sprint-50.5-T{1..4}/` worktree so a failed lane doesn't pollute main. Files touched are disjoint by design (graph.js / AGENT-RUNTIMES.md / session.js / app.js — zero overlap).
- Agent assignments per PLANNING.md frontmatter: T1=codex, T2=gemini (smallest scope per Gemini approval-heavy), T3=grok, T4=claude.
- Baseline `memory_items.source_type='session_summary'` count entering Sprint 50.5: 12 rows (Sprint 50 inject baseline). Expected after `/exit` of all 4 panels: 16+ rows with provenance (`claude` × 1, `codex` × 1, `gemini` × 1, `grok` × 1 — one new row per lane via Sprint 50 T1's per-agent hook trigger).

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — codex — URL state codec edge case (graph viewer)

_(no entries yet)_

### T2 — gemini — `approvalModel` adapter contract field (docs only)

_(no entries yet)_

### T3 — grok — TUI spinner spam stripping (stripAnsi extension)

_(no entries yet)_

### T4 — claude — Dead `triggerProactiveMemoryQuery` cleanup

_(no entries yet)_

## Orchestrator notes

_(append-only, orchestrator-only)_

## Memory write verification

_(orchestrator runs after all four `/exit`s)_

```sql
-- Expected: 4 new rows since Sprint 50 baseline of 12, with source_agent column populated.
select source_agent, count(*)
from memory_items
where source_type = 'session_summary'
group by source_agent
order by source_agent;
-- Expected delta: claude +1, codex +1, gemini +1, grok +1.
```

## v1.0.0 decision

_(orchestrator evaluates: did all 4 lanes close DONE in worktrees AND did 4 new memory rows land with correct `source_agent` AND did spinner/labels/launcher all hold under real load? If yes → v1.0.0 publish. If only partial → v0.19.0. If failure mode → v0.18.1 patch.)_

## Sprint close summary

_(orchestrator fills at close)_
