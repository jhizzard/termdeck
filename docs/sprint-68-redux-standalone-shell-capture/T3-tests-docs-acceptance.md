# T3 — Tests + docs + live acceptance

You are T3 in Sprint 68-REDUX. Read PLANNING.md + docs/INSTALLER-PITFALLS.md first.

## You own (edit ONLY these)

- NEW test files under the existing server/stack test globs (confirm they're inside the
  default `npm test` reach — the S84 ungated-suite AUDIT-FAIL must not repeat)
- Doc corrections: `~/.claude/CLAUDE.md` + project `CLAUDE.md` stale-claims,
  `docs/CRITICAL-READ-FIRST-2026-05-07.md` §Resolution addendum, `docs/BACKLOG.md` §5
  horizon item → in-progress
- `docs/INSTALLER-PITFALLS.md` — trace table + the new-class ruling

## Mission

1. **Fence tests** (fixture-driven, no live DB):
   - shim real-binary resolution: skip-self, skip-shims-dir, first-survivor-wins,
     none-found → 127
   - recursion sentinel → 70, nothing spawned
   - dedup matrix: `TERMDECK_PANEL_SESSION` set → exec-transparent (no transcript, no
     drain); unset → capture path taken
   - drain payload shape: valid JSON, correct `hook_event_name`, session_id UUID-shaped,
     `TERMDECK_NATIVE_CLI_HOOK` present, exit code preserved on drain failure
   - rc fence: fresh-add / already-present / splice-on-uninstall byte-exactness
   - rotation: only `standalone-transcripts/*` older than 14d pruned
2. **Live canary acceptance, per CLI** (this is the sprint's definition of real): run each
   shim standalone with an invented phrase (`s68r-canary-<agent>-2026-08-01`), exit, then
   `memory_recall` the phrase and post the row's `source_agent` + id as evidence. Then one
   panel-side session proving exactly-one-row. Coordinate with T1 — you validate T1's
   artifacts, you don't fork them.
3. **Doc corrections**: both CLAUDE.mds still carry Sprint-64-era "standalone shells are
   the only safety net gap / manual memory_remember only" language — update to name the
   shim capture; CRITICAL-READ-FIRST gets a dated §Resolution addendum (the 2026-05-19
   native-hook plan superseded by this sprint; say why in two lines). BACKLOG §5 → in-progress.
4. **INSTALLER-PITFALLS**: trace table for every T1/T2 change; RULE on the new-class
   candidate "PATH-shadowing drift" (writing executables that shadow third-party binaries
   by PATH order — schema we don't control, order that other installers churn). If yes,
   append the class with detection + prevention rows in house style.

## Acceptance (your DONE requires all)

- `npm test` green WITH your suites demonstrably inside the default glob (post the glob
  evidence — file:line of the test-script pattern plus a run count delta).
- Three standalone canaries + one panel dedup proof posted with recall evidence.
- All four doc surfaces updated; PITFALLS trace complete + new-class ruling posted.
- No version bumps, no CHANGELOG, no commits.

Post `### [T3] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-MM-DD HH:MM ET — <gist>`.
