# Getting Started: TermDeck + Mnestra + Rumen

The full stack in four tiers. Each tier is optional — stop wherever you have what you need.

**Total time:** ~30 minutes for the full stack. Tier 1 alone takes 2 minutes.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node 18+** | `node --version` to check |
| **macOS or Linux** | Windows not supported. Alpine/musl not supported (no prebuilt PTY binaries). |
| **Supabase project** (Tier 2+) | Free tier works. [supabase.com](https://supabase.com) |
| **OpenAI API key** (Tier 2+) | For `text-embedding-3-large` embeddings |
| **Anthropic API key** (Tier 3) | For Haiku synthesis in Rumen |
| **Supabase CLI + Deno** (Tier 3) | Required only for Edge Function deployment |

---

## Tier 1: Terminal Multiplexer (2 minutes)

```bash
npx @jhizzard/termdeck
```

Browser opens at `http://127.0.0.1:3000`. No accounts, no credentials, no database.

**What you get:** real PTY shells via prebuilt `node-pty` (no C++ toolchain), 7 grid layouts (1x1 through 4x2 plus focus/half modes), 8 themes (Tokyo Night, Catppuccin Mocha, Rose Pine Dawn, Dracula, Nord, Gruvbox Dark, Solarized Dark, GitHub Light), per-panel metadata overlays, output analyzer for Claude Code / Gemini CLI / Python servers, onboarding tour, local SQLite persistence.

**Verify:**

1. Type `bash` in the prompt bar, click Launch — terminal panel appears
2. Run `echo hello && ls` to confirm interactivity
3. Open 2-3 more terminals, switch layouts with `Cmd+Shift+1` through `6`
4. Stack badge in the top bar shows what's connected

**What's missing:** Flashback is silent (no memory store). "Ask about this terminal" returns nothing.

---

## Tier 2: Mnestra Memory (10 minutes)

Mnestra powers Flashback. When a panel errors, TermDeck queries Mnestra for similar past sessions and surfaces the match as a toast.

### Step 1 — Install and create Supabase project

```bash
npm install -g @jhizzard/mnestra
mnestra --version  # verify
```

Create a project at [supabase.com](https://supabase.com). Copy **Project URL** and **service_role key** from Project Settings > API.

### Step 2 — Apply migrations

```bash
export DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"

for i in 001 002 003 004 005 006; do
  psql "$DATABASE_URL" -f "$(npm root -g)/@jhizzard/mnestra/migrations/${i}_*.sql"
done
```

Verify: `psql "$DATABASE_URL" -c "SELECT count(*) FROM memory_items"` returns `0` with no errors.

### Step 3 — Create secrets and config

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
rag:
  enabled: true
  supabaseUrl: ${SUPABASE_URL}
  supabaseKey: ${SUPABASE_SERVICE_ROLE_KEY}
  openaiApiKey: ${OPENAI_API_KEY}
  mnestraMode: direct
YAML
```

Verify: `grep -c '=' ~/.termdeck/secrets.env` returns `5`.

### Step 4 — Restart TermDeck

```bash
npx @jhizzard/termdeck
```

Verify: Stack badge shows Mnestra connected.

### Step 5 (optional) — Mnestra as Claude Code MCP server

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

---

## Tier 3: Rumen Async Learning (15 minutes)

Rumen is a Supabase Edge Function on a 15-minute `pg_cron` schedule. It reads recent memories, cross-references via hybrid search, synthesizes insights via Claude Haiku, and writes them back. Flashback then surfaces cross-project patterns.

### Five gotchas (read first)

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

Verify: `deno --version && supabase --version`

### Step 2 — Supabase access token

Generate at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). Add `export SUPABASE_ACCESS_TOKEN=sbp_...` to `~/.zshrc`.

Verify: `source ~/.zshrc && supabase projects list` (no 401 error).

### Step 3 — Enable extensions and Vault secret

In Supabase Dashboard > Integrations: enable **Cron** (`pg_catalog` schema). Then in SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS pg_net;
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');  -- expect 2 rows
```

Add Vault secret: Dashboard > Database > Vault > New secret. Name: `rumen_service_role_key` (exact). Value: your service_role key from Settings > API.

### Step 4 — Confirm secrets.env keys

```bash
grep -cE '^DATABASE_URL=' ~/.termdeck/secrets.env       # must return 1
grep -cE '^ANTHROPIC_API_KEY=' ~/.termdeck/secrets.env   # must return 1
```

### Step 5 — Run the init wizard

```bash
termdeck init --rumen
```

If not globally installed: `node packages/cli/src/index.js init --rumen`

The wizard checks prerequisites, links your Supabase project, applies the Rumen migration, deploys the `rumen-tick` Edge Function, sets secrets, fires a manual test POST, and schedules `pg_cron`.

### Step 6 — Verify

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'rumen%';
```

Expect one row, `active = true`. Wait ~15 minutes, then:

```bash
psql "$DATABASE_URL" -c "SELECT id, status, sessions_processed, insights_generated FROM rumen_jobs ORDER BY started_at DESC LIMIT 3"
```

At least one row with `status = done`.

---

## Tier 4: Full Integration

Edit `~/.termdeck/config.yaml` to add project paths:

```yaml
projects:
  - name: my-saas
    path: ~/projects/my-saas
    theme: tokyo-night
    defaultCommand: bash
    color: "#7aa2f7"
  - name: api-service
    path: ~/projects/api-service
    theme: catppuccin-mocha
    defaultCommand: bash
    color: "#f5c2e7"

rag:
  enabled: true
  supabaseUrl: ${SUPABASE_URL}
  supabaseKey: ${SUPABASE_SERVICE_ROLE_KEY}
  openaiApiKey: ${OPENAI_API_KEY}
  mnestraMode: direct
```

Restart TermDeck and verify:

1. Project dropdown in prompt bar lists your projects
2. Selecting a project launches a terminal `cd`'d to that path
3. Panel header shows project tag with configured color
4. Stack badge shows green for all connected services
5. `ls ~/.termdeck/termdeck.db` confirms SQLite transcript backup exists

---

## Recommended CLAUDE.md Additions

If using Mnestra as a Claude Code MCP server, add to `~/.claude/CLAUDE.md`:

```markdown
## Project Directory Map

- ~/projects/my-saas — SaaS product (Next.js + Supabase)
- ~/projects/api-service — Backend API (Express + Postgres)
- ~/projects/mobile-app — Mobile client (React Native)

## Memory-First Instruction

You have access to persistent memory via Mnestra MCP tools. At the start of every
session, call `memory_recall` with a query about the current project or task.
Before making architectural decisions, search for prior decisions with
`memory_search`. When you fix a bug, discover a pattern, or make a key decision,
call `memory_remember` to persist it for future sessions.

Available tools: memory_recall, memory_remember, memory_search, memory_forget,
memory_status, memory_summarize_session.
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npx` fails with compilation error | Native module build issue | v0.2 uses prebuilts — `npm cache clean --force` and retry. macOS: `xcode-select --install`. |
| Blank page at localhost:3000 | xterm.js CDN unreachable | Check network. Dashboard loads from `cdn.jsdelivr.net`. |
| Flashback never fires | Empty store or RAG disabled | Check `rag.enabled: true`. Flashback needs existing memories — use for a few days first. |
| `Supabase responded 404` | RAG telemetry tables missing | Set `rag.enabled: false` (Flashback/MCP unaffected). See RUMEN-UNBLOCK.md. |
| `Connection refused` to Supabase | IPv6 Dedicated Pooler URL | Toggle ON "Use IPv4 (Shared Pooler)" in Supabase Connect modal, re-copy URL. |
| `password authentication failed` | Special chars in DB password | Reset to alphanumeric-only in dashboard. Do not URL-encode. |
| `Tenant or user not found` | `DIRECT_URL` set | Remove `DIRECT_URL`. Rumen uses `DATABASE_URL` only. |
| `init --rumen` fails on Deno | Homebrew Deno on macOS 13 | Use `curl -fsSL https://deno.land/install.sh \| sh` instead. |
| Edge Function version error | Pinned npm version not published | `npm view @jhizzard/rumen version`, update import in `rumen-tick/index.ts`. |
| `column "X" does not exist` | Schema drift | Run backfill from RUMEN-UNBLOCK.md Step 5a, re-run wizard. |
| pg_cron not firing | Extension missing or schedule not applied | `SELECT * FROM cron.job WHERE jobname LIKE 'rumen%'` — if empty, re-run wizard. |
