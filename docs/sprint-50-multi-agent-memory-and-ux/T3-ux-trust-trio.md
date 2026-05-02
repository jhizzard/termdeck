# Sprint 50 — T3 (Claude): UX trust trio (launcher buttons + panel labels + spinner freeze)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Gate-blocker UX gaps from Sprint 49):**

Three "visible signal lies to the human" bugs surfaced during Sprint 49 inject. All three independently erode user trust; v1.0.0 ships when they're fixed. Single lane bundles them because they share the same client + adapter-registry plumbing.

## Files

- EDIT `packages/server/src/index.js` — NEW route `GET /api/agents` returning the registered adapter list (one entry per `AGENT_ADAPTERS` value: `{name, sessionType, displayName, spawn: {binary, defaultArgs}}`). Optional `displayName` field added to the adapter contract (11th field if T1 adds resolveTranscriptPath; ordering negotiable).
- EDIT `packages/client/public/index.html` — replace hardcoded Claude button with a JS-rendered list. Container element + script hook.
- EDIT `packages/client/public/app.js` — fetch `/api/agents` on dashboard load, render one labeled launcher button per adapter (Claude / Codex / Gemini / Grok). Click handler POSTs to existing panel-create API with `command: <binary>`.
- EDIT `packages/client/public/app.js` (different section) — panel header label reads from `meta.type` (or `displayName` from adapter when available), not from launch command. Today the label says "Shell" because it reads the spawn command string; fix points it at adapter resolution.
- EDIT `packages/client/public/style.css` — spinner CSS animation: `animation-iteration-count: infinite` (currently runs once and stops). Plus: when `meta.status` transitions away from `thinking`, the panel UI should re-render the status text and stop the spinner. Today the spinner stops mid-`thinking` because the CSS keyframe completes its first cycle.
- EDIT `packages/client/public/app.js` (status-update section) — when `lastActivity` changes for a panel and `status === 'thinking'`, force-re-trigger the spinner (remove + re-add the spinner class with a brief delay) so the animation restarts. **Alternative cleaner approach:** make the spinner CSS purely time-based (infinite loop) and don't touch it from JS — single-line CSS fix.

## Acceptance criteria

1. **Launcher buttons:** dashboard panel chooser shows one button per registered adapter (4 today: Claude, Codex, Gemini, Grok). Each button labeled with the agent's display name. Clicking launches the right binary and the resulting panel correctly shows `meta.type` in the API.
2. **Panel labels:** opened Codex panel header shows "Codex", Gemini shows "Gemini", Grok shows "Grok", Claude shows "Claude Code" — NOT "Shell" or the raw launch command.
3. **Spinner stays alive:** simulate a long-thinking phase in a Claude panel (e.g., orchestrator-injected message that triggers a 60+ second response). Spinner animates throughout the entire phase. Status field transitions to `idle` cleanly when the agent is done; spinner stops at the right moment (NOT prematurely).
4. **No regressions:** existing dashboard tests stay green. Sprint 49 graph + flashback + transcripts work unchanged.
5. **Dogfood evidence in T4:** Sprint 50 close-out's worktree-isolated dogfood (T4) opens its 4 mixed-agent panels via the new launcher buttons (not via shell + manual binary command). Headers correctly identify each panel. Spinner animation visible during T4's lane work.

## Coordination

- T3 is mostly client-side; T1 + T2 are server-side. Independent.
- The new `GET /api/agents` route in T3 may be useful for T4's dogfood orchestrator (so the inject script can detect agent types via the same source). Document the route in your DONE post.
- If T3 ships fast, consider adding a `displayName` field to each adapter (`Claude Code`, `Codex CLI`, `Gemini CLI`, `Grok CLI`) — improves the launcher button labels without inventing a separate name field. T1 may also want this field for log messages.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 50 launcher buttons panel labels spinner freeze UX trust trio dashboard adapter registry")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/PLANNING.md (gate-blocker UX gaps section is your spec)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/index.js (the registry you expose via /api/agents)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/client/public/index.html (find the launch panel chooser DOM)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/client/public/app.js (status update logic + panel header rendering — search for "shell" + "thinking" + "spinner")
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
