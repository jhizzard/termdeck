# T3 — Tools, Data-source Clients, Connect Docs

You are **T3** in Sprint 71 (MCP Bridge). You build the actual read-only MCP tools (memory + live terminal state) and connect ChatGPT + Grok.

## Boot
1. `memory_recall(project="termdeck", query="TermDeck HTTP API GET /api/sessions buffer status; Mnestra memory_recall")`
2. `memory_recall(query="MCP Bridge tools read-only Mnestra TermDeck terminal state")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-71-mcp-bridge/PLANNING.md` + `STATUS.md`
5. Read `packages/server/src/index.js` around the session-list + buffer endpoints (`GET /api/sessions`, `GET /api/sessions/:id/buffer`) to learn the live-state shape you wrap.
6. **Read the MCP SDK tool-definition docs before coding** (input schemas, content return shape) — don't assume.

## Lane scope (own these)
- `packages/mcp-bridge/src/clients/termdeck.js` — read-only wrapper over TermDeck's HTTP API (`/api/sessions`, `/api/sessions/:id/buffer`). No input endpoints, no `/poke`, no `/input` — **read paths only.**
- `packages/mcp-bridge/src/clients/mnestra.js` — read-only wrapper over Mnestra `memory_recall` / `memory_search`.
- `packages/mcp-bridge/src/tools/*.js` — the tools, each handler registered through `withEgressRedaction` (server.js) and declared read-only:
  - `memory_recall(query, project?)`, `memory_search(query, filters?)` — Mnestra.
  - `list_panels()` → uses `policy.visiblePanels` (allowlist). `panel_status(id)`, `read_panel(id)` (approval-gated), `recent_activity(sinceMinutes?)`.
- `packages/mcp-bridge/docs/connect-claude.md`, `connect-chatgpt.md`, `connect-grok.md` — step-by-step connect instructions per provider.

## Tasks
1. Build the two clients (read-only). Make `read_panel` return the *latest* buffer slice, not unbounded history.
2. Author the tools; every handler returns plain data and is wrapped so output is redacted. Provide **sample-output fixtures** to T2 for the leak-gate.
3. Connect **ChatGPT** (Settings → Connectors → Advanced → Developer Mode → custom connector URL) and **Grok** (grok.com/connectors → New → Custom). Smoke-test a memory + a panel read on each; post evidence. Note Grok requires a paid tier (SuperGrok/Premium+).
4. Write the three connect-docs.

## Consume (don't author)
- `withEgressRedaction` (server.js), `policy.*` (T2), transport/auth (T1).

## Do NOT
- Expose ANY write/mutation tool (no `/input`, `/poke`, memory_remember, memory_forget). Author redaction/policy (T2) or transport/auth (T1). Touch `grok-models.js`. Bump versions / CHANGELOG / commit.

## Post shape
`### [T3] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
Read-only memory + terminal-state tools work; ChatGPT + Grok connected and round-trip a redacted call; three connect-docs written; fixtures handed to T2.
