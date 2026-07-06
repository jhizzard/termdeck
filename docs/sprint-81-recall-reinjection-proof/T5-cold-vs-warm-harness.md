# T5 — cold-vs-warm demonstration harness + web-write runbook · Sprint 81
**Deck :3002 · cwd `…/TermDeck/termdeck` · Model Opus 4.8**

## Boot
1. `memory_recall(project="termdeck", query="cold vs warm recall demonstration memory reinjection web-write activation inbox-promote TERMDECK_BRIDGE_ENABLE_PROPOSE")` then `memory_recall(query="recent decisions and bugs")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your charter is § T5**
4. Read the sibling `STATUS.md`

## Your work
**(1) Cold-vs-warm demonstration harness (THE empirical proof — Josh's headline deliverable).** A reproducible script that runs a representative task/query **recall-OFF vs recall-ON** (and/or `recall_boost` off vs on once T1's 032 lands) and captures the delta: tokens in, rows surfaced, `source_type` mix (doctrine/decision/fact), and the observable output difference. Emit a clean report artifact (markdown/JSON) that a human can read as "session X cold-started, recalled these N rows totaling T tokens, and here's how the answer changed."
- **MUST BE HONEST — no cherry-picking.** T8 (Codex) reproduces this independently; a rigged demo fails audit. This is the credibility crux of the whole sprint.
- While parked on 031/032, author the harness scaffold, fixtures, and the report format so it's ready to run.

**(2) Web-write activation runbook (Josh-go-gated — DOCS ONLY).** Write `docs/` runbook for deploying `inbox-promote` + secrets + cron + flipping `TERMDECK_BRIDGE_ENABLE_PROPOSE=1`. **Do NOT execute the deploy** — no live activation without explicit Josh go. Deliverable is the runbook, not the running system.

## Order / deps
Harness scaffold is independent (do first). The recall-ON / boost-on runs depend on T1's 031/032 — **you will park**; ORCH nudges you when they land. Coordinate with T4 (you may reuse its `/api/recall-events` output in the report).

## Discipline
- Post `### [T5] VERB 2026-07-05 HH:MM ET — gist`. No version bumps / CHANGELOG / commits / publish.
- File-only; any live run is a demonstration you PREPARE — ORCH runs the live cold-vs-warm at close-out for the record.
