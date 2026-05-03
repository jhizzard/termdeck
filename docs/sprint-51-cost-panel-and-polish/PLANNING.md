# Sprint 51 — Cost-monitoring panel + UX polish quartet

**Status:** Stub plan, authored at v1.0.0 close (2026-05-02 15:53 ET). Lane briefs not yet authored — orchestrator authors at kickoff after substrate probe.
**Target version:** `@jhizzard/termdeck@1.1.0` (minor — new user-visible cost panel + UX polish; no breaking changes). Companion: `@jhizzard/termdeck-stack@0.6.1` (audit trail; no functional change unless T2 click-stability fix touches the wizard's launcher button DOM advice).
**Last-published baselines (v1.0.0 release wave 2026-05-02 15:48 ET):** `termdeck@1.0.0`, `termdeck-stack@0.6.0`, `mnestra@0.4.0`, `rumen@0.4.4`.

> **⚠️ Sprint 51 may pivot to Sprint 51.5 first.** A real-user P0 surfaced 2026-05-02: stack-installer has no upgrade-detection path, so projects predating Sprint 38 never got migrations 009–015 / TermDeck migration 003 / graph-inference Edge Function. Reported by Brad's Claude Code on `jizzard-brain`. Synthesis at [`docs/INSTALLER-PITFALLS.md`](../INSTALLER-PITFALLS.md). v1.0.1 hotfix sprint authored at [`docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md`](../sprint-51.5-installer-upgrade-and-doctor/PLANNING.md). **Orchestrator decides at kickoff** whether to ship 51.5 first then 51 as Sprint 52, or interleave — read both PLANNINGs and call it.

## Why this sprint

v1.0.0 ships the trust-fundamental gates (per-agent MCP auto-wire + multi-agent memory + UX trust trio + dogfood validation). Sprint 51 is the **first post-v1.0.0 polish-and-feature wave** — three small UX cleanups Joshua flagged during Sprint 50 close (each one independently erodes new-user trust) plus the cost-monitoring panel that closes the "outside users may surprise themselves with bills" failure mode of mixed-agent adoption. None of these are v1.0.0 blockers — they're v1.1.0 confidence builders.

The cost panel deliberately rides naturally on top of Sprint 48's `costBand` adapter field (already declared on all 4 adapters; never surfaced visibly) and Sprint 50 T2's `source_agent` provenance column (lets the panel show "your last 30 days of memory spend, broken down by source LLM"). **No infrastructure work needed — Sprint 51 reads what's already shipped and renders it.**

## Lanes (sketch — orchestrator finalizes at kickoff)

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Cost-monitoring expandable panel** | NEW server endpoint `GET /api/cost-summary?session=<id>` returning per-active-panel: `{agent, costBand, sessionTokensIn, sessionTokensOut, costEstimateUsd, includedInSubscription: bool}`. Token counts extracted from each adapter's transcript usage objects (Claude `usage.input_tokens`/`output_tokens` per turn; Codex / Gemini / Grok same shape via their respective response usage metadata). Cost estimates: per-adapter `pricing` field (NEW 12th adapter contract field) — `{subscriptionTiers: [{name, included: '...'}], perTokenRate: {input, output, currency}}`. Client renders an expandable drawer at the bottom-right of the dashboard (collapsed by default; click expands). Optional non-blocking threshold toast when a per-token agent crosses a user-configurable spend threshold (default $5/session — Joshua to decide at scoping). | NEW `packages/server/src/cost-summary.js` (~120 LOC), EDIT 4 adapter files (+pricing field, ~20 LOC each), NEW `packages/client/public/cost-panel.{js,html-fragment}` (~150 LOC), NEW `tests/cost-summary.test.js` (~80 LOC, ~8 tests). |
| **T2 — Launcher click-stability + UX polish** | Fix the click-stability bug Joshua flagged at Sprint 50 close ("press the claude button at the top 2 times — the panel dynamically changes and pressing again without moving the mouse would have you click open a shell"). Recommended: combine fixed-position launcher row (`position: sticky` or absolute-positioned chrome — row stays put regardless of how many panels are below it) + brief click-confirm disable (button gets `.disabled` class for ~200ms after a click). ~25 LOC across CSS + app.js. **Bonus polish if scope allows:** keyboard navigation (`Alt+1..4` opens Claude/Codex/Gemini/Grok respectively) + accessibility (proper ARIA roles for the launcher buttons + sr-only descriptions). | EDIT `packages/client/public/{app.js,style.css,index.html}` for click-stability + optional keyboard nav. |
| **T3 — Gemini timestamp drift + per-agent quirks documentation** | Sprint 49 surfaced Gemini stamping STATUS posts ~21-44 min into the future. Lane briefs going forward should explicitly tell Gemini to use `date '+%Y-%m-%d %H:%M ET'` for every timestamp AND include the verbatim output in the post. Sprint 50 T3's `displayName` field is the precedent for documented per-agent metadata; Sprint 51 T3 adds an **`approvalModel: 'auto' \| 'per-step'`** field (12th or 13th depending on T1's pricing field ordering). Documents Gemini's per-step approval (`feedback_gemini_approval_heavy.md` memory) AND timestamp-drift mitigation in `docs/AGENT-RUNTIMES.md`. Future orchestrator logic can use `approvalModel === 'per-step'` to size lanes smaller, watch for >5min silence as approval-prompt-pending, etc. | EDIT 4 adapter files (+approvalModel field + per-agent timestamp-discipline notes), EDIT `docs/AGENT-RUNTIMES.md` § 5 (12-field contract documented), NEW lane-brief boilerplate snippet at `docs/AGENT-LANE-BRIEF-TEMPLATE.md` (timestamp discipline + per-agent quirks reference). |
| **T4 — Grok 16-sub-agent observability** | Per Sprint 47 Grok smoke-test self-report: Grok's `task` tool emits parseable stdout patterns (`"Delegating to [agent] sub-agent: ..."`, `"[sub-agent complete]"`). EXTEND `packages/server/src/session.js` analyzer to detect these and emit a structured event stream. NEW client-side collapsible tree pane in the panel header (or as a side panel) showing the sub-agent hierarchy with color-coded status pills + progress percentages. Bigger scope (~200 LOC across server + client + CSS); possibly the longest lane in this sprint. | EXTEND `packages/server/src/session.js`, NEW `packages/client/public/sub-agent-tree.{js,css-fragment}`, EDIT `packages/client/public/app.js` for tree integration, tests. |

## Acceptance criteria

1. **T1 cost panel:** dashboard shows the expandable cost drawer; clicking expand shows per-active-panel rows with cost-band badge + token counts + estimate (per-token agents) + "what's included" tooltip (subscription agents). Threshold toast fires (visually-non-blocking) when a per-token agent crosses the configured spend threshold.
2. **T2 click-stability:** rapid double-clicks on the same launcher button no longer trip across to adjacent buttons. Manual repro at Sprint 51 close: click Claude button 5× rapidly, verify all 5 panels open Claude (not 4 Claude + 1 shell). Optional keyboard nav: `Alt+1` opens Claude, `Alt+2` Codex, etc.
3. **T3 timestamp drift:** new lane briefs include the timestamp-discipline snippet. NEW Gemini lane in Sprint 52 produces STATUS posts with timestamps within ±2 min of real time (not 21-44 min future like Sprint 49). `approvalModel` field on all 4 adapters; documented in AGENT-RUNTIMES.md § 5.
4. **T4 sub-agent tree:** Grok panel running a multi-sub-agent workflow shows the tree pane updating in real-time with delegation events. Color-coded status (active=green, complete=gray, error=red).
5. **No regressions:** Sprint 50's 428/428 tests stay green. v1.0.0 user flows (per-agent auto-wire, mixed-agent panel launch, source_agent recall filter, SessionEnd hook for non-Claude agents) all unaffected.
6. **v1.1.0 publish:** `@jhizzard/termdeck@1.1.0`, `@jhizzard/termdeck-stack@0.6.1` (audit trail; OR 0.7.0 if T1's pricing-field plumbing requires the wizard to surface costBand info during install).

## Carry-overs from Sprint 50

- v1.0.0 is shipped — Sprint 51 is post-v1.0.0 territory. No carry-over urgency from Sprint 50 itself.
- The Sprint 50 worktree-isolated dogfood (T4 sub-sprint at `docs/sprint-50.5-dogfood/`) IS the close-out validation; no additional dogfood needed in Sprint 51 unless lane scopes demand it.
- `docs/INSTALL-FOR-COLLABORATORS.md` refresh — Sprint 48 → 49 → 50 → 51 carry-over. Sprint 51 finally ships it (T1 or T2 tackle as side-task).

## Other carry-overs

- **🚨 Sprint 51.5 v1.0.1 hotfix — installer upgrade-aware migration detection + mnestra doctor** ([PLANNING](../sprint-51.5-installer-upgrade-and-doctor/PLANNING.md)). Brad's 2026-05-02 schema-vs-package-drift report. Orchestrator decides whether to ship 51.5 before Sprint 51 or fold the doctor lane (T2) into Sprint 51 as the existing carry-over. Reference: [`docs/INSTALLER-PITFALLS.md`](../INSTALLER-PITFALLS.md) (NEW 2026-05-02 — read before any installer-adjacent change).
- **Upstream rumen `createJob.started_at` patch** (cross-repo work; needs `@jhizzard/rumen` patch release). 2-line fix at `~/Documents/Graciella/rumen/src/index.ts:177`. Sprint 51 may or may not pick this up depending on T1-T4 budget.
- **`mnestra doctor` subcommand** (Brad's third upstream suggestion 2026-04-28). Sprint 51 candidate side-task (~50 LOC in mnestra repo). **Note:** if Sprint 51.5 ships first, this lane is absorbed there as T2 — strike from Sprint 51.
- Sprint 40 carry-over: harness session-end hook PROJECT_MAP forward-fix.
- Sprint 40 carry-over: analyzer broadening — `PATTERNS.error` case-sensitivity gaps.
- Sprint 40 carry-over: LLM-classification pass on the ~898 chopin-nashville-tagged "other/uncertain" rows.
- **6 Sprint 46 deferrals still un-shipped** (graph viewer perf at 2000+ nodes, edge click handler, cross-project edges visual distinction, URL state codec edge case, source-session links, audit-write-gap cleanup). Probably absorbed across Sprint 52+.

## Pre-sprint substrate findings (orchestrator probes at kickoff)

Same checks as Sprint 50 plus:
- `npm view @jhizzard/termdeck version` → expect 1.0.0; T4 bumps to 1.1.0.
- `select count(*) from memory_items where source_agent IS NOT NULL` — confirm v1.0.0's `source_agent` plumbing is producing rows post-publish.
- Verify each adapter's transcript actually exposes usage metadata in the shape T1 needs (some agents may not emit usage objects in the transcript file — would need a different signal). Probe via `head -50 ~/.codex/sessions/.../rollout-*.jsonl | grep usage`.
- Confirm Joshua's daily-driver machine has v1.0.0 installed (`npm i -g @jhizzard/termdeck@latest && termdeck --version`) before Sprint 51 lanes execute against it.

## Notes

- Sprint 51 is the **first post-v1.0.0 sprint** — the bar shifts from "trigger criteria" (binary) to "polish + feature value." Lane briefs should still post FINDING / FIX-PROPOSED / DONE but the orchestrator can be more flexible on scope creep (T2 / T3 absorbing small Sprint 46 deferrals as they go is fine).
- T1 is the biggest scope. If T1 looks like it'll spill past 30 min, orchestrator can split: ship the cost SUMMARY (server endpoint + per-panel data) in Sprint 51, defer the THRESHOLD TOAST UX to Sprint 52.
- T4 may also be too big for one sprint. If sub-agent observability is more than ~150 LOC, drop it from this sprint and use the lane budget for one of the carry-over Sprint 46 deferrals instead. Don't blow the wall-clock budget chasing a stretch goal.
- v1.0.0 is the moment users will actually start filing issues. Sprint 51 may need to pivot mid-sprint if a real-user-bug surfaces during the day. Watch the @jhizzard/termdeck issue tracker between Sprints 50 and 51.
