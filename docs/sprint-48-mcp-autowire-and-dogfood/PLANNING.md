# Sprint 48 — Per-agent MCP auto-wire + first real mixed-agent dogfood

**Status:** Stub plan. Inject readiness is a Sprint 48 kickoff task (lane briefs not yet authored — orchestrator authors them at kickoff after probing each CLI's MCP-config schema).
**Target version:** `@jhizzard/termdeck@1.0.0` if BOTH per-agent MCP auto-wire ships AND a real mixed-agent sprint dogfoods the path end-to-end. Otherwise `@jhizzard/termdeck@0.17.0`.
**Last-published baselines (Sprint 47 close 2026-05-01):** `termdeck@0.16.0`, `termdeck-stack@0.4.11`, `mnestra@0.3.3`, `rumen@0.4.4`.

## Why this sprint

Sprint 47's Grok smoke test surfaced the v1.0.0 gate: cross-project memory recall (Mnestra MCP) is unavailable to non-Claude agents by default because their config files (`~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.grok/user-settings.json`) ship without `mcpServers` blocks. Outside users running mixed 4+1 today would hit `memory_recall` failures the first time they declared a non-Claude lane.

Sprint 48's job: close the auto-wire gap AND prove the path works end-to-end with a real sprint where lanes run on different CLIs. Then v1.0.0 is the natural call.

## Lanes (sketch — orchestrator finalizes at kickoff)

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Codex MCP auto-wire + schema probe** | Investigate `~/.codex/config.toml` schema (TOML, not JSON like the others). Each agent adapter declares its MCP-config path + write-shape. NEW `packages/server/src/agent-adapters/<name>.js` field: `mcpConfig: { path, format, mnestraBlock }`. NEW `packages/server/src/mcp-autowire.js` (~80 LOC): on panel spawn, ensures the Mnestra block is present in the right config file (idempotent — doesn't overwrite user config; appends or merges). Unit tests + a real-CLI integration test that spawns Codex and verifies `memory_recall` is callable. | NEW `mcp-autowire.js`, EXTEND adapter contract → 9 fields (`acceptsPaste` was 8th in Sprint 47), tests. |
| **T2 — Gemini MCP auto-wire** | `~/.gemini/settings.json` schema. Same shape as T1 but Gemini-specific. Same integration test pattern. | EXTEND `gemini.js` adapter, tests. |
| **T3 — Grok MCP auto-wire** | `~/.grok/user-settings.json` schema. Confirmed empty today (`{"defaultModel": "grok-4.20-0309-reasoning"}`). Probe whether Grok's MCP support requires restart or hot-loads. Same integration test pattern. **Bonus if scope allows:** Grok 16-sub-agent observability — `session.js` analyzer picks up `"Delegating to [agent] sub-agent: …"` and `"[sub-agent complete]"` patterns; UX is a collapsible tree pane with agent pills. | EXTEND `grok.js` adapter, tests; optionally `session.js` + UI. |
| **T4 — Mixed-agent dogfood (real sprint with frontmatter declarations)** | Pick a real audit-class task (the 14 Sprint 46 deferrals are obvious candidates; cosmetic title gaps + escapeHtml dedup + transcripts spinner spam). Author a PLANNING.md with frontmatter `T1: codex / T2: gemini / T3: grok / T4: claude`. The orchestrator at Sprint 48 close uses Sprint 47's frontmatter parser + boot-prompt resolver + inject extension to fire the mixed-agent inject. Validates T4's status-merger idiom-detection against actual non-Claude STATUS posts. | Author PLANNING.md + lane briefs; rely on Sprint 47 infrastructure. |

## Acceptance criteria

1. **T1/T2/T3:** `mcp-autowire.js` ensures Mnestra block in each agent's config on panel spawn. Idempotent. Integration test spawns each CLI and confirms `memory_recall` is callable.
2. **T4:** at least one lane runs on Codex / Gemini / Grok (not all four — pick the one with the most stable MCP path). The lane completes its task end-to-end including STATUS.md posts.
3. **No regressions:** Sprint 47's 847+ root tests stay green.
4. **v1.0.0 decision:** if T1+T2+T3+T4 all close DONE and the dogfood lane shipped real work via a non-Claude agent, the orchestrator ships v1.0.0. Otherwise v0.17.0.

## Carry-overs from Sprint 47

- **Resolver-into-helper wiring:** `resolveBootPrompt` (T2) not yet wired into `injectSprintPrompts` (T3). Sprint 48 inject scripts can declare `{ sessionId, agent, vars }` and have the helper resolve internally — eliminates the inline prompt construction in inject-sprint*.js scripts.
- **`docs/AGENT-RUNTIMES.md` § 5 update** for the 8-field adapter contract (`acceptsPaste` added in Sprint 47 T3).
- **Grok adapter SQLite extraction** for the memory hook. Sprint 45 T3 supplied `parseTranscript`; the hook layer needs to query `~/.grok/grok.db` (STRICT tables, SQLite ≥3.37) and synthesize a JSONL feed before invoking the parser. Better-sqlite3 prebuilt covers it.

## Carry-overs from Sprint 46 (14 deferrals — pick 3-5 smallest as orchestrator side-tasks if budget allows)

### T1 — Graph viewer
- Edge click handler (Surface 7) — needs design call.
- Cross-project edges visual distinction (Surface 8) — design intent missing or wait for `GRAPH_LLM_CLASSIFY=1`.
- Chip filters "all on / all off" preset (Surface 2) — low value at 5-kind density.
- Performance at 2000+ nodes (Surface 9) — needs profiling.
- URL state codec edge case (Surface 5) — low impact.

### T2 — Flashback history
- Source-session links (Surface #6) — needs session-recovery work first.
- Pagination (Surface #8) — fine at 33 rows; matters at multi-week scale.
- Audit-write-gap cleanup — delete dead `triggerProactiveMemoryQuery` OR wire to `recordFlashback`.

### T3 — Transcripts panel
- Server-side metadata gap (`termdeck_transcripts` doesn't carry session `type`/`project`).
- Stored content includes Claude TUI spinner spam (`\r✻\r\n…`).
- Perf virtualization at 1000+ chunks.
- `escapeHtml` duplication at `app.js:2693` and `:4296`.

### T4 — Quick-launchers + topbar
- Cosmetic title gap on `btn-status`/`btn-config`.
- Latent regex-injection risk in `^${binary}\b` (currently safe; defensive helper).

## Other carry-overs

- **Upstream rumen `createJob.started_at` patch** (cross-repo work; needs `@jhizzard/rumen` patch release). 2-line fix at `~/Documents/Graciella/rumen/src/index.ts:177`.
- **`mnestra doctor` subcommand** (Brad's third upstream suggestion 2026-04-28).
- Sprint 40 carry-over: harness session-end hook PROJECT_MAP forward-fix (`~/.claude/hooks/memory-session-end.js`).
- Sprint 40 carry-over: analyzer broadening (`PATTERNS.error` case-sensitivity gaps).
- Sprint 40 carry-over: LLM-classification pass on the ~898 chopin-nashville-tagged "other/uncertain" rows.

## Pre-sprint substrate findings (orchestrator probes at kickoff)

Same as Sprint 47 with one additional check:

```bash
# 8. Verify each agent's MCP-config file path exists OR is creatable
test -f ~/.codex/config.toml && echo "codex ok" || echo "codex absent (T1 creates)"
test -f ~/.gemini/settings.json && echo "gemini ok" || echo "gemini absent (T2 creates)"
test -f ~/.grok/user-settings.json && echo "grok ok" || echo "grok absent (T3 creates)"
# expect at minimum grok ok (Sprint 47 confirmed it exists)
```

## Inject readiness

Lane briefs not yet authored. Sprint 48 kickoff orchestrator authors `T{1,2,3,4}-*.md` lane briefs after running the substrate probe and confirming the per-agent MCP-config schema. Inject script at `docs/sprint-48-mcp-autowire-and-dogfood/scripts/inject-sprint48.js` is a Sprint 48 kickoff deliverable (clone from Sprint 47's `inject-sprint47.js` per the canonical template).

## Joshua's roadmap context

Sprint 48 is gated on Joshua returning to TermDeck after his pivot to TheHarness / BHHT / other queue. When he returns, Sprint 48 fires AS LONG AS he wants the v1.0.0 inflection — alternative is to defer Sprint 48 indefinitely and ship v0.17.0 with whatever bug fixes have accumulated. Restart prompt at `docs/RESTART-PROMPT-2026-05-02-sprint-48.md` is paste-ready for the next session.
