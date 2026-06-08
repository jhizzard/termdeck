# T1 — Transport, Auth, Tunnel

You are **T1** in Sprint 71 (MCP Bridge). You build the MCP server's transport, OAuth, and the public-endpoint tunnels, then connect Claude.ai end-to-end.

## Boot
1. `memory_recall(project="termdeck", query="MCP Bridge remote MCP Streamable HTTP OAuth tunnel")`
2. `memory_recall(query="MCP-connector egress security inverted threat model")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-71-mcp-bridge/PLANNING.md` and `STATUS.md`
5. Read `packages/mcp-bridge/README.md` + `src/server.js` (the scaffold you extend)
6. **Read the MCP SDK + Streamable-HTTP transport docs before writing code — do not rely on memorized API surface** (`modelcontextprotocol.io/specification`, the `@modelcontextprotocol/sdk` README). Confirm the current server-transport + auth API.

## Lane scope (own these)
- `packages/mcp-bridge/src/server.js` — replace the scaffold's placeholder transport with the SDK's **Streamable-HTTP** server transport. Register tools exposed by T3 (import their registry), each already wrapped by `withEgressRedaction`. Call `policy.assertReadOnly(toolDef)` (T2) at registration; set the MCP approval annotation when `policy.requiresApproval(name)` is true.
- `packages/mcp-bridge/src/auth.js` — **OAuth 2.1 + PKCE**, Dynamic Client Registration so a chat connects by URL; audience-bound tokens (RFC 8707); short-lived access tokens. ChatGPT also accepts a static bearer token — support that as a documented dev-only fallback.
- `packages/mcp-bridge/docs/tunnel.md` + config — **Anthropic MCP Tunnels** for the Claude endpoint (outbound gateway, no inbound firewall holes), **cloudflared** for the ChatGPT + Grok endpoint. Document setup for both.

## Tasks
1. `npm install` in `packages/mcp-bridge` (adds `@modelcontextprotocol/sdk`).
2. Streamable-HTTP server that mounts the read-only tool registry and starts cleanly. Health endpoint + structured logging (never log tool *output* — it may contain pre-redaction data).
3. OAuth 2.1/PKCE + DCR; rate limiting; per-connection scope.
4. Tunnels: prove the server is reachable over public HTTPS via both MCP Tunnels and cloudflared.
5. **Connect Claude.ai** (Settings → Connectors → Add custom connector → your URL). Smoke-test: a claude.ai chat calls `memory_recall` and gets a (redacted) result. Post the round-trip evidence.

## Consume (don't author)
- `withEgressRedaction` (server.js / A0), `policy.*` (T2), the tool registry (T3).

## Do NOT
- Author tool logic or data-source clients (T3). Author redaction/policy (T2). Touch `packages/server/src/agent-adapters/grok-models.js` or any existing TermDeck file outside `packages/mcp-bridge/`. Bump versions / edit CHANGELOG / commit.

## Post shape
`### [T1] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
Server runs over Streamable HTTP behind OAuth/PKCE + a tunnel; **Claude.ai connected and round-trips a redacted tool call**; no existing-test regression.
