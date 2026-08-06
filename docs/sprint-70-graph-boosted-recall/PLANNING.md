# Sprint 70 — Graph-Boosted Recall (Deck A, :3001)

**Dispatch 2026-08-05 evening. Dual-deck sprint: this deck (A) runs concurrently with
Deck B = Sprint 71 Objective Tier on :3002 (`docs/sprint-71-objective-tier/`). ONE
orchestrator shepherds both. Numbering note: the June-era `sprint-70-cli-runtime-migration`
and `sprint-71-mcp-bridge` dirs are UNRELATED historical sprints; these slugs are the
canonical Sprint 70/71 per `docs/RESTART-PROMPT-2026-08-02-EVENING-POST-S69.md`.**

## Mission

Wire the migration-034 graph substrate into the recall path so a few keywords trigger the
exact context CHAIN, not a flat list. Live diagnosis (2026-08-02, one call):
`memory_recall_graph(project=termdeck, query="vault readability navigation layer", k=6,
depth=2)` returned `d0=6` — all vector seeds, ZERO graph neighbors — because the walk
expands ONLY via `memory_relationships` and ignores the entire 034 substrate: 540
`memory_entities` + 383 mentions, 40 consolidation communities, typed edges from nightly
inference (7,378+ edges live). The primitive exists; the substrate is unwired.

**Repo: engram ONLY** (`~/Documents/Graciella/engram`). The termdeck-side injection
consumption (panel boot/flashback consuming chains hub-first) is deliberately OUT of this
sprint — it rides Deck B's injection surfaces or a follow-on. Nobody on this deck touches
the termdeck or rumen repos.

## Lanes

- **A-T1 — Walk-edge expansion + entity seeding (SQL).** Owns
  `migrations/037_graph_walk_expansion.sql` EXCLUSIVELY (number pre-assigned; Deck B owns
  038 — never renumber). (1) Extend the graph-walk RPC's edge set: typed
  `memory_relationships` ∪ entity co-mention (via the 034 mention tables) ∪ community
  co-membership — weight-tunable via function args with conservative defaults. (2)
  Keyword→entity triggering: match query terms against `memory_entities` FIRST (the
  literal "few key words" mechanism), seed the walk from matched entities' mention sets,
  union with vector seeds. RLS/function hygiene gates are release-blocking: `REVOKE
  EXECUTE ... FROM PUBLIC` + targeted GRANT + `SET search_path = public, pg_catalog` on
  every function; any constraint work uses `ADD ... NOT VALID` + `VALIDATE`.
- **A-T2 — MCP surface + hub coarse-to-fine.** Owns `src/recall_graph.ts` +
  `src/recall.ts`. Consume T1's RPC. When ≥N members of one community hit (N tunable,
  default 3), return the community's `consolidation_summary` hub as the PRIMARY unit with
  members as expandable citations (compiled knowledge, not raw chunks). Promote
  graph-walk to the default `memory_recall` path behind env flag `MNESTRA_GRAPH_RECALL`
  (default OFF — ships dark). The result envelope MUST implement the cross-deck seam
  contract (§Seam below): a reserved `tier0` pinned block above chain results, emitted
  empty this sprint.
- **A-T3 — Structural staleness + key-resolution hardening.** (1) Read-side recency:
  newest-dated-anchor downranks older same-cluster siblings (folds the two §A staleness
  items). (2) Consolidation near-dup clusters mechanically PROPOSE `supersedes` links
  (proposal rows/flags — never auto-apply). (3) Billing-fix engram half:
  `resolveAnthropicKey()` helper — `process.env.ANTHROPIC_API_KEY` first, then
  `~/.termdeck/secrets.env` fallback (copy the established pattern in
  `src/db-endpoint.ts`) — adopted by `extract_write.ts`, `summarize.ts`,
  `consolidate.ts`, so Haiku extraction survives key-free panel envs (see §Context item 2).
- **A-T4 — Codex auditor.** Independent adversarial review. Reproduce the d0 diagnosis
  pre- and post-change via read-only psql. Live-probe over diff-only. Verify RLS gates on
  037, weight-parameter sanity, hub-collapse correctness, seam-contract conformance.
  CHECKPOINT discipline mandatory (see lane brief).

## §Seam — cross-deck contract (FROZEN; identical text in both PLANNINGs)

1. **Recall envelope reserves a `tier0` pinned block.** A-T2's envelope shape:
   `{ tier0: [...], results: [...] }` (or the equivalent in the existing response
   format): `tier0` always FIRST, never interleaved, never downranked by A-T3 staleness,
   never absorbed into hubs/communities. This sprint Deck A emits `tier0: []` — Deck B's
   engram half (B-T1) provides the real fetch. If integration lands cleanly in-window,
   B-T1 may wire its fetch into A-T2's stub AFTER both post SCHEMA-READY; otherwise the
   stub ships empty and wiring is a fast-follow.
2. **Engram migration numbers: 037 = Deck A, 038 = Deck B.** Pre-assigned; never
   renumber; neither deck edits the other's migration file.
3. **Objectives are injected, not retrieved.** The 037 walk EXCLUDES tier-0/objective
   rows (B-T1 will mark them distinctly — exclusion predicate coordinated via STATUS
   posts before either migration lands: post `SCHEMA-READY` with exact column/flag spec).
4. **Cross-deck reads allowed; writes fenced to your own deck's files.** Deck A STATUS:
   `docs/sprint-70-graph-boosted-recall/STATUS.md`. Deck B STATUS:
   `docs/sprint-71-objective-tier/STATUS.md`.

## Context every lane must know

1. **MCP recall hangs under multi-panel load** (known engine behavior). Verify store
   state via READ-ONLY psql: `DATABASE_URL` from `~/.termdeck/secrets.env` (strip
   `?pgbouncer=true` for bare psql). If a memory MCP call hangs >60s at boot, Esc-abort
   and proceed — your brief carries the context.
2. **A billing-safety patch is ALREADY in the termdeck tree** (uncommitted, ORCH-owned):
   `ANTHROPIC_API_KEY` added to `SECRETS_EXCLUDED_FROM_PTY` in
   `packages/server/src/index.js`. Do not touch, revert, or commit it. Deck B T2
   formalizes. Your deck's related share is A-T3's `resolveAnthropicKey()`.
3. The termdeck working tree has deliberate untracked stragglers — leave them alone.
4. No version bumps, no CHANGELOG edits, no commits, no publishes — ORCH handles all at
   close. Lane work stays uncommitted in the tree.
5. Post-shape (uniform, mandatory): `### [A-T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
   Wake verbs the monitors key on: SCHEMA-READY · MIGRATION-AUTHORED · BLOCKED ·
   AUDIT-FAIL · AUDIT-PASS · DONE (+ FINDING / FIX-PROPOSED / FIX-LANDED / CHECKPOINT as
   informational). Idle-poll regex, if a brief calls for one:
   `^(### )?\[A-T<n>\] DONE\b` (tolerant form).

## Acceptance

- `memory_recall_graph` on the diagnosis query returns d0 seeds PLUS graph neighbors
  (entity/community/typed-edge expansion demonstrably firing), verified via psql by T4.
- Hub coarse-to-fine returns a `consolidation_summary` as primary unit on a ≥N-member
  community hit, members cited.
- `MNESTRA_GRAPH_RECALL` default-OFF path byte-identical to current behavior.
- Staleness: same-cluster older siblings rank below newest anchor; supersedes proposals
  are rows/flags only.
- Extraction works in a shell WITHOUT `ANTHROPIC_API_KEY` exported (secrets.env
  fallback proven by test).
- Root `npm test` green in engram; T4 FINAL-VERDICT GREEN.

## Resolution (ORCH close, 2026-08-05)

FINAL-VERDICT GREEN 20:33 ET (A-T4), ~59 min inject-to-verdict. All four scope items shipped: 037 walk expansion + entity seeding (13/13 live assertions in rollback; filter-before-cap fixed post-DONE), hub coarse-to-fine + MNESTRA_GRAPH_RECALL dark flag (byte-parity fenced), structural staleness (proposals only) + resolveAnthropicKey(), seam §1/§3 closed (tier0 envelope wired live behind MNESTRA_TIER0_INJECT after B-T1 hand-back). In-flight catches worth the record: graph surface privacy-blind since Sprint 38 (closed via batch hydrate); entity-seed cap-before-filter data loss (helena counterexample). Wave: mnestra 0.13.0 / termdeck 1.20.0. Live-apply operator-gated: `apply-s70-s71-live.sh`. Suite 629/631 at close.
