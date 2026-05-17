# Sprint 65 — Sub-task 3.1: "CLI windows open invisible" (Brad bug 2a) — hypothesis analysis

**Author:** T3 (verification lane), 2026-05-16.
**Brad's verbatim (2026-05-12 ~10:15 ET):** *"way to ensure that CLI windows don't open invisible and are closed."* — sub-bug **2a** ("open invisible") of BACKLOG § D.5 item 2. Sub-bug 2b ("are closed") is the tile-auto-removal work owned by T1 (1.3) + T2 (2.4) this sprint.

---

## Status: 2a is DEFERRED — with one exception that is live THIS sprint

Per `PLANNING.md` § 3.1 and the orchestrator's sprint-inject intel, T3 does **not** block on Brad's repro: the orchestrator chases a WhatsApp ask for repro steps separately. As of this writing no repro from Brad has been relayed to T3.

- **If Brad's repro lands mid-sprint:** the orchestrator relays it; T3 matches it to a hypothesis below and scopes a fix-in-sprint (T1 if client-side, T2 if server-side).
- **If it does not land:** 2a-proper is deferred to Sprint 66 as a "needs repro" item — see the paste-ready BACKLOG entry at the bottom of this file.

**The exception — Hypothesis B is NOT deferred.** It is a regression risk that *Sprint 65's own chip feature introduces*, independent of whatever Brad originally hit. It is actionable now and is posted to STATUS.md as a `### [T3] FINDING` for T1. See § Hypothesis B.

---

## Hypothesis tree (A–D), assessed against the codebase

The T3 brief seeds four candidate causes. Each is assessed for: bug shape, a manual repro recipe (run against an isolated `termdeck --port 3002 --no-open` instance — never :3000/:3001), and whether Sprint 65's landed work resolves, worsens, or is neutral to it.

### Hypothesis A — off-screen grid slot

**Shape.** A panel is created in a CSS-Grid cell beyond the current layout's visible slot count. Example: layout is `2x2` (4 cells); the operator spawns a 5th panel. Depending on `#termGrid`'s overflow behaviour the 5th tile lands in an implicit grid row that is clipped or scrolled out of view. The session exists in `GET /api/sessions`; the tile is in the DOM but not on screen.

**Manual repro.** On :3002 — switch to the `2x2` layout, spawn 5 shell panels, observe whether the 5th is reachable without resizing the layout.

**Sprint 65 assessment.** Not directly fixed. Sprint 65's tile auto-removal (1.3) *reduces* the trigger surface — dead tiles no longer accumulate, so fewer panels compete for slots — and Path A's larger layouts (1.4, if folded in) give the operator more visible cells. But nothing in Sprint 65 *auto-grows* the layout to the live panel count, so A remains possible if the operator keeps a small layout while spawning many panels. **Verdict: partially mitigated, not closed.** Candidate for a Sprint 66 "auto-fit layout to panel count" item.

### Hypothesis B — `display:none` from the chip filter ⚠ SPRINT-65-INTRODUCED

**Shape.** Sprint 65 T1 sub-task 1.1 adds project-filter chips. A non-"All" chip applies the class `panel--filtered-out` (`display:none`) to every tile whose `meta.project` ≠ the selected chip. **A panel spawned while a non-matching chip filter is active is therefore born hidden.**

Concretely: the operator has the `aetheria` chip selected. They spawn a new panel whose project is `structural360`. The new tile's `meta.project !== 'aetheria'`, so the chip-filter logic adds `panel--filtered-out` → `display:none`. The operator just spawned a panel and **it did not appear** — a textbook "opens invisible". The filter selection persists in `localStorage` (`termdeck.dashboard.projectFilter`), so this also fires on the *first* panel spawned in a fresh tab if a filter was left selected in a prior session.

**This is not a hypothesis about a pre-existing bug — it is a new failure mode this sprint creates.** Before Sprint 65 there were no chips and no `panel--filtered-out` class. It would be a poor outcome for the sprint that is partly meant to *fix* "opens invisible" to *manufacture* a fresh instance of it.

**Manual repro (once T1 FIX-LANDS).** On :3002 — spawn 2 panels project=`alpha`; click the `alpha` chip; spawn a panel project=`beta`. Observe: does the `beta` panel appear, or is it hidden behind the active `alpha` filter?

**Recommended T1 mitigation (one of):**
1. **Auto-switch the chip to the spawned panel's project** — when a panel is created whose project ≠ the active chip, switch the active chip to that project. Most intuitive: the operator wants to see what they just launched. *Recommended.*
2. Keep the filter but make the arrival unmissable — flash/pulse the chip for the new panel's project and bump its count, so the operator sees *where* the panel went.
3. Surface a brief toast — "panel spawned under project `beta` — hidden by the `alpha` filter" — with a click-to-reveal.

Option 1 is the cleanest and matches operator intent. Whatever T1 picks, the invariant T3 will verify is: **spawning a panel must never silently produce a tile the operator cannot see or reach.**

**Sprint 65 assessment.** B is *introduced* by 1.1 and **must be handled within this sprint** — it is the one branch of the 2a tree that Sprint 65 both touches and must own. Posted to STATUS.md as a `### [T3] FINDING` for T1. An ACCEPTANCE-CHECKLIST.md step covers it.

### Hypothesis C — dark-veil modal overlay

**Shape.** A stuck modal/overlay with a z-index above the xterm.js panels covers the grid and swallows pointer events — the panels are rendered but appear "covered" and unusable. This is `docs/ARCHITECTURE.md` § Known issues **#8** ("Dashboard 'dark veil'"), open since Sprint 36, with a documented workaround (`Esc` then `Cmd+Shift+R`).

**Manual repro.** Not reliably reproducible on demand — #8 is itself a "needs repro" known issue. The fingerprint: the whole window looks dimmed/covered; clicks and keyboard focus do not reach the terminals.

**Sprint 65 assessment.** Out of scope. Sprint 65 touches chips, the ORCH pin, tile lifecycle, and `meta.role` — no modal/overlay code. If Brad's 2a repro turns out to be the dark veil, it is a separate fix (Known Issue #8) and should be scoped on its own, not folded into Sprint 65.

### Hypothesis D — WS race / cross-client spawn

**Shape.** A panel is created server-side but an already-open dashboard never renders a tile for it. Per T1's 19:50 architecture note, `status_broadcast` only updates meta + counts via `updateGlobalStats` — **it never creates tiles**. So a panel spawned by a *different* client or by the inject API (e.g. the in-dashboard 4+1 sprint runner) shows up in another open dashboard's session *count* but not as a *tile* until that dashboard is reloaded. From that dashboard's point of view the panel "opened invisible".

**Manual repro.** On :3002 — open the dashboard in tab A; from a second tab/`curl`, `POST /api/sessions`; observe tab A — the global session count rises but no tile appears.

**Sprint 65 assessment.** Out of scope. Sprint 65 T1 does not add create-a-tile-from-broadcast behaviour. Worth a BACKLOG note: a dashboard could create tiles for sessions it sees in `status_broadcast` but has no DOM panel for (the mirror of T1's 1.3 "DOM panel absent from broadcast → remove" reconciliation).

---

## Summary

| Hypothesis | Sprint 65 relationship | Disposition |
|---|---|---|
| A — off-screen grid slot | Partially mitigated (1.3 fewer tiles; 1.4 bigger layouts) | Defer — Sprint 66 "auto-fit layout" candidate |
| **B — `display:none` from chip filter** | **Introduced by 1.1 this sprint** | **In-sprint — T1 must handle spawn-under-active-filter** |
| C — dark-veil modal | Untouched (separate Known Issue #8) | Defer — own fix, not Sprint 65 |
| D — WS / cross-client spawn race | Untouched | Defer — Sprint 66 BACKLOG note |

2a-proper (Brad's specific repro) stays **deferred pending Brad's repro**. Hypothesis B is handled in-sprint regardless of Brad, because Sprint 65 creates it.

---

## Paste-ready BACKLOG § D.5 entry (orchestrator — fold in at sprint close if Brad's repro did not land)

> - **🪟 Brad bug 2a "CLI windows open invisible" — needs repro.** Sprint 65 verified sub-bug 2b ("are closed" — tile auto-removal) but 2a ("open invisible") could not be reproduced without Brad's repro steps; the sprint-inject WhatsApp ask did not yield repro steps in time. T3's hypothesis analysis (`docs/sprint-65-dashboard-reliability/2A-OPENS-INVISIBLE-ANALYSIS.md`) narrows it to four candidates: (A) panel created in an off-screen CSS-Grid cell when the layout has fewer slots than live panels — partially mitigated by Sprint 65's tile auto-removal, candidate for a "auto-fit layout to panel count" follow-up; (C) the "dark veil" stuck-modal overlay, `ARCHITECTURE.md` § Known issues #8, open since Sprint 36 — needs its own fix; (D) a panel spawned by another client / the inject API never gets a tile in an already-open dashboard because `status_broadcast` updates counts but never creates tiles. **Next step:** get concrete repro steps from Brad, match to A/C/D, scope the fix. (Hypothesis B — a panel spawned while a project-chip filter is active is born `display:none` — was caught and handled inside Sprint 65 as part of the T1 chip work; it is not part of this deferral.)
