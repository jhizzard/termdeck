# Sprint 67 · T3 — Doc hygiene

**Lane:** T3 (Claude worker) · **Sprint:** 67 — Field-deployment integrity · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence.

## Your mission

Clear three accreted-cruft items: a bloated backlog, an over-long global rules file, and a legacy layout. You own docs + the `orch` layout retirement; you do NOT own the hook work (T1) or CI/GitHub (T2).

## Deliverables

**3.1 — Rewrite `docs/BACKLOG.md`.**
The file has accreted to ~70 KB — entries layered chronologically with `✅ CLOSED` tags inline, duplicate entries, and a stale 2026-04-27 header. Produce a clean, current, deduplicated backlog: drop or archive the closed entries, merge duplicates, fresh header, a clear P0 / categorized structure. **Scrub as you go** — this file is the highest-risk place for a forbidden internal Supabase project name / ref to hide (hardening rule 4); the gitleaks hook will block the commit if one slips through.

**3.2 — Trim `~/.claude/CLAUDE.md`.**
~387 lines → ~250 (actual is 434 lines as of 2026-05-23). The bloat is historical "Sprint N" war-story paragraphs embedded inside otherwise-load-bearing rule sections. **Promote** that history to Mnestra (`memory_remember`, kitchen-level) — do not delete it — and leave the rule itself stated cleanly. **Preserve every load-bearing rule verbatim in substance** — the time-check rule, session-end email, memory-first, 3+1+1 inject mandate, never-copy-paste-messages, RLS hygiene, gitleaks, the no-internal-Supabase-project-name rule, the kitchen-vs-recipe rule, orchestrator-centralized harvest. T4 audits this by enumeration — assume every rule is load-bearing unless it is purely a dated war story. Note: Sprint 68 T3 will also edit `~/.claude/CLAUDE.md` (correcting the stale "no hook surface" claim); Sprint 67 runs first and trims, Sprint 68 then corrects — sequential, no conflict.

**3.3 — Retire or gate the legacy `orch` grid layout.**
Selecting the legacy `orch` layout makes the last worker tile span oddly now that a role-tagged ORCH tile moves to `#orch-pin-row` (Sprint 65). Either remove `orch` from the layouts list in `packages/client/public/app.js` (the `['1x1','2x1','2x2','3x2','2x4','4x2','orch']` array) or gate it so it cannot be selected. Confirm no other code path hard-depends on the `orch` value.

## Files you'll touch

- `docs/BACKLOG.md` — full rewrite
- `~/.claude/CLAUDE.md` — trim (out-of-repo global file; editing its text is fine — only `~/.claude/settings.json` *hook* edits are classifier-blocked)
- `packages/client/public/app.js` — the layouts array / `orch` handling

## Not your lane

Hook field-deployment (T1). CI/GitHub (T2). No version bumps, no `CHANGELOG.md` edits, no commits — orchestrator close-out. (Doc *content* in 3.1–3.2 is yours; the CHANGELOG is not.)

## Lane discipline

Post `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>`. Before you touch `~/.claude/CLAUDE.md`, post a FIX-PROPOSED listing every rule you intend to keep + every paragraph you intend to promote-to-Mnestra, so T4 can audit the plan before the edit lands — a lost load-bearing rule is the one irreversible mistake in this lane.
