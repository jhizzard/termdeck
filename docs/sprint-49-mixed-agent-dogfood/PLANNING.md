# Sprint 49 — Real mixed-agent dogfood + 0.5.1 hook hotfix + auto-wire-on-launch

**Status:** Stub plan. Lane briefs not yet authored — orchestrator authors them at kickoff after a substrate probe (per-agent CLI versions, MCP-block presence, MCP-autowire smoke against each adapter).
**Target version:** `@jhizzard/termdeck@1.0.0` if a real mixed-agent sprint completes end-to-end with all four lanes posting DONE. Otherwise `@jhizzard/termdeck@0.18.0`. Companion: `@jhizzard/termdeck-stack@0.5.1` ships the hook-Stop→SessionEnd migration + secrets.env fallback that landed locally on 2026-05-02 13:30 ET (committed at `dd5173c`, not yet published).
**Last-published baselines (Sprint 48 close 2026-05-02 13:18 ET):** `termdeck@0.17.0`, `termdeck-stack@0.5.0`, `mnestra@0.3.4`, `rumen@0.4.4`.

## Why this sprint

Sprint 48 shipped the per-agent MCP auto-wire infrastructure (Codex/Gemini/Grok adapters + `mcp-autowire.js` helper) plus the global `termdeck-stack start|stop|status` launcher. The v1.0.0 inflection gate was always: per-agent MCP auto-wire **AND** a real mixed-agent sprint dogfooding the wired path end-to-end. Sprint 49 closes the dogfood gate.

Three sub-goals, one sprint:

1. **Real mixed-agent dogfood (T1-T3).** Pick a real backlog task. PLANNING.md frontmatter declares `T1=codex / T2=gemini / T3=grok`. T4 stays Claude (most reliable for the merger validation). The orchestrator runs Sprint 47's frontmatter-parser + boot-prompt resolver + status-merger end-to-end, tests them under real load. **First time non-Claude lanes post FINDING / FIX-PROPOSED / DONE in a sprint.**
2. **Auto-wire-on-launch wiring (T4 or side-task).** `startStack()` (Sprint 48 T4 launcher) calls `ensureMnestraBlock(adapter)` for each registered adapter on boot, so the global launcher also auto-wires MCP. Today the adapters declare their `mcpConfig`, the helper exists, but nothing wires them on launcher startup — only on explicit panel spawn. Sprint 49 closes that loop.
3. **Hook hotfix publish (`@jhizzard/termdeck-stack@0.5.1`).** Local commit `dd5173c` fixes two real bugs in the bundled hook: (a) registered as `hooks.Stop` instead of `hooks.SessionEnd`, so it fires on every turn instead of once per `/exit`; (b) didn't load `~/.termdeck/secrets.env` so standalone Claude Code (not in TermDeck) hit env-var-missing every time. Patched, tested, committed — needs publish.

## Lanes (sketch — orchestrator finalizes at kickoff)

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Codex (real lane)** | Pick from the 14 Sprint 46 deferrals (escapeHtml dedup + cosmetic title gaps + transcripts spinner spam are good Codex-sized scopes). Codex executes against its `mcpConfig` block written by Sprint 48 T1. **Validates Codex can call `memory_recall` end-to-end and post correctly-shaped STATUS lines that the merger normalizes.** | TBD per task; whatever the picked deferral touches. |
| **T2 — Gemini (real lane)** | Different deferral. Gemini executes against `~/.gemini/settings.json` block (Sprint 48 T2). Validates the JSON-record-merge path under real load + Gemini's at-startup MCP discovery (Gemini won't see the block until restart, so the lane's first action is a Gemini-restart side-effect to pick up the wiring). | TBD per task. |
| **T3 — Grok (real lane)** | Different deferral. Grok executes against `~/.grok/user-settings.json` block (Sprint 48 T3). Hot-load means no Grok restart needed — the lane's first `memory_recall` call should Just Work. **Bonus if scope allows:** the deferred 16-sub-agent observability ($session.js$ + UI). | TBD per task. |
| **T4 — Auto-wire-on-launch + 0.5.1 stack-installer publish prep** | EDIT `packages/stack-installer/src/launcher.js` `startStack()` — after binary checks, call `ensureMnestraBlock(adapter)` for each adapter in the AGENT_ADAPTERS registry that declares a non-null `mcpConfig`. Skip Claude (mcpConfig: null). Idempotent — second `start` call is a no-op for the wiring step. Plus: stamp the 0.5.1 stack-installer changelog entry covering the Sprint 48 close-out hook fix. NEW `tests/launcher-autowire.test.js` (~5 tests). EDIT `docs/GETTING-STARTED.md` to mention auto-wire as part of the start command's behavior. | EDIT `launcher.js`, NEW autowire test, CHANGELOG bump for stack-installer 0.5.1. |

## Acceptance criteria

1. **Mixed-agent dogfood proves the path.** All four lanes post FINDING + FIX-PROPOSED + DONE in `STATUS.md`. T1/T2/T3 run on Codex/Gemini/Grok respectively. The merger normalizes their idiom-divergent posts into the canonical Claude shape.
2. **Auto-wire-on-launch proven.** `npx @jhizzard/termdeck-stack start` from a clean Codex/Gemini/Grok install (no `mcpServers` block) results in all three configs gaining the Mnestra block. Idempotent — re-running `start` is a no-op for wiring.
3. **0.5.1 publish.** `@jhizzard/termdeck-stack@0.5.1` live on npm. `npm view @jhizzard/termdeck-stack version` returns `0.5.1`.
4. **No regressions.** Sprint 48's 326+ green tests stay green. Sprint 47.5's 4-row-baseline `session_summary` count grows by exactly 4 (one per lane closing).
5. **v1.0.0 decision.** If acceptance #1 + #2 + #3 all hold and at least one non-Claude lane shipped meaningful real work (not a vacuous DONE), orchestrator releases `@jhizzard/termdeck@1.0.0`. Otherwise `0.18.0` and v1.0.0 ships at Sprint 50.

## Gate-blocker UX gaps (surfaced 2026-05-02 14:08 ET at Sprint 49 inject)

These two issues block the v1.0.0 inflection — the dogfood means nothing if outside users can't open Codex / Gemini / Grok without knowing the binary names + can't see in the UI which agent each panel is running.

1. **Launcher buttons missing for Codex / Gemini / Grok.** The panel chooser only has a one-click Claude button. Other agents are opened as a generic "shell" + the user manually types `codex` / `gemini` / `grok`. Add adapter-driven launcher buttons that read from `AGENT_ADAPTERS` (4 entries today, all four expose `spawn.binary`). Each adapter declares its display name + spawn shape; the panel chooser grid renders one button per registered adapter. Sized at ~80 LOC (server route → JSON, client renders button per adapter, click handler POSTs to existing panel-create API with `command: <binary>`). Belongs in T3 or as a side-task.

2. **Panel labels show "shell" instead of agent name** even when `meta.type` is `grok` / `claude-code` / `codex` / `gemini`. The dashboard reads the launch command, not the resolved adapter. Server returns the correct `meta.type` via `/api/sessions`; the front-end label (the `data-session-type` attribute or whatever the panel template uses) is reading from the wrong field. Sized at ~10-LOC client fix.

3. **Status spinner freezes mid-work even when API heartbeat is healthy** (Joshua flagged 2026-05-02 14:17 ET during T4 Claude lane). The animation next to `Unravelling` / `Claude is reasoning...` etc. is one of the few visual signals a human has that the agent is alive. When it stops mid-thought, the user reasonably concludes the panel is stuck — and may interrupt a still-working agent. **Verified via API at the same moment Joshua reported visual freeze:** server reports `status=thinking, age=0s` continuously, so the agent is fine — the spinner CSS animation just isn't being kept alive by the client-side update loop. Probably a CSS `@keyframes` that runs from a `class` toggle which only re-adds when the status string changes; if the status string stays `thinking` for many seconds, the animation completes its first cycle and stops. Fix: animation should be `infinite`, OR the panel should refresh-trigger it on every `lastActivity` update. Sized at ~5-LOC CSS / client fix.

Sprint 49 includes these IF time budget allows after T1-T3 lane work + T4 auto-wire+publish; otherwise they roll into Sprint 50 as the v1.0.0-blocker hotfix. Document the fix path in either case.

## Carry-overs from Sprint 48

- **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** — Sprint 48 deferred this to close-out; Sprint 49 should refresh the doc to lead with `npm i -g @jhizzard/termdeck-stack && termdeck-stack start` instead of clone-and-`./scripts/start.sh`.
- **Optional `~/.zshrc` source-line offer** in the wizard (Sprint 48 T4 deferred; brief flagged as time-permitting).
- **Promote `packages/stack-installer/tests/**/*.test.js`** into the root `npm test` glob.
- **post-merge verification** — confirm the `memory_items` count of `source_type='session_summary'` rows climbed past the 4-row baseline. Today's Sprint 49 kickoff probe can run this.

## Carry-overs from Sprint 46 (14 deferrals — pick 3-5 as T1-T3 lane scopes)

### T1 candidates (graph-viewer, fits Codex / web-tooling-savvy)
- Edge click handler (Surface 7) — needs design call.
- Cross-project edges visual distinction (Surface 8) — wait for `GRAPH_LLM_CLASSIFY=1`.
- Chip filters "all on/all off" preset (Surface 2) — low value at 5-kind density.
- Performance at 2000+ nodes (Surface 9) — needs profiling.
- URL state codec edge case (Surface 5) — low impact.

### T2 candidates (flashback history, fits Gemini / careful-prose-savvy)
- Source-session links (Surface #6) — needs session-recovery work first.
- Pagination (Surface #8) — fine at 33 rows; matters at multi-week scale.
- Audit-write-gap cleanup — delete dead `triggerProactiveMemoryQuery` OR wire to `recordFlashback`.

### T3 candidates (transcripts panel, fits Grok / 16-sub-agent-aware)
- Server-side metadata gap (`termdeck_transcripts` doesn't carry session `type`/`project`).
- Stored content includes Claude TUI spinner spam (`\r✻\r\n…`).
- Perf virtualization at 1000+ chunks.
- `escapeHtml` duplication at `app.js:2693` and `:4296`.

### Smaller (Sprint 46 T4 set, fits any)
- Cosmetic title gaps on `btn-status`/`btn-config`.
- Latent regex-injection risk in `^${binary}\b` (currently safe; defensive helper).

Pick whichever 3 fit the agent-CLI strengths and ship in the same wall-clock band as Sprint 48 (~17-21 min).

## Other carry-overs

- **Upstream rumen `createJob.started_at` patch** (cross-repo work; needs `@jhizzard/rumen` patch release). 2-line fix at `~/Documents/Graciella/rumen/src/index.ts:177`.
- **`mnestra doctor` subcommand** (Brad's third upstream suggestion 2026-04-28).
- **Grok adapter SQLite extraction** for the memory-hook `parseTranscript` path. Sprint 45 T3 supplied `parseTranscript`; the hook layer needs to query `~/.grok/grok.db` and synthesize a JSONL feed before invoking the parser.
- Sprint 40 carry-over: harness session-end hook PROJECT_MAP forward-fix.
- Sprint 40 carry-over: analyzer broadening — `PATTERNS.error` case-sensitivity gaps.
- Sprint 40 carry-over: LLM-classification pass on the ~898 chopin-nashville-tagged "other/uncertain" rows.

## Pre-sprint substrate findings (orchestrator probes at kickoff)

Same checks as Sprint 48 plus: `npm view @jhizzard/termdeck-stack version` (expect 0.5.0; T4 lane bumps to 0.5.1 + publishes at close), and a smoke test where the orchestrator calls `ensureMnestraBlock` against a tmpdir-isolated copy of each adapter's config to confirm the helper still works against real inputs after Sprint 48's two commits (`f7da8a2`, `be59ad9`, `dd5173c`).

## Notes

- This is the v1.0.0 sprint if everything closes. Plan accordingly: don't take ambitious lanes that risk timing out — pick proven-shape deferrals so the dogfood lane exits cleanly.
- Sprint 48's 21-min wall-clock is the new ceiling expectation for 4+1 sprints with shared-helper coordination overhead. Sprint 49 may run longer if T4's auto-wire-on-launch surfaces unexpected adapter-shape divergences during integration.
- The 0.5.1 hook hotfix is small-but-load-bearing: outside users today running `npx @jhizzard/termdeck-stack` get a Stop-registered hook that spams the embed pipeline on every turn. Without 0.5.1, every Brad-tier user is silently broken.
