# Connect Claude.ai to the MCP Bridge

Connect the **Claude.ai** web/desktop app to your self-hosted Bridge as a **Custom
Connector**, so a Claude chat can pull your Mnestra memory and see live TermDeck
terminal state — read-only, egress-redacted, approval-gated.

> **What the chat can do once connected:** `memory_recall`, `memory_search`
> (your long-term memory) and `list_panels`, `panel_status`, `read_panel`,
> `recent_activity` (live terminal state). Everything is **read-only** — there is
> no write/input/poke tool. Every result is scrubbed by the egress redactor
> before it leaves your machine. The four terminal-state tools are **approval-
> gated**: Claude asks you before each call. Only panels in your **allowlist** are
> visible (default-deny — see "Allowlist" below).

## Prerequisites

1. **Bridge running + a public HTTPS tunnel.** Follow `docs/tunnel.md` (T1) to
   start the Bridge and bring up an **Anthropic MCP Tunnel** (the recommended
   path for the Claude endpoint). You'll end up with a public URL like
   `https://<your-tunnel-host>` whose MCP endpoint is **`https://<your-tunnel-host>/mcp`**.
2. **Mnestra reachable** over its webhook (default `http://localhost:37778/mnestra`)
   — `memory_recall`/`memory_search` route through it. Set `MNESTRA_WEBHOOK_URL`
   if yours differs.
3. **TermDeck running** (default `http://127.0.0.1:3000`) for the panel tools.
   Set `TERMDECK_BASE_URL` if yours differs.
4. A **Claude.ai plan that supports Custom Connectors** (Pro / Max / Team /
   Enterprise).

## Connect

1. In Claude.ai, open **Settings → Connectors**.
2. Click **Add custom connector**.
3. Paste your MCP endpoint URL: **`https://<your-tunnel-host>/mcp`**.
4. Claude discovers the server's auth metadata automatically
   (`/.well-known/oauth-protected-resource/mcp` → your Bridge's OAuth 2.1
   Authorization Server). It performs **Dynamic Client Registration** (`/register`)
   and starts the **OAuth 2.1 + PKCE** flow — no client ID/secret to copy by hand.
5. You'll be redirected to the Bridge's **`/authorize`** consent screen. Enter
   the **operator secret** (the consent passphrase you configured per
   `docs/tunnel.md`) to approve the connection. This is the gate that stops anyone
   who merely discovers the tunnel URL from connecting.
6. Approve. Claude exchanges the code at **`/token`**, and the Bridge's tools
   appear in the connector's tool list.

## Smoke test

In a new chat with the connector enabled, try:

- **Memory:** *"Use memory_recall to find what I decided about the MCP Bridge
  threat model."* → Claude calls `memory_recall`; you should see a short list of
  memories, with any secrets shown as `‹redacted:…›`.
- **Panels (approval-gated):** *"List my open terminal panels."* → Claude calls
  `list_panels`; **Claude prompts you to approve** the call first. Approve → you
  get the roster of allowlisted panels (labels, projects, status, last activity —
  metadata only).
- **Panel content (approval-gated):** *"Read the latest output from panel
  &lt;id&gt;."* → `read_panel` returns the **last ~4000 chars** of that panel's
  transcript (bounded; never full history), again after an approval prompt.

## Allowlist (what panels Claude can see)

Panel visibility is **default-deny**. Until you opt a project or panel in, the
panel tools return nothing. Opt in via either:

- env: `TERMDECK_BRIDGE_ALLOWLIST_PROJECTS=termdeck,podium` (and/or
  `TERMDECK_BRIDGE_ALLOWLIST_PANELS=<session-id>,…`), or
- file `~/.termdeck/bridge-allowlist.json`:
  ```json
  { "projects": ["termdeck"], "panels": [] }
  ```
- `"*"` in either list opts into "all panels visible" (not recommended).

## Troubleshooting

- **"Couldn't reach the server" / 4xx on connect:** confirm the tunnel is up and
  `https://<host>/mcp` is reachable; check `docs/tunnel.md`.
- **Stuck at the consent screen:** the operator secret is wrong — re-check the
  value from your Bridge config.
- **Tools call but return empty panel lists:** your allowlist is empty
  (default-deny). Opt a project in (above).
- **Memory tools error with "Mnestra webhook returned …":** Mnestra isn't running
  in webhook mode or `MNESTRA_WEBHOOK_URL` is wrong. Start it (`mnestra serve
  --webhook`) or fix the URL.

See also: `connect-chatgpt.md`, `connect-grok.md`, and `docs/tunnel.md` (transport
+ auth + tunnel setup).
