# Sprint 46 — T3: Transcripts panel audit

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Confirm the transcripts overlay (injected into the topbar by `app.js:4340`) works end-to-end. Recent tab populates from `/api/transcripts/recent?minutes=60`, search tab works against `/api/transcripts/search?q=…` with FTS, clicking into a session loads ordered chunks via `/api/transcripts/:sessionId`, copy-to-clipboard works, Back / Close buttons behave. Cross-check against Sprint 45 T4's launcher refactor since the panel shares helpers with the launcher.

## Files

- `packages/client/public/app.js` lines ~4340–4660 (panel injection, tabs, session loader, search, copy-to-clipboard, back/close)
- `packages/server/src/transcripts.js` (`TranscriptWriter`, lazy-init pg.Pool — note shares the resilience pattern with the rumen pool)
- Server routes in `packages/server/src/index.js`:
  - `GET /api/transcripts/search` (FTS across all sessions)
  - `GET /api/transcripts/recent?minutes=N` (time-windowed crash recovery)
  - `GET /api/transcripts/:sessionId` (ordered chunks for a session)
- Existing tests: `tests/transcript-contract.test.js`
- Sprint 45 T4 cross-cut: launcher refactor at `app.js:2422-2520` shares state & helpers with the panel injection block — any state-management regression introduced by T4's refactor likely shows up here

## Audit framework

For each surface, classify as **works / broken / sub-optimal**. Capture verdict + reproducer + fix.

### Surfaces under test

1. **Open / close.** Click the topbar Transcripts button. Panel slides in / opens cleanly. Click Close — panel dismisses. Click outside — does it dismiss too (modal pattern) or stay open? Verify against the design intent.
2. **Recent tab — initial.** Default tab is Recent. Loads `/api/transcripts/recent?minutes=60`. Sessions sorted reverse-chrono. Each row shows session ID, project, last activity timestamp, chunk-count, preview snippet.
3. **Recent tab — empty state.** No sessions in the last hour: does the empty-state message render? (Verify against fixture or wait period.)
4. **Search tab — switch.** Click "Search" tab. Input box gets focus. Recent results clear or stay visible per design.
5. **Search tab — query.** Type a query (e.g. "supabase" or a project name). Hit enter or wait for debounce. Results populate from `/api/transcripts/search?q=…` (FTS5 in SQLite). Result rows highlight the matched term if the design supports it.
6. **Search tab — empty result.** Query with no matches: empty-state message renders.
7. **Click into session.** Click any row from Recent or Search. View switches to ordered-chunks-for-this-session. Chunks display in chrono order. Each chunk has a timestamp.
8. **Copy-to-clipboard.** Inside session-detail view, click "Copy to clipboard". Confirm clipboard receives the full transcript text (or whatever the design specifies). Visual confirmation (button text changes / toast) fires.
9. **Back button.** From session-detail, click Back. View returns to the prior tab + scroll position (if implemented) + filter state preserved.
10. **Cross-check against Sprint 45 T4 refactor.** Specifically: does the panel STILL spawn / open / route correctly after the launcher refactor that touched shared helpers? Run the panel exhaustively against today's `app.js` HEAD; if anything is regressed vs Sprint 43-era behavior, fix it.
11. **Performance.** Open the panel against a session with 1000+ chunks. Does the chunk list render incrementally (virtualization) or load all at once? Is it interactive?
12. **Concurrency / staleness.** Open the panel during a live session that's actively writing chunks. Do new chunks appear when revisiting the session-detail view? (Polling or WS push? Verify behavior matches design.)

## Deliverable

NEW `docs/sprint-46-dashboard-audit/T3-transcripts-audit-report.md` — structured report, one section per surface, plus roll-up table at top.

## Coordination

- T1 ↔ T2 ↔ T3 ↔ T4 are independent in surfaces, BUT T3 + T4 both touch `app.js`. T3 owns the transcripts-panel block (~4340–4660). T4 owns the launcher block (~1577 + ~2422–2520). Coordinate via STATUS.md if either lane needs to refactor a shared helper — orchestrator merges at sprint close.
- Don't bump versions. Don't touch CHANGELOG. Don't commit. Orchestrator handles close-out.

## Boot

```
1. memory_recall(project="termdeck", query="transcripts panel TranscriptWriter FTS5 search recent crash recovery /api/transcripts session-detail copy-to-clipboard")
2. memory_recall(query="recent decisions and bugs")
3. Read /Users/joshuaizzard/.claude/CLAUDE.md
4. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/PLANNING.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md
7. Read this brief
8. Open http://127.0.0.1:3000/ — click the Transcripts button in the topbar — start exercising
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md` with timestamps. Detailed walkthrough goes in `T3-transcripts-audit-report.md`, NOT inline in STATUS.
