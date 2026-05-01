# Sprint 47 — Mixed 4+1 (per-lane agent assignment) + Sprint 46 dashboard-audit deferrals

**Status:** Stub. Lane briefs not yet authored. Inject script not yet authored.
**Target version:** `@jhizzard/termdeck@0.16.0` if mixed 4+1 ships full scope; or **`1.0.0` if Joshua deems multi-agent + cron + observability + audited-dashboard production-ready for outside users**.
**Last-published baselines (Sprint 46 close 2026-05-01):** `termdeck@0.15.0`, `termdeck-stack@0.4.10`, `mnestra@0.3.3`, `rumen@0.4.4`. Verify with `npm view @jhizzard/termdeck version` before inject.

## Why this sprint

This is the third lane of the multi-agent substrate trilogy that Sprint 44 (foundation) and Sprint 45 (adapters) set up. The original Sprint 46 plan was mixed 4+1; it got bumped to Sprint 47 because Sprint 46 needed to be the dashboard functionality audit (per Joshua's 2026-05-01 directive). With Sprint 46 now closed and the dashboard in known-clean state, mixed 4+1 is the next-up scheduled work.

## Scope (mixed 4+1)

- **Per-lane `agent: claude|codex|gemini|grok` field in `PLANNING.md` frontmatter.** Lane brief format extends to declare which agent runs the lane.
- **Per-agent boot-prompt templates.** `boot-prompt-{agent}.md` in each adapter's section of the docs directory; orchestrator reads the right template based on `lane.agent`.
- **Inject script extension.** `inject-sprint<N>.js` reads per-lane `agent` field; spawns the right CLI binary in each panel; wraps the boot prompt in the right bracketed-paste shape for the target TUI.
- **Cross-agent STATUS.md merger.** Each agent posts FINDING / FIX-PROPOSED / DONE differently (Claude has the convention, others don't yet); merger normalizes the shape.
- **Acceptance:** ship a sprint where T1=Codex / T2=Gemini / T3=Grok / T4=Claude (or any other mix), each lane reads its agent's boot prompt, all four post normalized STATUS entries, all four ship code that survives the existing test suite + adapter-parity guards.

Lane breakdown TBD — likely:

| Lane | Goal |
|---|---|
| T1 | PLANNING.md frontmatter parser + per-lane agent field validation |
| T2 | Per-agent boot-prompt templates (4 files: `boot-prompt-claude.md` etc.) + template-resolution helper |
| T3 | Inject script extension (read frontmatter, spawn the right binary, wrap the right paste shape) |
| T4 | Cross-agent STATUS.md merger + dogfood: actually run T1–T3 with mixed agent assignments |

## Sprint 46 deferrals to address (14 sub-optimal items)

Roll-up from `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md`. Lane briefs may bundle these into a 5th orchestrator-handled side-task or split across lanes if work overlaps.

### T1 — Graph viewer (5 deferrals)

- Edge click handler (Surface 7) — needs design call before implementing.
- Cross-project edges visual distinction (Surface 8) — wait for `GRAPH_LLM_CLASSIFY=1` to activate or add a render-time override.
- Chip filters "all on / all off" preset (Surface 2) — low value at current 5-kind density.
- Performance at scale (Surface 9) — needs profiling, no quick fix.
- URL state codec edge case (Surface 5) — low impact.

### T2 — Flashback history (3 deferrals)

- Source-session links (Surface #6) — would need session-recovery work first.
- Pagination (Surface #8) — ≤150 LOC fix, do at scale concern.
- Audit-write-gap cleanup — either delete dead `triggerProactiveMemoryQuery` or wire it to `recordFlashback`.

### T3 — Transcripts panel (4 deferrals)

- Server-side metadata gap — small `termdeck_sessions` table.
- Stored content includes Claude TUI spinner spam — extend `stripAnsi`.
- Perf virtualization — Sprint 47 candidate if a real user hits 1000+ chunks.
- `escapeHtml` duplication — pre-existing, dedupe.

### T4 — Quick-launchers + topbar (2 deferrals)

- Cosmetic title gap on `btn-status`/`btn-config` — trivial.
- Latent regex-injection risk in `^${binary}\b` — add regex-escape helper as defensive measure.

## Other queued work (Sprint 47+ candidates from earlier sprints)

- **Grok memory-hook SQLite extraction.** Sprint 45 T3 supplied `parseTranscript`; the hook layer needs to query `~/.grok/grok.db` (`messages.message_json` rows) and synthesize a JSONL feed. Better-sqlite3 prebuilt covers SQLite ≥3.37.
- **Upstream rumen `createJob.started_at` patch.** 2-line fix at `~/Documents/Graciella/rumen/src/index.ts:177`. Cross-repo work — needs its own `@jhizzard/rumen` patch release.
- **`mnestra doctor` subcommand.** Brad's third upstream suggestion 2026-04-28.
- **TheHarness as a TermDeck lane agent.** Sprint 47+ candidate per the multi-agent design memorialization.
- **Sprint 40 candidates** still in CHANGELOG `[Unreleased]` § Planned: harness session-end hook PROJECT_MAP forward-fix, analyzer broadening (uppercase ERROR / lowercase ENOENT / HTTP 5xx false-negative gaps), LLM-classification pass on the ~898 chopin-nashville-tagged "other/uncertain" rows.

## v1.0.0 decision

Sprint 47 close is the natural inflection point. Multi-agent + cron + observability + dashboard-audited reads as production-ready for outside users. Joshua decides at sprint close based on:

- Are mixed 4+1 lanes shipping cleanly across all four agents?
- Did the Sprint 46 deferrals (or any new Sprint 47 finds) surface anything that blocks "outside users"?
- Does Brad-tier feedback signal that v1.0.0 is the right comms moment?

## Joshua's roadmap context

When Sprint 47 closes, Joshua's expected to pivot more decisively to other projects (TheHarness, BHHT, etc.) for some weeks. Sprint 46 left the dashboard in known-clean state; Sprint 47 closes the multi-agent trilogy. After that, TermDeck enters maintenance mode until something concrete demands a return.
