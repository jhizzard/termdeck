# Sprint 51.7 — Mini-sprint: wizard wire-up bisect + bundled-hook metadata completeness (v1.0.3)

**Status:** Mini-sprint authored 2026-05-04 ~10:30 ET as the v1.0.3 follow-up to Sprint 51.6's Phase B finding. Sprint 51.6 (v1.0.2) shipped 2026-05-03 20:50 ET; Phase B was VERIFIED post-manual-refresh 21:20 ET, but the canonical user-path (`termdeck init --mnestra`) silently no-ops the new `refreshBundledHookIfNewer()` step. Brad's 2026-05-04 v1.0.2 install pass confirmed the same wire-up failure on `jizzard-brain` — Brad is currently blocked on `/exit → memory_sessions` writes pending v1.0.3 ship (or the manual one-liner Joshua DM'd him).

**This is the second sprint to use the canonical 3+1+1 pattern** (3 Claude workers + 1 Codex auditor). The pattern caught 4 real bugs in Sprint 51.6 T3's WIP that all-Claude lanes would have shipped — same applies here, especially because T1's bisect target (a function that works in isolation but no-ops in the CLI) is exactly the shape of bug a shared-Claude lane would close prematurely.

**Mini-sprint** — 2 fixes, 1 ship lane, 1 audit lane. Diagnose the wire-up bug, fix it, fold in the deferred metadata-completeness pass on the bundled hook, ship v1.0.3, verify on Brad's install via WhatsApp confirmation.

## Why this sprint (in two paragraphs)

Sprint 51.6 closed Class M (architectural omission of the `memory_sessions` write path in the bundled hook) and shipped v1.0.2 with a `refreshBundledHookIfNewer()` helper wired into `init-mnestra.js:677`. Codex confirmed the helper works in isolation (`node -e "...refreshBundledHookIfNewer({dryRun:false})"` returned `{status:'refreshed', from:null, to:1, backup:...}` on Joshua's stale 508-LOC pre-Sprint-50 hook). But Phase B's live-path probe — `npm install -g @jhizzard/termdeck@1.0.2 && termdeck init --mnestra` — left the installed hook unchanged. `memory_sessions` row delta was 0; `source_agent` was NULL on the fresh `session_summary` row. Brad's same-day install pass against jizzard-brain reproduces the wire-up failure independently.

The bug is structurally subtle. The CLI dispatch in `packages/cli/src/index.js:130` invokes `init-mnestra.js` via `require()` — same Node process, same `__dirname`, same path resolution. The call site at line 677 is inside the main try block, after `applyMigrations()` and `runMnestraAudit()` (both of which Brad's run confirmed executed — mig 017 self-healed his missing `memory_sessions.session_id` column). So either the function fires and returns a status that's silently ignored, OR it never gets called. T1's job is to bisect deterministically. While we're touching the bundled hook, T2 folds in the v1 metadata gap Codex flagged: `started_at` / `duration_minutes` / `facts_extracted` are NULL on the rows v1.0.2 writes because the v1 hook intentionally omitted transcript parsing. Sprint 51.6 close-out marked this as a v1.0.3 fold-in since we're already touching the file.

## Lanes

| Lane | Owner | Goal | Primary surface |
|---|---|---|---|
| **T1 — Wizard wire-up bug bisect + fix** | Claude | Deterministically reproduce the wire-up failure (set up a stale hook + tmp HOME or use Joshua's box's pre-refresh evidence, run `termdeck init --mnestra`, observe failure). Add stderr instrumentation to the call site at `packages/cli/src/init-mnestra.js:675-690` so the actual return status of `refreshBundledHookIfNewer()` is visible. Bisect: is the function NEVER called (control flow drops out before line 677), or is it called and returning a no-op status (`up-to-date`, `custom-hook-preserved`, `bundled-unsigned`, `no-bundled`)? Once root cause is pinned, write the fix. Add a CLI-binary integration test at `packages/cli/tests/init-mnestra-cli-refresh.test.js` that spawns `termdeck init --mnestra --dry-run --skip-verify` (or equivalent non-DB path) against a tmp HOME with a stale hook and asserts the refresh status logged matches expectations. | `packages/cli/src/init-mnestra.js` (lines ~598–724 main flow + the 502–571 helper); new `packages/cli/tests/init-mnestra-cli-refresh.test.js`. |
| **T2 — Bundled hook metadata completeness + version stamp bump** | Claude | The v1 bundled hook writes `memory_sessions` with `started_at=NULL`, `duration_minutes=NULL`, `facts_extracted=0` because v1 intentionally omitted transcript parsing (Sprint 51.6 T3's "minimum viable row"). Reach parity with the legacy rag-system writer that produced the original 289 rows. Parse the transcript JSONL passed to the hook on stdin to extract: earliest message timestamp → `started_at`; last message timestamp → existing `ended_at` (already populated, verify); `(ended_at - started_at)` → `duration_minutes`; count of `Remember:` / Mnestra `memory_remember` / extracted-fact lines → `facts_extracted` (heuristic, document the regex). Add unit tests in `packages/stack-installer/tests/hook-metadata-parser.test.js` against fixture transcripts. **Also bump the bundled hook version stamp from `v1` to `v2`** at `packages/stack-installer/assets/hooks/memory-session-end.js` line 54 (and the comment at line 46 reference). The stamp bump is independently load-bearing for T1 — even if T1's root cause is unrelated, an installed-`v1` user upgrading to bundled-`v2` will pass the `installed >= bundled` short-circuit at `init-mnestra.js:550` and reach the refresh path. T2's stamp bump is an insurance policy; T1 still has to find the actual wire-up bug. | `packages/stack-installer/assets/hooks/memory-session-end.js` (postMemorySession payload + version stamp); new `packages/stack-installer/tests/hook-metadata-parser.test.js`; fixture: a small transcript JSONL pulled from `~/.claude/projects/`. |
| **T3 — Ship v1.0.3 wave** | Claude | After T1 and T2 have posted FIX-PROPOSED, integrate, run the full test matrix, prepare the wave: bump `@jhizzard/termdeck` 1.0.2 → 1.0.3; stack-installer audit-trail bump `@jhizzard/termdeck-stack` 0.6.2 → 0.6.3; mnestra and rumen unchanged. CHANGELOG entry. Verify both tarballs via `npm pack --dry-run` ship the updated bundled hook AND the patched init-mnestra.js. Run `node --test` across packages. **Hand off to orchestrator for npm publish (Passkey-authenticated, never `--otp`) + git push** per `docs/RELEASE.md`. **Lane discipline:** T3 stages all changes in working tree but does NOT commit; orchestrator handles publish + push + commit at sprint close. | Root `package.json`, `packages/stack-installer/package.json`, `CHANGELOG.md`; verification harness for the tarball contents. |
| **T4 — Codex independent audit (3+1+1 auditor)** | **Codex** | Independently reproduce T1's root cause — do NOT trust T1's bisect verbatim. Run the same `termdeck init --mnestra` path against a separate fixture (Codex's own clone or a tmp HOME) and confirm the failure mode matches what T1 reports. Audit T2's transcript parser for edge cases (zero-message transcripts, malformed JSONL lines, transcripts where the first message has no timestamp, very long transcripts where the heuristic facts-count regex over-matches). Audit the v1 → v2 stamp bump for any bookkeeping it depends on (e.g., test fixtures that hard-code `v1`, doc references). After T3 stages v1.0.3: pre-publish audit (npm pack contents, init-mnestra-cli-refresh test passes against the staged binary). Post-publish: install v1.0.3 globally, run the canonical user path, verify `memory_sessions` row count grows AND `started_at` / `duration_minutes` / `facts_extracted` are populated AND a fresh-install backup file is written. Post `[T4-CODEX] FINDING / AUDIT / VERIFY / DONE — VERIFIED` or `DONE — REOPEN T<n>` to STATUS.md as durable substrate (Codex CLI in this setup does NOT have Mnestra MCP wired — STATUS.md is the canonical record). | Audits all of T1/T2/T3's deliverables from outside the lane that built each; uses the same `petvetbid` Mnestra (luvvbrpaopnblvxdxwzb) for live-path verification. |

## Acceptance criteria

1. **T1 finds the root cause.** A clear writeup of WHERE/WHY `refreshBundledHookIfNewer()` no-ops in `termdeck init --mnestra` (line of control flow, exact return status, OR the missing call). Fix landed.
2. **T1 ships a CLI-binary integration test.** New test exercises the binary against a tmp HOME with a stale hook; would have caught Phase B's failure mode pre-publish. Lives at `packages/cli/tests/init-mnestra-cli-refresh.test.js`.
3. **T2 ships transcript-parsing metadata population.** New rows in `memory_sessions` from the v2 bundled hook have non-NULL `started_at`, `duration_minutes`, and a meaningful `facts_extracted` count. Unit tests cover edge cases.
4. **T2 bumps the bundled hook version stamp v1 → v2** at `packages/stack-installer/assets/hooks/memory-session-end.js:54`.
5. **T3 ships v1.0.3.** Versions bumped (termdeck@1.0.3 + termdeck-stack@0.6.3), CHANGELOG entry, full test matrix green, tarballs verified via `npm pack --dry-run`. Orchestrator handles npm publishes + git push.
6. **T4 verifies post-publish on Joshua's daily-driver.** `npm install -g @jhizzard/termdeck@1.0.3 && termdeck init --mnestra` actually refreshes the installed hook to v2; a fresh `/exit` writes a `memory_sessions` row with all metadata fields populated. Posts `[T4-CODEX] DONE — VERIFIED`.
7. **Brad re-pinged on WhatsApp** post-publish: "v1.0.3 ships the wizard wire-up fix; `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` should refresh your installed hook automatically now." Joshua sends via wa.me deep-link inject (auto-authorized).

## Pre-sprint substrate (orchestrator probes before inject)

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Confirm v1.0.2 installed + Phase-B-post-manual-refresh state
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# Expect: 1.0.2

# Confirm bundled hook stamp + LOC baseline (T2 will bump v1 → v2)
grep -n "@termdeck/stack-installer-hook" packages/stack-installer/assets/hooks/memory-session-end.js
wc -l packages/stack-installer/assets/hooks/memory-session-end.js
# Expect: line 54 = "v1", LOC ~740

# Confirm memory_sessions baseline post-Phase-B
psql "$DATABASE_URL" -c "select count(*), max(ended_at), bool_or(started_at is not null) any_started, bool_or(duration_minutes is not null) any_duration from memory_sessions"
# Expect: count >= 290 (Phase B added 1), some rows with started_at IS NOT NULL (rag-system legacy 289), at least 1 row with started_at IS NULL (the v1 hook's row from 2026-05-04 01:19 ET)

# Confirm Joshua's installed hook is the v1 bundled hook (post-manual-refresh from 51.6)
diff ~/.claude/hooks/memory-session-end.js /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js
# Expect: byte-identical

# Confirm latest sprint-51.6 STATUS.md tail (the durable record T4 will reference)
tail -50 docs/sprint-51.6-memory-sessions-hook-fix/STATUS.md
```

## Risks

- **T1's bisect could turn out to be a non-bug** — e.g., Joshua's actual `termdeck init --mnestra` run silently errored at a step before line 677 (a transient pg connection blip, a `runMnestraAudit` exception caught and logged but flow-broken). If that's the case, T1 still owns the fix: convert silent catch-and-continue paths to explicit logged-and-continue with stderr writes, AND add the integration test. The wire-up itself may not need a code change beyond the version stamp bump from T2.
- **T2's transcript parser could over-match `facts_extracted`.** The heuristic regex needs to be conservative — a regex that matches "Remember:" inside a quoted string should NOT count. Better: count distinct Mnestra `memory_remember` MCP tool calls in the transcript JSONL (parse `role: "tool_use", name: "memory_remember"` blocks). T2 brief specifies the conservative path.
- **The v1 → v2 stamp bump invalidates any test fixture that hardcodes `v1`.** T2 must grep for `stack-installer-hook v1` across tests and update.
- **Codex compaction mid-sprint** — Sprint 51.6 had Codex compact at 20:53 ET and recover via orchestrator-side rebootstrap inject. Same risk here. Recovery procedure documented in `~/.claude/CLAUDE.md` § Sprint role architecture.
- **RELEASE.md publish discipline** — Passkey only (never `--otp`), publish before push, stack-installer audit-trail bump even though only termdeck root changed (per Sprint 35 close-out lesson). T3's brief reiterates.

## Boot for the orchestrator (this terminal)

The orchestrator continues from the existing TermDeck server on `127.0.0.1:3000`. Joshua opens 4 NEW Claude Code panels (T1/T2/T3 = Claude; T4 = Codex CLI in a non-Claude panel). Inject script lives at `/tmp/inject-sprint-51.7-prompts.js` (orchestrator generates after panels open) and uses the canonical two-stage submit pattern (paste-then-`\r`, never combined) per `~/.claude/CLAUDE.md` § "MANDATORY: 4+1 sprint orchestration."

## Boot for the four lanes

Each lane brief (T1-*.md / T2-*.md / T3-*.md / T4-*.md) contains a customized boot block. Codex's T4 brief explicitly accommodates the "Codex CLI does not have Mnestra MCP wired" constraint (Sprint 51.6 finding) — durable substrate is STATUS.md, no `memory_recall` calls.

## Companion artifacts

- After v1.0.3 ships: append a brief follow-up note to ledger entry #15 in `docs/INSTALLER-PITFALLS.md` documenting the wire-up bug's true root cause and the integration-test gap that allowed it. Pre-ship checklist may grow item #13 ("every wizard helper invoked from a CLI entry point must have a binary-spawn integration test, not just a unit test of the helper in isolation").
- After v1.0.3 ships: Sprint 51.5b dogfood audit (deferred since 51.5) becomes UNBLOCKED for inject. Sprint 52 (cost-monitoring panel) and Sprint 24 (Maestro) remain queued.
- Class M ledger entry #15 may evolve into Class N if the wire-up bug surfaces a new failure pattern (e.g., "wizard helper integration gap"). T4's audit names the class.

## Lane discipline

Standard 3+1+1 rules: no version bumps inside lanes (T3 is the exception, and only at the very end after T1/T2 post DONE and T4 has signed off on the diagnosis), no CHANGELOG edits inside lanes, no commits inside lanes. Orchestrator handles publish + push + commit at sprint close.
