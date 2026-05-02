# Sprint 49 — Mixed-agent dogfood + 0.5.1 hook hotfix — STATUS

**Sprint kickoff timestamp:** _(orchestrator stamps at inject time)_
**Sprint close timestamp:** _(orchestrator stamps at sprint close)_
**Wall-clock:** _(filled at close — Sprint 41=9, 42=12, 43=17, 44=11, 45=16, 46=16, 47=28, 48=21. Sprint 49 may run longer because mixed-agent CLIs add idiom-mismatch friction at the merger boundary; budget for 25-30 min.)_

## Pre-sprint context

- Sprint 48 closed 2026-05-02 13:18 ET shipping per-agent MCP auto-wire (Codex/Gemini/Grok adapters + 207-LOC `mcp-autowire.js` helper) plus the global `termdeck-stack start|stop|status` launcher. v1.0.0 stays gated on real mixed-agent dogfood (this sprint).
- Post-Sprint-48 polish committed at `dd5173c`: hook moved from Stop → SessionEnd (was firing on every turn, not once per /exit) + `~/.termdeck/secrets.env` fallback in the bundled hook (was hitting env-var-missing on standalone Claude Code launches outside TermDeck). Tests 53/53 green. Not yet published — Sprint 49 T4 stamps + ships as `@jhizzard/termdeck-stack@0.5.1`.
- Baseline `memory_items` count of `source_type='session_summary'` rows: 4 (queried 2026-05-02 13:30 ET via Supabase REST). Sprint 49 close should see at least +4 (one per lane closing through the now-correct SessionEnd hook).
- v1.0.0 trigger: T1+T2+T3+T4 all DONE with at least one non-Claude lane shipping meaningful real work. Otherwise v0.18.0.

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — Codex real lane (deferral TBD at kickoff)

_(no entries yet)_

### T2 — Gemini real lane (deferral TBD at kickoff)

_(no entries yet)_

### T3 — Grok real lane (deferral TBD at kickoff)

_(no entries yet)_

### T4 — Auto-wire-on-launch + stack-installer 0.5.1 publish

_(no entries yet)_

## Orchestrator notes

_(append-only, orchestrator-only)_

## Side-task progress

### Sprint 46 + Sprint 47 + Sprint 48 deferrals picked up opportunistically

_(orchestrator picks 3-5 smallest items; documents which ones shipped here)_

### `docs/INSTALL-FOR-COLLABORATORS.md` refresh

_(Sprint 48 carry-over — orchestrator handles at sprint close)_

### v1.0.0 decision

_(orchestrator evaluates at sprint close: did all 4 lanes close DONE AND did at least one non-Claude lane ship meaningful real work? If yes → v1.0.0 publish. If only auto-wire/launcher landed → v0.18.0. If failure mode → v0.17.1 patch.)_

## Sprint close summary

_(orchestrator fills at close)_
