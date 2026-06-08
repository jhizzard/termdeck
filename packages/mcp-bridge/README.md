# @jhizzard/termdeck-mcp-bridge — The MCP Bridge

**Status:** Sprint 71 complete — transport (Streamable-HTTP + OAuth 2.1/PKCE), the egress-redaction security keystone, the six read-only tools, and per-provider connect docs all landed, audited (T1/T2/T3 AUDIT-PASS), and tested (**86/86** in `test/`). The live claude.ai Custom Connector round-trip is verified for the memory tools (2026-06-08); a live smoke of the approval-gated terminal-state tools awaits a double-panel session.

The Bridge is the **INBOUND** half of the chat integration: a self-hosted **remote MCP server** that the consumer chats connect to *via each provider's own sanctioned connector feature* — so they can **pull Mnestra memory** and **see what the coding terminals are doing**, with **zero scraping and zero browser automation**.

```
  Claude.ai ─┐
  ChatGPT  ─┼─ (provider connector, OAuth 2.1) ──▶  MCP Bridge ──▶  Mnestra (memory)
  Grok     ─┘        Streamable HTTP, public HTTPS              └──▶  TermDeck HTTP API
                     (tunnel: Anthropic MCP Tunnels for Claude,        (live panel state)
                      cloudflared for ChatGPT + Grok)
  Gemini  ─✗  consumer app has no custom-MCP surface (use Gemini CLI locally)
```

## Non-negotiable invariants (why this package can exist safely)

1. **Read-only manifest.** No write/delete/exec tools. A prompt-injected chat can, at worst, read what you chose to share.
2. **Egress redaction.** Every tool result passes through `src/redact.js` before leaving the process — tool output transits the provider's cloud, so secrets (provider keys, JWTs, Supabase refs, plus an external org-literal denylist) are scrubbed first. See the inverted-threat-model note in `redact.js`.
3. **Approval-gated + allowlisted.** Terminal-state tools require per-call approval; only projects/panels explicitly marked shareable are visible. Default-deny.
4. **Auth + scoping are the server's job.** OAuth 2.1 + PKCE, rate limits, audience-bound tokens (RFC 8707) — the MCP spec provides none of these.
5. **Never returns the internal Supabase project name/ref.** Operators add those literals to the external denylist (`~/.termdeck/bridge-redact.json` or `TERMDECK_BRIDGE_REDACT_LITERALS`) — never hardcoded here (public repo + gitleaks).

## Layout

| Path | Owner (Sprint 71) | What |
|---|---|---|
| `src/redact.js` | T2 | Egress-redaction keystone (✅) |
| `src/auth.js` | T1 | OAuth 2.1 + PKCE + Dynamic Client Registration + operator-secret consent (✅) |
| `src/server.js` | T1 | Streamable-HTTP MCP server + auth wiring + tunnel (✅) |
| `src/policy.js` | T2 | Read-only enforcement, approval gate, default-deny project allowlist (✅) |
| `src/clients/` | T3 | Mnestra webhook client + read-only TermDeck HTTP-API client (✅) |
| `src/tools/` | T3 | The six read-only MCP tools, each wrapping output in `redactDeep` (✅) |
| `test/` | T2 | Redaction · leak-gate · auth · policy · tools · server · integration suites (✅ 86 tests) |
| `docs/connect-*.md` | T3 | Per-provider connect instructions — claude / chatgpt / grok + `tunnel.md` (✅) |

## Run the tests

```bash
cd packages/mcp-bridge
node --test test/*.test.js   # all 86 tests
```
