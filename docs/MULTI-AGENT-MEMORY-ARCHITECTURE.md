# Multi-Agent Memory Architecture

**Authored:** 2026-05-02 14:32 ET, post-Sprint-49 close
**Owner:** Sprint 50 (top-line) + Sprint 51 (cost-panel companion)
**Status:** Design doc + scoping. Implementation lands in Sprint 50; some rows benefit from the new schema before Sprint 51 cost-panel surfaces them.

This document is the canonical reference for two related Sprint 50 deliverables that together close the v1.0.0 trust gap surfaced during the Sprint 49 mixed-agent dogfood:

1. **Per-agent SessionEnd hook trigger** — make `/exit` (and equivalent panel close) write memories for Codex / Gemini / Grok the way it does for Claude Code today.
2. **Memory tagging by source agent** — add provenance metadata so future `memory_recall` calls can filter or trust-weight by which LLM produced the row.

Sprint 49 PLANNING.md and Sprint 50 PLANNING.md both reference this doc instead of inlining the design.

---

## Why this matters now

Sprint 49 (2026-05-02) ran as a real 4-lane mixed-agent dogfood: T1=Codex, T2=Gemini, T3=Grok, T4=Claude. All four lanes posted DONE in 12 minutes wall-clock, shipping `@jhizzard/termdeck@0.18.0` + `@jhizzard/termdeck-stack@0.5.1`. The dogfood proved the auto-wire-on-launch path works end-to-end — but it ALSO surfaced two trust-fundamental gaps:

1. **`/exit` from Codex / Gemini / Grok writes nothing to Mnestra.** Only Claude Code has a hook system that fires our session-summary script. So Sprint 49 closed with 4 of 4 lanes complete but only 1 of 4 panels' work captured to memory. The first three lanes' work is **discoverable from the git diff and STATUS.md, but not retrievable via `memory_recall` for future sessions**.

2. **Even if every panel WROTE a memory, there's no way to filter by source LLM.** Joshua trusts Claude most; Codex less; Gemini and Grok least (anecdotal at this stage, may change with use). When `memory_recall` returns rows that include both a careful Claude observation and a hallucinated Gemini timestamp claim (Sprint 49 surfaced exactly this — Gemini stamped its STATUS posts at 14:35–14:58 ET when actual time was 14:14–14:19 ET), the recall consumer can't tell which row is which.

Both gaps are gate-blockers for v1.0.0 ramp adoption — outside users running mixed 4+1 will hit them on day one.

---

## Deliverable 1: Per-agent SessionEnd hook trigger

### Problem
The SessionEnd hook (`~/.claude/hooks/memory-session-end.js`, registered in `~/.claude/settings.json` under `hooks.SessionEnd`) is **Claude-Code-specific** because that's the hook system Claude Code exposes. Other agents have no equivalent:

| Agent | Hook system today | Captured on `/exit` today? |
|---|---|---|
| Claude Code | `~/.claude/settings.json` `hooks.SessionEnd` | ✅ Yes (post-Sprint-48 close fix) |
| Codex (`grok-dev`) | None — no user-script hooks | ❌ No |
| Gemini CLI | None — no user-script hooks | ❌ No |
| Grok (`grok-dev`) | None — no user-script hooks | ❌ No |

So a 4-lane sprint produces 1 row, not 4. The mixed-agent dogfood proved this: post-Sprint-49 `/exit`s from T1/T2/T3 vanished into the void.

### Approach
TermDeck **already owns the PTY for every panel** — it spawned them via `node-pty` in `packages/server/src/index.js` `spawnTerminalSession()`. When a panel closes (PTY exits), TermDeck knows. Today we don't act on that signal; Sprint 50 wires it.

**The infrastructure is in place — only the trigger is missing.** Sprint 45 T4 already pluralized the transcript parser (`packages/server/src/agent-adapters/<name>.js` exposes `parseTranscript` per-adapter). The bundled hook script (`packages/stack-installer/assets/hooks/memory-session-end.js`) already accepts a `sessionType` field in its stdin payload and dispatches to the right parser. **All we need is the server-side panel-close interceptor that fires the hook with the right payload.**

### Design

NEW server-side function in `packages/server/src/index.js`:

```js
// Fires when a panel's PTY exits. Locates the appropriate transcript path
// (per the adapter), spawns the bundled hook script with the right payload.
// Fail-soft: any error logs and exits cleanly. Never blocks panel close.
async function onPanelClose(session) {
  const adapter = AGENT_ADAPTERS[session.meta.type] || AGENT_ADAPTERS.claude;
  const transcriptPath = await adapter.resolveTranscriptPath(session);
  if (!transcriptPath) return;  // adapter declares no transcript → no-op

  const hookPath = path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js');
  if (!fs.existsSync(hookPath)) return;  // user hasn't installed the hook → no-op

  const payload = {
    transcript_path: transcriptPath,
    cwd: session.meta.cwd,
    session_id: session.id,
    sessionType: adapter.sessionType,
    source_agent: adapter.name,  // NEW — see Deliverable 2
  };

  const child = spawn('node', [hookPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...readTermdeckSecretsForPty() },
    detached: true,
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  child.unref();  // don't block server shutdown
}
```

**Adapter contract extension (10th field):**

```js
{
  // ... existing 9 fields from Sprint 48 ...
  resolveTranscriptPath: async (session) => string | null,
}
```

Per-adapter implementation:
- **Claude**: returns the path Claude Code passes via the SessionEnd hook payload — wait, that's a hook payload, not session metadata. Refactor: Claude Code stores transcript JSONL in `~/.claude/projects/<dir-hash>/<session-id>.jsonl`. Adapter computes the path from `session.id` + `session.meta.cwd`.
- **Codex**: writes to `~/.codex/sessions/<session-id>.jsonl` (verify path during Sprint 50 lane).
- **Gemini**: writes to `~/.gemini/sessions/<session-id>.json` (single-JSON shape per Sprint 45 T4).
- **Grok**: writes to `~/.grok/grok.db` (SQLite, per Sprint 45 T3 finding) — adapter extracts via SQL query and synthesizes a JSONL feed (Sprint 45 carry-over noted in CHANGELOG planned).

### Coordination with Claude's existing hook

Claude Code already fires the SessionEnd hook on `/exit`. We don't want a double-fire when (a) Claude's hook fires AND (b) TermDeck's panel-close interceptor also fires. The dedupe rule:

- **TermDeck server's interceptor only fires for non-Claude panels.** Claude's existing hook handles Claude.
- Or: TermDeck's interceptor fires for ALL panels, AND Claude Code's hook detects "this row already exists for this session_id" and no-ops. The hook can do this with a Supabase pre-insert SELECT against `session_id`.

Recommend the first approach — simpler, no race condition with the hook script.

### Sprint 50 sizing
~60 LOC server-side (`onPanelClose` + `resolveTranscriptPath` per adapter) + 1 new test file (~80 LOC, ~6 tests). Plus the Grok SQLite-extraction work (Sprint 45 carry-over) which is bigger (~150 LOC with `better-sqlite3`).

### Acceptance criteria for Sprint 50 lane
1. Closing a Codex panel writes one `session_summary` row to `memory_items` with `source_agent='codex'`.
2. Same for Gemini, Grok.
3. Claude's existing hook still fires; no double-write per session.
4. If a panel closes with no transcript (e.g., user opened and immediately closed), the interceptor no-ops cleanly.
5. Server doesn't block panel close on the hook script's exit code (fire-and-forget pattern).

---

## Deliverable 2: Memory tagging by source agent

### Problem
`memory_items` rows today carry `project`, `source_type`, `category`, etc. — but **no field identifying which LLM produced them**. So `memory_recall` returns a Claude-authored carefully-reasoned observation alongside a Gemini-authored hallucinated timestamp claim, with the consumer unable to tell them apart.

### Approach
Single column, single table, filter by query. **NOT** separate tables per LLM (would fragment hybrid search and complicate the recall RPC; also makes cross-LLM analysis harder).

### Schema migration
NEW migration `~/Documents/Graciella/engram/migrations/015_source_agent.sql`:

```sql
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS source_agent text;

-- partial index — historical rows are NULL, only filter when set
CREATE INDEX IF NOT EXISTS idx_memory_items_source_agent
  ON memory_items (source_agent)
  WHERE source_agent IS NOT NULL;

COMMENT ON COLUMN memory_items.source_agent IS
  'Agent that produced this memory: claude|codex|gemini|grok|orchestrator|NULL (historical, pre-Sprint-50).';
```

**Backwards-compatible:** historical rows stay NULL; new rows get the value populated by the hook (which receives `source_agent` in the payload — see Deliverable 1).

### Recall RPC extension
EDIT `~/Documents/Graciella/engram/migrations/006_memory_status_rpc.sql` (or its successor) — extend the `memory_recall` function signature with an optional `source_agents text[]` param. If supplied, filter to rows where `source_agent = ANY(source_agents)`. If NULL, no filter (default — backwards-compatible).

### MCP `memory_recall` tool extension
EDIT `~/Documents/Graciella/engram/mcp-server/index.ts` — add the `source_agents` field to the tool input schema:

```ts
inputSchema: {
  query: z.string().describe('What to search for in memory'),
  project: z.string().optional(),
  token_budget: z.number().default(2000),
  min_results: z.number().default(5),
  source_agents: z.array(z.enum(['claude','codex','gemini','grok','orchestrator']))
    .optional()
    .describe('Filter to specific source agents. Omit for all-agents (default).'),
}
```

### Joshua's "trust Claude most" preference

Two paths, recommend the first:

**Path A — client-side filter (simpler):** the consumer passes `source_agents=['claude']` when they want pure-Claude recall. Default behavior is unchanged. Joshua's CLAUDE.md global rules can document the convention: "for any decision-grade recall, pass `source_agents=['claude']`." Per-conversation default override is also viable.

**Path B — weighted-trust ranking (more complex):** add a `trust` JSONB param mapping agent name to weight (default `{claude: 1.0, codex: 0.7, gemini: 0.5, grok: 0.6}`). The recall RPC multiplies per-row score by the source agent's weight. Returns mixed agents but ranks Claude higher.

**Recommended:** ship Path A first; add Path B if needed after live use. Weights are subjective and may bias future sessions in ways that are hard to debug.

### Sprint 50 sizing
~30 LOC migration + 1 backfill query (manual, for the 8 existing `session_summary` rows — set `source_agent='claude'` since they came from Claude Code). ~15 LOC hook payload field. ~20 LOC mnestra recall param. ~40 LOC mnestra MCP tool input schema + handler. 1 page of doc (this file).

### Acceptance criteria
1. New `session_summary` rows have `source_agent` populated (verified via `select source_agent, count(*) from memory_items group by 1`).
2. `memory_recall(source_agents=['claude'])` returns only Claude-authored rows.
3. `memory_recall(source_agents=['claude','codex'])` returns Claude + Codex (union).
4. `memory_recall()` (no filter) returns all agents (no breaking change to existing callers).
5. Mnestra full test suite stays green; new tests cover the filter param.

---

## Companion: Sprint 51 cost-monitoring panel

The cost-panel work (`memory/project_cost_monitoring_panel.md`) reads each adapter's `costBand` field. Sprint 50's `source_agent` column is the natural foundation — the cost panel can show "your last 30 days of memory spend, broken down by source LLM" once that column exists. Don't ship them simultaneously (Sprint 50 ships the data plumbing; Sprint 51 ships the visible panel that reads from it).

---

## Open questions / risks

1. **Codex / Gemini / Grok transcript paths.** Sprint 50 lane authoring needs to verify the exact path each agent uses. May vary by agent version. Sprint 50 substrate probe should `ls ~/.codex/sessions/` etc. as a kickoff step.

2. **Grok SQLite extraction.** Grok's transcript lives in `~/.grok/grok.db` (SQLite), not a flat JSONL. Sprint 45 T3 surfaced this; the parser needs `better-sqlite3` to query the messages table and synthesize a JSONL feed. Adds a runtime dep to the bundled hook OR is gated on the user having `better-sqlite3` available. Decide at Sprint 50 lane scoping.

3. **Concurrent panel closes.** If Joshua /exits all 4 panels in rapid succession (Sprint 49 close pattern), the server gets 4 simultaneous panel-close events. Each fires a hook script. 4 concurrent embedding pipelines + 4 concurrent Supabase inserts. Should be fine at this scale; document as a thing to watch under heavier orchestration loads (10+ simultaneous panel closes).

4. **Memory dedup.** If Claude Code's existing hook fires AND TermDeck's interceptor fires (during transition), we'd get duplicate rows. Resolve by either (a) only firing the interceptor for non-Claude panels (recommended), or (b) hook-side dedup via session_id pre-check.

5. **Mnestra recall in this codebase requires the patched `~/.claude.json`.** This session today STILL has the broken pre-hotfix env. Sprint 50 lane consuming `memory_recall` will need to start in a fresh Claude Code session. Document at Sprint 50 kickoff.

---

## References

- `docs/sprint-49-mixed-agent-dogfood/PLANNING.md` — Sprint 49 plan (closed).
- `docs/sprint-49-mixed-agent-dogfood/STATUS.md` — Sprint 49 lane outcomes including Gemini scope-creep + timestamp drift observations.
- `docs/AGENT-RUNTIMES.md` — 9-field adapter contract (post-Sprint-48); Sprint 50 extends to 10 fields with `resolveTranscriptPath`.
- `packages/server/src/agent-adapters/*.js` — per-adapter implementations.
- `packages/stack-installer/assets/hooks/memory-session-end.js` — bundled hook (post-Sprint-48-close-out: SessionEnd registration, secrets.env fallback, ${VAR}-placeholder rejection).
- `packages/server/src/mcp-autowire.js` — Sprint 48 helper, parallel pattern to the per-agent hook trigger (both iterate adapters from a registry).
- `~/.claude/projects/.../memory/project_cost_monitoring_panel.md` — Sprint 51 vision (companion deliverable).
- `~/.claude/projects/.../memory/feedback_gemini_approval_heavy.md` — Gemini's per-step approval model (relevant when sizing Sprint 50 Gemini-related lanes).
