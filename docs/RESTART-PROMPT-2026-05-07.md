# RESTART PROMPT — 2026-05-07 (TermDeck Sprint 61 v1.1.0 convergence keystone close)

**This file overwrites the prior 16:55 ET wrap (Sprint 59 v1.0.13).** Three sprints shipped on 2026-05-07 calendar day: Sprint 59 v1.0.13 (~16:55 ET), Sprint 60 v1.0.14 (~18:05 ET), Sprint 61 v1.1.0 (~19:45 ET). This doc is the LATEST.

**Session ended:** 2026-05-07 ~19:45 ET (Thursday)
**Wall-clock:** ~1h25m active orchestration (18:22 boot → 19:45 close)
**Session UUID for `claude --resume`:** `fe4bb8e7-67c4-4016-a14d-fe2622ece623`

## What shipped — Sprint 61 (Convergence Keystone)

**Wave** (3 npm packages + 2 git pushes):
- `@jhizzard/termdeck@1.1.0` (was 1.0.14; minor bump for new uninstall feature)
- `@jhizzard/termdeck-stack@1.1.0` (was 0.6.14; first cross-1.0 alignment with termdeck)
- `@jhizzard/mnestra@0.4.7` (was 0.4.6; mig 020 migration tracking + Part B 014 scrub)
- termdeck commit `6496a2b` on origin/main (pushed 19:44 ET)
- engram commit `280b811` on origin/main (pushed by Joshua via runbook)

**3+1+1 inject 18:34 ET → FINAL-VERDICT GREEN 19:26 ET** — ~52 min from open to clear, plus ~20 min for ORCH-side close-out (CHANGELOG, BACKLOG, gitleaks allowlist, version bumps, sync-rumen-functions, npm pack verify, commit + push).

**Lane work:**
- **T1 — UNINSTALL CLI.** `packages/stack-installer/src/uninstall.js` ~570 LOC, top-level subcommand wiring, 12 tests, idempotent + OS-aware (macOS LaunchAgent / Linux systemd) + surgical splices for `~/.claude.json` mnestra MCP entry + `~/.claude/settings.json` SessionEnd+Stop hooks (BOTH flat AND matcher-group shapes — round-3 added flat-shape support after T3 surfaced real-world variant). 12/12 + 101/101 across 3 suites.
- **T2 — UPGRADE-DETECTION.** Mnestra `020_migration_tracking.sql` + `applyPendingMigrations` diff-and-apply loop in `packages/server/src/setup/migrations.js` + 19-row `MIGRATION_PROBES` backfill table + bootstrap-via-out-of-band-020-apply path. Closes Brad's 2026-05-02 P0. Mirrored engram `019_security_hardening.sql` into bundle (drift since mnestra 0.4.4). Proactive 7-file engram→bundle comment-scrub parity sweep. 13/13 tracker tests + 1214/1217 root.
- **T3 — FRESH-INSTALL HARNESS.** macOS install-smoke workflow NEW + install-smoke.yml extended with uninstall→reinstall probe + docker/run-fixture.sh baseline extended + reset script extended + local-dev test 7/7 GREEN.
- **T4-CODEX (auditor).** 8 audit-concerns across T1+T2+T3 (all addressed) + 4 hygiene catches forcing orchestrator-side scrubs + 3 idle-hang recoveries via two-stage paste+submit re-inject. FINAL-VERDICT GREEN with explicit "proceed with ORCH-owned close-out" recommendation.

## Restart sequence for the next session

```
1. memory_recall(project="termdeck", query="Sprint 61 close 2026-05-07 + v1.1.0 ship + uninstall CLI + migration tracker + Phase B deferral")
2. memory_recall(query="recent decisions and bugs")
3. Read ~/.claude/CLAUDE.md
4. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read docs/CONVERGENCE-PLAN.md
6. Read docs/RESTART-PROMPT-2026-05-07.md (this file)
7. memory_recall(project="termdeck", query="<topic Joshua names at session start>")

Then begin.
```

## What's queued for the next sprint

### Convergence path (priority — keystone done, two more sprints to HN-postable)

- **Sprint 62 — Security-by-default at install.** Mnestra 0.4.8: every public-schema table in fresh install ships RLS-on with new lint check. SECURITY DEFINER REVOKE EXECUTE FROM PUBLIC migration. Wizard refuses to apply migrations against a Supabase project that fails the 5-gate hygiene check unless `--accept-existing-state` is passed. Auth brute-force rate limiting. Estimated 1-2 days, 3+1+1.

- **Sprint 63 — Install-polish wizard.** Supabase MCP-driven auto-provision (paste OAuth token, wizard creates project + applies migrations + writes secrets + wires MCP + installs hooks → 60 sec end-to-end). OS-detection branching. Schema-generation auto-detection. Self-heal end-of-wizard probes. Re-install detection. Ship gate v1.2.0; HN-postable after this. Estimated 2-3 days, 3+1+1.

### Sprint 61 deferred items (must land before or during 62-63 cycle)

- **Sprint 61.5 — Phase B activation.** Operator-only ~35-45 min runbook at `docs/sprint-61-uninstall-and-install-harness/PHASE-B-RUNBOOK.md`. Provision termdeck-test Supabase project + apply 19 mnestra migrations + add 10 GH Actions secrets + plant canary row + verify reset script. Once active, install-smoke + macos-install-smoke workflows run automatically on next PR. Deferred 2026-05-07 because Joshua's laptop was dead.

- **Sprint 61.1 — Functional ILIKE classifier hygiene pass.** Mnestra migrations 011:160 + 012:252 contain a project-tagging classifier whose load-bearing matcher is a forbidden literal. Allowlisted in `~/.gitleaks.toml` for v1.1.0 ship. Three resolution candidates documented in `docs/BACKLOG.md` § D.5 first entry: substitute classifier matcher with re_tag_lookup table + data migration; OR move classifier rules to runtime config / SECURITY DEFINER lookup; OR accept as allowlisted permanently with SECURITY.md note. Joshua's call at scoping. Likely small focused sprint (~1 day single-orchestrator).

### Open backlog items (non-convergence)

- **v1.0.15 polish** — Brad's 3 improvement ideas from 2026-05-07 18:00 ET patch (term.onExit null pty, body-parser raw-body capture for hex-prefix logging, 410 Gone vs 409 on PTY-exited resize). Estimated 30 min single-orchestrator. NOT urgent.
- **🚨 Joshua's memory_sessions ingestion** — was the original 2026-05-03 P0; largely closed by Sprint 51.6 bundled-hook fix. Verify health periodically (check ROW count growth in memory_sessions on the daily-driver project). If stale, escalate.
- **🚨 Flashback not firing in Joshua's daily flow** — open since 2026-04-27. Likely PATTERNS.error regex too narrow in `packages/server/src/session.js`. Promoted to P0 in BACKLOG.

## Sprint 61 lessons learned (worth carrying into Sprint 62)

1. **3+1+1 with Codex auditor was load-bearing AGAIN.** Codex caught 8 audit-concerns across T1+T2+T3 + 4 hygiene catches. T1 settings.json splice incompleteness for flat-shape entries (would have shipped without round-3 fix); T2 backfill semantics gap on null-probe migrations; T2 self-transactional migration handling for 011/012's top-level `BEGIN;`/`COMMIT;`; T3 fixture-shape false-alarm against T1 (T3 self-recovered via direct probe — beautiful 3+1+1 dynamic); T3 Docker fixture scope omission; T3 settings.json clean-state check missing in workflows; T3 final-uninstall masking with `|| true`; T3 v2 matcher-group fixture shape gap. Pattern from 51.6 → 51.7 → 60 → 61: Claude lanes share training and miss the same things; Codex's training-cut + prompt-history asymmetry continues to deliver.

2. **Codex compaction recovery now happens 3+ times per long sprint.** Sprint 61: Codex went idle 17 min, 14 min, 6 min — three recoveries via two-stage paste+submit re-inject with directive recovery prompt. Each landed cleanly within 60 sec. T1 also experienced one ~21 min idle hang post-FIX-LANDED requiring same recovery. The two-stage paste+submit pattern (paste body without `\r`, settle 400ms, then `\r` alone in a separate POST) per `~/.claude/CLAUDE.md` § 3+1+1 sprint orchestration is canonical. Workers AND auditors can hang.

3. **Hygiene meta-leak pattern.** When the orchestrator describes a scrub of forbidden literals, do NOT spell out the literals in the description — even inside quoted shell commands or "no matches" sentences. Codex caught me 4 times in 8 minutes during Sprint 61 reinstating the literals while describing what got removed. Reference tokens by category only ("the four forbidden external-project literals"), never spell.

4. **Pre-commit gitleaks hook works.** Pre-push scan ran successfully on Sprint 61 commit 6496a2b: 1 commit scanned, 379KB, 257ms, no leaks. Two-layer defense (pre-commit + pre-push) is solid.

5. **Mirror backup is solid.** `~/.local/bin/git-mirror-active-repos.sh` ran cleanly post-Sprint-61: 0 failures across 8 repos, all caught up to latest pushes. Mirror at `~/git-backups/termdeck.git` HEAD = `6496a2b` ✓.

6. **Lane-discipline mtime audit pattern (NEW from this sprint).** Joshua surfaced a clean way to verify "no scope creep post-DONE": diff file mtimes against lane DONE timestamps. Sprint 61 verified clean: T1/T2/T3 all touched only their lane files, all before their respective DONE posts. Adopt as standing close-out check before commit.

7. **Engram-side commit message via `git commit -F /tmp/file.txt`.** When ORCH composes a commit message for Joshua to use in a sibling repo (engram), do NOT use HEREDOC in shell commands — the multi-line paste can hit `dquote cmdsubst heredoc>` quoting hell on his terminal. Instead Write the message to `/tmp/<repo>-commit-msg.txt` and have Joshua run `git commit -F /tmp/<repo>-commit-msg.txt`. No quoting issues; works every time. This pattern was used to commit engram 280b811 (mnestra 0.4.7) on the second attempt after the HEREDOC failed on the first.

## Resume command for THIS session (alternative to clean restart)

```bash
claude --resume fe4bb8e7-67c4-4016-a14d-fe2622ece623
```

The `--resume` flag re-attaches to this exact orchestrator session with full conversation context preserved.

Use this when:
- You want to continue Sprint 62 prep with Sprint 61 context still warm
- The same orchestrator-pattern decisions made this evening (3+1+1 with Codex, two-stage submit, mtime audit) need to apply unchanged
- You want to ship v1.0.15 polish without re-orienting
- You're re-attaching within hours/days to debug a v1.1.0 field finding

Use the clean restart sequence (top of this doc) when:
- It's been days since this session
- You want a fresh perspective on the next sprint scope
- You don't need this session's specific decisions in-context

## Cross-references

- Sprint 61 STATUS feed: `docs/sprint-61-uninstall-and-install-harness/STATUS.md`
- Sprint 61 PLANNING: `docs/sprint-61-uninstall-and-install-harness/PLANNING.md`
- Phase B operator runbook: `docs/sprint-61-uninstall-and-install-harness/PHASE-B-RUNBOOK.md`
- Convergence end-state + sprint sequence: `docs/CONVERGENCE-PLAN.md`
- v1.1.0 CHANGELOG: `CHANGELOG.md` `## [1.1.0] - 2026-05-07`
- v1.1.0 carve-outs: `CHANGELOG.md` `[1.1.0] § Known carve-outs`
- Sprint 61.1 backlog item: `docs/BACKLOG.md` § D.5 (first entry, "Sprint 61.1 — classifier hygiene pass")
- Global rules: `~/.claude/CLAUDE.md`
- Project rules: `CLAUDE.md`
- Prior session restart (Sprint 59 close, 16:55 ET): superseded by this file
- Prior-day restart: `docs/RESTART-PROMPT-2026-05-06.md` (untracked, Sprint 56-58 context)

## Three packages on npm post-Sprint-61

| Package | Pre-Sprint-61 | Post-Sprint-61 | Bump type |
|---|---|---|---|
| `@jhizzard/termdeck` | 1.0.14 | **1.1.0** | minor (new uninstall feature) |
| `@jhizzard/termdeck-stack` | 0.6.14 | **1.1.0** | minor + cross-1.0 alignment |
| `@jhizzard/mnestra` | 0.4.6 | **0.4.7** | patch (mig 020 + 014 scrub) |

Verified live on npm registry at session close. Mirror backup verified current.
