# Sprint 47 — T3: Inject script extension (mixed-agent dispatch)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Extend `packages/server/src/sprint-inject.js` to take `lanes[].agent` and dispatch per-lane: lookup binary from the adapter registry, apply the right paste shape, fire the two-stage submit. After this lane closes, future inject scripts (cloned-and-renamed each sprint) just declare `lane.agent` in the LANES array; the helper handles the rest.

## Files

- EXTEND `packages/server/src/sprint-inject.js` (currently the two-stage helper for Claude — Sprint 37 T4 baseline)
- NEW `tests/sprint-inject-mixed-agent.test.js` (~100 LOC, stubs `writeBytes` + `getStatus`, pins dispatch logic for all four agents)
- UPDATE the inject-script template — establish the canonical shape future sprints clone

## What "extend" means

Today `sprint-inject.js` accepts a `lanes[]` array where each lane has `{ sessionId, prompt }`. The helper writes the bracketed-paste payload to each session, settles, writes `\r`, verifies status. Sprint 47 extends this:

```js
// Before (Sprint 37 baseline)
function injectSprint(lanes) {
  // lanes: [{ sessionId, prompt }]
  // Bracketed-paste pattern only (Claude assumption)
}

// After (Sprint 47)
function injectSprint(lanes, options) {
  // lanes: [{ sessionId, agent, briefingPath, ...allTheVarsForBootPromptResolver }]
  // For each lane:
  //   const adapter = AGENT_ADAPTERS[lane.agent || 'claude'];
  //   const prompt = resolveBootPrompt(lane.agent || 'claude', lane.vars);
  //   const payload = adapter.acceptsPaste
  //     ? `\x1b[200~${prompt}\x1b[201~`
  //     : chunkedFallback(prompt);
  //   writeBytes(lane.sessionId, payload);
}
```

The `acceptsPaste` flag is a NEW field on the adapter contract (extends from 7 to 8 fields). Existing adapters: Claude=true, Codex=true (TUI accepts paste), Gemini=true (paste-friendly per Sprint 45 T2), Grok=needs-verification (Bun+OpenTUI per Sprint 45 T3 prep notes). Lane-time test: paste a 200-line prompt into a Grok TUI; if it rejects or eats the paste, set `acceptsPaste=false` and use the chunked fallback.

## Chunked fallback (defensive path, ~30 LOC)

If an adapter declares `acceptsPaste: false`, write the prompt in newline-delimited chunks with a small inter-chunk delay so the TUI's input handler can buffer line-by-line. Slower than bracketed-paste but works against any line-oriented TUI.

```js
async function chunkedFallback(sessionId, prompt, writeBytes, sleep) {
  const lines = prompt.split('\n');
  for (const line of lines) {
    await writeBytes(sessionId, line + '\r');
    await sleep(20);
  }
}
```

## Acceptance criteria

1. **Existing Claude path unchanged.** Sprint 47's own inject (claude on all four lanes) goes through the new code path with `acceptsPaste=true` and produces the same payload as Sprint 46's inject. Snapshot test with stubbed `writeBytes`.
2. **Mixed-agent dispatch works.** A synthetic test fires a 4-lane inject with `T1=codex / T2=gemini / T3=grok / T4=claude`. Each lane's `writeBytes` receives the right bracketed-paste payload (or chunked fallback if `acceptsPaste=false`). Verify with stub `writeBytes` that captures all calls per session.
3. **Adapter-contract extended.** All four existing adapters (claude.js, codex.js, gemini.js, grok.js) declare `acceptsPaste: true` (default). Grok's value gets verified at lane time; if Bun+OpenTUI rejects bracketed-paste, flip to false and add `chunkedFallback` integration test.
4. **Paste-pattern parity test.** Adapter parity test (`tests/agent-adapter-parity.test.js`) extended to assert all four adapters declare `acceptsPaste`. Today's parity test already iterates the registry; extending it is one new assertion.
5. **Inject-script template updated.** The canonical shape future sprints clone (currently `docs/sprint-46-dashboard-audit/scripts/inject-sprint46.js` is the freshest reference) gains a `lanes[].agent` field. Authors fill it in per their sprint's needs.

## Coordination

- T3 consumes T2's `resolveBootPrompt`. T2 must ship before T3's snapshot tests can pin the per-agent payloads. If T2 lands first, T3 is unblocked. If T2 is mid-flight when T3 needs to test, T3 stubs `resolveBootPrompt` and the integration is verified at sprint close (orchestrator merges).
- T3 modifies `packages/server/src/agent-adapters/{claude,codex,gemini,grok}.js` to add the `acceptsPaste` field. Each adapter file gets a 1-line change. Coordinate with whoever audits the adapter modules — Sprint 45 lane authors are the natural reviewers but they're not active this sprint.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 37 T4 sprint-inject two-stage submit bracketed paste Sprint 45 inject-sprint45.js mixed agent dispatch agent adapters acceptsPaste")
3. memory_recall(query="recent decisions and bugs")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (especially the MANDATORY two-stage submit pattern section)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/sprint-inject.js (the current helper — your extension target)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/claude.js (adapter contract reference; Sprint 47 extends with acceptsPaste)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
