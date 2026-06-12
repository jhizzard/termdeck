# Connect Gemini Enterprise to the MCP Bridge

Connect **Gemini Enterprise** to your self-hosted Bridge via its **custom MCP
connector** (preview), so a Gemini Enterprise chat can pull your Mnestra memory
and see live TermDeck terminal state — read-only, egress-redacted,
approval-gated.

> Same security posture as the other providers: **read-only** tools only, every
> result **egress-redacted**, the four terminal-state tools **approval-gated**,
> panel visibility **default-deny** via the allowlist. Tool list + allowlist
> details are in `connect-claude.md` (identical here).

> **Why this page is different.** Claude.ai / ChatGPT / Grok register
> themselves via **Dynamic Client Registration** — you only paste a URL. The
> Gemini Enterprise connector **cannot DCR**: an admin enters a **static
> client_id + client_secret** plus the authorize/token URLs by hand. The Bridge
> supports exactly that (Sprint 75): a **pre-seeded static OAuth client**
> configured by env or options, alongside the existing DCR path.

## Prerequisites

1. **A Gemini Enterprise plan** with the custom MCP connector feature
   (in preview; admin access to the connector / integrations configuration is
   required).
2. **Bridge running + a public HTTPS tunnel** (cloudflared recommended, per
   `docs/tunnel.md`). MCP endpoint: **`https://<your-tunnel-host>/mcp`**.
3. **Mnestra reachable** (`MNESTRA_WEBHOOK_URL`, default
   `http://localhost:37778/mnestra`) and **TermDeck running**
   (`TERMDECK_BASE_URL`, default `http://127.0.0.1:3000`).

## Step 1 — Seed a static client on the Bridge

Generate a strong secret (this is the credential Gemini will present — treat it
like a password):

```bash
openssl rand -base64 32
```

Configure the Bridge (env, alongside your other `TERMDECK_BRIDGE_*` vars):

```bash
TERMDECK_BRIDGE_STATIC_CLIENT_ID=gemini-enterprise
TERMDECK_BRIDGE_STATIC_CLIENT_SECRET=<the-secret-you-generated>
# Gemini's exact redirect URI — see Step 2 (comma-separate if more than one):
TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS=<gemini-redirect-uri>
```

Restart the Bridge. Notes:

- The static client lives **in memory only** — it is never written to
  `~/.termdeck/bridge-auth.json`. The env (or `staticClients` option) is the
  secret's single source of truth.
- The id must **not** start with `mcp_` (reserved for DCR-registered clients).
- Multiple static clients: use the `staticClients` option array
  (`{ client_id, client_secret, redirect_uris, client_name?, scope?,
  allow_no_pkce? }`) instead of the env single-client shorthand.
- The token endpoint accepts the secret as **`client_secret_post`** (form
  body) **or `client_secret_basic`** (Authorization header) — whichever the
  connector sends.

## Step 2 — Register the connector in Gemini Enterprise

In the Gemini Enterprise admin console, add a **custom MCP connector** (the
preview UI may move between releases; the fields are stable):

| Field | Value |
|---|---|
| MCP server / endpoint URL | `https://<your-tunnel-host>/mcp` |
| Auth type | OAuth 2.0 (authorization code) |
| Client ID | `gemini-enterprise` (your `TERMDECK_BRIDGE_STATIC_CLIENT_ID`) |
| Client secret | the secret from Step 1 |
| Authorization URL | `https://<your-tunnel-host>/authorize` |
| Token URL | `https://<your-tunnel-host>/token` |

The connector config shows the **redirect URI** Gemini will send users back
through (a Google-hosted callback URL). **Copy it exactly** into
`TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS` and restart the Bridge — the
Bridge exact-matches redirect URIs against the registration, so a missing or
mistyped value fails the authorize step with `Unregistered redirect_uri`.

> Chicken-and-egg: if the console only reveals the redirect URI after you save
> the connector, save it first with the other fields filled in, copy the
> redirect URI, then set the env and restart the Bridge before testing.

## Step 3 — Authorize

Start the connection from Gemini Enterprise (enable the connector / connect as
a user). You'll be redirected to the Bridge's **`/authorize`** consent screen —
enter your **operator secret** to approve, exactly as with the other providers.
Gemini exchanges the code at **`/token`** and the Bridge's read-only tools
appear.

## Smoke test

In a Gemini Enterprise chat with the connector enabled:

- **Memory:** *"Use memory_recall to pull my decisions about the MCP Bridge."*
  → redacted memory list.
- **Panels (approval-gated):** *"List my TermDeck panels,"* then *"read the
  latest output from panel &lt;id&gt;."* → `list_panels` then `read_panel`,
  approval-prompted, bounded + redacted.

## Troubleshooting

- **Authorize step bounces straight back with `error=invalid_request` (no
  consent screen):** the connector did not send a PKCE `code_challenge`. The
  Bridge requires PKCE by default (OAuth 2.1). If your Gemini Enterprise
  connector version doesn't send PKCE, opt this one client out:

  ```bash
  TERMDECK_BRIDGE_STATIC_CLIENT_ALLOW_NO_PKCE=1
  ```

  Security framing: this relaxation applies **only** to this static
  confidential client — the grant is still gated by the client_secret
  (verified timing-safely) plus the operator consent screen, so PKCE here is
  defense-in-depth rather than the primary credential. It can never apply to
  DCR/public clients (Claude/ChatGPT/Grok keep full PKCE), and codes issued
  with PKCE can never be redeemed without it.
- **`invalid_client` at the token step:** the client secret pasted into the
  console doesn't match `TERMDECK_BRIDGE_STATIC_CLIENT_SECRET` (or the id
  doesn't match). Re-paste both.
- **`Unregistered redirect_uri` at the authorize step:** the redirect URI in
  `TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS` isn't byte-identical to what
  Gemini sends. Re-copy it from the connector config.
- **Connector can't reach the server:** verify `https://<your-tunnel-host>/mcp`
  is live (`docs/tunnel.md`). If `TERMDECK_BRIDGE_ALLOWED_HOSTS` is set,
  include your tunnel host.
- **401 after auth:** re-run the connect flow so a fresh audience-bound token
  is minted.
- **Empty panel results:** allowlist is default-deny — opt a project in
  (`TERMDECK_BRIDGE_ALLOWLIST_PROJECTS=…` or `~/.termdeck/bridge-allowlist.json`).
- **Memory tool errors:** Mnestra not in webhook mode / wrong
  `MNESTRA_WEBHOOK_URL`.

See also: `connect-claude.md`, `connect-chatgpt.md`, `connect-grok.md`,
`docs/tunnel.md`.
