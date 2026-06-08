# Sprint 67 · T4 — Codex auditor

**Lane:** T4 (Codex — adversarial auditor) · **Sprint:** 67 — Field-deployment integrity

## Boot sequence

Per `PLANNING.md` § Boot sequence. You are the auditor — no shared context with the Claude worker lanes by design. Reproduce; do not trust.

## Your mission

Adversarial, independent review of T1/T2/T3. Audit WIP *before* FIX-LANDED. The single highest-stakes audit this sprint is the `~/.claude/CLAUDE.md` trim — a lost load-bearing rule is silent and irreversible.

## Audit focus (highest-leverage first)

**A1 — The `~/.claude/CLAUDE.md` trim lost zero load-bearing rules.** Take the pre-trim file and the post-trim file. Enumerate every distinct rule/directive in the pre-trim file. For each, confirm it survives in the post-trim file in substance (wording may tighten; the *obligation* must not weaken or vanish). Confirm every "promoted to Mnestra" paragraph actually landed in Mnestra (a real `memory_remember` row, not just deleted). Report any rule whose force is reduced. This is your RED-line audit — do not pass the lane on a hand-wave.

**A2 — The `runHookRefresh` fix actually closes the systemic bug.** Independently reproduce: put a deliberately-stale (pre-Sprint-64) hook file on disk, run T1's fixed refresh path, confirm **both** `memory-session-end.js` and `memory-pre-compact.js` end up current. Verify T1's test drives from a stale starting state, not the developer's current state (INSTALLER-PITFALLS #13). Confirm the root-cause FINDING is evidenced, not assumed.

**A3 — CI is genuinely green on GitHub.** Not "`npm test` passes locally." Check the actual GitHub Actions run — all jobs green or correctly skip-neutral. Confirm the skip-neutral gate still *fails* on a real regression when secrets are present (a skipped job must not mask a broken install).

**A4 — `BACKLOG.md` rewrite drops nothing still-open.** Spot-check that open items from the pre-rewrite backlog survive the dedup; no live work-item silently dropped. Confirm no forbidden internal Supabase literal in the rewritten file.

## Discipline

- Post `### [T4-CODEX] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB ∈ AUDIT-CONCERN / AUDIT-RED / CHECKPOINT / FINAL-VERDICT).
- **CHECKPOINT discipline:** post `### [T4-CODEX] CHECKPOINT` at every phase boundary and at least every 15 minutes — phase + name, what's verified with file:line evidence, what's pending, the last FIX-LANDED reference. Your panel may compact mid-sprint; STATUS.md is your only durable memory — on compact, self-orient from your most recent CHECKPOINT.
- `FINAL-VERDICT GREEN` only when A1–A4 all hold with evidence; otherwise `RED` with the specific failing claim.

## Not your lane

You author no production code. You verify, reproduce, and report.
