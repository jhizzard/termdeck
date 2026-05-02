# Sprint 49 — T4 (Claude): Auto-wire-on-launch + `termdeck-stack@0.5.1` hotfix publish

**Lane scope:** Two related deliverables that together close the v0.17.0 → 0.5.1 follow-up loop and prepare the auto-wire infrastructure for v1.0.0:

1. **Auto-wire-on-launch.** Sprint 48 T1 shipped `mcp-autowire.js` `ensureMnestraBlock(adapter)`. Sprint 48 T1/T2/T3 shipped per-agent `mcpConfig` declarations on Codex/Gemini/Grok adapters. But nothing currently wires the helper into the global launcher — `npx @jhizzard/termdeck-stack start` only boots the three processes; it doesn't make sure the agent CLIs all have their Mnestra block. Sprint 49 closes that loop: `startStack()` calls `ensureMnestraBlock` for every adapter that declares a non-null `mcpConfig`. Idempotent — second `start` is a no-op for the wiring step.

2. **`termdeck-stack@0.5.1` publish.** Local commit `dd5173c` (post-Sprint-48 polish) ships the bundled hook fix: `hooks.Stop` → `hooks.SessionEnd` (was firing on every assistant turn instead of once per `/exit`) + `~/.termdeck/secrets.env` fallback in the bundled hook + migration branch in `_mergeSessionEndHookEntry` so existing users get healed on their next `npx @jhizzard/termdeck-stack` run. T4 stamps the changelog and ships.

**Agent: Claude.** This is the orchestration / publish lane — needs careful version-bump discipline + coordination across two files (`launcher.js` + `CHANGELOG.md` for stack-installer).

## Files

### Deliverable 1: auto-wire-on-launch

- EDIT `packages/stack-installer/src/launcher.js` `startStack()` — after the binary checks but before health probes, iterate `AGENT_ADAPTERS` (require it via the bundled installer's awareness of `@jhizzard/termdeck`'s install path; if you can't reach the registry from the installer cleanly, EITHER copy the adapter's `mcpConfig` shape into a small bundled config OR `require('@jhizzard/termdeck/packages/server/src/agent-adapters')` if the path resolves). For each adapter where `adapter.mcpConfig` is a non-null object, call `ensureMnestraBlock(adapter)`. Print a one-line summary like `auto-wire: codex (wrote), gemini (unchanged), grok (wrote)`. Skip Claude (`mcpConfig: null`). Skip on `--no-wire` flag if you add one for users who explicitly don't want it.
- EDIT `packages/stack-installer/src/launcher.js` exports — expose `_autowireMcp(adapters)` for tests.
- NEW `packages/stack-installer/tests/launcher-autowire.test.js` (~80 LOC, ~5 tests) — mocks `ensureMnestraBlock`, asserts: (a) called once per non-null-mcpConfig adapter, (b) skipped for null-mcpConfig (Claude), (c) summary line printed correctly, (d) errors from the helper don't kill the launcher (logged + continued), (e) `--no-wire` flag bypasses entirely if implemented.

### Deliverable 2: stack-installer 0.5.1 publish

- EDIT `packages/stack-installer/package.json` — bump version `0.5.0` → `0.5.1`.
- EDIT `CHANGELOG.md` — new `## [0.5.1] - YYYY-MM-DD` block under `@jhizzard/termdeck-stack`. Cover the hook hotfix (Stop → SessionEnd + secrets.env fallback + migration branch) AND the auto-wire-on-launch (Deliverable 1). Match the dense-bullet shape of the Sprint 48 entry.
- The hook source files (`packages/stack-installer/assets/hooks/memory-session-end.js`) and the merge function (`packages/stack-installer/src/index.js`) and the test file (`tests/stack-installer-hook-merge.test.js`) ALREADY have the changes from `dd5173c` — you don't re-edit them, you just stamp the version + changelog so the next publish has the right metadata.

## Acceptance criteria

1. `node -e "const L=require('./packages/stack-installer/src/launcher'); console.log(typeof L._autowireMcp);"` prints `function`.
2. `_autowireMcp(adapters)` is idempotent: second call against an already-wired environment returns `{wired: 0, unchanged: 3}` (or similar shape).
3. Claude adapter (mcpConfig: null) is never passed to `ensureMnestraBlock`.
4. `npm view @jhizzard/termdeck-stack version` returns `0.5.1` after publish.
5. CHANGELOG entry covers both deliverables with the lane-style bullet density.
6. No regressions: `node --test tests/stack-installer-hook-merge.test.js` stays at 53/53. `node --test packages/stack-installer/tests/launcher.test.js` stays at 10/10 (plus the new 5 from `launcher-autowire.test.js` = 15 total).

## Coordination

- T4 is independent of T1/T2/T3 — different package (`@jhizzard/termdeck-stack`), different files.
- **Publish discipline (orchestrator handles, you stage):** at sprint close, Joshua publishes via `cd packages/stack-installer && npm publish --auth-type=web`. RELEASE.md is canon. Don't run `npm publish` yourself; stage everything so the orchestrator's close-out flow works the same as Sprint 48 (commit → publish → push).
- If T1/T2/T3 close early and you finish auto-wire fast, you can also bump `@jhizzard/termdeck` to `1.0.0` if the v1.0.0 inflection criteria from Sprint 48 PLANNING are met (≥1 non-Claude lane shipped meaningful real work). Otherwise hold the termdeck version at `0.17.0` and only ship `termdeck-stack@0.5.1`.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 49 auto-wire-on-launch ensureMnestraBlock startStack stack-installer 0.5.1 SessionEnd hook hotfix CHANGELOG")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/src/launcher.js (the file you extend)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/mcp-autowire.js (the helper you consume; understand its contract before wiring)
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/index.js (registry shape — for the iteration in startStack)
13. git log --oneline dd5173c -1 (the post-Sprint-48 polish commit your CHANGELOG entry stamps)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump termdeck version (orchestrator decides v1.0.0 vs v0.18.0 at close); DO bump termdeck-stack 0.5.0 → 0.5.1 + author CHANGELOG. Don't commit — orchestrator handles all close-out.
