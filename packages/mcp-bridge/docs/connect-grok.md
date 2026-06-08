# Connect Grok to the MCP Bridge

Connect **Grok** (grok.com) to your self-hosted Bridge via its **Bring-Your-Own-
MCP** custom-connector feature (shipped May 6 2026), so a Grok chat can pull your
Mnestra memory and see live TermDeck terminal state — read-only, egress-redacted,
approval-gated.

> Same security posture as the other providers: **read-only** tools only, every
> result **egress-redacted**, the four terminal-state tools **approval-gated**,
> panel visibility **default-deny** via the allowlist. Tool list + allowlist
> details are in `connect-claude.md` (identical here).

> **Scope note.** This is the **inbound** direction — Grok *pulls* from the Bridge
> through its own connector. It is unrelated to driving a Grok web-chat panel
> *outbound* (Sprint 72 / Workstream B). Connecting here does **not** touch Grok
> model routing.

## Prerequisites

1. **A paid Grok tier.** BYO-MCP custom connectors require **SuperGrok** or
   **Premium+** — the free tier cannot add custom MCP servers.
2. **Bridge running + a public HTTPS tunnel** (cloudflared recommended, per
   `docs/tunnel.md`). MCP endpoint: **`https://<your-tunnel-host>/mcp`**.
3. **Mnestra reachable** (`MNESTRA_WEBHOOK_URL`, default
   `http://localhost:37778/mnestra`) and **TermDeck running**
   (`TERMDECK_BASE_URL`, default `http://127.0.0.1:3000`).

## Connect

1. Go to **grok.com → Settings → Connectors** (or directly **grok.com/connectors**).
2. Click **New → Custom**.
3. Paste the MCP endpoint URL: **`https://<your-tunnel-host>/mcp`**.
4. **Authenticate** via **OAuth 2.1 + PKCE**: Grok reads the Bridge's auth
   metadata, registers dynamically, and runs the authorize/token flow. At the
   Bridge's **`/authorize`** consent screen, enter your **operator secret** to
   approve.
5. Enable the connector. The Bridge's read-only tools become available to Grok.

## Smoke test

In a Grok chat with the connector enabled:

- **Memory:** *"Use memory_recall to pull my decisions about the MCP Bridge."* →
  redacted memory list.
- **Panels (approval-gated):** *"List my terminal panels,"* then *"read the latest
  from panel &lt;id&gt;."* → `list_panels` then `read_panel`; Grok prompts for
  approval before the terminal-state calls; output is bounded + redacted.

## Troubleshooting

- **No "Custom" option under Connectors:** you're on a tier without BYO-MCP —
  upgrade to SuperGrok / Premium+.
- **Connect fails through the tunnel:** confirm `https://<host>/mcp` is reachable;
  cloudflared's forwarded `Host` is tolerated by default (OAuth bearer is the
  gate). If `TERMDECK_BRIDGE_ALLOWED_HOSTS` is set, include your tunnel host.
- **401 after auth:** re-run connect so a fresh audience-bound token is minted.
- **Empty panel results:** allowlist is default-deny — opt a project in.
- **Memory tool errors:** Mnestra not in webhook mode / wrong `MNESTRA_WEBHOOK_URL`.

See also: `connect-claude.md`, `connect-chatgpt.md`, `docs/tunnel.md`.
