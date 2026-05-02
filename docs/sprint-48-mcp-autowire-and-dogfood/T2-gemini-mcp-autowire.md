# Sprint 48 — T2: Gemini MCP auto-wire

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Add the `mcpConfig` field to the Gemini adapter so `mcp-autowire.js` (shipped by T1) writes the Mnestra block into `~/.gemini/settings.json`. JSON config (T1's helper auto-switches on `format: 'json'`).

## Files

- EDIT `packages/server/src/agent-adapters/gemini.js` — add the `mcpConfig` field describing path + format + write-shape.
- NEW `tests/agent-adapter-gemini-mcpconfig.test.js` (~40 LOC, ~4 tests) — Gemini-specific shape assertions.
- NO new `mcp-autowire.js` work — that file is T1's. You consume it.

## Adapter contract — `mcpConfig` field shape

```js
// in packages/server/src/agent-adapters/gemini.js
const adapter = {
  name: 'gemini',
  sessionType: 'gemini-cli',
  // ... existing 8 fields ...
  mcpConfig: {
    path: '~/.gemini/settings.json',
    format: 'json',
    mnestraBlock: ({ secrets }) => ({
      mnestra: {
        command: 'mnestra',
        env: {
          SUPABASE_URL: secrets.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: secrets.SUPABASE_SERVICE_ROLE_KEY,
          OPENAI_API_KEY: secrets.OPENAI_API_KEY,
        },
      },
    }),
    // For JSON format the shared helper merges into a top-level mcpServers
    // object (or whatever Gemini calls it — verify the schema first).
    mcpServersKey: 'mcpServers',
  },
};
```

## Gemini specifics (T2's research load)

- Confirm `~/.gemini/settings.json` is the right path. Verify the JSON top-level key for MCP servers — could be `mcpServers`, `mcp_servers`, `servers`, etc.
- Read https://github.com/google-gemini/gemini-cli docs for the actual schema. If unclear, write a candidate shape and have Gemini try to launch with it; the error message will reveal the right key.
- Gemini MAY require a restart to pick up new MCP servers. Document the requirement in your adapter comment if so.
- If Gemini's settings.json doesn't exist on this machine, the adapter creates it. (Sprint 48 substrate probe reports actual state.)

## Acceptance criteria

1. `ensureMnestraBlock(gemini)` from T1's helper writes a valid Mnestra entry to `~/.gemini/settings.json`. Running it twice → no-op the second time (test asserts file mtime unchanged).
2. The block is callable end-to-end: spawning `gemini` and asking it to call `memory_recall(query="anything")` returns memories. **Integration test in T1's `tests/mcp-autowire.test.js` (T1 owns that file; you contribute a fixture pinned to your adapter).**
3. Pre-existing keys in `~/.gemini/settings.json` (e.g. Joshua's `defaultModel`, theme prefs) are preserved verbatim — only the `mcpServers.mnestra` key is added/updated.
4. JSON merge handles the case where `mcpServers` already exists with other servers — Mnestra is appended, others untouched.
5. No regressions to existing Gemini adapter tests.

## Coordination

- **Wait for T1's `mcp-autowire.js` to land before testing end-to-end.** The first ~10 min of the sprint is research + adapter field draft; you can write the adapter changes in parallel with T1 building the helper, but the integration test depends on T1 publishing the helper API.
- Watch T1's STATUS posts. As soon as T1 posts `FIX-PROPOSED — mcp-autowire.js helper exports ensureMnestraBlock` you can wire your adapter call.
- T3 (Grok) is parallel to you and uses the same JSON path — coordinate on the merge shape if T3 surfaces a different key convention.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 48 Gemini MCP auto-wire settings.json mcpServers adapter contract")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/T1-codex-mcp-autowire.md (T1's brief — same shared helper you consume)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/gemini.js (your starting point)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
