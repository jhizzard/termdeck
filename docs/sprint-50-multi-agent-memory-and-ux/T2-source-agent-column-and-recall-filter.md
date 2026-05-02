# Sprint 50 — T2 (Claude): `source_agent` column + recall filter (cross-repo)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes; full design in [docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md](../MULTI-AGENT-MEMORY-ARCHITECTURE.md) § Deliverable 2):**

Add `source_agent` provenance column to `memory_items`. Extend the `memory_recall` MCP tool with a `source_agents` filter param. **Cross-repo work** — touches `~/Documents/Graciella/engram` (Mnestra source) AND `packages/stack-installer/assets/hooks/memory-session-end.js` (TermDeck-side hook population).

## Files

### Mnestra repo (`~/Documents/Graciella/engram`)

- NEW `migrations/015_source_agent.sql` — column + partial index + comment + backfill of historical rows from Claude Code (set `source_agent='claude'` for `source_type='session_summary'` rows where `source_agent IS NULL` AND `created_at < <Sprint-50-start>`).
- EDIT `src/recall.ts` — accept optional `source_agents: string[]` param; filter at the SQL `WHERE source_agent = ANY($N)` level when supplied. Backwards-compatible (NULL/omitted = no filter).
- EDIT `mcp-server/index.ts` — extend `memory_recall` tool's input schema with the `source_agents` field. Pass through to `memoryRecall()`.
- NEW `tests/recall-source-agent.test.ts` (~80 LOC, ~6 tests) — fixture rows with mixed `source_agent` values; assert filter works for single agent, multiple agents, undefined (all), empty array (still all — discuss design), unknown agent name (returns 0).
- EDIT `package.json` version 0.3.4 → 0.4.0 (minor bump — new schema feature).
- EDIT `CHANGELOG.md` — `## [0.4.0]` block.

### TermDeck repo (`packages/stack-installer/assets/hooks/memory-session-end.js`)

- EDIT `postMemoryItem()` — accept and pass `source_agent` field from the payload. Default to `'claude'` if not supplied (backwards-compat for Claude Code's existing hook payload).
- EDIT bundled hook header — document the new payload field.
- EDIT `tests/stack-installer-hook-merge.test.js` — add 2 tests: payload-without-source_agent defaults to 'claude'; payload-with-source_agent='codex' passes it through.

## SQL migration shape

```sql
-- migrations/015_source_agent.sql
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS source_agent text;

CREATE INDEX IF NOT EXISTS idx_memory_items_source_agent
  ON memory_items (source_agent)
  WHERE source_agent IS NOT NULL;

COMMENT ON COLUMN memory_items.source_agent IS
  'Agent that produced this memory: claude|codex|gemini|grok|orchestrator|NULL (historical, pre-Sprint-50).';

-- Backfill historical session_summary rows — they came from Claude Code
-- (only Claude had a working SessionEnd hook before Sprint 50 T1).
UPDATE memory_items
  SET source_agent = 'claude'
  WHERE source_type = 'session_summary'
    AND source_agent IS NULL;
```

## Recall RPC extension

```ts
// src/recall.ts — append to existing memoryRecall function signature.
export async function memoryRecall(opts: {
  query: string;
  project?: string | null;
  token_budget?: number;
  min_results?: number;
  source_agents?: string[];  // NEW — filter by source agent. Omit/null = all agents.
}): Promise<RecallResult>;
```

```ts
// mcp-server/index.ts — extend the tool input schema.
inputSchema: {
  query: z.string(),
  project: z.string().optional(),
  token_budget: z.number().default(2000),
  min_results: z.number().default(5),
  source_agents: z.array(z.enum(['claude','codex','gemini','grok','orchestrator']))
    .optional()
    .describe('Filter to specific source agents. Omit for all-agents (default).'),
}
```

## Acceptance criteria

1. **Migration applies cleanly** to the live Mnestra Supabase project. `select count(*) from memory_items where source_agent='claude'` returns the count of historical session_summary rows post-backfill (12 at Sprint 50 kickoff).
2. **`memory_recall(source_agents=['claude'])`** returns only Claude rows.
3. **`memory_recall(source_agents=['claude','gemini'])`** returns Claude + Gemini (union).
4. **`memory_recall()` (no filter)** returns all agents (no breaking change to existing callers — verified via existing test suite).
5. **TermDeck-side hook population** sets `source_agent` correctly for new Sprint 50 inserts. Verified by `select source_agent, count(*) from memory_items where created_at > <Sprint-50-start> group by 1`.
6. **Mnestra full test suite stays green** — recall behavior unchanged when filter omitted.
7. **`@jhizzard/mnestra@0.4.0`** published. `npm view @jhizzard/mnestra version` returns 0.4.0.
8. T1 lane's `onPanelClose` payload field `source_agent` actually lands in the database (validated against acceptance #5 in Sprint 50 T4 dogfood close-out).

## Coordination

- **Migration must apply BEFORE any insert with the new column.** If T1 ships before T2, hook inserts fail with "column does not exist." Two options:
  - (a) Ship T2 first (migration applied to live DB), then T1 starts populating.
  - (b) Ship in same release; T1's hook payload includes `source_agent` but the postMemoryItem function gracefully drops the field if the column doesn't exist (defensive). Recommend (a) — simpler and the migration is fast.
- T3 + T4 are independent of T2.
- **Cross-repo:** mnestra changes need their own publish flow (Passkey, npm publish). Coordinate at sprint close — orchestrator handles the publish dance per RELEASE.md (mnestra has a parallel RELEASE doc; check before publishing).

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 50 source_agent column recall filter Mnestra cross-repo migration 015 memory_items provenance")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md (Deliverable 2 section is your spec)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/engram/migrations/014*.sql (latest existing migration — model your 015 on it)
11. Read /Users/joshuaizzard/Documents/Graciella/engram/src/recall.ts (the function you extend)
12. Read /Users/joshuaizzard/Documents/Graciella/engram/mcp-server/index.ts (memory_recall tool registration)
13. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (postMemoryItem to extend)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. **DO bump mnestra to 0.4.0** + author its CHANGELOG. **DON'T bump termdeck root version** — orchestrator decides at sprint close. Don't commit either repo — orchestrator handles all close-out.
