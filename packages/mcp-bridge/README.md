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
| `src/clients/` | T3 | Mnestra webhook client + read-only TermDeck HTTP-API client (✅). The TermDeck API base auto-resolves (2026-07-31): `TERMDECK_API_BASE`/`TERMDECK_BASE_URL` env → `~/.termdeck/ports.json` → port probe 3000/3001/3002/3099 — see `src/clients/termdeck-base.js` |
| `src/tools/` | T3 | The six read-only MCP tools, each wrapping output in `redactDeep` (✅) |
| `test/` | T2 | Redaction · leak-gate · auth · policy · tools · server · integration suites (✅ 86 tests) |
| `docs/connect-*.md` | T3 | Per-provider connect instructions — claude / chatgpt / grok + `tunnel.md` (✅) |

## Web-surface write path

Invariant 1 above ("read-only manifest") is enforced literally:
`policy.js::assertReadOnly` **throws at mount** for any tool whose
`readOnlyHint` is `false`, and independently rejects any tool whose *name*
contains a mutating verb token (`remember`, `forget`, `store`, `save`,
`propose`, `record`, …). **`memory_remember` can never be mounted here.** A web
chat therefore has no path to `memory_items`, which is what every recall reads.

Writes reach memory only through two **quarantined** channels, each with its own
default-OFF flag, and each landing in a table that no recall path reads:

| Tool | Flag | Lands in | Promoted by |
|---|---|---|---|
| `memory_propose` | `TERMDECK_BRIDGE_ENABLE_PROPOSE=1` | `memory_inbox` (`status='pending'`) | Rumen's inbox-promote gate |
| `memory_session_record` | `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1` | `memory_sessions` | the Rumen tick's extract→synthesize pass |

Flags live in **`~/.termdeck/supervisor.env`** (sourced `set -a` by
`scripts/termdeck-supervise.sh`), not in an ad-hoc export. A missing flag means
the tool is **absent from `tools/list` entirely** rather than present-and-erroring.

### The propose map

`source_agent` is **never caller-supplied** — it is derived per request from the
OAuth client behind the call, and an unmappable client is refused outright.
Resolution order (`policy.js::mapClientToSourceAgent`):

1. the operator's explicit `client_id` → agent map in **`~/.termdeck/bridge-propose.json`** (0600);
2. otherwise, unless `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1`, a `client_name`
   heuristic — one provider family per entry, and a name matching two families
   resolves to nothing (ambiguity fails closed).

Only these four values can ever be minted: `claude-web`, `chatgpt-web`,
`grok-web`, `gemini-web`. A CLI identity is unreachable from this surface.

**Every re-authorization creates a NEW client_id** via dynamic client
registration, so the map goes stale silently and provenance quietly falls back
to whoever chose the DCR display name. Resync it:

```bash
node scripts/sync-propose-map.js           # dry run — shows ADDED / UNRESOLVED
node scripts/sync-propose-map.js --write   # apply (0600)
```

The script only ever **adds**; an existing hand-set mapping always wins, and a
client whose name does not resolve to exactly one family is left unmapped and
reported. The bridge re-reads this file **per call** — no restart needed.

### Seeing what happened to a proposal

A proposal is fire-and-forget: it queues, and an async pass promotes or rejects
it later. `memory_propose_status` (Sprint 86) closes that loop — pass it the id
`memory_propose` returned and it reports pending / promoted / rejected (with the
reason) / unknown. It rides the **same** `TERMDECK_BRIDGE_ENABLE_PROPOSE` flag
and is a genuine read, so it is never approval-gated.

Two behaviours worth knowing before you trust its output:

- **Unknown ≠ pending.** The store answers `200 {found:false}` for an id it does
  not hold. That renders as UNKNOWN, explicitly instructing the surface not to
  report it as pending or saved — telling a user their memory is queued when
  nothing is queued is the exact false reassurance this tool exists to remove.
- **The proposal text never comes back.** Status, reason, promoted id,
  timestamps and the store's `detail` string only.

Requires `@jhizzard/mnestra` ≥ 0.14.0 (webhook ops `propose_status` and
`inbox_staleness`). Against an older store the tool answers with the upgrade
message rather than failing opaquely.

### Verifying that writes actually land

```sql
-- proposals (memory_propose)
select max(created_at) as last_proposal, source_agent, status, count(*)
  from memory_inbox group by source_agent, status order by 1 desc;

-- session captures (memory_session_record)
select max(created_at) as last_capture, source_agent, count(*)
  from memory_sessions where source_agent like '%-web' group by source_agent;
```

A long-silent `max(created_at)` with a healthy `/healthz` means the transport is
fine and the *write channel* is the fault — check, in order: the flag in
`supervisor.env`, the client's presence in the propose map, and whether the
:37778 Mnestra webhook build actually implements the op (`session_record`
requires migration 035 / `@jhizzard/mnestra` ≥ 0.12.0; an older webhook returns
"no session_record op" on every call even though the Postgres RPC exists).

`/healthz` reports the mounted tool count and, when the store supports
`inbox_staleness`, an `inbox` field:

```json
{ "ok": true, "tools": 8, "inbox": { "inbox_last_at": "2026-09-06T01:28:03Z", "inbox_stale_hours": 225.9 } }
```

Read it carefully — the three states are distinct and deliberately so:

| What you see | What it means |
|---|---|
| `inbox` **absent** | UNKNOWN — pre-0.14.0 store, webhook unreachable, or not wired |
| `inbox_last_at: null` | the store answered and **nothing has ever landed** |
| a large `inbox_stale_hours` | the write path has been silent that long |

The field is served from a ≤60 s cache and **never blocks** the health check
(the first probe after boot omits it and warms the cache), so a slow or dead
Mnestra can never make the bridge look down. It is deliberately minimal: the
per-agent breakdown and pending counts stay out, because `/healthz` is public
and unauthenticated.

## Run the tests

```bash
cd packages/mcp-bridge
node --test test/*.test.js   # all 86 tests
```
