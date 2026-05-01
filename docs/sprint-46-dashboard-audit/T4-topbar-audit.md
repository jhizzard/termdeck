# Sprint 46 — T4: Quick-launchers + topbar UX cross-cut audit

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Confirm the three topbar quick-launch buttons (`shell` / `claude` / `python`) actually spawn correctly via `quickLaunch(cmd)` against today's adapter-driven launcher (Sprint 45 T4 refactored this path, so silent regressions are plausible). Confirm the dashboard's main launcher input (free-form command) routes through `AGENT_ADAPTERS.matches` correctly for all four CLIs (claude / codex / gemini / grok). Theme parity. Tooltip accuracy. No orphaned buttons. Cross-check the parity-row index.html quick-launch tile (the larger empty-state tiles at `index.html:90+`) against the topbar mini-buttons — both paths should behave identically.

## Files

- `packages/client/public/index.html`:
  - Topbar quick-launch row at lines 56–58 (`shell` / `claude` / `python` mini-buttons)
  - Topbar nav buttons at lines 64–65 (`graph`, `flashback history`) — confirm tooltips + onclick paths
  - Empty-state quick-launch tiles at lines 90+ (the larger mirror of the topbar mini-buttons)
- `packages/client/public/app.js:1577` (`quickLaunch(cmd)` definition — what it does today, post-Sprint-45-T4 refactor)
- `packages/client/public/app.js:2422-2520` (Sprint 45 T4 launcher refactor — adapter-driven type detection)
- `packages/server/src/agent-adapters/*.js` (registry consumed by the launcher — claude / codex / gemini / grok)
- `GET /api/agent-adapters` endpoint (Sprint 45 T4 — serializes registry for client; client builds RegExps at fetch time)
- `packages/client/public/style.css` (topbar + theme rules)

## Audit framework

For each surface, classify as **works / broken / sub-optimal**. Capture verdict + reproducer + fix.

### Surfaces under test

1. **Quick-launch: `shell`.** Click the topbar `shell` button. New panel spawns running `zsh`. Type a command, see output. Status badge transitions correctly (`active` "Ready" → tracking).
2. **Quick-launch: `claude`.** Click the topbar `claude` button. Panel spawns running `claude`. Status badge advances `active` → `thinking` "Claude is reasoning..." once Claude initializes. The Claude adapter's prompt regex picks up correctly.
3. **Quick-launch: `python`.** Click the topbar `python` button. Panel spawns `python3 -m http.server 8080`. Status badge surfaces python-server detection (port 8080 visible in metadata if the analyzer catches it).
4. **Empty-state quick-launch tiles** (lines 90+). Same three buttons in larger tile form. Click each — same behavior as topbar mini-buttons. **No drift between the two paths.**
5. **Free-form launcher: claude.** Type `claude` (or `cc`) into the main launcher input. Submit. Panel routes through `AGENT_ADAPTERS.claude.matches` → `sessionType: 'claude-code'`. Status badge consistent with #2.
6. **Free-form launcher: codex.** Type `codex` into the main launcher. Routes through `AGENT_ADAPTERS.codex` → `sessionType: 'codex'`. Status badge advances per Codex adapter's status patterns (`Thinking|Reasoning|Working`).
7. **Free-form launcher: gemini.** Type `gemini` into the main launcher. Routes through `AGENT_ADAPTERS.gemini`. Status badge advances per Gemini adapter (`Gemini is generating...`).
8. **Free-form launcher: grok.** Type `grok` into the main launcher. Routes through `AGENT_ADAPTERS.grok`. Status badge advances per Grok adapter (`Planning next moves` / `Generating plan…` / `Answering…`).
9. **Free-form launcher: bare command.** Type something neutral like `vim` or `ls`. Routes to shell fallback (no adapter claims it). Panel spawns; status reflects shell.
10. **Topbar nav buttons.** Confirm `graph` opens `/graph.html` in a new tab (per `index.html:64` `window.open` call). Confirm `flashback history` opens `/flashback-history.html`. Tooltips on each are accurate.
11. **Tooltip accuracy.** Hover every topbar button. Tooltip text matches what the button does. No stale tooltips referencing removed functionality.
12. **Theme parity.** Switch theme to at least 2 themes (`tokyo-night` and `light` via `~/.termdeck/config.yaml` or in-dashboard theme picker). Topbar renders correctly in each — no broken contrast, no clipped text, no overlapping buttons.
13. **Viewport / resize.** Shrink the browser window to 1280px / 1024px / 800px wide. Topbar buttons either resize / wrap / collapse to a menu — confirm the design's responsive intent. No buttons disappear without a fallback.
14. **Orphaned / dead buttons.** Confirm there are no buttons in the topbar (or empty-state) that reference removed features. (Sprint 30+ has churned a lot — anything stale?)

## Deliverable

NEW `docs/sprint-46-dashboard-audit/T4-topbar-audit-report.md` — structured report, one section per surface, plus roll-up table at top.

## Coordination

- T3 + T4 both touch `app.js`. T3 owns the transcripts-panel block (~4340–4660). T4 owns the launcher block (~1577 + ~2422–2520) AND `index.html`. Coordinate via STATUS.md if a shared helper needs refactoring — orchestrator merges at sprint close.
- T4 may surface findings that overlap with T1/T2 (e.g. the `graph` and `flashback history` topbar buttons route to T1/T2's surfaces). Don't audit the destination pages here — just confirm the buttons route correctly. T1/T2 own the destination audits.
- Don't bump versions. Don't touch CHANGELOG. Don't commit. Orchestrator handles close-out.

## Boot

```
1. memory_recall(project="termdeck", query="topbar quick-launch buttons quickLaunch shell claude python Sprint 45 T4 launcher refactor agent-adapters AGENT_ADAPTERS matches sessionType")
2. memory_recall(query="recent decisions and bugs")
3. Read /Users/joshuaizzard/.claude/CLAUDE.md
4. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/PLANNING.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md
7. Read this brief
8. Open http://127.0.0.1:3000/ — exercise the topbar row exhaustively
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md` with timestamps. Detailed walkthrough goes in `T4-topbar-audit-report.md`, NOT inline in STATUS.
