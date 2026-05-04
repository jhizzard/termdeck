# T1 — Adversarial pen-test sweep (Claude worker)

You are T1 in Sprint 53. Single-lane Claude worker. Owns the **adversarial pen-test sweep** — enumerate (install-state × platform × cwd) cells, run the wizard cell-by-cell, ledger every novel failure BEFORE outside users hit them. The deliverable is the matrix output, not just the fixes that fall out.

This sprint runs LIVE during a Brad call as a demo of the 3+1+1 pattern. Show the SHAPE of the work; full completion likely overruns the call window.

## Boot sequence (do these in order, no skipping)

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 53 pen-test adversarial sweep install state platform cwd cells")`
3. `memory_recall(project="termdeck", query="INSTALLER-PITFALLS Class O ledger 20 21 dogfood macOS Docker --use-api")`
4. `memory_recall(query="3+1+1 hardening rules checkpoint post shape idle-poll regex")`
5. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback")` — confirm the codename rule is loaded
6. Read `~/.claude/CLAUDE.md` (global)
7. Read `./CLAUDE.md` (project router)
8. Read `docs/sprint-53-pen-test-and-picker/PLANNING.md` (sprint scope)
9. Read `docs/sprint-53-pen-test-and-picker/STATUS.md` (substrate)
10. Read `docs/INSTALLER-PITFALLS.md` ledger entries #20 + #21 (Class O context for what cells to prioritize)

## Lane focus

Build a matrix of cells and exercise the wizard in each. **Demo target: 5 cells in 25 min.** Bias toward cells that simulate Brad's likely starting state OR Joshua's known-bad combos (NOT "fresh user, fresh project, current platform" — those are the only ones that work today, demoing them is uninteresting).

**Demo cell selection (5 cells):**

1. **Cell A — Joshua's daily-driver state, repo-cwd**: run `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && termdeck init --rumen --yes`. Expected: success post-v1.0.8 (`--use-api` flag bypasses the macOS Docker bug; pin probe should now report GREEN for rumen-tick since the daily-driver was redeployed at 0.4.5 earlier today).
2. **Cell B — Contaminated repo-cwd state**: create `<repo>/supabase/functions/rumen-tick/index.ts` (touch one byte) BEFORE running `init --rumen --yes` from `/tmp`. This reproduces the v1.0.8 ledger #21 bug 3 starting state. Expected: wizard's `cwd: stage` isolation should prevent contamination — verify behavior.
3. **Cell C — Fresh tmp HOME**: `HOME=/tmp/td-test-home-$(date +%s) termdeck init --mnestra --yes` after copying secrets.env to the new HOME. Expected: clean fresh-install path; mig 016 cron-conditional guard should fire (Class A #19 regression check).
4. **Cell D — Stale supabase CLI version simulation**: skip if Joshua's local CLI was updated since the v1.0.8 dogfood (was at 2.75 then, current 2.98+). If still stale, force the Docker bundler path by unsetting `--use-api` manually and confirming the failure pattern. If updated, skip and note.
5. **Cell E — Brad-shape simulation**: read jizzard-brain config from memory (Brad's project is on Linux MobaXterm SSH, supabase CLI 2.x). We can't reproduce his exact env locally, but we CAN simulate it via a Linux Docker container running `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra --yes` against a throwaway Supabase project. SKIP this cell if container setup exceeds 5 min — flag for follow-up.

For each cell, post FINDING with the exact command, expected behavior, observed behavior, and any new ledger candidate. Capture stdout to `/tmp/sprint-53-cell-<letter>.log` for the orchestrator to grep into PEN-TEST-RESULTS.md at sprint close.

## Lane discipline

- **Post shape:** `### [T1] STATUS-VERB 2026-05-04 HH:MM ET — <gist>` in `docs/sprint-53-pen-test-and-picker/STATUS.md`.
- **Cadence:** post FINDING per cell; CHECKPOINT every 15 min if >15 min on a single cell.
- **No version bumps. No CHANGELOG edits. No commits.** This is a discovery lane; orchestrator handles any code fixes that fall out at sprint close.
- **Codename scrub rule:** if any FINDING references the daily-driver project, do NOT use the codename. Use "the daily-driver project" or elide. Same for the project ref `<project-ref>`. Per the feedback memory canonized today.
- **External codename hygiene applies to your STATUS.md posts too** — Brad will see this STATUS.md if Joshua shows it during the call. Keep posts neutral.

## When you're done

Post `### [T1] DONE 2026-05-04 HH:MM ET — <PASS|FINDINGS|RED>` with full evidence dump:
- Cells exercised + status
- Any new ledger candidates (Class letter + one-line description)
- File:line evidence for any reproducible failure
- Pointer to `/tmp/sprint-53-cell-*.log` files

If the demo window closes before Cell E (or earlier), post `### [T1] PARTIAL — N/5 cells exercised — handing over to orchestrator for sprint close`.

Begin.
