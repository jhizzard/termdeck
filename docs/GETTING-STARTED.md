# Getting Started: TermDeck + Mnestra + Rumen

The full stack in four tiers — plus an optional fifth (the Web-Chat Bridge, so Claude.ai / ChatGPT / Grok can read your stack). Each tier is independent — stop wherever you have what you need.

**Quick path (Quick mode):** Tier 1 takes 2 minutes, zero config. You get a working terminal multiplexer. Stop there if that's all you want. Each subsequent tier adds a heading that says what you gain and what it costs.

**Full path (Full stack mode):** All four tiers take ~30 minutes. You get a closed-loop cognitive system where your terminals remember what you fixed, learn while you sleep, and surface relevant memories when you hit the same error on a different project. Read straight through.

---

## Prerequisites

| Requirement | Tier | Notes |
|---|---|---|
| **Node 18+** | 1+ | `node --version` to check |
| **macOS or Linux** | 1+ | Windows not supported. Alpine/musl not supported (no prebuilt PTY binaries). |
| **Supabase project** | 2+ | Free tier works. [supabase.com](https://supabase.com) |
| **OpenAI API key** | 2+ | For `text-embedding-3-large` embeddings in Mnestra |
| **Anthropic API key** | 3 | For Haiku synthesis in Rumen |
| **Supabase CLI + Deno** | 3 | Required only for Edge Function deployment |
| **Claude Code (or another AI CLI)** | optional | TermDeck panels run *any* command; Claude Code (`claude`) is the default. Install: `npm install -g @anthropic-ai/claude-code` (Linux x64: see hint below). |

### Linux x64 install hint

The pass-`--include=optional` rule for npm-globally-suppressed optional deps. Both `@jhizzard/termdeck-stack` and `@anthropic-ai/claude-code` ship platform-specific native binaries via npm `optionalDependencies`. On macOS this is invisible — npm installs the matching binary automatically. **On Linux x64, if your environment has set `omit=optional`** (check with `npm config get omit`; common in CI images, slim Docker bases, or after running `npm install --omit=optional` once at user-config level), npm silently skips the platform binary and the installed `claude` stub fails `claude --version` with a missing-binary error. The fix is to pass `--include=optional` explicitly on the install:

```bash
# macOS (default behavior is already correct, but the flag is harmless)
npm install -g @jhizzard/termdeck-stack
npm install -g @anthropic-ai/claude-code

# Linux x64 (mandatory if `npm config get omit` returns `optional`)
npm install -g @jhizzard/termdeck-stack --include=optional
npm install -g @anthropic-ai/claude-code --include=optional
```

If you've already installed without the flag and `claude --version` fails, re-install with the flag — npm will pick up the missed platform binary on the second pass. This affects any `optionalDependencies`-using package; the flag is a safe always-on choice on Linux x64.

---

## Quick start (any tier)

The stack launcher handles everything — loads secrets, kills stale processes, starts Mnestra if installed, boots TermDeck:

**Globally-installed stack (recommended for outside users):**

```bash
npm i -g @jhizzard/termdeck-stack
termdeck-stack start
```

This boots Mnestra (if Tier 2+ is installed) and the TermDeck server, prints a numbered three-step status line, and exits. Stop with `termdeck-stack stop`; check health with `termdeck-stack status`. The launcher writes `~/.termdeck/stack.pid` so subsequent `stop`/`status` calls find the right processes.

**npm-installed (v0.4.6+, equivalent stack flow):**

```bash
termdeck stack
```

**Repo clone (development):**

```bash
./scripts/start.sh
```

All three produce equivalent step-by-step output. From v0.5.0, plain `termdeck` auto-detects a configured stack and routes through the orchestrator — `termdeck stack` becomes the explicit-force form. Use `termdeck --no-stack` to force a Tier-1-only boot.

It gracefully skips anything that isn't installed. Tier 1 users get a working dashboard. Full-stack users get the whole pipeline.

---

## Tier 1: Terminal Multiplexer (2 minutes)

Two ways to launch, depending on whether you've cloned the repo:

**npm users (no repo clone):**

```bash
npx @jhizzard/termdeck
```

This pulls the published package and runs the `termdeck` bin. Requires Node 18+ and a working `npx`. If `npx` can't resolve the bin (older versions of the package shipped without the bin wired up), upgrade with `npm install -g @jhizzard/termdeck@latest` and run `termdeck` directly.

**Global launcher (no repo clone, persistent):**

```bash
npm i -g @jhizzard/termdeck-stack
termdeck-stack start
```

Boots the full stack (Mnestra autostart + TermDeck server) detached and prints a status line. Same flow as `./scripts/start.sh` but ships in the npm package — no repo clone required. Use `termdeck-stack stop`/`status` for the matching subcommands.

**Repo-clone users (development):**

```bash
./scripts/start.sh
```

From the cloned repo root. This launcher runs the server directly from `packages/cli/src/index.js` instead of the global bin — useful when hacking on TermDeck itself. The published `termdeck-stack start` subcommand is preferred for outside users.

Either path opens the browser at `http://127.0.0.1:3000`. No accounts, no credentials, no database.

**What you get:** real PTY shells via prebuilt `node-pty` (no C++ toolchain), 7 grid layouts (1x1 through 4x2 plus focus/half modes), 8 themes (Tokyo Night, Catppuccin Mocha, Rose Pine Dawn, Dracula, Nord, Gruvbox Dark, Solarized Dark, GitHub Light), per-panel metadata overlays, output analyzer for Claude Code / Gemini CLI / Python servers, onboarding tour, local SQLite persistence, health badge in the toolbar.

**Verify:**

1. Type `bash` in the prompt bar, click Launch — terminal panel appears
2. Run `echo hello && ls` to confirm interactivity
3. Open 2-3 more terminals, switch layouts with `Cmd+Shift+1` through `6`
4. Health badge in the top bar shows "Tier 1: OK" in green

**What's not active yet:** Flashback toasts (need Mnestra). Morning briefing (needs Rumen). Transcript backup to cloud (needs DATABASE_URL). All of these are silent — no errors, just features waiting for their tier.

**Setup wizard:** Click **config** in the toolbar to see your setup status and get guided instructions for each tier. The wizard detects which tiers are active, flags missing pieces, and links back into the steps below.

### >> STOP HERE if you just want a browser terminal multiplexer.

---

## Tier 2: Mnestra Memory (10 minutes)

**What you gain:** Flashback — when a terminal panel errors, TermDeck queries your memory store for similar past errors across all projects and surfaces the match as a toast. Plus: your AI editor (Claude Code, Cursor, Windsurf, Cline) gains persistent memory via MCP.

**What it costs:** A Supabase project (free tier), an OpenAI API key, ~10 minutes of setup.

### Step 1 — Install Mnestra and create Supabase project

```bash
npm install -g @jhizzard/mnestra
mnestra --version  # verify
```

Create a project at [supabase.com](https://supabase.com). Copy **Project URL** and **service_role key** from Project Settings > API.

### Step 2 — Get your DATABASE_URL

Dashboard > **Connect** (green button) > **Transaction pooler** tab > **toggle ON "Use IPv4 connection (Shared Pooler)"** (this is critical — see [RUMEN-UNBLOCK.md](./RUMEN-UNBLOCK.md) gotcha #1). Copy the displayed URL. Type your password in the password field at the top — it substitutes into the URL.

> **Note on pooler URL query parameters.** Supabase's Transaction pooler URL often appears as `...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`. Those `pgbouncer=true` and `connection_limit=1` parameters are **Prisma-specific hints** that Prisma's connection-string parser strips before opening the underlying `pg` connection. `psql` and other plain-`pg` clients (including TermDeck's wizard and `mnestra doctor` probes) treat them as unknown libpq params and emit a harmless `WARNING: invalid configuration parameter` on connect. The cross-client portable form is plain `?sslmode=require` — both shapes work, the Prisma-specific form just adds noise to `psql` output. **Either is safe to paste** into `DATABASE_URL`; if you want a clean `psql` log, trim back to `?sslmode=require`. Do not surround the value with quotes — the URL parser does not strip them and you'll see `Invalid URL`.

### Step 3 — Apply migrations

```bash
export DATABASE_URL="<paste the URL you just copied>"

for i in 001 002 003 004 005 006; do
  psql "$DATABASE_URL" -f "$(npm root -g)/@jhizzard/mnestra/migrations/${i}_*.sql"
done
```

Verify: `psql "$DATABASE_URL" -c "SELECT count(*) FROM memory_items"` returns `0` with no errors.

### Step 4 — Create secrets and config

```bash
mkdir -p ~/.termdeck

cat > ~/.termdeck/secrets.env <<'EOF'
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
EOF
```

```bash
cat > ~/.termdeck/config.yaml <<'YAML'
port: 3000
defaultTheme: tokyo-night

rag:
  enabled: true
  supabaseUrl: ${SUPABASE_URL}
  supabaseKey: ${SUPABASE_SERVICE_ROLE_KEY}

projects:
  my-project:
    path: ~/path/to/your/project
    defaultTheme: tokyo-night
    defaultCommand: claude
YAML
```

Verify: `grep -c '=' ~/.termdeck/secrets.env` returns `5`.

### Step 5 — Restart TermDeck

```bash
npx @jhizzard/termdeck
```

Health badge now shows "Stack: OK" (or "Stack: 4/6" — Mnestra reachable and Rumen checks depend on whether you start the Mnestra server and set up Rumen).

### Step 6 (optional) — Mnestra as Claude Code MCP server

This gives Claude Code six persistent memory tools (`memory_recall`, `memory_remember`, `memory_search`, `memory_forget`, `memory_status`, `memory_summarize_session`).

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mnestra": {
      "command": "mnestra",
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_...",
        "OPENAI_API_KEY": "sk-proj-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Code. Verify: `/mcp` shows six `memory_*` tools.

### >> STOP HERE if you want Flashback + MCP memory but not the async learning loop.

---

## Tier 3: Rumen Async Learning (15 minutes)

**What you gain:** A Supabase Edge Function on a 15-minute `pg_cron` schedule that reads your recent memories, cross-references them via hybrid search (keyword + vector), synthesizes higher-order insights via Claude Haiku, and writes those insights back into Mnestra. Flashback then surfaces cross-project patterns you never explicitly saved.

**What it costs:** Anthropic API key (Haiku is cheap — soft cap 100 calls/day), Deno, Supabase CLI, ~15 minutes.

### Five gotchas (read before starting)

Full detail in [RUMEN-UNBLOCK.md](./RUMEN-UNBLOCK.md). Summary:

| # | Gotcha | Fix |
|---|---|---|
| 1 | Supabase Connect modal defaults to IPv6-only Dedicated Pooler | Toggle ON "Use IPv4 connection (Shared Pooler)" before copying URL |
| 2 | Password reset takes the literal string (no URL-decoding) | Use alphanumeric-only passwords |
| 3 | Setting `DIRECT_URL` alongside `DATABASE_URL` breaks auth | Set `DATABASE_URL` only |
| 4 | `brew install deno` fails on macOS 13 (needs Xcode 15) | Use `curl -fsSL https://deno.land/install.sh \| sh` |
| 5 | Schema drift from earlier failed installs | Run backfill SQL from RUMEN-UNBLOCK.md Step 5a first |

### Step 1 — Install Deno and Supabase CLI

```bash
curl -fsSL https://deno.land/install.sh | sh  # NOT brew on macOS 13
brew install supabase/tap/supabase
```

Add to `~/.zshrc`:

```bash
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
```

Verify: `source ~/.zshrc && deno --version && supabase --version`

### Step 2 — Supabase access token

Generate at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). Add to `~/.zshrc`:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
```

Verify: `source ~/.zshrc && supabase projects list` (no 401 error).

### Step 3 — Enable extensions and Vault secret

In Supabase Dashboard > Integrations: enable **Cron** (`pg_catalog` schema). Then in SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS pg_net;
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');  -- expect 2 rows
```

Vault secrets (`rumen_service_role_key` and `graph_inference_service_role_key`) are auto-created by the wizard in Step 4 below; you no longer need a manual dashboard step. If the wizard's auto-apply ever fails (permission denied, etc.), it falls back to printing a SQL-Editor deeplink per missing secret — click the link, then click Run. The Vault dashboard panel was removed in current Supabase UIs, so SQL Editor is now the canonical manual surface.

### Step 4 — Run the init wizard

```bash
termdeck init --rumen
```

If not globally installed: `node packages/cli/src/index.js init --rumen`

The wizard checks prerequisites, links your Supabase project, applies the Rumen migration, deploys the `rumen-tick` Edge Function, sets secrets, fires a manual test POST, and schedules `pg_cron`.

### Step 5 — Verify

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'rumen%';
```

Expect one row, `active = true`. Wait ~15 minutes, then:

```bash
psql "$DATABASE_URL" -c "SELECT id, status, sessions_processed, insights_generated FROM rumen_jobs ORDER BY started_at DESC LIMIT 3"
```

At least one row with `status = done`.

### >> STOP HERE if you don't need project path awareness or CLAUDE.md integration.

---

## Tier 4: Full Integration — CLAUDE.md and Project Path Awareness

This tier isn't about installing new software. It's about making the tools you already installed in Tiers 1-3 aware of each other and of your project layout. This is what makes Claude Code inside TermDeck able to find your repos, recall your memories, and work across projects without you manually providing paths.

### What goes where: the three CLAUDE.md files

There are three different CLAUDE.md files with different scopes. You need to know which one to edit for what purpose.

| File | Scope | Who reads it | What goes in it |
|------|-------|-------------|-----------------|
| **`~/.claude/CLAUDE.md`** | Global — every Claude Code session, every folder | Every Claude Code instance on your machine | Memory-first instructions, project directory map, tool conventions |
| **`<project>/CLAUDE.md`** | Per-project — only when Claude Code is in that project directory | Claude Code sessions in that specific repo | Build commands, architecture decisions, coding conventions, file structure |
| **`~/.claude/projects/<path>/MEMORY.md`** | Per-project auto-memory — Claude Code's own notes | Claude Code's auto-memory system (not the same as Mnestra) | Auto-generated by Claude Code. Don't edit directly. |

### Step 1 — Global CLAUDE.md: Memory-first instructions

Add this to `~/.claude/CLAUDE.md`. This ensures every Claude Code session — whether inside TermDeck or in a standalone terminal — checks Mnestra before doing anything.

```markdown
## MANDATORY: Check Memory First

At the START of every conversation, before doing ANY work:

1. Call `memory_recall` with a query relevant to the current working directory/project
2. Call `memory_recall` with a query about recent sessions and decisions
3. If the user references something you don't have context for, ALWAYS
   check `memory_recall` and `memory_search` BEFORE saying you don't know

This is non-negotiable. Never start work without checking memory. Never say
"I don't have context" without first searching memory.
```

**Why this matters:** Without this, Claude Code sessions inside TermDeck start cold. They don't know about your prior decisions, recent bugs, or project history. The Mnestra MCP server provides the memory tools, but Claude Code won't use them proactively unless instructed to. This instruction is what closes the loop between Mnestra's memory store and Claude Code's behavior.

### Step 2 — Global CLAUDE.md: Project directory map

Also add to `~/.claude/CLAUDE.md`. This tells Claude Code where every project lives on disk, so it never fails to find a repo when asked.

```markdown
## Project Directory Map

| Project | Path |
|---------|------|
| my-saas | ~/projects/my-saas |
| api-service | ~/projects/api-service |
| mobile-app | ~/projects/mobile-app |

Never say "I can't find project X" without checking this table first.
```

**Why this matters:** During a live demo on 2026-04-16, Claude Code inside TermDeck was asked to "review rumen work from yesterday" and couldn't find the Rumen project — it searched by name and found nothing. The project map prevents this by giving Claude Code an explicit path table it checks before searching blindly.

### Step 3 — Per-project CLAUDE.md files

Each of your repos should have its own `CLAUDE.md` at the root with project-specific instructions. This file is read when Claude Code opens in that directory. Example for a Next.js project:

```markdown
# My SaaS — CLAUDE.md

## What this project is
A Next.js 14 SaaS with Supabase auth, Stripe billing, and a Postgres backend.

## Build and test
- `npm run dev` — starts dev server on :3000
- `npm test` — runs vitest suite
- `npm run build` — production build

## Architecture decisions
- App Router, not Pages
- Server Components by default
- Supabase Auth via @supabase/ssr
```

This file does NOT need memory instructions (those are global). It just needs project-specific context that helps Claude Code work effectively in that repo.

### Step 4 — Configure project paths in TermDeck

Edit `~/.termdeck/config.yaml` and add your actual project paths:

```yaml
projects:
  my-saas:
    path: ~/projects/my-saas
    defaultTheme: tokyo-night
    defaultCommand: claude
  api-service:
    path: ~/projects/api-service
    defaultTheme: catppuccin-mocha
    defaultCommand: claude
  mobile-app:
    path: ~/projects/mobile-app
    defaultTheme: nord
    defaultCommand: bash
```

### Step 5 — Verify the full stack

Restart TermDeck. Check:

1. Health badge shows "Stack: OK" (green) with all checks passing
2. Project dropdown in prompt bar lists your configured projects
3. Selecting a project launches a terminal `cd`'d to that path
4. Panel header shows project tag with theme color
5. Open Claude Code in a panel — it should immediately call `memory_recall`
6. Ask Claude Code "where is the [project-name] project?" — it should answer from the directory map, not search blindly

---

## Tier 5 (optional): Web-Chat Bridge — Claude.ai / ChatGPT / Grok read your stack (20 minutes)

**What you gain:** The consumer web chats you already pay for connect to your stack through each provider's own sanctioned MCP-connector feature — zero scraping, zero browser automation. A connected chat can `memory_recall` your Mnestra store mid-conversation and (per-call approval-gated) see what your coding terminals are doing. With the named tunnel + supervisor below, the connector URL is **permanent**: it survives reboots and `cloudflared` restarts, so you wire each provider exactly once.

**What it costs:** Free Cloudflare account + any domain whose DNS is hosted on Cloudflare (for the stable hostname), `cloudflared`, ~20 minutes. No recurring cost. Without a domain you can still run an ephemeral quick tunnel, but the URL rotates on every restart and every connector breaks with it — fine for a smoke test, miserable as a daily driver.

**Security model (read before exposing anything):** the Bridge is read-only by construction; every tool result is egress-redacted before it leaves your machine; terminal-state tools are approval-gated; panel visibility is default-deny until you allowlist it; OAuth 2.1 + PKCE with audience-bound tokens gates the endpoint, and an operator secret gates consent. Full invariants in [`packages/mcp-bridge/README.md`](../packages/mcp-bridge/README.md); pre-exposure checklist in [`packages/mcp-bridge/docs/tunnel.md`](../packages/mcp-bridge/docs/tunnel.md).

### Step 1 — One-time: create the named tunnel

Requires a domain whose DNS is on Cloudflare (add one at dash.cloudflare.com first if needed — the free plan is fine).

```bash
brew install cloudflared          # macOS; Linux: see Cloudflare's package repo
cloudflared tunnel login          # browser auth — select the zone (domain) to authorize
cloudflared tunnel create termdeck-bridge
cloudflared tunnel route dns termdeck-bridge bridge.<your-domain>
```

`create` prints a tunnel ID and writes credentials to `~/.cloudflared/<tunnel-id>.json`. Then write `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: bridge.<your-domain>
    service: http://127.0.0.1:8870
  - service: http_status:404
```

### Step 2 — Point the supervisor at the named tunnel

The stack supervisor (`scripts/termdeck-supervise.sh`, see [`SELF-HEALING.md`](./SELF-HEALING.md)) starts and keeps alive all four processes — TermDeck server, Mnestra webhook, the tunnel, and the Bridge — and re-pins the Bridge's OAuth surface to the current public URL. Tell it about the tunnel in `~/.termdeck/supervisor.env`:

```bash
TERMDECK_TUNNEL_NAME=termdeck-bridge
TERMDECK_PUBLIC_HOSTNAME=bridge.<your-domain>
```

The supervisor re-reads this file on every tick — no reinstall needed when it changes.

### Step 3 — Install the supervisor on a 60s timer

macOS (launchd — edit the two absolute paths in the plist if your repo or HOME differ):

```bash
cp scripts/com.jhizzard.termdeck-supervise.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist
```

Linux (systemd user timer — canonical units at [`docs/examples/termdeck-supervise.service`](./examples/termdeck-supervise.service) + [`.timer`](./examples/termdeck-supervise.timer); they carry the same minimal-PATH fix as `termdeck.service`):

```bash
mkdir -p ~/.config/systemd/user
cp docs/examples/termdeck-supervise.{service,timer} ~/.config/systemd/user/
# edit ExecStart in the .service if your repo is not at ~/termdeck
systemctl --user daemon-reload
systemctl --user enable --now termdeck-supervise.timer
loginctl enable-linger "$(whoami)"
```

The first tick generates a **stable operator secret** at `~/.termdeck/bridge-operator-secret.txt` (the consent passphrase you'll type during each provider's OAuth flow — it never rotates on restart) and brings up tunnel + Bridge pinned to `https://bridge.<your-domain>`.

### Step 4 — Verify public reachability

```bash
H=https://bridge.<your-domain>
curl -s "$H/healthz"                                        # {"ok":true,...,"resource":"$H/mcp"}
curl -s "$H/.well-known/oauth-protected-resource/mcp"       # resource + authorization_servers
curl -s "$H/.well-known/oauth-authorization-server"         # endpoints, S256 in code_challenge_methods
curl -si -X POST "$H/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -1   # HTTP/2 401 (unauth must 401)
```

All four behaving means any provider can discover, register, and complete OAuth against your Bridge.

### Step 5 — Connect the providers

Paste `https://bridge.<your-domain>/mcp` into each provider's connector UI and complete the OAuth flow; when the consent page asks, enter the operator secret from `~/.termdeck/bridge-operator-secret.txt`:

| Provider | Where | Doc |
|---|---|---|
| Claude.ai | Settings → Connectors → Add custom connector | [`connect-claude.md`](../packages/mcp-bridge/docs/connect-claude.md) |
| ChatGPT | Settings → Apps & Connectors → **"New App" dialog** | [`connect-chatgpt.md`](../packages/mcp-bridge/docs/connect-chatgpt.md) |
| Grok | grok.com → Connectors → New → Custom | [`connect-grok.md`](../packages/mcp-bridge/docs/connect-grok.md) |

(Gemini's web app has no custom-MCP surface — Gemini gets Mnestra locally via the CLI path in Tier 2.)

Prove each connection with a `memory_recall` prompt in that chat. Because the hostname is yours, this wiring never goes stale: reboot the machine and the supervisor brings everything back on the same URL.

### >> STOP HERE — Tiers 1–4 are complete without the Bridge; add it only if you want web chats reading your stack.

---

## Running TermDeck under systemd (Linux always-on launch)

Skip this section if you launch TermDeck interactively from a shell — `termdeck` (Tier 1+) or `termdeck-stack start` (Tier 2+) covers that case and is the recommended path on a workstation.

Use systemd when you want TermDeck to start automatically on boot, restart on crash, and run unattended on a Linux server (Hetzner, DigitalOcean, a home-lab box, etc.). The canonical unit lives at **[`docs/examples/termdeck.service`](./examples/termdeck.service)** — copy it into place rather than authoring your own; it incorporates two non-obvious fixes you would otherwise have to debug yourself:

| Fix | Why it's required |
|---|---|
| `ExecStart=...termdeck --service` (the `--service` flag) | Plain `termdeck` auto-routes through the stack launcher (`stack.js`), which spawns the real TermDeck server as a detached child and *returns 0* immediately. systemd's `Type=simple` interprets the exit-0 as a clean shutdown and marks the service inactive — `Restart=on-failure` does NOT trigger on clean exits. The `--service` flag (added Sprint 59) bypasses the auto-stack fire-and-forget path so the foreground process stays alive for systemd to monitor. **Without it, your unit will appear to start, then immediately go inactive.** |
| `Environment="PATH=%h/.npm-global/bin:..."` | systemd starts processes with a minimal PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`). Every npm-global bin directory — including `~/.npm-global/bin` (where `termdeck`, `claude`, `codex`, `gemini` typically live) — is invisible. PTY children spawned by TermDeck inherit this minimal PATH, so panels launching `claude` or any global CLI fail silently with `command not found`. The `Environment=PATH=...` line prepends the npm-global directory so panel-spawn works inside the systemd-supervised process. |

### Step 1 — Install the unit

System scope (run as root or via sudo; service starts at boot for all users):

```bash
sudo cp docs/examples/termdeck.service /etc/systemd/system/termdeck.service
sudo systemctl daemon-reload
sudo systemctl enable --now termdeck.service
```

User scope (per-user, no sudo; service starts when the user logs in if `loginctl enable-linger <user>` is set):

```bash
mkdir -p ~/.config/systemd/user
cp docs/examples/termdeck.service ~/.config/systemd/user/termdeck.service
# Edit the [Install] section to swap WantedBy=multi-user.target → WantedBy=default.target
systemctl --user daemon-reload
systemctl --user enable --now termdeck.service
loginctl enable-linger "$(whoami)"   # so the unit survives logout
```

Adjust `ExecStart` if your `termdeck` binary lives somewhere other than `~/.npm-global/bin/termdeck` — the canonical unit has a commented-out `ExecStart=/usr/local/bin/termdeck --service` alternative for system-wide npm installs. Run `which termdeck` to confirm your path.

### Step 2 — Verify

```bash
sudo systemctl is-active termdeck.service       # expect: active
sudo systemctl status termdeck.service          # expect: Active: active (running)
curl -sf http://localhost:3000/api/health       # expect: 200, {"status":"ok",...}
sudo journalctl -u termdeck.service -n 50 --no-pager
```

If any of these fail, see the troubleshooting table below for the most common cases.

### Step 3 — Confirm panel-spawn under systemd PATH

The Brad #8 fix is only effective if `Environment=PATH=...` actually exposes the global npm bin to spawned PTYs. Confirm by spawning a panel that invokes a global CLI:

```bash
curl -sS -X POST http://localhost:3000/api/sessions \
  -H 'content-type: application/json' \
  -d '{"command":"claude --version"}' \
  | jq -r '.id'                                  # capture the session id
sleep 5
curl -sS http://localhost:3000/api/sessions/<id> \
  | jq '{status: .meta.status, exit: .meta.exitCode, detail: .meta.statusDetail}'
# Expect: status="exited", exit=0, detail unset
```

`exit=127` or `detail` containing `command not found` means PATH is still wrong — re-check the `Environment=PATH=...` line in your unit and that `which claude` (run as the same user the unit runs under) succeeds.

### systemd troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `systemctl is-active termdeck.service` reports `inactive` immediately after `enable --now` | Missing `--service` flag — launcher fire-and-forget exits 0 (Brad #7) | Confirm `ExecStart=...termdeck --service` (NOT bare `termdeck`); restart with `systemctl restart termdeck.service` |
| Service is `active` but `curl /api/health` returns nothing | Health bind hasn't completed yet | Wait 15-30s after start; if still nothing, check `journalctl -u termdeck.service -n 100` for bind errors |
| Service is `active` but Claude / Codex panels fail with `command not found` | PATH not inheriting `~/.npm-global/bin` (Brad #8) | Confirm `Environment="PATH=%h/.npm-global/bin:..."` is in the unit; `systemctl daemon-reload && systemctl restart termdeck.service` |
| `EnvironmentFile=-%h/.termdeck/secrets.env` skipped silently | The leading `-` makes the file optional; secrets are missing | Verify file exists and is readable by the User= account; check `journalctl` for secret-related errors. The launcher's `--service` mode also self-reads `~/.termdeck/secrets.env` (Brad #1 fix) so EnvironmentFile is belt-and-suspenders. |
| Service crashes on boot with `Permission denied` writing SQLite | `ProtectHome=true` (not in canonical unit, but a common over-hardening copy-paste) | Remove any `ProtectHome=true` line — TermDeck needs write access to `~/.termdeck/` |
| Service runs but TermDeck UI in browser shows port mismatch | Default port 3000 collides with another service | Add `--port 3001` (or similar) to the ExecStart; also update any reverse-proxy config |

For the full reproducer infrastructure that catches systemd regressions, see `docs/INSTALL-FIXTURES.md` § 4.5 systemd-nightly (a Hetzner CX22 VM provisioned and torn down nightly to verify the unit still works against fresh OS images).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npx` fails with compilation error | Native module build issue | v0.3+ uses prebuilts — `npm cache clean --force` and retry. macOS: `xcode-select --install`. |
| Blank page at localhost:3000 | xterm.js CDN unreachable | Check network. Dashboard loads from `cdn.jsdelivr.net`. |
| `EADDRINUSE: port 3000` (or 37778) on startup | Stale TermDeck/Mnestra process from a prior run | `termdeck-stack stop` (then `start`) cleans up via the pidfile, or `./scripts/start.sh` kills stale PIDs automatically. Manual: `lsof -ti :3000 \| xargs kill`. |
| Mnestra check red even though `mnestra serve` is running | Preflight hits `/healthz` (not `/health`) and parses `store.rows` — older Mnestra builds lacked that endpoint | Upgrade: `npm install -g @jhizzard/mnestra@latest` (≥0.2.0 required). |
| Tier 2 features silent despite `secrets.env` being populated | Vars exist in the file but weren't exported into the shell launching `npx termdeck` | From v0.17.0 the TermDeck server auto-merges `~/.termdeck/secrets.env` into every PTY env block, so launching via `termdeck-stack start` (or `./scripts/start.sh`) covers it. If you launch the bare `termdeck` bin from a fresh shell, run `set -a; source ~/.termdeck/secrets.env; set +a` first. |
| Health badge shows "Tier 1: OK" | DATABASE_URL not set | Expected for Tier 1. Add DATABASE_URL to `~/.termdeck/secrets.env` for full stack. |
| Health badge shows red | Mnestra/Rumen/DB not configured | Click badge for detail per check. Each failed check shows a remediation hint. |
| Flashback never fires | Empty memory store or Mnestra not running | Flashback needs memories. Use Mnestra for a few days first, or `mnestra serve` to start the server. |
| Claude Code says "I can't find project X" | No directory map in global CLAUDE.md | Add the Project Directory Map to `~/.claude/CLAUDE.md` (see Tier 4 Step 2). |
| Claude Code doesn't check memory on startup | No memory-first instruction | Add the MANDATORY section to `~/.claude/CLAUDE.md` (see Tier 4 Step 1). |
| `Connection refused` to Supabase | IPv6 Dedicated Pooler URL | Toggle ON "Use IPv4 (Shared Pooler)" in Supabase Connect modal, re-copy URL. |
| `password authentication failed` | Special chars in DB password | Reset to alphanumeric-only in dashboard. Do not URL-encode. |
| `Tenant or user not found` | `DIRECT_URL` set | Remove `DIRECT_URL`. Rumen uses `DATABASE_URL` only. |
| `init --rumen` fails on Deno | Homebrew Deno on macOS 13 | Use `curl -fsSL https://deno.land/install.sh \| sh` instead. |
| Edge Function version error | Pinned npm version not published | `npm view @jhizzard/rumen version`, update import in `rumen-tick/index.ts`. |
| `column "X" does not exist` | Schema drift from earlier install | Run backfill from RUMEN-UNBLOCK.md Step 5a, re-run wizard. |
| pg_cron not firing | Extension or schedule missing | `SELECT * FROM cron.job WHERE jobname LIKE 'rumen%'` — if empty, re-run wizard. |
