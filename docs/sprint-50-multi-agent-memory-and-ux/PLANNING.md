# Sprint 50 — Multi-agent memory plumbing + v1.0.0 UX polish

**Status:** Stub plan, authored at Sprint 49 close (2026-05-02 14:32 ET). Lane briefs not yet written; orchestrator authors at kickoff after substrate probe.
**Target version:** `@jhizzard/termdeck@1.0.0` if all four lanes close DONE — Sprint 50 is the **final v1.0.0 gate** (multi-agent memory + UX trust signals + auto-wire-on-launch + dogfood already proven). Otherwise `0.19.0`.
**Last-published baselines (Sprint 49 close 2026-05-02 14:30ish):** `termdeck@0.18.0`, `termdeck-stack@0.5.1`, `mnestra@0.3.4`, `rumen@0.4.4`.

## Why this sprint

Sprint 49 closed with v1.0.0 trigger criteria met (mixed-agent dogfood, all 4 lanes DONE, non-Claude lanes shipping real work). v1.0.0 was deferred deliberately — outside users will hit two trust-fundamental gaps on day one:

1. **Memory write-side (multi-agent memory plumbing):** `/exit` from Codex / Gemini / Grok writes nothing to Mnestra. Only Claude has a hook system. Sprint 49 closed with 4 of 4 lanes complete but only 1 of 4 panels' work captured to memory. **Architecture doc:** [docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md](../MULTI-AGENT-MEMORY-ARCHITECTURE.md).

2. **Memory read-side (provenance + filtering):** Even when every agent writes a row, there's no way to filter `memory_recall` by source LLM. Joshua's "trust Claude most" preference is unmodelable today. Sprint 49 surfaced an exact failure mode — Gemini stamped STATUS timestamps wildly into the future (14:35–14:58 ET when real time was 14:14–14:19); a future `memory_recall` consumer reading those timestamps as truth would build wrong inferences. **Same architecture doc** covers Deliverable 2 (`source_agent` column + recall filter param).

3. **UX trust signals:** Three "visible signal lies to the human" bugs from Sprint 49 — launcher buttons missing for Codex/Gemini/Grok, panel labels show "shell" instead of agent name, status spinner freezes mid-work. All three erode user trust independently; v1.0.0 ships when they're fixed.

4. **Dogfood validation under polished UX:** Sprint 50 close-out itself runs as a 4-lane mixed sprint (smaller scope, easily-reversible) to confirm the new launcher buttons + panel labels + spinner work end-to-end. Worktree-isolated so a botched lane doesn't pollute main.

## Lanes (sketch — orchestrator finalizes at kickoff)

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Per-agent SessionEnd hook trigger** | NEW server-side `onPanelClose(session)` in `packages/server/src/index.js` that fires the bundled hook with the correct adapter-specific payload when a non-Claude panel closes. EXTEND adapter contract with `resolveTranscriptPath(session)` (10th field) per the architecture doc. Codex/Gemini/Grok adapters implement their transcript-path resolution. **Bundles in:** Grok SQLite extraction (Sprint 45 carry-over) since Grok's transcript is in `~/.grok/grok.db` rather than a flat file. | NEW or EXTEND `packages/server/src/index.js` (`onPanelClose`), EXTEND `packages/server/src/agent-adapters/{codex,gemini,grok,claude}.js` (`resolveTranscriptPath`), tests, EXTEND `docs/AGENT-RUNTIMES.md` (9 → 10 fields). |
| **T2 — Memory `source_agent` column + recall filter** | NEW Mnestra migration `015_source_agent.sql` (column + partial index + comment). EDIT `packages/stack-installer/assets/hooks/memory-session-end.js` to populate `source_agent` from the new payload field. EDIT mnestra `mcp-server/index.ts` to add `source_agents` filter param to the `memory_recall` MCP tool. EDIT mnestra `src/recall.ts` to support the filter at the SQL level. Backfill 8 existing rows: `UPDATE memory_items SET source_agent='claude' WHERE source_type='session_summary' AND source_agent IS NULL` — these came from Claude Code. | NEW migration, EDIT mnestra source (cross-repo work — bumps mnestra to 0.3.5 or 0.4.0), EDIT bundled hook, tests. |
| **T3 — UX trust trio (launcher buttons + panel labels + spinner freeze)** | (a) Adapter-driven launcher buttons in the panel chooser — read `AGENT_ADAPTERS` registry, render one labeled button per registered adapter, click POSTs to existing panel-create API with `command: <binary>`. (b) Panel labels read from `meta.type` (or the resolved adapter `displayName`), not from the launch command. (c) Status-spinner CSS animation set to `iteration-count: infinite` OR re-triggered on every `lastActivity` update; status field transitions correctly when the agent posts DONE. ~95 LOC across server + client + CSS. | EDIT `packages/server/src/index.js` (adapter list endpoint), EDIT `packages/client/public/{app,index,style}.{js,html,css}`, tests. |
| **T4 — Worktree-isolated dogfood close-out + v1.0.0 publish** | Run Sprint 50 close-out itself as a 4-lane mixed dogfood (T4 of Sprint 50 IS the Sprint 51 kickoff). Use `--isolation=worktree` per-lane git worktrees so a botched lane is `git worktree remove` away from clean. Pick small Sprint 46 deferrals (the remaining un-claimed ones from the 14-deferral pool). Validates: (i) new launcher buttons in T3 actually work, (ii) panel labels show correct agent names, (iii) per-agent SessionEnd hooks fire and write 4 rows with correct `source_agent` values, (iv) memory_recall with `source_agents=['claude']` filter returns expected. **At close, orchestrator decides v1.0.0 vs v0.19.0.** | New PLANNING/STATUS for the dogfood, plus the actual deliverable shipping (orchestrator authors a tight Sprint 50.5 doc). |

## Acceptance criteria

1. **Memory writes from all four agents.** Closing one of each (Codex / Gemini / Grok / Claude) produces 4 new `session_summary` rows with the correct `source_agent` values. Confirmed via Supabase REST count delta.
2. **Recall filter works.** `memory_recall(source_agents=['claude'])` returns only Claude-authored rows; `memory_recall()` returns all (no breaking change).
3. **Launcher buttons present.** Panel chooser shows one button per registered adapter. Clicking each opens a panel that flips to the correct `meta.type` AND shows the right name in the panel header.
4. **Spinner stays alive.** A long Claude-thinking phase (manually reproduced via `Sleep 90` tool call inside a panel) keeps the spinner animating throughout. Status field transitions to `idle` cleanly when the agent posts DONE.
5. **Dogfood close-out succeeds with worktree isolation.** All 4 lanes DONE; no main-branch pollution from any failed lane.
6. **No regressions.** Sprint 49's 326+ tests stay green. Mnestra full test suite stays green.
7. **v1.0.0 trigger:** if 1–6 all hold, orchestrator publishes `@jhizzard/termdeck@1.0.0` + companion `@jhizzard/termdeck-stack@0.6.0` (minor bump because adapter-driven launcher buttons are a new user-visible feature) + `@jhizzard/mnestra@0.4.0` (minor — `source_agent` is a new schema feature).

## Carry-overs from Sprint 49

- v1.0.0 publish itself (Sprint 49 declined, Sprint 50 ships).
- The 3 UX gaps documented in Sprint 49 PLANNING § "Gate-blocker UX gaps" — all three roll into T3 of this sprint.
- Verify pickle-paste / approval-heavy Gemini behavior in the dogfood T4 — `feedback_gemini_approval_heavy.md` notes this. Size T4's Gemini lane ~half of the others.
- `docs/INSTALL-FOR-COLLABORATORS.md` refresh (Sprint 48 carry-over → Sprint 49 carry-over → Sprint 50).
- Optional `~/.zshrc` source-line offer in the wizard (Sprint 48 T4 deferred; Sprint 50 includes if T1 ships fast).
- Promote `packages/stack-installer/tests/**/*.test.js` into root `npm test` glob (Sprint 48 T4 deferred).
- Auto-wire-on-launch consumes `source_agent` in its hook payload (Sprint 49 T4 didn't have this — Sprint 50 T1 adds it).

## Carry-forward for Sprint 51

- **Cost-monitoring expandable panel** (`memory/project_cost_monitoring_panel.md`). Sprint 50 ships the `source_agent` data plumbing; Sprint 51 ships the visible panel that reads it.
- Grok 16-sub-agent observability (`session.js` analyzer + collapsible tree pane). Sprint 49 deferred; Sprint 51 picks up if budget allows.

## Sprint 49 Gemini observations to apply

- **Approval-heavy:** Gemini lanes need ~1.5-2× wall-clock budget (per `feedback_gemini_approval_heavy.md`). T4 dogfood-Gemini-lane should be the smallest of the four picks.
- **Timestamp drift:** Sprint 49 Gemini stamped its STATUS posts ~21-44 minutes in the future. Sprint 50 lane briefs should explicitly tell Gemini to use `date '+%Y-%m-%d %H:%M ET'` for every timestamp (and ideally include the output verbatim in the post). The `source_agent='gemini'` column will let consumers filter Gemini rows out of trust-grade recalls if the timestamp drift continues.
- **Scope creep:** Sprint 49 Gemini grabbed two Sprint 46 deferrals unprompted (added `title` attributes to `btn-status`/`btn-config` and the `escapeRegex` helper). Acceptable but the brief should explicitly forbid out-of-lane edits next time.

## Pre-sprint substrate findings (orchestrator probes at kickoff)

Same checks as Sprint 49 plus:
- `ls ~/.codex/sessions/ ~/.gemini/sessions/ ~/.grok/grok.db` — confirm transcript paths exist for T1 lane.
- `ls /Users/joshuaizzard/Documents/Graciella/engram/migrations/` — confirm migration numbering for T2 (014 was last; T2 ships 015).
- `node -e "const r=require('@jhizzard/mnestra/dist/mcp-server/index.js')"` — sanity-check mnestra package shape before T2 cross-repo edit.
- `npm view @jhizzard/termdeck version` → expect 0.18.0; T4 bumps to 1.0.0 if all criteria hold.
- `select source_agent, count(*) from memory_items group by 1` — pre-T2 baseline (expect all NULL).

## Notes

- This is the v1.0.0 sprint if everything closes. Plan accordingly: don't take ambitious lanes that risk timing out — pick proven-shape work so the dogfood close-out lane T4 exits cleanly.
- The architecture doc [docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md](../MULTI-AGENT-MEMORY-ARCHITECTURE.md) is the single source of truth for T1 + T2 design. Lane briefs reference sections of that doc rather than re-stating the rationale.
- T4's worktree-isolated dogfood is small-scope on purpose — Joshua's directive at Sprint 49 close was "save a dogfood one for a test, easily reversible, smaller sprint on a working tree." T4 IS that test, run inside Sprint 50's normal close-out.
