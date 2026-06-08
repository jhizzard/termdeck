# Sprint 68 · T4 — Codex auditor

**Lane:** T4 (Codex — adversarial auditor) · **Sprint:** 68 — Standalone-shell memory capture

## Boot sequence

Per `PLANNING.md` § Boot sequence. You are the auditor — you have no shared context with the Claude worker lanes by design (different model, different training, different prompt history). Reproduce; do not trust.

## Your mission

Adversarial, independent review of T1/T2/T3. Audit WIP *before* FIX-LANDED, not after. Your job is to catch the shared-assumption blind spots the three Claude lanes cannot see in themselves.

## Audit focus (highest-leverage first)

**A1 — The D1 dedup invariant (load-bearing).** Independently reproduce all four invocation paths:
1. Native CLI hook, standalone shell → a row lands in Mnestra, labeled `codex` / `gemini` / `grok`.
2. Native CLI hook, *inside* a TermDeck panel → the hook no-ops; exactly **one** row total (from `onPanelClose`), not two.
3. `onPanelClose` (TermDeck panel) → still captures, unchanged.
4. Claude Code's own `SessionEnd` hook, inside a TermDeck panel → still captures (must NOT be caught by the guard).
A wrong guard either double-writes or silently drops Claude-in-TermDeck captures. Verify the env-var logic against the *actual* `spawnTerminalSession` env block and the *actual* installed hook commands — not against the briefs' description of them.

**A2 — JSON-merge clobber audit.** For each of the three CLI config files: pre-seed a file containing the user's own hooks + unrelated settings, run the installer, diff. Nothing of the user's may be lost or destructively reordered. Malformed input → abort, no overwrite. Re-run → idempotent. Check against INSTALLER-PITFALLS § "Settings.json invariants the wizard must enforce".

**A3 — Version-gate honesty.** Confirm a too-old CLI produces a loud skip, never a silent write of a config the CLI ignores (Class I). Independently check the Grok verdict — does the installed `grok-dev` actually honor the `hooks` block, or is the gate wrong in either direction?

**A4 — Asset inclusion.** Any new bundled asset is in the relevant `package.json` `files` array and shows in `npm pack --dry-run` (INSTALLER-PITFALLS Class H, checklist item #3).

## Discipline

- Post `### [T4-CODEX] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB ∈ AUDIT-CONCERN / AUDIT-RED / CHECKPOINT / FINAL-VERDICT).
- **CHECKPOINT discipline:** post `### [T4-CODEX] CHECKPOINT` at every phase boundary and at least every 15 minutes — phase + name, what's verified with file:line evidence, what's pending, the last FIX-LANDED reference you were verifying. Your panel may compact mid-sprint; STATUS.md is your only durable memory — on compact, self-orient from your most recent CHECKPOINT.
- `FINAL-VERDICT GREEN` only when A1–A4 all hold with file:line evidence. Otherwise `RED` with the specific failing claim.

## Not your lane

You author no production code. You verify, reproduce, and report.
