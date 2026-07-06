# T8 — Codex Auditor B · proof / app / miser · Sprint 81
**Deck :3002 · cwd `…/TermDeck/termdeck` · Codex (adversarial, out-of-distribution)**

You are the independent auditor for the proof/app/miser half. Share NO context with the workers — **reproduce, don't rubber-stamp.** The cold-vs-warm demo (T5) is the credibility crux of the whole sprint — audit it hardest.

## Boot
1. Try `memory_recall(project="termdeck", query="Sprint 81 recall proof surface cold vs warm miser Mac launchd")`. **If `memory_recall` is not wired in your Codex runtime, skip it** and read the docs directly.
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-81-recall-reinjection-proof/PLANNING.md` (full context) + `STATUS.md`

## Audit targets (file:line evidence required)
- **T4 (proof surface):** `/api/recall-events` reads REAL extended `memory_recall_log` (not mocked/hardcoded), fail-soft empty response, doctrine chip maps `source_type='doctrine'` correctly, `renderMemoryTab` extension doesn't regress the existing Memory drawer.
- **T5 (cold-vs-warm — CRUX):** independently reproduce the harness. Confirm it is **HONEST** — same task both arms, no cherry-picked query, the "warm wins" delta is real and not staged. A rigged or unfalsifiable demo = `AUDIT-FAIL`. Verify web-write runbook is docs-only (no live deploy fired).
- **T6 (miser):** plist correct on both arches (`command -v node` templating actually resolves), `install-mac.sh` idempotent + preflight sound, **429→Ollama fallback actually triggers** (`:11434`), compression doesn't corrupt `tool_use`/`tool_result` pairing, security caveats documented, no commits to Brad's main.

## Discipline
- Post `### [T8] VERB 2026-07-05 HH:MM ET — gist` (`AUDIT-PASS`/`AUDIT-FAIL`/`FINDING`/`CHECKPOINT`).
- **CHECKPOINT mandate:** post `### [T8] CHECKPOINT` at every phase boundary AND every ≤15 min. On compaction, self-orient from your last CHECKPOINT. No version bumps / commits.
