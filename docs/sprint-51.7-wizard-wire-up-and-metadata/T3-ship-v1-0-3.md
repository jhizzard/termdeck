# T3 — Ship v1.0.3 wave

You are T3 in Sprint 51.7 (wizard-wire-up-and-metadata, v1.0.3 mini).

## Boot sequence (do these in order, no skipping)

1. `memory_recall(project="termdeck", query="Sprint 51.6 ship v1.0.2 RELEASE.md publish order Passkey npm publish stack-installer audit-trail bump")`
2. `memory_recall(query="termdeck CHANGELOG entry style version bump pattern files array root package.json")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/PLANNING.md`
6. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` — wait for T1 DONE and T2 DONE before staging the wave.
7. Read this brief end-to-end.
8. Read `docs/RELEASE.md` end-to-end (this sprint's deliverable IS a release; treat the doc as enforcement).
9. Read `CHANGELOG.md` (root) — look at the v1.0.2 entry's shape and match the style for v1.0.3.

## Pre-sprint intel

Sprint 51.6 shipped v1.0.2 wave (termdeck@1.0.2 + termdeck-stack@0.6.2 + mnestra@0.4.2). Sprint 51.7 ships v1.0.3 wave: **termdeck@1.0.3 + termdeck-stack@0.6.3** (audit-trail bump only — stack-installer source unchanged but ships from the same monorepo). Mnestra and Rumen unchanged (no schema changes, no edge function changes).

Critical RELEASE.md rules to internalize before staging:
- **Passkey only.** `@jhizzard/*` auths via web Passkey. NEVER pass `--otp` to `npm publish`.
- **Publish order: npm BEFORE git push.** If publish fails, the un-pushed commit can still be amended.
- **Stack-installer audit-trail bump.** Even though only the root `termdeck` package's source changed, `@jhizzard/termdeck-stack` bumps to maintain the audit trail (lesson from Sprint 35 close-out).
- **`files: []` array verification.** Both root `package.json` AND `packages/stack-installer/package.json` must include any new asset paths the helpers reference. Sprint 51.6 T4-CODEX caught a packaging gap mid-flight — verify with `npm pack --dry-run --json` for both packages.
- **Test matrix green.** Full `node --test` across packages must be green. The 22 historical `tests/project-taxonomy.test.js` failures should already be CLOSED (Joshua's hook is post-Phase-B v1; T2 will bump it to v2 in this sprint).

## Lane scope

T3 has TWO phases. Phase A is staging (immediately after T1 DONE + T2 DONE). Phase B is publish (orchestrator-driven; T3 reports staged-and-ready and orchestrator runs the publishes).

### Phase A — Stage the wave (T3-owned)

1. **Wait for T1 DONE + T2 DONE in STATUS.md.** Do NOT begin staging until both have posted DONE. If you finish reading earlier, post `[T3] STANDBY 2026-05-04 HH:MM ET — awaiting T1 + T2 DONE` and idle.

2. **Bump versions:**
   - Root `package.json`: `"version": "1.0.2"` → `"1.0.3"`
   - `packages/stack-installer/package.json`: `"version": "0.6.2"` → `"0.6.3"`
   - `packages/cli/package.json` if it has its own version (check first; usually mirrors root)
   - Mnestra and Rumen package.json files: DO NOT TOUCH.

3. **Verify `files: []` arrays** include any new asset paths T1/T2 added. Run `npm pack --dry-run --json` from BOTH the root and `packages/stack-installer/` and confirm:
   - `packages/cli/src/init-mnestra.js` (T1's instrumentation removal + fix should be in)
   - `packages/cli/tests/init-mnestra-cli-refresh.test.js` (T1's new integration test — though tests typically aren't shipped, verify file is in repo)
   - `packages/stack-installer/assets/hooks/memory-session-end.js` (T2's metadata + v2 bump)
   - `packages/stack-installer/tests/hook-metadata-parser.test.js` (T2's new test)
   - `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` (T2's fixture — confirm it's in `files: []` if needed for any test, OR confirm tests don't ship)

4. **CHANGELOG entry.** Add a `## 1.0.3 — 2026-05-04` block (or whatever the date is at ship time — use `date` to confirm) above the `1.0.2` block. Match the prior style. Required line items:
   - Wizard wire-up fix: `termdeck init --mnestra` now actually refreshes `~/.claude/hooks/memory-session-end.js` (T1 root cause + fix in 1 sentence).
   - Bundled hook metadata completeness: `started_at`, `duration_minutes`, `facts_extracted` now populated from transcript parsing (T2).
   - Bundled hook version stamp v1 → v2 (forces refresh on existing v1 installs).
   - New CLI integration test catches wire-up regressions pre-publish.
   - Closes ledger #15 v1.0.3 follow-up (per `docs/INSTALLER-PITFALLS.md:173`).

5. **Run the full test matrix:**
   ```bash
   node --test packages/cli/tests/**/*.test.js
   node --test packages/stack-installer/tests/**/*.test.js
   node --test packages/server/tests/**/*.test.js
   node --test tests/**/*.test.js
   ```
   Expect: NEW pass count = Sprint 51.6 baseline (~986 pass) + T1's new test + T2's new tests, fail count = 0 (the 22 project-taxonomy failures should already be closed post-Phase-B).

6. **Tarball verification:**
   ```bash
   cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
   npm pack --dry-run --json > /tmp/sprint-51.7-root-pack.json
   cd packages/stack-installer
   npm pack --dry-run --json > /tmp/sprint-51.7-stack-pack.json
   cd ../..
   ```
   Verify the bundled hook + init-mnestra.js both ship in the root tarball. Verify the bundled hook also ships in the stack-installer tarball. Post sample paths in your DONE.

7. **Post `[T3] FIX-LANDED 2026-05-04 HH:MM ET — wave staged, awaiting orchestrator publish`** with: version diffs, CHANGELOG entry text, test counts (before/after), and a paste of the relevant npm-pack-dry-run lines proving the bundled hook + init-mnestra ship in both tarballs.

### Phase B — Hand off to orchestrator

Do NOT run `npm publish`. Do NOT run `git commit`. Do NOT run `git push`. The orchestrator owns publish (Passkey is on Joshua's machine, must be human-driven). Post `[T3] STAGED-FOR-PUBLISH` to STATUS.md and idle. Orchestrator will:
- Run `npm publish` from root (Passkey)
- Run `npm publish` from `packages/stack-installer/` (Passkey)
- Wait 30s, verify `npm view @jhizzard/termdeck version` shows 1.0.3
- `git add -A && git commit -m "..."` and `git push`

## Lane discipline

- No commits.
- No publishes.
- No CHANGELOG edits OUTSIDE the v1.0.3 block (don't reword v1.0.2 etc.).
- All findings → STATUS.md.
- If T1 or T2 DONE is missing or fails, post `[T3] BLOCKED — ...` with the blocker and idle. Do NOT try to ship without both lanes' DONE.

## When you're done

Post `[T3] STAGED-FOR-PUBLISH` to STATUS.md with the full staging report.

Begin.
