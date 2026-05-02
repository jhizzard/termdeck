---
sprint: 50.5
parent: 50
name: worktree-isolated mixed-agent dogfood close-out
lanes:
  - tag: T1
    agent: codex
  - tag: T2
    agent: gemini
  - tag: T3
    agent: grok
  - tag: T4
    agent: claude
---

# Sprint 50.5 — Worktree-isolated mixed-agent dogfood close-out

**Parent sprint:** [Sprint 50](../sprint-50-multi-agent-memory-and-ux/PLANNING.md). Authored by Sprint 50 T4 once T1+T2+T3 closed DONE.
**Status:** Inject-ready when Joshua opens 4 worktree-backed panels (one per lane) using the Sprint 50 T3 launcher buttons.
**Target version (post-dogfood):** `@jhizzard/termdeck@1.0.0` + `@jhizzard/termdeck-stack@0.6.0` + `@jhizzard/mnestra@0.4.0` (T2 ships during Sprint 50). Roll forward to `0.19.0` if any dogfood lane fails.

## Why this sub-sprint

Sprint 50 ships three load-bearing pieces (T1 per-agent SessionEnd hook trigger, T2 `source_agent` provenance column, T3 UX trust trio). The dogfood validates them all in one shot under real load — the same pattern that proved Sprint 48's auto-wire in Sprint 49. **Worktree-isolated** because four parallel lane edits to the same repo carry merge risk; per-lane worktrees mean a botched lane is `git worktree remove` away from clean main.

This is also v1.0.0's confidence test. If the dogfood lands clean, orchestrator publishes v1.0.0 at Sprint 50 close. If any lane fails, the v1.0.0 ship slips to Sprint 51 and Sprint 50 closes as v0.19.0.

## Lanes (each picks one small Sprint 46 deferral, scope-bounded for fast close)

| Lane | Agent | Goal | Primary files |
|---|---|---|---|
| **T1 — URL state codec edge case (graph viewer)** | codex | Fix the silent project-dropdown failure: when `?project=foo` references a project not in `/api/config`'s list, dropdown reads back blank but `state.project` retains `'foo'`, fetches still target `'foo'`, end-user sees stale data with no error. Validate before applying. | EDIT `packages/client/public/graph.js` (~10 LOC, the `applyControls` site near line 178), NEW or EXTEND `tests/graph-viewer-e2e.test.js` test for unknown-project param. |
| **T2 — `approvalModel` adapter contract field (docs only)** | gemini | Add `approvalModel: 'auto' \| 'per-step'` as the 11th adapter contract field in `docs/AGENT-RUNTIMES.md` § 5, documenting the Sprint 49 Gemini approval-heavy lifecycle finding. Pure docs — no code, no tests. Smallest lane on purpose (Gemini is approval-heavy per `feedback_gemini_approval_heavy.md` so we right-size the budget). | EDIT `docs/AGENT-RUNTIMES.md` (~20 lines added). |
| **T3 — TUI spinner spam stripping** | grok | Extend `stripAnsi` in `packages/server/src/session.js` to strip Claude's TUI spinner glyph (`✻`) + the surrounding `\r\n` repetition that Sprint 46 T3 audit flagged as polluting transcript chunks and search results. | EDIT `packages/server/src/session.js` (~5-10 LOC at the `stripAnsi` site, line 22), EXTEND `tests/session.test.js` or NEW fixture asserting spinner glyph stripped. |
| **T4 — Dead `triggerProactiveMemoryQuery` cleanup** | claude | Delete the dead `triggerProactiveMemoryQuery` path at `packages/client/public/app.js:569` + its sole caller at `:2610`. The function is gated off when `aiQueryAvailable=false` (default) and Sprint 46 T2 audit confirmed no production call site needs it — server-side flashback is the only producer of toasts. Removing reduces audit-write-gap surface area to zero. | EDIT `packages/client/public/app.js` (~30-40 LOC delete), confirm no test references the symbol. |

## Acceptance criteria (dogfood)

1. **All 4 sub-sprint lanes DONE** in worktrees `.worktrees/sprint-50.5-T{1..4}/`. Lane work merges back to main cleanly (worktrees give us this for free as long as lanes don't touch the same files — current picks confirm zero overlap: graph.js / AGENT-RUNTIMES.md / session.js / app.js).
2. **4 new `session_summary` rows** in `memory_items` post-`/exit` of all four panels, with correct `source_agent` values: `claude` / `codex` / `gemini` / `grok`. Verified via Supabase REST `select source_agent, count(*) from memory_items where source_type='session_summary' group by 1`. Baseline at Sprint 50 inject = 12 rows; expected post-dogfood = 16+ rows.
3. **Spinner stays alive** during the dogfood (Sprint 50 T3's spinner-freeze fix validated under real ~20-min sprint load).
4. **Panel labels show correct agent names** (Sprint 50 T3's panel-labels-says-shell fix validated).
5. **Launcher buttons used** to open the 4 panels — orchestrator pre-step is "Joshua opens 4 worktree-rooted panels via the new T3 launcher buttons (not via shell + manual binary)."
6. **`memory_recall(source_agents=['claude'])`** filter returns only Claude-authored rows from the dogfood (Sprint 50 T2's read-side gap closed).

## Worktree convention

```bash
git worktree add .worktrees/sprint-50.5-T1 main
git worktree add .worktrees/sprint-50.5-T2 main
git worktree add .worktrees/sprint-50.5-T3 main
git worktree add .worktrees/sprint-50.5-T4 main
```

`.worktrees/` is in `.gitignore` (added by this sprint's prep — Sprint 47 introduced the worktree pattern but never updated gitignore). Orchestrator handles worktree creation + clean-up at sprint close. Joshua's role: open 4 panels, one rooted at each worktree path, via the T3 launcher buttons (T1 panel is `agent: codex`, T2 is `gemini`, T3 is `grok`, T4 is `claude`).

## Inject

Inject script staged at `/tmp/inject-sprint-50.5-dogfood.js`. Same shape as `/tmp/inject-sprint49-prompts.js`: type-aware lane mapping, two-stage submit (paste, settle 400ms, then `\r` alone), per-lane brief reference. Override via `SPRINT505_SESSION_IDS=t1,t2,t3,t4 node /tmp/inject-sprint-50.5-dogfood.js` if auto-detect misses.

## Carry-overs absorbed

This sub-sprint also closes the Sprint 49 → 50 carry-over of "verify per-agent SessionEnd hooks fire under real mixed load" — that's deliverable #2 above. No separate verification step.

## Out of scope

- Test-coverage expansion (lanes ship the minimum test for their pick — the dogfood IS the integration test).
- Cross-lane coordination (lanes touch disjoint files by design — see acceptance #1 file list).
- New deferrals — the four picks are the four picks. Gemini's Sprint 49 scope-creep tendency means T2's brief is explicit: docs-only, no code, no extras.

## Sprint close checklist (orchestrator)

1. All 4 STATUS.md DONE posts present.
2. `git diff --stat` per worktree shows expected file changes (graph.js / AGENT-RUNTIMES.md / session.js / app.js).
3. `select source_agent, count(*) from memory_items where source_type='session_summary' group by 1` shows 4 new rows with correct provenance.
4. UX validation: spinner stayed alive, panel labels named the agent, launcher buttons fired without manual `claude`/`codex`/`gemini`/`grok` typing.
5. Merge worktrees back to main (orchestrator handles).
6. Bump root `package.json` 0.18.0 → 1.0.0; stack-installer 0.5.1 → 0.6.0. Both CHANGELOG entries authored by Sprint 50 T4.
7. Publish per `docs/RELEASE.md` — npm first (Passkey, NOT OTP), push second.
