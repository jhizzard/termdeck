# TermDeck Stack Install — For Technical Collaborators

**Audience:** experienced engineers (e.g. SWE leads, senior engineers) who want the full TermDeck + Mnestra stack running today, with eyes-open awareness of known issues and pending fixes. **Not** for first-time terminal users — for that, see [`GETTING-STARTED.md`](./GETTING-STARTED.md). For end-user install paths with hand-holding, see [`INSTALL.md`](./INSTALL.md).

This doc is **version-pinned to the published 2026-05-01 stack**. Re-check pinned versions if you're reading this more than ~30 days after the date below.

**Last updated:** 2026-05-01
**Pinned versions:** `@jhizzard/termdeck@0.13.0` · `@jhizzard/termdeck-stack@0.4.8` · `@jhizzard/mnestra@0.3.3` · `@jhizzard/rumen@0.4.4`

## What you're getting

| Tier | Package | What it does | Install today? |
|---|---|---|---|
| 1 | `@jhizzard/termdeck` | Browser-based terminal multiplexer with metadata overlays, panel grid, knowledge-graph viewer, flashback persistence dashboard (v0.12.0+), in-dashboard 4+1 sprint runner | ✅ yes |
| 2 | `@jhizzard/mnestra` | MCP server giving any AI coding tool persistent memory across sessions (pgvector + Supabase + OpenAI embeddings) | ✅ yes |
| 3 | `@jhizzard/rumen` | Async learning Edge Function — Extract → Relate → Synthesize → Surface; runs on `pg_cron` daily | ✅ yes (Sprint 43 T3 fixed the fresh-install wizard bug — `init --rumen` now bundles both `rumen-tick` and `graph-inference` Edge Function source in the npm tarball) |
| Meta | `@jhizzard/termdeck-stack` | One-command installer that wires all three tiers | ✅ yes |

**For your use case (collaborator install, not contributor):** all three tiers today. The Rumen tier was deferred in earlier versions of this doc due to a wizard bug; that bug is fixed as of `termdeck@0.12.0` (shipped 2026-04-30). Sprint 43 T3 bundled the Edge Function source directly inside the TermDeck npm package, so fresh users no longer need a sibling Rumen repo.

## Prerequisites

- **Node.js 18+** (best-tested on 18 / 20 LTS / 22 / 23 / 24)
- **macOS or Linux.** macOS is the daily-driver platform. Linux works (node-pty supports it, the `Brad`-tier tester runs on Linux), but is less battle-tested. Windows: not supported (node-pty Windows build is unreliable; use WSL2 if Windows is forced).
- **Claude Code installed and logged in.** TermDeck launches Claude Code sessions inside its panels — without it, panels are empty. (Other agents — Codex / Gemini / Grok — are partially recognized today; full multi-agent ships in Sprint 44–46.)
- **A fresh Supabase project** (free tier is fine). You'll need the project URL + service-role key during install.
- **An OpenAI API key.** Mnestra uses `text-embedding-3-large` (1536d) for memory embeddings.
- **A C++ toolchain.** `node-pty` and `better-sqlite3` compile native binaries. macOS: `xcode-select --install`. Debian/Ubuntu: `apt install build-essential`.

## Install (one command, ~3 minutes)

```bash
npx @jhizzard/termdeck-stack@latest
```

What this does, in order:

1. Installs `@jhizzard/termdeck` and `@jhizzard/mnestra` globally via `npm i -g`.
2. Wires `~/.claude.json` to register the `mnestra` MCP server (stdio transport).
3. Bundles the session-end hook to `~/.claude/hooks/memory-session-end.js` (writes session memories to Mnestra after every Claude Code session).
4. Runs the in-terminal setup wizard:
   - Prompts for Supabase URL + service-role key
   - Prompts for OpenAI API key
   - Prompts for Anthropic API key (used by Rumen later, optional today)
   - Saves all to `~/.termdeck/secrets.env`
   - Connects to your Supabase project via `pg`
   - Applies Mnestra migrations 001–014 (creates `memory_items`, `memory_sessions`, `memory_relationships`, indexes, RPCs, GRANTs)
5. Prompts to also run `init --rumen` — **answer NO. See § Known issues below.**

When the wizard finishes:

```bash
termdeck
```

Open `http://127.0.0.1:3000` in your browser. You should see the TermDeck dashboard with an empty panel grid and a launcher prompt at the top.

## Verify the install

In the dashboard launcher, type `claude` and click Launch. A panel should open, status badge should advance through `starting` → `active` → `thinking` as Claude initializes.

In the Claude Code session that just launched, run:

```
memory_status
```

Expected output:

```
Total active memories: 0
By Project: (none yet)
By Type: (none yet)
```

That confirms the Mnestra MCP is reachable from inside the Claude Code session. Now write a memory to verify the round-trip:

```
memory_remember("Test memory — TermDeck install validation 2026-04-30", project="install-validation")
```

Expected: `Memory inserted: "Test memory ..."`

Then:

```
memory_recall("install validation")
```

Expected: returns the memory you just wrote, with similarity score.

If `memory_remember` returns `Memory skipped: ...` instead of `Memory inserted: ...`, **stop** — that's the symptom of Mnestra's permission-denied bug. Mnestra 0.3.2+ ships migration 014 that fixes this; if you're seeing it on 0.3.3, your Supabase project's `service_role` doesn't have GRANTs on `memory_items`. The fix is in `migrations/014_explicit_grants.sql` — re-apply it manually via psql against your `$DATABASE_URL`.

## Known issues + workarounds

### 1. `termdeck init --rumen` (FIXED in v0.12.0+)

Earlier versions of this doc told you to defer the Rumen step due to a fresh-install bug at `packages/server/src/setup/migrations.js:76` (`rumenFunctionDir()` returned a path that the npm package didn't actually ship). **Sprint 43 T3 fixed this** — the npm tarball now bundles `packages/server/src/setup/rumen/functions/{rumen-tick,graph-inference}/index.ts`, and `init --rumen` deploys both Edge Functions in one staging dir with a multi-function `config.toml`. **`termdeck@0.12.0` and later ship this fix.** No workaround needed.

If you DO still see the old error (`Error: entrypoint path does not exist (supabase/functions/rumen-tick/index.ts)`), check `npm view @jhizzard/termdeck version` — you may be on a stale install. `npm i -g @jhizzard/termdeck@latest` to refresh.

### 2. npm cache trap (Brad's incident, 2026-04-28)

**Symptom:** `termdeck --version` reports an old version (e.g. `0.7.2`) even after running `npx @jhizzard/termdeck-stack@latest`. The installer reports success but the binary is stale.

**Cause:** `npx` resolved a cached older version instead of pulling latest.

**Fix:**

```bash
npm cache clean --force
npx @jhizzard/termdeck-stack@latest
```

If still stuck, verify:

```bash
npm view @jhizzard/termdeck version            # expect 0.11.0
npm view @jhizzard/termdeck-stack version      # expect 0.4.6
```

If those return the expected versions but `termdeck --version` doesn't match, your global install is the culprit:

```bash
npm uninstall -g @jhizzard/termdeck @jhizzard/mnestra
npm i -g @jhizzard/termdeck@latest @jhizzard/mnestra@latest
```

### 3. PTY exhaustion on macOS at sustained heavy use

**Symptom:** opening new TermDeck panels fails with `forkpty: Device not configured`. Hit by the maintainer 2026-04-28 morning at 585 PTY refs vs `kern.tty.ptmx_max = 511`.

**Cause:** MCP children (rag-system, imessage-mcp, etc.) escape via `setsid` and reparent to launchd, holding their PTY fds after their Claude Code parent terminates. `term.kill()` only signals the leader's pgroup.

**Fix:** TermDeck v0.11.0 ships a PTY orphan reaper that runs every 30s and kills orphans (Sprint 42 T2). It's enabled by default. Confirm it's running:

```bash
curl http://127.0.0.1:3000/api/pty-reaper/status
```

Should return `{ tickCount, lastTickAt, intervalMs: 30000, registry: [...], reapedHistory: [...], reapedCount: N }`.

If you hit PTY exhaustion before the reaper kicks in, kill stale node-pty children manually:

```bash
ps -ef | grep -E "node-pty|claude" | awk '{print $2}' | xargs -n1 kill -9
```

### 4. Supabase auto-grant default doesn't fire on some projects (fixed in 0.3.3 but worth knowing)

**Symptom (legacy, fixed):** `memory_remember` silently no-ops returning `Memory skipped`. `memory_recall` errors with `permission denied for table memory_items`.

**Root cause:** Supabase's auto-grant default to `anon` / `authenticated` / `service_role` doesn't always fire on all project provisioning paths. Mnestra 0.3.2+ ships migration 014 with explicit GRANTs that close this gap deterministically.

**If you see this on 0.3.3+:** verify migration 014 was applied:

```sql
-- in your Supabase SQL editor
SELECT count(*) FROM memory_items;  -- should not throw
```

If it throws `permission denied`, re-apply the migration:

```bash
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql  # adjust for your install
$PSQL "$DATABASE_URL" -f $(npm root -g)/@jhizzard/mnestra/migrations/014_explicit_grants.sql
```

### 5. Auto mode requires Opus on Pro tier (Brad's 2026-04-28 question)

**Symptom:** Claude Code's auto mode is unavailable when `/model` is set to Sonnet on the standard Pro plan.

**Cause:** auto mode is gated to Opus-class reasoning depth on the standard tier. 20x Max plan unlocks Sonnet auto.

**Workaround:** stay on Opus when you want auto. Or upgrade tier.

## Configuration files you'll have after install

| Path | What's there |
|---|---|
| `~/.termdeck/config.yaml` | TermDeck server config (port, theme, Mnestra wiring) |
| `~/.termdeck/secrets.env` | API keys (sourced by TermDeck server at boot — do NOT commit to git) |
| `~/.claude.json` | Claude Code MCP server registry — `mnestra` entry should exist |
| `~/.claude/hooks/memory-session-end.js` | The bundled session-end hook — writes Mnestra memories after each Claude Code session |
| `~/.claude/CLAUDE.md` | (optional) global Claude Code instructions — recommended to set up if you don't have one |

## Recommended next steps after install

1. **Fork or clone any project where you want TermDeck-driven sessions.** TermDeck spawns sessions in any cwd you point at — they don't need to be in a specific TermDeck-managed location.

2. **Write a `CLAUDE.md` in each project** so the agent has project-specific context. The TermDeck repo's own `CLAUDE.md` is a reference example.

3. **Browse the knowledge graph** at `http://127.0.0.1:3000/graph.html` after a few sessions have run. Empty at first; populates as memories accumulate. Note: with sparse early data, the graph will look mostly disconnected — that's expected, and Sprint 43 T1 ships graph viewer controls (hide isolated, min-degree filter) to make it usable at low density.

4. **Read `docs/architecture.md`** to understand how the pieces fit. ~10-minute read; covers the analyzer, flashback, MCP wiring, and the orchestration model.

5. **Optional: install Codex CLI plugin if you want delegate-from-Claude.** The `codex@openai-codex` Claude Code plugin gives Claude Code tools to delegate tasks to Codex. This is a Codex-as-Claude's-tool path; full Codex-as-its-own-panel ships in Sprint 45.

## What's queued (FYI, not blockers)

- **Sprint 43** (graph viewer controls, flashback persistence with audit dashboard, init-rumen wizard repair, Telegram MCP) — fully inject-ready at `docs/sprint-43-graph-controls-and-cross-project-surfacing/`. Ships `termdeck@0.12.0`.
- **Sprint 44–46** (multi-agent substrate trilogy: Codex / Gemini / Grok as first-class lane agents alongside Claude). See `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` for the full design.

## Verification checklist (paste this back if anything fails)

```
[ ] Node.js version (`node --version`):
[ ] Platform (`uname -s`):
[ ] Installer ran cleanly (`npx @jhizzard/termdeck-stack@latest`):
[ ] Versions match expected (`npm view @jhizzard/termdeck version` → 0.11.0):
[ ] TermDeck starts (`termdeck` opens dashboard at http://127.0.0.1:3000):
[ ] Claude session launches in a panel:
[ ] memory_remember + memory_recall round-trips successfully:
[ ] /api/pty-reaper/status returns valid JSON:
[ ] Graph viewer at /graph.html loads (empty is fine):
```

## Where to ask questions

- **Blocking install issue:** open a GitHub issue at `github.com/jhizzard/termdeck/issues` or DM Joshua directly.
- **Conceptual / "how is X supposed to work" question:** check `docs/architecture.md` first; if not covered, ask.
- **Sprint planning / roadmap:** `docs/BACKLOG.md` and the sprint-43+ planning docs.

— TermDeck maintainer notes, 2026-04-30
