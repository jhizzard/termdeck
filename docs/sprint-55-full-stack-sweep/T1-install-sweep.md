# T1 — Install + wizard stack sweep (Claude worker)

You are T1 in Sprint 55. Lane focus: **adversarial sweep across every wizard step + every install starting state.** This is Sprint 53's stack sweep extended from 5 cells to 20+, covering EVERY known onion-class failure mode AND fresh adversarial probes.

## Boot the panel with: `claude --dangerously-skip-permissions`

This flag puts Claude Code into permissive mode — no approval prompts. Required for autonomous overnight execution OR for keeping interactive morning fast-flowing without click-fatigue. Set BEFORE any tool call.

## Boot sequence (do these in order, no skipping)

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 55 stack sweep multi-lane install wizard cells Class O macOS Docker --use-api")`
3. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback codename")` — codename rule
4. `memory_recall(query="3+1+1 hardening rules checkpoint post shape idle-poll regex")`
5. Read `~/.claude/CLAUDE.md` (global)
6. Read `./CLAUDE.md` (project router)
7. Read `docs/sprint-55-full-stack-sweep/PLANNING.md` — full sprint scope (Lane T1 cells listed there)
8. Read `docs/sprint-55-full-stack-sweep/STATUS.md` — substrate
9. Read `docs/INSTALLER-PITFALLS.md` ledger entries #16-#21 (today's discoveries — recognize when a cell reproduces a previously-ledgered class)

## Cells (target ~20)

Per PLANNING.md Lane T1 section. Start with a substrate probe (verify v1.0.9 installed locally), then run cells in order. Each cell is a discrete experiment:

```
[Cell N — short name]
Command:    <exact command run>
Expected:   <what should happen>
Observed:   <actual stdout/stderr captured>
Status:     PASS | FAIL | SKIP | UNKNOWN
Ledger:     <Class letter + reference if novel; or "existing class X #Y" if repro>
```

Output to `docs/sprint-55-full-stack-sweep/T1-SWEEP-CELLS.md` (NEW file; you create it). Capture full stdout to `/tmp/sprint-55-t1-cell-<N>.log` for any cell that needs debugging.

## Lane discipline

- **Post shape:** `### [T1] STATUS-VERB 2026-05-04 HH:MM ET — <gist>` in `docs/sprint-55-full-stack-sweep/STATUS.md`.
- **CHECKPOINT every 30 min** (or phase boundary) so post-compact you can resume.
- **READ-ONLY-ONLY:** no npm publish, no git push, no destructive prod-DB writes. If a cell finds a fix-required bug, write a FIX-PROPOSED post with a unified diff snippet and MOVE TO THE NEXT CELL. Orchestrator ships at sprint close.
- **Codename scrub:** never use the internal Supabase project codename in posts. Use "the daily-driver project" or elide.
- **Cell selection:** if you find a high-impact bug at Cell N, do NOT pivot to fixing it — finish the cell matrix first. The orchestrator's job is to prioritize fixes; your job is to surface findings.

## When you're done

Post `### [T1] DONE 2026-05-04 HH:MM ET — install stack sweep PASS|YELLOW|RED — N/M cells PASS, K findings, J ledger candidates` with full evidence dump:
- T1-SWEEP-CELLS.md committed (well, written — orchestrator commits)
- Total cells exercised + status breakdown
- New ledger candidates (one line per class)
- Reproducibility evidence for each finding (file:line OR command + stdout snippet)

If the demo window closes mid-matrix, post `### [T1] PARTIAL — N/M cells exercised — handing over to orchestrator for sprint close`.

Begin.
