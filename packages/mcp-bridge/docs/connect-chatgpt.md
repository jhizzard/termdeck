# Connect ChatGPT to the MCP Bridge

Connect **ChatGPT** to your self-hosted Bridge via **Developer Mode** custom
connectors, so a ChatGPT conversation can pull your Mnestra memory and see live
TermDeck terminal state — read-only, egress-redacted, approval-gated.

> Same security posture as the other providers: **read-only** tools only, every
> result **egress-redacted**, the four terminal-state tools **approval-gated**,
> and panel visibility **default-deny** via the allowlist. See `connect-claude.md`
> for the full tool list and allowlist details (identical here).

## Prerequisites

1. **Bridge running + a public HTTPS tunnel.** Follow `docs/tunnel.md` (T1). For
   the ChatGPT/Grok endpoint the recommended tunnel is **cloudflared**, giving a
   URL like `https://<your-tunnel-host>`; the MCP endpoint is
   **`https://<your-tunnel-host>/mcp`**.
2. **Mnestra reachable** (`MNESTRA_WEBHOOK_URL`, default
   `http://localhost:37778/mnestra`) and **TermDeck running**
   (`TERMDECK_BASE_URL`, default `http://127.0.0.1:3000`).
3. A **ChatGPT plan with Developer Mode / custom connectors** (Plus / Pro /
   Business, where available).

## Enable Developer Mode + connect

1. In ChatGPT, open **Settings → Connectors**.
2. Open **Advanced** and enable **Developer Mode** (this is what exposes the
   "add a custom MCP connector by URL" option).
3. **Create / Add** a custom connector and paste the MCP endpoint URL:
   **`https://<your-tunnel-host>/mcp`**.
4. **Authenticate.** Two supported paths:
   - **OAuth 2.1 + PKCE (recommended).** ChatGPT reads the Bridge's auth metadata
     (`/.well-known/oauth-protected-resource/mcp`), performs Dynamic Client
     Registration, and runs the authorize/token flow. You'll hit the Bridge's
     **`/authorize`** consent screen — enter your **operator secret** to approve.
   - **Static bearer token (dev only).** For a quick local bring-up, the Bridge
     can issue a **static bearer** you paste into the connector's auth field. This
     is a **development convenience** — prefer OAuth for anything beyond local
     testing. (How to mint the dev bearer: see `docs/tunnel.md` → auth.)
5. Save. The Bridge's tools appear under the connector.

## Smoke test

With the connector enabled in a chat (Developer Mode shows MCP tool calls inline):

- **Memory:** *"Call memory_recall for my notes on the MCP Bridge egress model."*
  → expect a redacted memory list.
- **Panels (approval-gated):** *"List my TermDeck panels,"* then *"show the last
  output of panel &lt;id&gt;"* → `list_panels` then `read_panel`; ChatGPT surfaces
  the tool call for your approval before each, and results are bounded + redacted.

## Troubleshooting

- **Connector won't add / "invalid server":** verify `https://<host>/mcp` is live
  through the tunnel (`docs/tunnel.md`). cloudflared forwards a non-localhost
  `Host` header; the Bridge tolerates this by default (OAuth bearer is the gate).
  If you've set `TERMDECK_BRIDGE_ALLOWED_HOSTS`, make sure your tunnel host is in
  it.
- **401 after auth:** the access token's audience must match the Bridge's resource
  URI. Re-run the connect flow so a fresh, audience-bound token is issued.
- **Empty panel results:** allowlist is default-deny — opt a project in
  (`TERMDECK_BRIDGE_ALLOWLIST_PROJECTS=…` or `~/.termdeck/bridge-allowlist.json`).
- **Memory tool errors:** Mnestra not in webhook mode / wrong `MNESTRA_WEBHOOK_URL`.

See also: `connect-claude.md`, `connect-grok.md`, `docs/tunnel.md`.
