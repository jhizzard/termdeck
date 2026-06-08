# The MCP Bridge — public endpoint & tunnels

The Bridge binds to **localhost** (`127.0.0.1:8870` by default). Consumer chats
(Claude.ai / ChatGPT / Grok) need a **public HTTPS** endpoint, so you put a
**tunnel** in front: a public HTTPS URL that forwards to your local Bridge over an
**outbound-initiated** connection — no inbound firewall holes, no exposed port.

This doc gets you a public URL pointing at the Bridge. For the per-provider
connector UI once the URL is live, see `connect-claude.md`, `connect-chatgpt.md`,
`connect-grok.md`.

---

## The one rule: `TERMDECK_BRIDGE_PUBLIC_URL` must equal the tunnel URL

The Bridge's entire OAuth surface is derived from `TERMDECK_BRIDGE_PUBLIC_URL`:

| Thing | Value |
|---|---|
| AS issuer | `${PUBLIC_URL}` |
| MCP endpoint (the URL you paste into a provider) | `${PUBLIC_URL}/mcp` |
| Resource id / token audience (RFC 8707) | `${PUBLIC_URL}/mcp` |
| Protected Resource Metadata (RFC 9728) | `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp` |
| AS metadata (RFC 8414) | `${PUBLIC_URL}/.well-known/oauth-authorization-server` |
| OAuth endpoints | `${PUBLIC_URL}/authorize` · `/token` · `/register` · `/revoke` |
| Operator consent gate | `${PUBLIC_URL}/oauth/consent` |

A provider discovers those by fetching the metadata, and the access token it
receives is **audience-bound** to `${PUBLIC_URL}/mcp`. So `PUBLIC_URL` **must** be
the exact public origin of your tunnel, set **before** the Bridge serves metadata.

> **Chicken-and-egg with ephemeral tunnels:** a quick tunnel only tells you its URL
> *after* it starts. Either (a) use a **named tunnel** with a stable hostname so you
> know `PUBLIC_URL` in advance, or (b) start the tunnel, read its URL, then start the
> Bridge with `TERMDECK_BRIDGE_PUBLIC_URL` set to it. Recipes for both below.

---

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `TERMDECK_BRIDGE_PUBLIC_URL` | `http://localhost:8870` | **Set to the tunnel URL for any remote use.** Drives all OAuth metadata + the token audience. |
| `PORT` | `8870` | Local listen port. |
| `TERMDECK_BRIDGE_HOST` | `127.0.0.1` | Local bind host. Keep on loopback; the tunnel reaches it. |
| `TERMDECK_BRIDGE_OPERATOR_SECRET` | *(ephemeral, printed at boot)* | The consent passphrase entered on `/authorize`. **Set a strong one for any stable deployment** — it's the gate that stops anyone who merely learns the tunnel URL from connecting. |
| `TERMDECK_BRIDGE_STATIC_BEARER` | *(unset)* | Dev-only fixed bearer (a manual ChatGPT/curl fallback that skips the OAuth dance). **Leave unset in normal use.** |
| `TERMDECK_BRIDGE_ALLOWED_HOSTS` | *(unset)* | Optional comma-separated Host-header allowlist (your tunnel hostname). OAuth is the primary gate; this is belt-and-suspenders. See "Why not localhost Host-validation" below. |
| `TERMDECK_BRIDGE_ACCESS_TTL_SEC` | `3600` | Access-token lifetime. |
| `TERMDECK_BRIDGE_REFRESH_TTL_SEC` | `2592000` | Refresh-token lifetime (rotated on use). |
| `TERMDECK_BRIDGE_MCP_RATELIMIT` | `120` | Max `/mcp` requests per minute (per client IP). |
| `TERMDECK_BRIDGE_STATEFUL` | `1` | Streamable-HTTP session mode. `0` = stateless. |
| `MNESTRA_WEBHOOK_URL` | `http://localhost:37778/mnestra` | Memory tools' data source. |
| `TERMDECK_API_BASE` / `TERMDECK_BASE_URL` | `http://127.0.0.1:3000` | Live-panel data source (either name works). |
| `TERMDECK_BRIDGE_ALLOWLIST_PROJECTS` / `_PANELS` | *(empty = deny all)* | **Default-deny** panel visibility (or `~/.termdeck/bridge-allowlist.json`). Nothing is visible until you opt in. |
| `TERMDECK_BRIDGE_REDACT_LITERALS` | *(unset)* | Org-specific literal strings to scrub (or `~/.termdeck/bridge-redact.json`). **Never** put these in the repo. |

### Start the Bridge

```bash
cd packages/mcp-bridge
npm install
TERMDECK_BRIDGE_PUBLIC_URL=https://<your-tunnel-host> \
TERMDECK_BRIDGE_OPERATOR_SECRET='<a-strong-passphrase>' \
npm start
```

The boot banner prints the issuer, resource, and PRM URLs — and, if you did not set
`TERMDECK_BRIDGE_OPERATOR_SECRET`, a generated one to use on the consent screen.

---

## Option A — cloudflared (ChatGPT + Grok; works for Claude too)

The universally-available path.

### A1. Quick tunnel (ephemeral URL — fastest for a smoke)

```bash
brew install cloudflared                       # macOS (or your platform's installer)
cloudflared tunnel --url http://127.0.0.1:8870 # prints https://<random>.trycloudflare.com
```

Because the URL is only known once it starts, bring the Bridge up *after* you have it:

```bash
# terminal 1 — start the tunnel and capture the URL
cloudflared tunnel --url http://127.0.0.1:8870 2>&1 | tee /tmp/cf.log
#   …note the printed https://<random>.trycloudflare.com

# terminal 2 — start the Bridge pinned to that URL
TERMDECK_BRIDGE_PUBLIC_URL=https://<random>.trycloudflare.com \
TERMDECK_BRIDGE_OPERATOR_SECRET='…' npm start
```

### A2. Named tunnel (stable hostname — recommended for daily use)

```bash
cloudflared tunnel login
cloudflared tunnel create termdeck-bridge
cloudflared tunnel route dns termdeck-bridge bridge.example.com
# ~/.cloudflared/config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: ~/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: bridge.example.com
#       service: http://127.0.0.1:8870
#     - service: http_status:404
cloudflared tunnel run termdeck-bridge
```

`PUBLIC_URL = https://bridge.example.com` — stable, so set it once and forget it.

---

## Option B — Anthropic MCP Tunnels (preferred for the Claude endpoint)

An Anthropic-managed **outbound gateway** purpose-built for connecting Claude to a
local MCP server. The tunnel is initiated outbound from your machine (no inbound
firewall holes), and the path stays within Anthropic's infrastructure — which is why
it's the preferred transport for the **Claude.ai** connector specifically.

Setup is driven from the Claude side: provision an MCP tunnel pointed at the local
Bridge endpoint `http://127.0.0.1:8870/mcp`; it yields a public HTTPS URL you use as
both `TERMDECK_BRIDGE_PUBLIC_URL` and the connector URL in Claude.ai.

> **Verify the exact provisioning step against Claude's current MCP-connector docs at
> setup time** — the feature and its CLI/flags evolve, and this repo does not pin a
> specific invocation. **cloudflared (Option A) is the tested fallback and works for
> Claude too**, so if MCP Tunnels isn't available to you, use a cloudflared named
> tunnel and paste that URL into the Claude connector instead.

---

## Option C — ngrok (alternative)

```bash
ngrok http 8870        # prints https://<id>.ngrok-free.app  → use as PUBLIC_URL
```

---

## Prove public reachability (before adding to any provider)

With the tunnel up and `PUBLIC_URL` set, from anywhere:

```bash
H=https://<your-tunnel-host>

curl -s "$H/healthz" | jq .
#   → { "ok": true, "name": "termdeck-mcp-bridge", "tools": 6, "auth": "oauth", "resource": "https://…/mcp" }

curl -s "$H/.well-known/oauth-protected-resource/mcp" | jq .
#   → { "resource": "https://…/mcp", "authorization_servers": ["https://…"], … }

curl -s "$H/.well-known/oauth-authorization-server" | jq '{token_endpoint, authorization_endpoint, registration_endpoint, code_challenge_methods_supported}'
#   → endpoints present; code_challenge_methods_supported includes "S256"

# /mcp without a token MUST 401 with a WWW-Authenticate pointing at the PRM:
curl -si -X POST "$H/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | grep -i www-authenticate
#   → WWW-Authenticate: Bearer …, resource_metadata="https://…/.well-known/oauth-protected-resource/mcp"
```

If all four behave as above, a provider's connector will be able to discover, register
(DCR), and complete the OAuth 2.1 + PKCE flow against your Bridge.

---

## Then connect a provider

Paste **`https://<your-tunnel-host>/mcp`** into the provider's connector and complete
the flow (DCR → PKCE `/authorize` → **operator-secret consent** → `/token`):

- **Claude.ai** (Custom Connectors) → `connect-claude.md`
- **ChatGPT** (Developer Mode) → `connect-chatgpt.md`
- **Grok** (BYO-MCP) → `connect-grok.md`

---

## Security checklist before exposing a tunnel

- [ ] `TERMDECK_BRIDGE_OPERATOR_SECRET` set to a strong passphrase (don't ship the ephemeral one).
- [ ] Allowlist configured — **default-deny**: panel tools return nothing until you opt projects/panels in.
- [ ] Org literals in the external redaction denylist (`TERMDECK_BRIDGE_REDACT_LITERALS` / `~/.termdeck/bridge-redact.json`), **never** in the repo.
- [ ] `TERMDECK_BRIDGE_STATIC_BEARER` **unset** (dev-only).
- [ ] HTTPS only — never expose the raw `127.0.0.1:8870` port directly; always front it with the tunnel.
- [ ] Remember the layered defenses are all active: **OAuth bearer gate → operator consent → read-only manifest → default-deny allowlist → egress redaction**. The Bridge is read-only by construction; a connected chat can at worst *read* what you allowlisted, with secrets scrubbed.

---

## Why not the SDK's localhost Host-validation?

The MCP SDK's `createMcpExpressApp` can apply DNS-rebinding protection by rejecting
requests whose `Host` header isn't localhost. Behind a tunnel that is exactly wrong —
the forwarded `Host` is your **public** tunnel hostname, so that check would reject all
legitimate traffic. The Bridge therefore does **not** use it; the **OAuth bearer token
is the gate**. If you want Host pinning anyway, set `TERMDECK_BRIDGE_ALLOWED_HOSTS` to
your tunnel hostname(s) and the Bridge will enforce it.
