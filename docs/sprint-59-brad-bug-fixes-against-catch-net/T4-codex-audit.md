# T4 — CODEX AUDITOR lane (NON-Claude — independent training cut)

**Role:** Adversarial auditor, Sprint 59. NOT a worker — reviewer-not-author.
**Scope:** Independently verify that each Sprint 59 fix turns its Sprint 58 fixture from RED to GREEN. Every claim that "Brad #N is fixed" must be backed by file:line evidence + explicit fixture-state-before/after.

## Why you exist

Sprint 58 built the catch-net. Sprint 59 closes the bugs the catch-net was built to catch. Without you, the workers will happily land code that LOOKS correct but doesn't actually turn the corresponding fixture GREEN. The whole sprint pattern only delivers compounding value if every fix → fixture pair is empirically verified.

You also caught the Sprint 58 RED blockers (6 fixture-level issues) on 2026-05-05; Sprint 58 went RED → YELLOW → GREEN because of your audit. Sprint 59 needs the same scrutiny. Don't accept "FIX-LANDED" claims without checking the fixture.

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (compaction-checkpoint discipline mandatory)
2. `./CLAUDE.md`
3. `docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md`
4. `docs/sprint-59-brad-bug-fixes-against-catch-net/STATUS.md`
5. `docs/sprint-59-brad-bug-fixes-against-catch-net/T1-launcher-env.md`
6. `docs/sprint-59-brad-bug-fixes-against-catch-net/T2-shell-systemd.md`
7. `docs/sprint-59-brad-bug-fixes-against-catch-net/T3-docs-example-unit.md`
8. `docs/sprint-58-environment-coverage/STATUS.md` (your prior audit context — the YELLOW → GREEN repair you led)
9. `docs/sprint-58-environment-coverage/T1-ghactions-docker.md`, `T2-systemd-doctor.md`, `T3-supabase-docs.md`
10. `CHANGELOG.md` § [1.0.12] Notes (Brad's verbatim 9-finding report)

## Compaction-checkpoint discipline — MANDATORY

Your panel WILL compact during this sprint. STATUS.md is the only durable substrate.

**MUST post:** `### [T4-CODEX] CHECKPOINT 2026-MM-DD HH:MM ET — <gist>` to STATUS.md:
- At every phase boundary
- AT LEAST every 15 minutes of active work
- Each post includes: (a) phase name, (b) what's verified with file:line evidence, (c) what's pending, (d) the most recent worker `FIX-LANDED` you were about to verify

On detected compaction, the orchestrator re-injects pointing at your most recent CHECKPOINT post.

## Audit phases

### Phase 1 — Read-the-WIP (start now)

Don't wait for `### [T<n>] FIX-LANDED` posts. As soon as worker diffs appear, audit them. Goal: catch the bug 5 minutes after introduction, not 30 minutes after.

For each in-flight T1/T2/T3 edit:
- Read the actual diff (`git diff` against the pre-Sprint-59 state, which is `origin/main` HEAD = Sprint 58 close commit `d1fc11d`).
- Independently reason about whether it would turn the corresponding Sprint 58 fixture from RED to GREEN.
- File:line evidence in every CHECKPOINT post.

### Phase 2 — Per-finding fixture verification (the core Sprint 59 audit)

For each Brad finding F-N where N ∈ {1, 2, 5, 6, 7, 8, 3}:

1. **Locate the fixture.** Cross-reference Sprint 58's STATUS.md or T1/T2/T3 lane briefs to find the fixture for F-N.
2. **Reproduce RED on pre-fix state.** Checkout `d1fc11d`. Run the fixture (or a local equivalent if Phase B isn't wired). Confirm fixture reports RED.
3. **Verify GREEN on post-fix state.** Run fixture against post-Sprint-59 HEAD. Confirm fixture reports GREEN.
4. **Adversarial probe.** Can the fix be circumvented or bypassed? Does the fix introduce a new failure mode? Examples:
   - Brad #1 fix: does merging secrets.env into process.env clobber pre-existing user env? (T1 brief says don't clobber; verify the test enforces it.)
   - Brad #2 fix: does the quote-strip handle mismatched-quote edge cases (`'foo"`)? Does it strip from values that legitimately start with a quote (rare but possible)?
   - Brad #5 fix: does the new fallback chain still respect explicit user-typed commands? Does it work on macOS where `process.env.SHELL=/bin/zsh` and `/bin/sh` is also present?
   - Brad #7 fix: does `--service` flag interact with other interactive-mode behaviors (TUI, prompts, color output)?

Post `### [T4-CODEX] FIXTURE-VERIFIED F-N — <evidence>` for each verified finding. Post `### [T4-CODEX] FIXTURE-STILL-RED F-N — <evidence>` for each unverified finding.

### Phase 3 — Phase B substitute path

The Sprint 58 catch-net's CI verification depends on Phase B (shared test Supabase project + 10 GitHub Actions secrets), which is pending operator action. If Phase B is not wired at audit time, you cannot run the actual GitHub Actions workflow against pre-fix and post-fix states. Substitute path:

1. **Local manual reproduction.** For each finding, reproduce the bug locally using the same shape the fixture was designed to catch:
   - Brad #1: launch via `nohup termdeck` from a clean shell where `~/.termdeck/secrets.env` exists; observe `termdeck doctor --json` probe state.
   - Brad #2: write `DATABASE_URL="postgres://..."` (literal quotes) into `~/.termdeck/secrets.env`; observe behavior.
   - Brad #5: launch a session in an environment with `/bin/zsh` absent (use Docker `alpine:3.20` or simulate by `mv /bin/zsh /bin/zsh.bak` — only if you're willing to revert).
   - Brad #7: simulate non-TTY launch (`nohup termdeck < /dev/null > /tmp/out 2>&1 &`); observe whether process stays alive.
2. Post `### [T4-CODEX] LOCAL-VERIFIED F-N — <evidence>` instead of `FIXTURE-VERIFIED`. The orchestrator accepts LOCAL-VERIFIED as equivalent until Phase B is wired.

### Phase 4 — Cross-fix interaction probe

The four T1+T2+T3 fixes are independent in scope but share the launcher boot path. Probe interactions:

1. Does T1's secrets-merge happen BEFORE T2's `--service` flag check? If `--service` is checked first, the TTY-bypass fires before secrets are loaded, and the doctor probes still see empty `process.env.DATABASE_URL`.
2. Does T2's PTY shell fallback chain interact with T1's secrets propagation? If `process.env.SHELL` was supposed to come from secrets.env (it usually doesn't, but verify), T1 must merge it before T2 reads it.
3. Does T3's canonical systemd unit's `Environment=PATH=` interact with T1's secrets-merge? Yes — `~/.npm-global/bin` must be on PATH BEFORE the launcher runs, but secrets.env is read AFTER the launcher boots. These are sequential, not racing, but verify the documented invariants hold.

Post `### [T4-CODEX] INTERACTION-OK <pair>` for each verified non-interaction. `### [T4-CODEX] INTERACTION-BUG <pair>: <evidence>` for any bug found.

## Discipline (universal)

- **Post shape:** `### [T4-CODEX] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix + -CODEX suffix).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Audit-only.
- **No code edits.** If you find a fix gap, post `### [T4-CODEX] FIXTURE-STILL-RED ...` with suggested-fix shape; let the worker handle it. (Exception: if Sprint 58-style RED-blocker repair is needed AND the orchestrator dispatches `codex:codex-rescue`, then code edits are sanctioned via that path.)
- **Append-only STATUS.md.**
- **Cross-repo and cross-system reads required.** Reading the test Supabase project (via psql) is in scope. Reading Hetzner VM state (if Phase B wired) is in scope.

## Success criteria

1. CHECKPOINT posts every 15 min minimum (compaction-recovery substrate).
2. Phase 1 / 2 / 3 / 4 each have at least one `### [T4-CODEX]` post with file:line evidence.
3. Each Brad finding (F-1, F-2, F-5, F-6, F-7, F-8, F-3) has a `FIXTURE-VERIFIED` or `LOCAL-VERIFIED` post — OR a `FIXTURE-STILL-RED` flag with reproduction evidence.
4. Cross-fix interaction probe completed (Phase 4) with at least one `INTERACTION-OK` per pair.
5. `### [T4-CODEX] DONE 2026-05-07 HH:MM ET` with verdict: **GREEN** (every Brad P0 finding's fix turns its fixture from RED to GREEN, no interaction bugs) / **YELLOW** (P0 fixes verified locally but Phase B not wired so CI verification deferred) / **RED** (one or more fixes don't actually close the bug).
