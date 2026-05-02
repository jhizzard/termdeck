# Sprint 48 — T3: Grok MCP auto-wire

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Add the `mcpConfig` field to the Grok adapter so `mcp-autowire.js` (shipped by T1) writes the Mnestra block into `~/.grok/user-settings.json`. JSON config. Grok's smoke-test in Sprint 47 confirmed the file exists with `{"defaultModel": "grok-4.20-0309-reasoning"}` and no `mcpServers` block — this lane closes that gap.

## Files

- EDIT `packages/server/src/agent-adapters/grok.js` — add the `mcpConfig` field.
- NEW `tests/agent-adapter-grok-mcpconfig.test.js` (~40 LOC, ~4 tests).
- NO new `mcp-autowire.js` work — that file is T1's. You consume it.

## Adapter contract — `mcpConfig` field shape

```js
// in packages/server/src/agent-adapters/grok.js
const adapter = {
  name: 'grok',
  sessionType: 'grok-cli',
  // ... existing 8 fields ...
  mcpConfig: {
    path: '~/.grok/user-settings.json',
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
    mcpServersKey: 'mcpServers',  // verify against Grok docs
  },
};
```

## Grok specifics (T3's research load)

- Confirm Grok's MCP config schema. The Sprint 47 Grok smoke test self-reported that `~/.grok/user-settings.json` is "the right place" but didn't verify the exact MCP key. Probe by:
  1. Reading https://github.com/superchargedt/grok-cli docs (or whichever repo Grok ships from — the binary on disk should reveal the homepage).
  2. Asking the running Grok process via `grok mcp list` if such a command exists.
  3. Writing a candidate block and observing whether Grok picks it up after restart.
- Grok is built on Bun + OpenTUI, NOT Node — the launch lifecycle differs from Codex/Gemini. Document any Bun-specific quirks in your adapter comment.
- **Bonus if scope allows:** the Sprint 47 Grok self-report flagged 16-sub-agent observability — `session.js` analyzer picks up `"Delegating to [agent] sub-agent: ..."` and `"[sub-agent complete]"` patterns; UX is a collapsible tree pane. That's a UI lane (server + client + CSS), probably too big for the remaining T3 budget after MCP auto-wire ships. Defer if the MCP work fills the lane.

## Acceptance criteria

1. `ensureMnestraBlock(grok)` from T1's helper writes a valid Mnestra entry to `~/.grok/user-settings.json`. Joshua's existing `defaultModel` value is preserved.
2. After write + Grok restart (if required), `memory_recall(query="anything")` is callable from inside a Grok session.
3. Idempotent — running it twice → no-op.
4. JSON merge preserves all other top-level keys.
5. Grok-binary-absent → test skipped (CI), passes on Joshua's machine.

## Coordination

- Wait for T1's `mcp-autowire.js` to land before integration testing.
- T2 (Gemini) is parallel to you and uses the same JSON format. If T2 surfaces a key-naming convention you both can reuse, align on it; otherwise each adapter declares its own `mcpServersKey`.
- The 16-sub-agent observability is OUT-OF-SCOPE unless MCP work finishes early. Don't start it; flag it in your DONE post as a Sprint 49 candidate.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 48 Grok MCP auto-wire user-settings.json mcpServers Bun OpenTUI adapter")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/T1-codex-mcp-autowire.md (shared helper)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/grok.js
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md (search for "Grok smoke test PART 3" — that's your single best research input for Grok-specific behavior)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
