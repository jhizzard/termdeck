# Sprint 59 — Brad Bug Fixes Against the New Catch-Net

**Status:** Stub authored 2026-05-05 ~15:35 ET, immediately after Sprint 58 plan was authored. Sprint 59 cannot start until Sprint 58 ships (the catch-net is the gating dependency).

**Pattern:** 3+1+1, same as Sprints 57/58. Sprint 59 is a *bug-fix-against-fixtures* sprint — every fix must turn its corresponding Sprint 58 fixture from RED to GREEN. **If the fix doesn't make the fixture green, the fix isn't done.**

**Target ship:** `@jhizzard/termdeck@1.0.13` + `@jhizzard/termdeck-stack@0.6.13` (audit-trail bump). Possibly Mnestra/Rumen unchanged. Wall-clock estimate 2-3 hours (small fixes against a known catch-net are fast).

## What this sprint exists for

Sprint 58 builds the catch-net. Sprint 59 closes the bugs the catch-net was built to catch. Together they're a paired sprint pattern that should generalize: **every Brad-class field report becomes (a) Sprint X+1 = fixture additions, (b) Sprint X+2 = bug fixes against the fixtures.** That's the mechanism that prevents any class of bug from regressing back into the codebase.

If we ship a fix and Sprint 58's CI passes for that bug, the fix is permanent — any future regression turns the fixture RED before reaching production. That's the compounding part. Without the catch-net, fixing Brad's bugs is a one-off; with the catch-net, fixing Brad's bugs is a permanent closure.

## Brad's 5 P0 findings to close

### #1 nohup not inheriting secrets.env into process.env

**Severity:** HIGH — root cause of Brad's "Invalid URL" cascade.

**Symptom:** `checkRumen` in `packages/server/src/preflight.js` and the database health check read `process.env.DATABASE_URL` directly. When TermDeck is launched via `nohup termdeck` from a shell that hasn't sourced `~/.termdeck/secrets.env`, those probes get empty/stale `DATABASE_URL` and fail with `Invalid URL`.

**Distinct from Sprint 51.5 fix:** Sprint 51.5 added `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')` fallback in the bundled Edge Function source — that fix only covers the Edge Function path. The launcher-side direct-process.env probes weren't touched. Brad #1 is the launcher-side bug.

**Fix:** Either (a) launcher injects all secrets into `process.env` during Step 1 secrets loading (before any health probe), or (b) all health probes read from the loaded config object rather than `process.env`. Brad recommends (a); orchestrator preference: (a) is simpler and less invasive.

**Fixture:** Sprint 58 T1's install-smoke-ubuntu workflow launches via nohup-equivalent and runs doctor — should turn from RED (Brad's "Invalid URL" cascade reproduced) to GREEN post-fix.

### #2 DATABASE_URL with surrounding quotes breaks Node URL parser

**Severity:** MEDIUM.

**Symptom:** `pg`-based loaders strip surrounding quotes; Node URL constructor (used in some probe paths) doesn't and throws `Invalid URL` on the leading `"`.

**Fix:** Either (a) `init --mnestra` wizard writes `DATABASE_URL` without surrounding quotes, OR (b) audit-upgrade verification step strips quotes on every read. Both — defense in depth. Probably 10 LOC + a unit test.

**Fixture:** Sprint 58 T1's install-smoke-ubuntu workflow deliberately writes a quoted `DATABASE_URL` value to reproduce Brad #2. Should turn RED pre-fix, GREEN post-fix.

### #4 search_memories vs memory_hybrid_search drift

**Severity:** LOW (false-negative, not a true failure) — but affects all current users with Mnestra ≥ 0.4.0.

**STATUS:** Already shipped in **Sprint 58 T2 Task 2.3** as part of the catch-net validation. No Sprint 59 work needed. Documented here for completeness; cross-reference `docs/sprint-58-environment-coverage/T2-systemd-doctor.md` Task 2.3.

### #5 PTY shell hardcoded /bin/zsh fallback

**Severity:** MEDIUM — cosmetic on macOS (zsh present), fatal on minimal Linux.

**Symptom:** `packages/server/src/index.js` line 938: `const spawnShell = isPlainShell ? cmdTrim : (config.shell || '/bin/zsh');`. On a system where `config.shell` is empty/unread AND zsh isn't installed, PTY spawn fails silently with `execvp(3) failed: No such file or directory`. User's login shell, `$SHELL`, and `config.shell` are all bypassed.

**Fix (per Brad):** Change fallback chain to `cmdTrim || config.shell || process.env.SHELL || '/bin/sh'`. `/bin/sh` is universally present on POSIX; `/bin/zsh` is not. Bonus: investigate why `config.shell` from `config.yaml` may be empty/unread — separate root cause that Brad's workaround (install zsh) papered over.

**Fixture:** Sprint 58 T1's `install-smoke-alpine` (no zsh by default) and `install-smoke-ubuntu` (with `apt remove zsh` step) — both turn RED pre-fix, GREEN post-fix.

### #7 Launcher exits 0 immediately under systemd Type=simple

**Severity:** BLOCKING for systemd deployment.

**Symptom:** TermDeck launcher detects no controlling TTY and exits, presumably to defer to interactive use. Under `systemd Type=simple`, this is a clean exit — systemd marks the service inactive, doesn't restart (since `Restart=on-failure` doesn't trigger on clean exits).

**Fix:** Add a `--service` (or `--non-interactive`) flag to the launcher that skips the TTY check. Document in install guide with a sample systemd unit.

**Fixture:** Sprint 58 T2's `systemd-nightly` Hetzner workflow — installs the systemd unit with `Type=simple` and checks `systemctl is-active termdeck.service`. Currently RED (proves the bug); turns GREEN post-fix.

## Brad's 3 documentation gaps (P1)

### #6 @anthropic-ai/claude-code optional dep on Linux x64

**Fix:** Update install guide with `--include=optional` for Linux x64. Sprint 58 T1's install-smoke could verify `claude --version` works post-install — currently fails because the binary stub doesn't have the platform native dep.

### #8 systemd doesn't inherit user PATH

**Fix:** Sprint 58 T2's systemd-nightly fixture deliberately omits `Environment=PATH=`. Sprint 59 docs add the `Environment=PATH=~/.npm-global/bin:/usr/local/sbin:...` line to the example unit + documents in the install guide. Fixture turns GREEN once the docs unit is canonical.

### #3 pgbouncer params unrecognized by psql

**Fix:** Docs note in install guide that `?pgbouncer=true&connection_limit=1` are Prisma-specific URL hints; bare `?sslmode=require` is the cross-client portable form. No fixture (cosmetic).

## Lane carve (3+1+1)

| Lane | Scope |
|---|---|
| **T1 LAUNCHER+ENV** | Brad #1 (nohup secrets propagation) + Brad #2 (DATABASE_URL quote-strip in wizard + audit-upgrade) |
| **T2 SHELL+SYSTEMD** | Brad #5 (PTY shell fallback chain hardening) + Brad #7 (launcher --service flag) |
| **T3 DOCS+EXAMPLE-UNIT** | Brad #6 + #8 + #3 docs updates + canonical systemd unit example |
| **T4-CODEX AUDITOR** | Verify each fix turns its Sprint 58 fixture GREEN; reproduce Brad's environment as closely as possible; flag any fix that ships without the corresponding fixture going GREEN |

## Acceptance criteria

1. All 5 P0 fixtures (Brad #1, #2, #5, #7, #4-already-shipped) turn from RED to GREEN in Sprint 58 CI.
2. T4-CODEX verdict: GREEN — every claimed fix is empirically validated by the catch-net.
3. CHANGELOG.md `## [1.0.13]` block documents which Brad findings closed AND cross-references each fix to its fixture. Future audit can verify the fix is permanent by checking the fixture is still passing.
4. `npm publish` wave: termdeck 1.0.12 → 1.0.13 + termdeck-stack 0.6.12 → 0.6.13. Mnestra/Rumen unchanged.
5. Updated install guide reflects #6 / #8 / #3 docs improvements.

## Out-of-Sprint-59 scope

- The Sprint 51 cost-monitoring expandable dashboard panel (deferred chain since Sprint 51.x; Sprint 60+ candidate)
- Auto-upgrade strategy for users on stale TermDeck installs
- Cross-doctor coverage gap (`--full` flag)
- Push Sprint 56 env-var override gates upstream to the rumen repo (sync drift mitigation)
- Rumen drain-stall root cause (currently mitigated by `RUMEN_MAX_SESSIONS_OVERRIDE=10`; Edge Function wall-clock relationship deserves canonization but isn't a Brad finding)
- Future Brad-class reports — by definition unknown until they arrive; the Sprint 58 catch-net is designed to absorb them faster

## Cross-references

- Sprint 58 catch-net: `docs/sprint-58-environment-coverage/PLANNING.md`
- Brad's 9-finding report: `CHANGELOG.md` § [1.0.12] Notes
- Sprint 57 close: commit `574c2eb`, `@jhizzard/termdeck@1.0.12`
