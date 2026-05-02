# Sprint 48 — T1: Codex MCP auto-wire + shared `mcp-autowire.js`

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

NEW `packages/server/src/mcp-autowire.js` — the SHARED helper that T1/T2/T3 all consume. T1 owns the file. NEW `mcpConfig` field added to the agent-adapter contract (now 9 fields — `acceptsPaste` was 8th in Sprint 47). T1 implements + ships the Codex specifics: `~/.codex/config.toml` is the only TOML config in the four agents. T2 and T3 copy the pattern for JSON.

## Files

- NEW `packages/server/src/mcp-autowire.js` (~80–100 LOC) — single export `ensureMnestraBlock(adapter)`. Idempotent: reads the agent's MCP config file, merges in the Mnestra block if absent, writes back. No-op when block already present and unchanged.
- EDIT `packages/server/src/agent-adapters/codex.js` — add the `mcpConfig` field describing path + format + write-shape.
- EDIT `packages/server/src/agent-adapters/index.js` — header comment lists 9 fields now (drop the `acceptsPaste was 8th` line, add `mcpConfig` to the contract block).
- EDIT `docs/AGENT-RUNTIMES.md` § 5 — adapter contract table updated to 9 fields.
- NEW `tests/mcp-autowire.test.js` (~120 LOC, ~10 tests).
- NEW `tests/agent-adapter-codex-mcpconfig.test.js` (~40 LOC, ~4 tests) — Codex-specific shape assertions.

## Adapter contract — `mcpConfig` field shape

```js
// in packages/server/src/agent-adapters/codex.js
const adapter = {
  name: 'codex',
  sessionType: 'codex-cli',
  // ... existing 8 fields ...
  mcpConfig: {
    path: '~/.codex/config.toml',          // tilde-expanded at write time
    format: 'toml',                         // 'toml' | 'json'
    mnestraBlock: ({ secrets }) => `\n[mcp_servers.mnestra]\ncommand = "mnestra"\n[mcp_servers.mnestra.env]\nSUPABASE_URL = "${secrets.SUPABASE_URL}"\nSUPABASE_SERVICE_ROLE_KEY = "${secrets.SUPABASE_SERVICE_ROLE_KEY}"\nOPENAI_API_KEY = "${secrets.OPENAI_API_KEY}"\n`,
    detectExisting: (text) => /\[mcp_servers\.mnestra\]/m.test(text),
  },
};
```

The `format: 'toml'` value is what makes T1 different from T2/T3 (which use `'json'`). The shared `ensureMnestraBlock()` switches on `format` for parse / merge / serialize.

## `ensureMnestraBlock()` API

```js
// packages/server/src/mcp-autowire.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function readSecrets() {
  // Same dotenv-subset parser used by stack-installer's readTermdeckSecrets.
  // Returns {} on absent / unreadable file.
}

function ensureMnestraBlock(adapter) {
  // 1. If adapter.mcpConfig is undefined → no-op (return { skipped: true, reason: 'no-mcpConfig' }).
  // 2. Tilde-expand path; create parent dir if missing.
  // 3. Read existing file (empty string if absent).
  // 4. If detectExisting(text) → no-op (return { unchanged: true, path }).
  // 5. Append the rendered mnestraBlock(adapter, { secrets }) to the file.
  // 6. Return { wrote: true, path, bytes }.
}

module.exports = { ensureMnestraBlock, readSecrets };
```

**Idempotency requirement:** Running `ensureMnestraBlock` twice on the same adapter MUST be a no-op the second time. Tests assert this directly.

## Codex specifics (T1's research load)

- Confirm `~/.codex/config.toml` is the right path. If absent on this machine, the adapter creates it. (Sprint 48 substrate probe will report the actual state.)
- Codex's MCP config is documented at https://github.com/openai/codex but the schema may have changed since the original adapter shipped. Read the live source if needed.
- Codex MAY support `[mcp_servers.NAME]` blocks OR a different shape. Probe by writing the assumed shape and running `codex` — if it fails, investigate and update the brief.
- The `secrets` are read from `~/.termdeck/secrets.env` (same path used by mnestra fallback + stack-installer). DON'T inline them into the brief or commit them.

## Acceptance criteria

1. `ensureMnestraBlock(codex)` writes a valid `[mcp_servers.mnestra]` block to `~/.codex/config.toml`. Running it again is a no-op (`{ unchanged: true }`).
2. The block is callable end-to-end: spawning `codex` and asking it to call `memory_recall(query="anything")` returns memories. **Integration test goes in `tests/mcp-autowire.test.js` as the LAST test, marked `node:test --skip-condition` if `codex` binary is absent — it can be skipped in CI but must pass on Joshua's machine.**
3. Mnestra block shape is mergeable: if the user already has other `[mcp_servers.X]` entries, the Mnestra block is appended without disturbing them. Tests verify with a fixture file that has 2 pre-existing servers.
4. Adapter contract documented at 9 fields in `docs/AGENT-RUNTIMES.md` § 5.
5. No regressions: full TermDeck test suite stays green (847+ tests as of Sprint 47 close).

## Coordination

- T2 (Gemini) and T3 (Grok) consume the SAME `mcp-autowire.js` you write. Make `ensureMnestraBlock` agent-agnostic. T2/T3 only need to add the `mcpConfig` field to their adapter — no changes to your file.
- The shared module landing in T1 is the critical path; T2 and T3 are blocked on it. Push the helper module + tests early (within the first ~10 min) so T2/T3 can start consuming it.
- Don't write `mcpConfig` for Claude — Claude's MCP config lives in `~/.claude.json` and is managed by the user / `claude mcp add`, not by TermDeck. Adding a Claude block here would conflict with Joshua's existing setup.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 48 Codex MCP auto-wire config.toml mcp_servers adapter contract mcpConfig 9 fields")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md (current 8-field contract; you extend it to 9)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/codex.js (your starting point)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/src/index.js (lines 48-84 — the `readTermdeckSecrets` helper you can lift / share with `mcp-autowire.js`)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
