# A-T1 — Walk-edge expansion + entity seeding (engram SQL)

You are A-T1 in Sprint 70 (Graph-Boosted Recall), Deck A of a dual-deck sprint. Repo:
`~/Documents/Graciella/engram`. Read PLANNING.md fully first — §Seam and §Context bind you.

## Own exclusively
- `migrations/037_graph_walk_expansion.sql` (number pre-assigned; Deck B owns 038).
- The graph-walk RPC surface (034's `memory_recall_graph`-backing function(s) — extend
  via 037; read `migrations/034_graph_layer.sql` §walk + `src/recall_graph.ts` for the
  current call signature. Do NOT edit `src/*.ts` — that is A-T2's ground; coordinate the
  RPC signature via a `SCHEMA-READY` post BEFORE landing it so A-T2 can consume.)

## Scope
1. **Expand the walk's edge set.** Today the recursive expansion follows ONLY
   `memory_relationships`. Add, weight-tunable via function args (conservative defaults):
   - Entity co-mention edges: memories sharing a `memory_entities` mention.
   - Community co-membership edges: memories in the same consolidation community.
   - Typed relationship edges keep their existing weight; new arms get lower defaults.
   Bidirectionality precedent: the CASE-WHEN source/target flip from the 038-era
   `expand_memory_neighborhood` — keep edges reachable from either endpoint.
2. **Keyword→entity triggering.** Match query terms against `memory_entities` (name +
   aliases if present) FIRST; matched entities' mention sets become walk seeds, UNIONed
   with the vector seeds. This is the literal "a few key words trigger the chain"
   mechanism.
3. **Exclusion predicate (seam §3):** the walk excludes tier-0/objective rows. Deck B-T1
   posts its marker (column/flag) as `SCHEMA-READY` in
   `docs/sprint-71-objective-tier/STATUS.md`; poll `^(### )?\[B-T1\] SCHEMA-READY\b`
   before finalizing the predicate. If B-T1 hasn't posted by the time you're otherwise
   done, land 037 with a clearly-marked `WHERE` placeholder excluding nothing + post
   FINDING; ORCH will arbitrate.

## Hygiene (release-blocking)
- Every function: `SET search_path = public, pg_catalog`; `REVOKE EXECUTE ... FROM
  PUBLIC;` then targeted GRANT (service_role; anon/authenticated only if the existing
  recall path already grants them — mirror 033/034 precedent exactly).
- Constraints (if any): `ADD ... NOT VALID` + `VALIDATE CONSTRAINT`.
- Idempotent re-run safety per the migration-file house style (read 034's header).

## Verification
- READ-ONLY psql against the daily driver (DATABASE_URL from `~/.termdeck/secrets.env`,
  strip `?pgbouncer=true`). Do NOT apply 037 live — authoring + local assertion only;
  ORCH applies at close. Use `BEGIN; ... ROLLBACK;` if you must exercise DDL against a
  scratch schema.
- The diagnosis query to beat: seeds for "vault readability navigation layer" should gain
  nonzero neighbors at depth 2 once 037 is applied (T4 will reproduce post-apply; you
  demonstrate via EXPLAIN/dry-run SQL in a rollback transaction).

## Discipline
Post `### [A-T1] ...` per STATUS.md shape. SCHEMA-READY the moment the RPC signature is
frozen (A-T2 is blocked on it). MIGRATION-AUTHORED when 037 is complete. DONE when tests
+ self-review pass. No version bumps, no CHANGELOG, no commits. If any memory MCP call
hangs >60s, Esc-abort it and proceed on the brief.

Boot: read `~/.claude/CLAUDE.md`, engram `CLAUDE.md` (if present), PLANNING.md, STATUS.md,
this brief. Then begin.
