# B-T3 — Anti-drift jobs (rumen)

You are B-T3 in Sprint 71 (Objective Tier), Deck B of a dual-deck sprint. Repo:
`~/Documents/Graciella/rumen`. Read PLANNING.md fully first — §Seam and §Context bind
you. You are the only lane in the rumen repo.

## Own exclusively
- New rumen `src/` modules + `migrations/009_*.sql` (and 010 if you need a second cron
  file — rumen migration numbering is independent of engram's 037/038).

## Scope — all three jobs ship DARK (crons/flags default OFF; ORCH activates at the
operator gate)
1. **Contradiction scan.** New decisions/facts vs the project's tier-0 objectives →
   when semantically contradictory, write a FLAG row (surface pattern: follow
   `doctrine-scan.ts` / `surface.ts` precedents) — NEVER silently absorb, never
   auto-resolve. The operator adjudicates flags. Consume B-T1's marker/predicate for
   what counts as tier-0 (poll `^(### )?\[B-T1\] SCHEMA-READY\b` in this deck's
   STATUS.md; until it lands, build against a mockable accessor).
2. **Objective-coverage report.** Sustained project activity (memory writes over a
   window) with ZERO tier-0 linkage = drift signal → report row, styled after the
   existing surface/report machinery.
3. **Objective-staleness flags.** Tier-0 rows past a ratification-age threshold get
   review flags (flags only — objectives never decay; seam §3).

## Notes
- Follow the extract-sweep/doctrine-scan house pattern: ledger + pg_cron registration in
  the migration, throttles, fail-soft, idempotent.
- Function hygiene release-blocking: search_path pin, REVOKE-then-GRANT, RLS on new
  tables.
- Haiku/LLM calls (if the contradiction scan needs semantic judgment) follow the
  existing rumen model-call pattern with retry/backoff; cheap model; hard caps per run.

## Discipline
Post `### [B-T3] ...` per STATUS.md shape (in the termdeck repo's
`docs/sprint-71-objective-tier/STATUS.md` — note the STATUS file lives in the termdeck
repo, not rumen). DONE when rumen `npm test` is green. No version bumps, no CHANGELOG,
no commits. Memory MCP hangs >60s → Esc-abort, proceed. Verify store facts via read-only
psql (strip `?pgbouncer=true`).

Boot: read `~/.claude/CLAUDE.md`, rumen `CLAUDE.md` (if present), PLANNING.md, STATUS.md,
this brief. Then begin.
