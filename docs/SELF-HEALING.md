# TermDeck self-healing

Three independent layers keep the daily-driver stack alive without manual
re-bring-up. Shipped 2026-06-09 (Sprint-72 hardening).

## 1. Web-chat render-watchdog (panel-level)

A brand-new browser profile's *first* cold-start occasionally paints nothing
(white) even though CDP attach + screencast are healthy — a flaky race, not a
config bug (5 fresh repros rendered; only the live panel wedged). A full
re-navigation clears it; a `reload` does **not**.

`setupWebChatSession()` (`packages/server/src/index.js`) now polls the tab for a
painted body (`innerText.length > 0`) for ~8s; if blank it re-navigates up to
2× and, if it still never paints, degrades the panel to `errored` with a clear
detail rather than leaving a silent white panel. Tunable:

| env | default | effect |
|---|---|---|
| `TERMDECK_WEBCHAT_RENDER_SETTLE_MS` | `8000` | per-attempt settle window |
| `TERMDECK_WEBCHAT_RENDER_ATTEMPTS` | `2` | re-navigation attempts before erroring |
| `TERMDECK_WEBCHAT_RENDER_STEP_MS` | `500` | paint-poll interval |

Regression tests: `packages/server/tests/web-chat-seams.test.js` (blank → self-heals; never-paints → errored).

## 2. Server crash guard (process-level)

The server now installs fail-soft `unhandledRejection` + `uncaughtException`
handlers (in the `main()` startup block — not `createServer`, so tests are
unaffected). One bad async error in a panel handler, request, or hook **logs**
(per-event ISO timestamp, greppable like the boot banner) and the server keeps
running instead of crashing and taking *every* live panel down with it. The
supervisor (below) is the backstop if the process ever truly wedges.

## 3. Stack supervisor (process keep-alive)

`scripts/termdeck-supervise.sh` ensures — and restarts if down — the four
processes, detecting each by **port** (never process-arg path; `pgrep -f
'mcp-bridge/src/server.js'` is a false-negative because the bridge's argv is
just `node src/server.js`):

| # | component | port | restart |
|---|---|---|---|
| 1 | TermDeck server | `:3000` | `node packages/server/src/index.js` (with `secrets.env`) |
| 2 | Mnestra webhook | `:37778` | `mnestra serve` |
| 3 | cloudflared tunnel | — (→ `:8870`) | named (stable) or quick (ephemeral) |
| 4 | MCP bridge | `:8870` | re-pinned to the current tunnel URL |

Idempotent (run once = bring up; run on a timer = keep up). It **adopts** an
already-running stack (learns the live tunnel URL from the bridge's `/healthz`
so it never spawns a duplicate), keeps a **stable** operator secret
(`~/.termdeck/bridge-operator-secret.txt`) so restarts don't silently change the
consent secret, and re-pins the bridge whenever the public URL drifts.

**Test before trusting it** (zero side effects):

```bash
TERMDECK_SUPERVISE_DRY_RUN=1 bash scripts/termdeck-supervise.sh   # logs intended actions only
```

**Install on a 60s timer** (operator — launchd can't be loaded from the sandbox):

```bash
cp scripts/com.jhizzard.termdeck-supervise.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist
```

State + logs live in `~/.termdeck/` (`logs/supervise.log`, `bridge-public-url.txt`,
`bridge-operator-secret.txt`).

## First-class config (no more env-only)

| file | purpose | reload |
|---|---|---|
| `~/.termdeck/bridge-allowlist.json` | which projects/panels web chats may see (`{"projects":["*"]}` = all, still approval-gated) | **hot** (read every tool call) |
| `~/.termdeck/bridge-redact.json` | egress redaction literals (never leave the host) | on bridge start |
| `~/.termdeck/supervisor.env` | supervisor overrides (repo dir, tunnel name, allowlist) | each tick |

> A guided `termdeck init` wizard step for these is a future enhancement; today
> they are file-based and (for the allowlist) hot-reloaded, which is enough for
> the daily driver.

## Stable hostname (kills connector-breaks-on-restart)

Quick tunnels rotate their hostname when `cloudflared` restarts, which breaks
every connector. For a **stable** URL so Grok/ChatGPT/Claude.ai connectors
survive restarts, use a **named** cloudflared tunnel (requires a Cloudflare
account + a domain you control):

```bash
cloudflared tunnel login                       # browser auth, once
cloudflared tunnel create termdeck-bridge
cloudflared tunnel route dns termdeck-bridge bridge.<your-domain>
# then in ~/.termdeck/supervisor.env:
#   TERMDECK_TUNNEL_NAME=termdeck-bridge
#   TERMDECK_PUBLIC_HOSTNAME=bridge.<your-domain>
```

The supervisor will then run the named tunnel (stable URL) and the connectors
stop breaking on restart. Until a domain is set up, quick tunnels work but the
URL changes whenever `cloudflared` itself restarts.

The end-to-end install flow (named tunnel + supervisor on launchd/systemd +
provider connect) is **Tier 5** in [`GETTING-STARTED.md`](./GETTING-STARTED.md);
Linux units live at `docs/examples/termdeck-supervise.{service,timer}`.

## Activation

The watchdog + crash guard are **server code** — they take effect on the next
server restart. The supervisor + config are live as soon as you run/install them.
