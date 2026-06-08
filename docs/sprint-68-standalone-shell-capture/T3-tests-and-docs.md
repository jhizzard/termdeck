# Sprint 68 · T3 — Tests + docs

**Lane:** T3 (Claude worker) · **Sprint:** 68 — Standalone-shell memory capture · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence.

## Your mission

Fence the sprint with tests, correct the now-stale documentation, and complete the INSTALLER-PITFALLS trace. You own tests + docs; you do NOT own the hook scripts (T1) or installer functions (T2) — but you read both lanes' WIP to test and document them accurately.

## Deliverables

**3.1 — Fence tests** (`node --test`; follow the patterns in `packages/server/tests/` and the `packages/stack-installer/` test files):
- Per-CLI JSON-merge idempotency (run the merge twice → exactly one entry).
- **The D1 dedup guard truth table** — four invocation paths: native-CLI standalone (captures), native-CLI inside TermDeck (no-ops), `onPanelClose` (captures, unchanged), Claude's own SessionEnd hook (captures — must NOT be caught by the guard). This is the load-bearing correctness test.
- `source_agent` resolution: stdin → `TERMDECK_NATIVE_CLI_HOOK` → inference.
- Version-gate: a too-old CLI → skip + message, never a silent write.
- Malformed-config abort: pre-seed a malformed config → installer aborts that CLI, does not overwrite, other CLIs unaffected.
- User's-own-hooks preserved: pre-seed a user hook → after merge it is still present verbatim.
- **Confirm the new tests are inside the `npm test` glob** — Sprints 65/66 flagged stranded test files; do not strand these.

**3.2 — Correct the stale docs.** The "non-Claude CLIs have no hook surface / no PreCompact equivalent" claim is now false for Gemini and Grok. Correct it in: `~/.claude/CLAUDE.md` (the auto-commit / Investigation-2 section), project `./CLAUDE.md` (§ Hard rules — the auto-commit bullet), `docs/CRITICAL-READ-FIRST-2026-05-07.md` (the Investigation-2 Resolution paragraph). State the current reality precisely — Gemini `SessionEnd`+`PreCompress`; Grok `SessionEnd`+`PreCompact`; Codex `Stop` only, still no `SessionEnd`. Do not delete the history — annotate it as superseded by the 2026-05-19 finding.

**3.3 — INSTALLER-PITFALLS.** Add CLI-config invariants tables (mirror § "Settings.json invariants the wizard must enforce") for `~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.grok/user-settings.json`. Trace the sprint to classes A / B / E / I / N. Evaluate whether writing into third-party CLI config (schema + version we do not control) warrants a **new failure class** — if yes, append it to the taxonomy and add a pre-ship checklist line, per the doc's § "How to add a new entry".

**3.4 — `BACKLOG.md`.** Move the §5 horizon "standalone-shell capture" item to in-progress (cite Sprint 68).

**3.5 — Install docs.** Document the native CLI hooks + the Codex degraded-mode limitation (D2) in `docs/GETTING-STARTED.md` / `docs/INSTALL.md` as appropriate.

## Files you'll touch

- `packages/server/tests/` and/or the `packages/stack-installer/` test files — new fence tests
- `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `docs/CRITICAL-READ-FIRST-2026-05-07.md`, `docs/INSTALLER-PITFALLS.md`, `docs/BACKLOG.md`, `docs/GETTING-STARTED.md`

## Not your lane

Hook scripts (T1), installer functions (T2). No version bumps; no `CHANGELOG.md` edits; no commits — those are orchestrator close-out. (Doc *content* corrections in 3.2–3.5 are yours; the CHANGELOG is not.)

## Lane discipline

Post `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>`. Your fence tests depend on T1 + T2 WIP — read their landed code; idle-poll with the tolerant regex `^(### )?\[T<n>\] (FIX-LANDED|DONE)\b` while you wait, and start the doc-correction deliverables (3.2–3.4) first since they don't block on the other lanes.
