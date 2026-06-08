# Sprint 68 · T2 — Installer wiring

**Lane:** T2 (Claude worker) · **Sprint:** 68 — Standalone-shell memory capture · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence (this file is the last step). **Read `docs/INSTALLER-PITFALLS.md` in full before writing code** — your work is the installer surface; § "Settings.json invariants the wizard must enforce" and the failure-class taxonomy are your contract.

## Your mission

Make the TermDeck installer write the native session-end (+ compaction) hook configs into the three non-Claude CLIs, so a standalone shell captures to Mnestra. You own the installer functions, the refresh path, and the uninstall path. You do NOT own the hook scripts (T1) or tests/docs (T3).

The proven template is `installPreCompactHook` + `_mergePreCompactHookEntry` + `_isPreCompactHookEntry` in `packages/stack-installer/src/index.js` (Sprint 64) — **mirror it.**

## Deliverables

**2.1 — `installGeminiHook`.** Idempotent JSON-merge of two hook groups into `~/.gemini/settings.json` `hooks`: a `SessionEnd` group and a `PreCompress` group. Commands: `TERMDECK_NATIVE_CLI_HOOK=gemini node ~/.claude/hooks/memory-session-end.js` and `... memory-pre-compact.js`. Version gate: Gemini ≥ 0.26.0 (hooks default-on). Structure per the Gemini CLI hooks reference (`SessionEnd` uses no matcher).

**2.2 — `installGrokHook`.** `SessionEnd` + `PreCompact` groups into `~/.grok/user-settings.json` `hooks`. **Gate on T1's verified minimum `grok-dev` version** — if the installed version lacks hooks, SKIP with a loud, explicit upgrade message (`grok-dev ≥ <X> required for standalone memory capture; upgrade with: npm i -g grok-dev`). Never write a `hooks` block a version-too-old CLI silently ignores (INSTALLER-PITFALLS Class I).

**2.3 — `installCodexHook`.** A `Stop` hook group into `~/.codex/hooks.json` — create the file if absent (the daily-driver has `config.toml` but no `hooks.json`). Confirm Codex honors `hooks.json` when both files exist; if precedence is unclear, fall back to a `[[hooks.Stop]]` block in `config.toml`. Codex gets no compaction hook — none exists (D2). Command sets `TERMDECK_NATIVE_CLI_HOOK=codex`.

**2.4 — Shared merge invariants (all three).** Backup-before-write (`<path>.bak.<YYYYMMDDhhmmss>`); abort + clear status line on malformed JSON (never overwrite a malformed file); idempotent (detect an existing TermDeck entry → skip); preserve the user's own hook entries verbatim (conservative substring match on the command, like `_isSessionEndHookEntry`); `--dry-run` support. Each config file gets an invariants table (T3 documents them in INSTALLER-PITFALLS).

**2.5 — Refresh + uninstall.** Extend `runHookRefresh` (`packages/cli/src/init-mnestra.js`) so `termdeck init --mnestra` reconciles all three CLI-hook configs. Extend the uninstall splice (`packages/stack-installer/src/uninstall.js`) to surgically remove the three native-CLI-hook entries. **Sprint 67 repairs `runHookRefresh` first — build on the fixed path, do not re-fix it; if Sprint 67's fix is not yet merged at inject, flag it as a blocker in STATUS.md.**

**2.6 — Wizard prompt.** One umbrella prompt — "Install native session-end memory hooks for standalone Codex / Gemini / Grok sessions?" — in the `installPreCompactHook` style: default-yes, `--yes`-aware. Wire the three installers into the stack-installer main flow alongside `installPreCompactHook` (~`index.js:1005`).

## Files you'll touch

- `packages/stack-installer/src/index.js` — `installCodexHook` / `installGeminiHook` / `installGrokHook` + merge/predicate helpers + main-flow wiring + exports
- `packages/cli/src/init-mnestra.js` — `runHookRefresh` extension
- `packages/stack-installer/src/uninstall.js` — uninstall splice

## Not your lane

The hook scripts themselves (T1). Tests + docs (T3). No version bumps / CHANGELOG / commits.

## Lane discipline

Post `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>`. You are blocked on T1's Grok `transcript_path` FINDING for 2.2 — **start with 2.1 (Gemini, lowest-risk) while you wait**, then 2.3 (Codex), then 2.2 (Grok).
