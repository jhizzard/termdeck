# T2 — Rumen picker rewrite (Claude worker, cross-repo)

You are T2 in Sprint 53. Single-lane Claude worker. Owns the **Rumen picker rewrite** — pivot the picker from the pre-Sprint-51.6 multi-row-per-session GROUP BY pattern to read `memory_sessions` directly. This is THE fix that restarts insights flow on the daily-driver project (321 / 2026-05-01 baseline).

This sprint runs LIVE during a Brad call as a demo. Show the SHAPE of the work; full completion likely overruns the call window.

## Boot sequence (do these in order, no skipping)

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 53 Rumen picker rewrite memory_sessions extract.ts mig 018")`
3. `memory_recall(query="Sprint 51.6 mig 017 memory_sessions session_id summary_embedding bundled hook 1-row-per-session")`
4. `memory_recall(project="rumen", query="extract.ts picker source_session_id GROUP BY threshold")`
5. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback")` — codename rule
6. Read `~/.claude/CLAUDE.md` (global)
7. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (project router — your STATUS.md home)
8. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/PLANNING.md` (sprint scope)
9. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/STATUS.md`
10. **Cross-repo work:** your CODE changes land in two repos:
    - `~/Documents/Graciella/rumen/src/extract.ts` (the picker itself, ~30 LOC change at lines 55-77)
    - `~/Documents/Graciella/engram/migrations/018_rumen_processed_at.sql` (NEW — adds `rumen_processed_at timestamptz` column to `memory_sessions`; idempotent `ADD COLUMN IF NOT EXISTS`)
    - Plus mirror the new mig to `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/mnestra-migrations/018_rumen_processed_at.sql` (byte-identical — Sprint 51.5 T1 hygiene rule)

## Lane focus — picker rewrite

**Current shape (rumen src/extract.ts:55-77):**
```ts
// SELECT source_session_id, count(*) AS n FROM memory_items GROUP BY source_session_id HAVING count(*) >= N ORDER BY ...
```
This pattern assumed each Claude turn → one `memory_items` row. Sprint 51.6 changed the bundled hook to write ONE row per session (the session_summary). Picker now sees `count = 1` for every session and the threshold filter rejects them all → 0 sessions to process per tick → 0 insights for 3+ days.

**New shape (target):**
```ts
// SELECT session_id, started_at, ended_at, summary, summary_embedding
//   FROM memory_sessions
//   WHERE rumen_processed_at IS NULL
//     AND ended_at IS NOT NULL
//     AND started_at > now() - interval '<lookback>'
//   ORDER BY started_at DESC LIMIT N;
//
// On successful insight emit, UPDATE memory_sessions SET rumen_processed_at = now()
// WHERE session_id = $1; (idempotent — re-running a tick won't double-emit)
```

Each row in `memory_sessions` IS a candidate session (1:1 with hook fires post-Sprint-51.6). No grouping needed. The `rumen_processed_at` column makes the picker idempotent (no double-processing) and lets us track "which sessions Rumen has seen."

## Demo target

In the call window:
1. Author `018_rumen_processed_at.sql` (5 min) — add column, mirror to TermDeck bundled tree.
2. Rewrite `rumen/src/extract.ts:55-77` (10 min) — pivot to memory_sessions read.
3. Run `npm run typecheck && npm test` in rumen repo (5 min) — confirm no regressions in extract tests.
4. Post FIX-PROPOSED with file:line diffs.
5. **Don't ship.** Orchestrator handles publish wave at sprint close (rumen 0.4.5 → 0.5.0 + mnestra 0.4.2 → 0.4.3 + termdeck 1.0.8 → 1.0.9 + termdeck-stack 0.6.8 → 0.6.9).

## Lane discipline

- **Post shape:** `### [T2] STATUS-VERB 2026-05-04 HH:MM ET — <gist>` in `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-53-pen-test-and-picker/STATUS.md`.
- **Cross-repo coordination:** all status posts go in TermDeck's STATUS.md (not rumen's, not engram's). Cross-repo file paths are absolute in posts so anyone reading STATUS.md can navigate.
- **No version bumps in any of the 3 repos. No CHANGELOG edits. No commits.** Orchestrator handles ship at sprint close.
- **Codename scrub rule:** if you reference the daily-driver project, use neutral phrasing.
- **Mirror invariant:** mig 018 in TermDeck's bundled tree must be byte-identical to engram's primary. Run `diff` to confirm.

## When you're done

Post `### [T2] DONE 2026-05-04 HH:MM ET — picker rewrite + mig 018` with:
- Diff stats per file
- Test results (rumen src/extract tests + any new mig 018 shape test)
- File:line refs for the picker rewrite
- Pointer to the diff via `git diff --no-index`-style snippet OR a stash entry

If the demo window closes mid-rewrite, post `### [T2] PARTIAL — picker WIP — handing over to orchestrator for sprint close`.

Begin.
