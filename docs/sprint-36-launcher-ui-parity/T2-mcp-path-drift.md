# Sprint 36 — T2: MCP config path drift fix

**Lane goal:** Migrate every installer/CLI write of MCP config from the legacy `~/.claude/mcp.json` to the current `~/.claude.json` (which is what Claude Code v2.1.119+ actually reads). Detect existing entries in BOTH paths on install, merge into the new path, leave the old path untouched (user may have it pinned). Idempotent.

**Why this matters:** Joshua's box has Mnestra wired at `~/.claude.json` (current). The installer ships writes to `~/.claude/mcp.json` (legacy). Fresh users install Mnestra → it shows up in `~/.claude/mcp.json` → Claude Code never reads that path → users believe the install is broken when it actually wrote to the wrong file. This is THE single biggest fresh-install regression after Sprint 35.

## Acceptance behavior

1. On install (`npx @jhizzard/termdeck-stack`, `npx @jhizzard/termdeck init --mnestra`, `npx @jhizzard/rumen init`):
   - Read `~/.claude.json` if it exists, parse `mcpServers` block (may be nested under top-level or per-project — investigate before writing).
   - Read `~/.claude/mcp.json` if it exists.
   - MERGE entries: if a server name appears in legacy but not current, copy it. If a name appears in both, current wins (no clobber).
   - Write merged result back to `~/.claude.json`. Leave `~/.claude/mcp.json` alone.

2. Idempotent: running install twice produces the same `~/.claude.json` content (or at minimum, no spurious additions).

3. The CLI absence-hint code (T1's lane) reads from `~/.claude.json`. Coordinate constant location.

## Primary files

- `packages/stack-installer/src/index.js` — meta-installer. Likely owns the config-merge logic.
- `packages/cli/src/init-rumen.js` — Rumen-specific MCP wiring path.
- `packages/cli/src/index.js` — wherever the CLI checks for MCP entries today.
- `packages/server/src/setup/supabase-mcp.js` — Supabase MCP wiring (also writes config).
- READ-ONLY: any test fixtures that mock `~/.claude.json` / `~/.claude/mcp.json`.

## Investigation step (do this first)

Before writing code, run on Joshua's actual box:
```sh
[ -f ~/.claude.json ] && jq '.mcpServers // empty' ~/.claude.json
[ -f ~/.claude/mcp.json ] && jq '.mcpServers // empty' ~/.claude/mcp.json
```

Document the actual schema you find in your STATUS.md FINDING entry. The schema may be top-level `mcpServers` or per-project nested under `projects.<path>.mcpServers` — Claude Code's format has shifted across releases. Whatever you observe, write to that shape.

If `~/.claude.json` uses per-project nesting, the merge logic gets more interesting: legacy `~/.claude/mcp.json` is global, but current `~/.claude.json` may want per-project. Decide policy with care; if unclear, default to top-level `mcpServers` (works for global) and note it.

## Test plan

- Unit tests for the merge function: legacy-only, current-only, both-with-overlap, both-disjoint, malformed JSON, empty file.
- Integration: install twice → no diff in `~/.claude.json` after second run.
- Verify a fresh install produces a `~/.claude.json` Claude Code can read. (Manual: load a Claude Code session and check whether the MCP entry shows up.)

## Coordination notes

- **T1 reads the same path.** Either expose a `MCP_CONFIG_PATH` constant from `packages/cli/src/stack.js` (or wherever T1 puts shared launcher helpers) and import it everywhere, or land the constant in your lane and ping T1's STATUS entry.
- **T4 is also writing to `~/.claude/settings.json`** (different file, but same `~/.claude/` directory). Don't accidentally touch settings.json from this lane.

## Out of scope

- Don't delete `~/.claude/mcp.json`. Leaving it is the safe default — user may have other tooling pinned to it.
- Don't refactor the installer's broader install flow. Just fix the path.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-36-launcher-ui-parity/STATUS.md` under `## T2`. No version bumps. No commits. Stay in your lane.
