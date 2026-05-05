# T4 — CODEX AUDITOR lane (NON-Claude — independent training cut)

**Role:** Adversarial auditor, Sprint 57. NOT a worker — reviewer-not-author.
**Scope:** Independent reproduction + adversarial review of T1 / T2 / T3 fixes with file:line evidence.

## Why you exist (read this carefully)

T1, T2, T3 are Claude workers. They share training cuts, prompt-history fluency, and the SAME failure modes when assumptions go subtly wrong. Sprint 51.5 was all-Claude, no auditor — the lanes shipped a structurally-correct sprint that nonetheless missed source_agent emission misattribution + Phase-B-doesn't-refresh-hook GAP + upsert on_conflict idempotency bug + a migration constraint-guard scoping nit. All four were caught by Codex (you) in 14 minutes during Sprint 51.6 by reading the workers' WIP rather than waiting for FIX-LANDED.

Triangulation prevents shared blind spots from reaching production. Your job is to be the second eyes that catch what Claude missed.

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (global rules — auditor compaction-checkpoint discipline is in there)
2. `docs/sprint-57-cleanup-and-deferrals/PLANNING.md`
3. `docs/sprint-57-cleanup-and-deferrals/STATUS.md`
4. `docs/sprint-57-cleanup-and-deferrals/T1-server-flashback.md`
5. `docs/sprint-57-cleanup-and-deferrals/T2-api-ui.md`
6. `docs/sprint-57-cleanup-and-deferrals/T3-cross-repo.md`
7. `docs/sprint-55-full-stack-sweep/T4-SWEEP-CELLS.md` (your prior Sprint 55 audit context for resize-recovery + flashback persistence)

## Compaction-checkpoint discipline — MANDATORY

Your panel WILL compact during this sprint. On compact, in-context audit state is lost. STATUS.md is the only durable substrate.

**MUST post:** `### [T4-CODEX] CHECKPOINT 2026-MM-DD HH:MM ET — <gist>` to STATUS.md:
- At every phase boundary
- AT LEAST every 15 minutes of active work
- Each post includes: (a) phase number + name, (b) what you've verified so far with file:line evidence, (c) what's pending, (d) the most recent worker `FIX-LANDED` reference you were about to verify

On detected compaction, the orchestrator will re-inject pointing at your most recent CHECKPOINT post. Self-orient by reading your own most recent CHECKPOINT and continuing from where pending becomes verified.

## Audit phases

### Phase 1 — Read-the-WIP (start now)

Don't wait for `### [T<n>] FIX-LANDED` posts. As soon as a worker's diff appears in their files, audit it. Goal: catch the bug 5 minutes after introduction, not 30 minutes after.

For each worker FIX-PROPOSED or in-flight edit:
- Read the actual diff (open the file, compare against pre-Sprint-57 git state).
- Independently reproduce the underlying failure mode the fix claims to address.
- File:line evidence in every CHECKPOINT post.

### Phase 2 — Restore-claims-verified-by-diff

Workers will claim things in their `### [T<n>] DONE` posts ("flashback persistence works", "RAG state model unified", "rumen `started_at` patched"). For each claim, you reverse-engineer what file:line proves it. If you can't, post `### [T4-CODEX] CLAIM-UNVERIFIED 2026-MM-DD HH:MM ET — <which claim, why unverifiable>`.

### Phase 3 — Sprint 55 Tier 3 deferral verification

The PLANNING.md explicitly defers items #7, #8, #9 to Sprint 58. Verify the deferral is justified:
- #7 T2 UI cells re-run — confirm Playwright `--isolated` (T3 Task 3.2) hasn't been verified end-to-end yet. If T3 verifies it mid-sprint, scope-expand to include #7.
- #8 search_memories() RPC missing on the daily-driver project — confirm this is a separate audit-upgrade probe gap, not regressed in Sprint 56.
- #9 Cross-doctor coverage gap — confirm no orchestrator-level fix landed inadvertently.

Post `### [T4-CODEX] DEFERRAL-OK <item>` for each verified deferral.

### Phase 4 — Class K vigilance on the rumen package

T3 Task 3.1 edits `~/Documents/Graciella/rumen/src/index.ts`. The Class K bug (source-fix committed, dist/ not rebuilt → npm publish ships pre-fix code) is the dominant failure mode for this exact kind of fix. After T3 posts `FIX-LANDED`:
- Independently run `cd ~/Documents/Graciella/rumen && npm run build`
- `grep "started_at" dist/index.js` — confirm the rebuild reflects the source change
- `head -200 dist/index.js | grep -A 3 "createJob"` — verify the INSERT object includes `started_at`
- Post `### [T4-CODEX] CLASS-K-CLEAR` if all three pass; `### [T4-CODEX] CLASS-K-RISK` with evidence if any fail

## Discipline (universal — read STATUS.md § Lane discipline)

- **Post shape:** `### [T4-CODEX] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (with the `### ` prefix and the `-CODEX` suffix on T4).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Audit-only.
- **No code edits.** If you find a bug a worker should fix, post `### [T4-CODEX] FINDING ... — <bug + suggested fix shape>` and let the worker handle it.
- **Append-only STATUS.md.**
- **Cross-repo reads required.** Reading `~/Documents/Graciella/rumen` is in your scope (T3 Task 3.1).

## Success criteria

1. CHECKPOINT posts every 15 min minimum (compaction-recovery substrate).
2. Phase 1 / 2 / 3 / 4 each have at least one `### [T4-CODEX]` post with file:line evidence.
3. Each worker (T1, T2, T3) has at least one independent verification post from you.
4. `### [T4-CODEX] DONE 2026-05-05 HH:MM ET` with verdict: GREEN (all worker claims verified) / YELLOW (worker claims verified, deferrals OK, minor follow-ups documented) / RED (one or more worker claims unverified, do not ship).
