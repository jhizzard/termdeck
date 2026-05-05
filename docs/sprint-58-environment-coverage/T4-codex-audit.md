# T4 — CODEX AUDITOR lane (NON-Claude — independent training cut)

**Role:** Adversarial auditor, Sprint 58. NOT a worker — reviewer-not-author.
**Scope:** Independent verification that the catch-net actually catches every Brad-class bug it claims to. File:line evidence per finding. No code edits.

## Why you exist

Sprint 57 proved the 3+1+1 pattern's value at catching shared LLM blind spots within a sprint — you caught five in-flight regressions T1/T2 would have shipped. Sprint 58's bugs are different: the workers are building fixtures that *claim* to catch Brad's 9 findings. Your job is to verify those claims independently. Without you, the workers would happily build a catch-net that catches one or two findings while claiming to catch all nine.

The structurally hard problem in Sprint 58: **the workers can't run their own fixtures against a pre-Sprint-58 codebase to prove the fixture catches the bug.** They're building the fixture; they don't have a "before" reference state. You do — you can checkout an earlier commit, run the fixture, observe whether it correctly RED-flags the known bug.

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (compaction-checkpoint discipline mandatory)
2. `docs/sprint-58-environment-coverage/PLANNING.md` (full sprint context)
3. `docs/sprint-58-environment-coverage/STATUS.md` (post shape, lane discipline)
4. `docs/sprint-58-environment-coverage/T1-ghactions-docker.md`
5. `docs/sprint-58-environment-coverage/T2-systemd-doctor.md`
6. `docs/sprint-58-environment-coverage/T3-supabase-docs.md`
7. Brad's full 9-finding field report (cross-referenced in PLANNING.md § Why this sprint exists)
8. `docs/sprint-57-cleanup-and-deferrals/T4-codex-audit.md` (your prior Sprint 57 audit context — same 3+1+1 pattern, different sprint scope)

## Compaction-checkpoint discipline — MANDATORY

Your panel WILL compact during this sprint. STATUS.md is the only durable substrate.

**MUST post:** `### [T4-CODEX] CHECKPOINT 2026-MM-DD HH:MM ET — <gist>` to STATUS.md:
- At every phase boundary
- AT LEAST every 15 minutes of active work
- Each post includes: (a) phase name, (b) what's verified with file:line evidence, (c) what's pending, (d) the most recent worker `FIX-LANDED` you were about to verify

On detected compaction, the orchestrator re-injects pointing at your most recent CHECKPOINT post. Self-orient by reading your own most recent CHECKPOINT and continuing from where pending becomes verified.

## Audit phases

### Phase 1 — Read-the-WIP (start now)

Don't wait for `### [T<n>] FIX-LANDED` posts. As soon as a worker's diff appears in their files, audit it. Goal: catch the bug 5 minutes after introduction, not 30 minutes after.

For each in-flight T1/T2/T3 edit:
- Read the actual diff (`git diff` against pre-Sprint-58 state).
- Independently reason about whether it would catch the Brad finding it claims to catch.
- File:line evidence in every CHECKPOINT post.

### Phase 2 — Coverage matrix verification (the core Sprint 58 audit)

T3 publishes `docs/INSTALL-FIXTURES.md` with a coverage matrix mapping each of Brad's 9 findings to a fixture. Your job is to verify each row:

For each Brad finding F-i and claimed fixture X-i:
1. **Reproduce the bug.** Checkout pre-Sprint-58 HEAD (or whatever commit matches Brad's environment). Confirm the bug exists.
2. **Run fixture X-i against the buggy code.** Confirm the fixture reports RED.
3. **Run fixture X-i against post-fix code (if Sprint 59 has shipped) or against a hypothetical post-fix construct.** Confirm the fixture reports GREEN post-fix.
4. **Look for false-positive paths.** Does X-i ever report RED when the bug is absent? If yes, the fixture is too eager — flag for tuning.
5. **Look for false-negative paths.** Does X-i ever report GREEN when the bug is present? If yes, the fixture is broken — flag as `### [T4-CODEX] FIXTURE-GAP F-i`.

Post `### [T4-CODEX] FIXTURE-VERIFIED F-i — <fixture-name>` for each verified row. Post `### [T4-CODEX] FIXTURE-GAP F-i — <fixture-name>: <evidence>` for each unverified row.

### Phase 3 — Adversarial coverage probe

Independent of T3's claimed coverage, ask: **what Brad-class bug shape is NOT in the catch-net?** Three candidates to specifically probe:

1. **macOS-specific regressions.** Sprint 58 fixtures are heavily Linux-weighted. Does any fixture catch a bug that would fire on macOS but not Linux? If no, that's a coverage gap (smaller — Joshua daily-drives macOS so most macOS bugs surface during his use, but still worth flagging).
2. **Concurrent-process regressions.** TermDeck's WebSocket protocol, multi-panel state, sprint inject path — are these exercised by any fixture? Unlikely, since the fixtures are install-and-doctor not full session.
3. **Network-dependency timing.** Edge Function cold-start latency, Mnestra HTTP timeout, Anthropic API rate-limit retries — does any fixture exercise these? Probably not — flag as Sprint 60+ extension.

Post `### [T4-CODEX] COVERAGE-GAP <category>` for each identified gap, with proposed fixture additions.

### Phase 4 — Sprint 57 deferral verification

PLANNING.md explicitly defers items #7 (T2 UI cells re-run), #8 (search_memories RPC + auto-upgrade), #9 (cross-doctor coverage gap), drain-stall RC, override-gates-upstream-push, cost-monitoring panel to later sprints. Verify each deferral is justified — no inadvertent fix landed. Post `### [T4-CODEX] DEFERRAL-OK <item>` for each verified deferral.

Note: Brad #4 (search_memories) is partially folded into Sprint 58 via T2 Task 2.3 (the doctor version-gate). The fix lands in Sprint 58; the original Sprint 57 deferral #8 is partially closed. Verify T2's Task 2.3 actually closes it — if Mnestra ≥ 0.4.0 is on the test project AND post-fix doctor reports GREEN AND pre-fix doctor reports RED, deferral #8 is closed. Post `### [T4-CODEX] DEFERRAL-PARTIAL-CLOSE #8` with evidence.

## Discipline (universal)

- **Post shape:** `### [T4-CODEX] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix + -CODEX suffix on T4).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Audit-only.
- **No code edits.** If you find a fixture gap a worker should fix, post `### [T4-CODEX] FIXTURE-GAP ... — <gap + suggested fix shape>` and let the worker handle it.
- **Append-only STATUS.md.**
- **Cross-repo and cross-system reads required.** Reading the test Supabase project (via psql) is in scope. Reading Hetzner VM state via the API is in scope. Reading existing Sprint 57 doc artifacts for context is in scope.

## Success criteria

1. CHECKPOINT posts every 15 min minimum (compaction-recovery substrate).
2. Phase 1 / 2 / 3 / 4 each have at least one `### [T4-CODEX]` post with file:line evidence.
3. Coverage matrix in INSTALL-FIXTURES.md has at least one `FIXTURE-VERIFIED` post per row that claims coverage; any unverified row is flagged.
4. At least one `COVERAGE-GAP` post identifying a Brad-class shape NOT in the catch-net (or an explicit "no gaps found" verdict with reasoning).
5. `### [T4-CODEX] DONE 2026-05-05 HH:MM ET` with verdict: GREEN (catch-net covers all 5 P0 Brad findings + most P1) / YELLOW (covers P0, gaps in P1 documented) / RED (one or more P0 not actually caught despite claims).
