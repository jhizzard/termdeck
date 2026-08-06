# A-T2 — MCP surface + hub coarse-to-fine (engram TS)

You are A-T2 in Sprint 70 (Graph-Boosted Recall), Deck A of a dual-deck sprint. Repo:
`~/Documents/Graciella/engram`. Read PLANNING.md fully first — §Seam and §Context bind you.

## Own exclusively
- `src/recall_graph.ts`, `src/recall.ts` (+ their tests). A-T1 owns the SQL; you consume.
- Do NOT edit `migrations/*` or A-T3's staleness/key files.

## Scope
1. **Consume 037's expanded RPC.** Idle-poll `^(### )?\[A-T1\] SCHEMA-READY\b` in this
   deck's STATUS.md for the frozen signature; until then, build against the documented
   current signature and keep the new args behind a compat shim.
2. **Hub coarse-to-fine.** When ≥N members of one consolidation community appear in the
   walk result (N tunable, default 3), collapse: return that community's
   `consolidation_summary` hub as the PRIMARY result unit, with member rows as expandable
   citations (ids + one-line gists), not full bodies. Compiled knowledge over raw chunks.
3. **Graph-walk as default recall, dark.** `MNESTRA_GRAPH_RECALL` env flag (default OFF):
   ON routes `memory_recall` through the chain engine; OFF is byte-identical to today.
   Fence with a test asserting OFF-path parity.
4. **Seam envelope (§Seam 1).** The response reserves `tier0` FIRST — emitted `[]` this
   sprint. Never interleaved, never restyled by hub collapse. Document the field in the
   tool description. After BOTH `[A-T2] SCHEMA-READY` and `[B-T1] SCHEMA-READY` exist,
   B-T1 may wire its fetch into your stub — coordinate via STATUS posts; your envelope
   shape is the frozen interface either way.

## Test rules
Instrumentation/telemetry writes must not poison the suite (Sprint-78 lesson): keep
fire-and-forget writes mockable and OFF under test env. Root `npm test` must stay green.

## Discipline
Post `### [A-T2] ...` per STATUS.md shape; SCHEMA-READY when your envelope shape is
frozen; DONE when tests pass. No version bumps, no CHANGELOG, no commits. Memory MCP
hangs >60s → Esc-abort, proceed on the brief. Verify store facts via read-only psql, not
MCP recall.

Boot: read `~/.claude/CLAUDE.md`, engram `CLAUDE.md` (if present), PLANNING.md, STATUS.md,
this brief. Then begin.
