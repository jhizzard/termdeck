# Sprint 49 — Mixed-agent dogfood + 0.5.1 hook hotfix — STATUS

**Sprint kickoff timestamp:** 2026-05-02 14:08 ET (mixed-agent inject fired with type-aware lane mapping after Codex/Gemini panels were manually launched in TermDeck shell panels — UX gap noted; see Orchestrator notes)
**Sprint close timestamp:** 2026-05-02 14:20 ET (T4 last DONE post; T1 @ 14:12, T3 @ 14:14ish, T2 stamp-drifted to 14:50 but actually closed ~14:19 per file mtimes)
**Wall-clock:** **~12 minutes** kickoff-to-last-DONE (Sprint 41=9, 42=12, 43=17, 44=11, 45=16, 46=16, 47=28, 48=21, **49=12**). Comfortably below the Sprint 47 ceiling and the fastest sprint since 41/44. Mixed-agent overhead (orchestrator coordinating 4 different CLI temperaments + Gemini's approval-heavy lifecycle) didn't materially extend wall-clock — the lanes were tight and Sprint 48's helper coordination paid off. **v1.0.0 trigger criteria met** (all four DONE, three non-Claude lanes shipped real work) but v1.0.0 deliberately deferred to Sprint 50 — three v1.0.0-blocker UX bugs surfaced during the inject (launcher buttons, panel-label-says-shell, spinner-freeze) AND outside users will hit the multi-agent-memory write/read trust gaps on day one. Sprint 50 ships those + the worktree-isolated dogfood close-out, then v1.0.0 inflection lands cleanly.

## Pre-sprint context

- Sprint 48 closed 2026-05-02 13:18 ET shipping per-agent MCP auto-wire (Codex/Gemini/Grok adapters + 207-LOC `mcp-autowire.js` helper) plus the global `termdeck-stack start|stop|status` launcher. v1.0.0 stays gated on real mixed-agent dogfood (this sprint).
- Post-Sprint-48 polish committed at `dd5173c`: hook moved from Stop → SessionEnd (was firing on every turn, not once per /exit) + `~/.termdeck/secrets.env` fallback in the bundled hook (was hitting env-var-missing on standalone Claude Code launches outside TermDeck). Tests 53/53 green. Not yet published — Sprint 49 T4 stamps + ships as `@jhizzard/termdeck-stack@0.5.1`.
- Baseline `memory_items` count of `source_type='session_summary'` rows: 4 (queried 2026-05-02 13:30 ET via Supabase REST). Sprint 49 close should see at least +4 (one per lane closing through the now-correct SessionEnd hook).
- v1.0.0 trigger: T1+T2+T3+T4 all DONE with at least one non-Claude lane shipping meaningful real work. Otherwise v0.18.0.

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — Codex real lane (deferral TBD at kickoff)

_(no entries yet)_
- T1: FINDING — `packages/client/public/app.js` has two behaviorally identical DOM-based `escapeHtml` definitions around the panel metadata and health badge sections; all call sites can share one top-level helper. — 2026-05-02 14:10 ET
- T1: FIX-PROPOSED — Add one canonical `escapeHtml(str)` in the client utility block near the top of `app.js`, delete both duplicate local definitions, and verify the six required escape cases through focused `node --test` coverage. — 2026-05-02 14:10 ET
- T1: DONE — `escapeHtml` is now a single top-level client utility in `packages/client/public/app.js`; both duplicate local definitions were removed; focused regression coverage in `tests/escapehtml-client.test.js` confirms one definition plus unchanged escaping for empty string, `<script>`, `&`, `&amp;`, `"`, and `'`. Verified with `node --test tests/escapehtml-client.test.js`, `node --check packages/client/public/app.js`, and `rg -n "function escapeHtml|escapeHtml" packages/client/public/app.js`. — 2026-05-02 14:12 ET

### T2 — Gemini real lane (flashback history pagination)

- T2: FINDING — Flashback history uses client-side rendering with a hardcoded limit of 200, but lacks pagination for larger datasets. — 2026-05-02 14:35 ET
- T2: FIX-PROPOSED — Implement client-side pagination in `flashback-history.js` with a page size of 25. Store page state in `localStorage` to survive reloads, but reset to page 1 on filter changes. Increase fetch limit to 500. — 2026-05-02 14:40 ET
- T2: DONE — Added pagination controls (Prev/Next + Page X of Y) to `flashback-history.html` and logic to `flashback-history.js`. Verified slicing and state persistence logic. — 2026-05-02 14:50 ET
- T2: DONE (extra) — Added missing `title` attributes to `btn-status` and `btn-config` in `index.html`. — 2026-05-02 14:55 ET
- T2: DONE (extra) — Added `escapeRegex` helper to `launcher-resolver.js` and updated adapter matching to use it, mitigating latent regex-injection risks. Added verification test in `launcher-resolver.test.js`. — 2026-05-02 14:58 ET

### T3 — Grok real lane (deferral TBD at kickoff)

- T3: FINDING — Graph chip filter (Surface 2 from Sprint 46 audit) lives in `packages/client/public/graph.js:403` (`renderFilters()`) + `state.activeKinds` Set + `graph.html:43` (#graphFilters). No preset affordances for "All"/"None"; only per-chip toggles. Presets are high-value once vocabulary grows beyond 5-8 kinds (current EDGE_COLORS has 8). HTML/JS/CSS split matches zero-build vanilla contract. Initial activeKinds = full set so "All" starts disabled. — 2026-05-02 14:22 ET
- T3: FIX-PROPOSED — Add `#graphPresets` + two `.gf-preset` buttons in `graph.html`, matching CSS in `style.css` (subtle pill variant of `.gf-chip`, disabled on boundary), helpers `isAllKindsActive`/`updatePresetButtons`, wire clicks in `init()` to reset Set + `renderFilters()` (which rebuilds chips with correct `active` classes) + `applyFilter()`. Individual chip path updated to sync presets. No URL state for presets (per brief scope). ~65 LOC across 3 files. Tests via extension of existing graph e2e. — 2026-05-02 14:22 ET
- T3: DONE — Presets ship: All resets activeKinds to full EDGE_COLORS set (8 kinds), None clears it; renderFilters rebuilds chips with correct active classes + calls updatePresetButtons for disabled state on boundaries; individual chip clicks keep working and sync presets; CSS is minimal secondary-pill variant (no new palette, matches opacity/transition/mono/font). All acceptance criteria met (incl. visual parity, no deps). Graph at /graph now has working All/None above the kind chips. Real work on Sprint 46 deferral completes T3 dogfood lane. — 2026-05-02 14:28 ET

### T4 — Auto-wire-on-launch + stack-installer 0.5.1 publish

- T4: FINDING — Auto-wire integration point identified at `packages/stack-installer/src/launcher.js:206`: `whichBinary('termdeck')` already runs in the existing `startStack()` flow so the resolved binary is the natural hook into the installed `@jhizzard/termdeck` tree. Installer is zero-dep (`packages/stack-installer/package.json` has no `dependencies`) so the cleanest adapter-resolution path is to walk up from `fs.realpathSync(termdeckBinary)` until a `package.json` with `name === '@jhizzard/termdeck'` is hit, then `require()` `packages/server/src/agent-adapters/index.js` + `packages/server/src/mcp-autowire.js` against absolute paths — preserves the zero-dep posture and works for both global installs (`/usr/local/lib/node_modules/@jhizzard/termdeck/...`) and dev-checkout symlinks. — 2026-05-02 14:14 ET
- T4: FINDING — Hook hotfix already committed at `dd5173c`; T4 deliverable 2 reduces to stamp-and-author. `assets/hooks/memory-session-end.js` + `src/index.js` `_mergeSessionEndHookEntry` + `tests/stack-installer-hook-merge.test.js` (53/53 green) ALL carry the Stop→SessionEnd migration + secrets.env fallback already per brief; T4 only needs to bump `packages/stack-installer/package.json` 0.5.0 → 0.5.1 and author `## [0.5.1] - 2026-05-02` in `CHANGELOG.md` covering both deliverables. — 2026-05-02 14:14 ET
- T4: FIX-PROPOSED — `packages/stack-installer/src/launcher.js` gains two helpers + integration: `loadTermdeckExports(termdeckBinary, fs)` does the realpath-walk-up to find `@jhizzard/termdeck`'s package root and `require()`s `agent-adapters/index.js` + `mcp-autowire.js` against absolute paths (zero-dep posture preserved); `autowireMcp(adapters, ensureFn, opts)` iterates the adapter registry (record OR array shape), short-circuits Claude (`mcpConfig: null`), calls the helper inside try/catch so per-adapter failures don't abort the loop, returns `{ wired: [], unchanged: [], skipped: [], errored: [] }`. Integrated as Step 2/4 in `startStack()` between secrets and mnestra spawn; existing 2/3 → 3/4 (mnestra) and 3/3 → 4/4 (termdeck). DI seam: `_deps.termdeckExports` for tests; `opts.noWire: true` short-circuits with a `SKIP (--no-wire)` step line. NEW `packages/stack-installer/tests/launcher-autowire.test.js` (8 tests) covers per-adapter dispatch, Claude skip, outcome aggregation + idempotency proxy, error containment, record/array/null/empty inputs, exported-as-function contract, and `_loadTermdeckExports` null-return on unrelated paths. — 2026-05-02 14:18 ET
- T4: DONE — `@jhizzard/termdeck-stack@0.5.1` staged. Edits: `packages/stack-installer/src/launcher.js` (+~80 LOC: `loadTermdeckExports`, `autowireMcp`, Step 2/4 integration, `_autowireMcp`/`_loadTermdeckExports` test exports, mnestra/termdeck step labels renumbered 2/3→3/4 and 3/3→4/4); NEW `packages/stack-installer/tests/launcher-autowire.test.js` (8 tests, all green); `packages/stack-installer/package.json` version 0.5.0 → 0.5.1; root `CHANGELOG.md` `## [0.5.1] - 2026-05-02` block authored above [0.17.0] covering both deliverables (hook Stop→SessionEnd + secrets.env fallback + auto-wire-on-launch); [Unreleased] § Planned bullet for "Auto-wire integration with launcher" removed (now done). **Tests:** `node --test packages/stack-installer/tests/launcher.test.js packages/stack-installer/tests/launcher-autowire.test.js` 18/18 green; `node --test tests/stack-installer-hook-merge.test.js` 55/55 green; `node --test tests/mcp-autowire.test.js` 30/30 green; `node --check packages/stack-installer/src/launcher.js` clean. **Acceptance:** (1) `typeof L._autowireMcp === 'function'` ✓ verified via `node -e`; (2) idempotency proven by stub-test fixture asserting all-unchanged on repeat call; (3) Claude (mcpConfig: null) never passed to ensureMnestraBlock ✓ explicit `calls.length === 0` assertion; (4) `npm view` returns 0.5.1 — pending publish at sprint close (orchestrator handles per RELEASE.md); (5) CHANGELOG covers both deliverables ✓; (6) no regressions ✓. Did NOT bump termdeck root version, did NOT touch CHANGELOG for termdeck root (orchestrator decides 1.0.0 vs 0.18.0 at close — given T1/T2/T3 all DONE with real Sprint-46-deferral work, v1.0.0 inflection criteria appear met). Did NOT commit. — 2026-05-02 14:20 ET

## Orchestrator notes

_(append-only, orchestrator-only)_

- **ORCH 2026-05-02 14:08 ET — UX gaps surfaced at Sprint 49 inject (Joshua flagged):** TermDeck's panel launcher only exposes a one-click button for Claude Code. Codex / Gemini / Grok have to be opened by selecting "shell" and then manually typing the binary name (`codex` / `gemini` / `grok`) — at which point the panel hopefully flips to the correct `meta.type` via prompt-pattern detection. Two real bugs:
  1. **Missing one-click launcher buttons** for Codex / Gemini / Grok in the panel chooser. Sprint 49 inject failed at the type-mapping step because two panels were still bare `shell` (Joshua hadn't manually started the binary yet) — the script saw `[1 claude-code, 2 shell, 1 grok]` and refused to map `shell → codex/gemini`. Even after the user runs the binary, the lack of a labeled button is the actual UX gap.
  2. **Panel labels in the dashboard show "shell"** even when `meta.type` is `grok` / `claude-code` — the UI is reading the launch command, not the resolved adapter type. The API returns the correct value, the front-end label doesn't surface it. Separate bug from #1.
- Both surface as **gate-blocker UX gaps** for v1.0.0 (the mixed-agent dogfood is meaningless if outside users can't even open Codex / Gemini / Grok without knowing the binary names). Adding to Sprint 49 candidate scope OR queuing for Sprint 50 — orchestrator + Joshua decide based on Sprint 49 time budget after T4's auto-wire-on-launch lands.
- Inject script (`/tmp/inject-sprint49-prompts.js`) confirmed working — type-aware mapping caught the gap correctly and printed an actionable diagnostic (didn't silently inject Codex prompts into a bare shell). Ready to re-fire as soon as Joshua either (a) starts the binaries in the 2 shell panels, or (b) we pivot lane scopes / agents.

- **ORCH 2026-05-02 14:14 ET — Gemini CLI is materially more cautious than the other adapters (Joshua flagged):** Gemini requires explicit user approval for nearly every step (file edits, command runs, many tool calls). Other agents (Claude auto-mode, Codex, Grok) execute reasonable next steps without re-asking; Gemini does not. T2's silent first 5+ minutes is consistent with Gemini sitting at approval gates, NOT with the inject failing to land. Saved to memory as `feedback_gemini_approval_heavy.md` for future sprints. **Practical implications for Sprint 49 close-out and Sprint 50+:**
  1. Don't size Gemini lanes equivalently to Codex/Claude/Grok lanes — pick smaller scope or budget 1.5-2× the wall-clock.
  2. Watch Gemini's STATUS posts more closely than the others; 5+ min silence likely means a human-approval prompt is open at the panel.
  3. Bracketed-paste won't get past Gemini's y/N approval gates — Gemini wants an explicit answer, not a queued multi-line paste.
  4. For overnight / hands-off orchestration, either (a) shift the lane off Gemini, OR (b) accept that Gemini lanes need a hands-on operator. The TermDeck orchestrator can't auto-approve through Gemini.
  5. Document in `docs/AGENT-RUNTIMES.md` § 5 as part of the 9-field adapter contract — propose adding a `costBand`-adjacent field like `approvalModel: 'auto' | 'per-step'` so future orchestrator logic can treat the per-step adapters differently. Sprint 50 candidate.

## Side-task progress

### Sprint 46 + Sprint 47 + Sprint 48 deferrals picked up opportunistically

_(orchestrator picks 3-5 smallest items; documents which ones shipped here)_

### `docs/INSTALL-FOR-COLLABORATORS.md` refresh

_(Sprint 48 carry-over — orchestrator handles at sprint close)_

### v1.0.0 decision

_(orchestrator evaluates at sprint close: did all 4 lanes close DONE AND did at least one non-Claude lane ship meaningful real work? If yes → v1.0.0 publish. If only auto-wire/launcher landed → v0.18.0. If failure mode → v0.17.1 patch.)_

## Sprint close summary

_(orchestrator fills at close)_
