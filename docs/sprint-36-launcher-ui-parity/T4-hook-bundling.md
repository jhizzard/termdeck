# Sprint 36 — T4: Hook bundling

**Lane goal:** The stack-installer (`@jhizzard/termdeck-stack`) drops `~/.claude/hooks/memory-session-end.js` and merges the corresponding `Stop` hook block into `~/.claude/settings.json`. Idempotent. Defaulted-on but opt-in via prompt.

**Why this matters:** Joshua's box has the session-end hook installed; fresh users don't. The hook fires on every Claude Code session close to summarize the session into Mnestra. Without it, Mnestra ingestion is sparse for fresh users and Rumen has no signal to learn from. This is the last "personal-vs-product asymmetry" in the Phase B reconciliation strategy.

## Sprint 35 discovery (read this first)

Joshua has only ONE hook: the user-global one at `~/.claude/hooks/memory-session-end.js`. No project-level hooks across his 10 `.claude/` directories. This means:
- The installer only needs to drop ONE file to ONE path.
- The settings.json merge is a single block, not a per-project loop.

This is simpler than initially scoped.

## Acceptance behavior

1. Stack-installer prompts the user: `Install TermDeck's session-end memory hook? (Y/n)` — defaults to Y.
2. On Y:
   - Copy vendored `assets/hooks/memory-session-end.js` to `~/.claude/hooks/memory-session-end.js`. If the destination exists and differs, prompt: `Existing hook found at ~/.claude/hooks/memory-session-end.js. Overwrite? (y/N)` — defaults to N.
   - Read `~/.claude/settings.json`, parse, locate or create the `hooks.Stop` array, ensure an entry referencing `~/.claude/hooks/memory-session-end.js` exists. If it already exists, skip. Idempotent.
   - Write back `~/.claude/settings.json`. Preserve all unrelated keys.
3. On N: skip both file copy and settings.json merge.
4. After install, print: `Session-end hook installed at ~/.claude/hooks/memory-session-end.js. It runs on every Claude Code session close to summarize the session into Mnestra.`
5. README the hook so a curious user can read what it does.

## Primary files

- `packages/stack-installer/src/index.js` — wire the prompt + file copy + settings merge.
- NEW `packages/stack-installer/assets/hooks/memory-session-end.js` — vendored copy of Joshua's hook. Source: `~/.claude/hooks/memory-session-end.js`. Copy verbatim. (Worth a sanity check that there are no machine-specific paths hardcoded in there before vendoring.)
- NEW `packages/stack-installer/assets/hooks/README.md` — short doc explaining: what the hook does, when it fires, what it writes to Mnestra, how to disable.

## Investigation step (do this first)

```sh
cat ~/.claude/hooks/memory-session-end.js | head -80
jq '.hooks // empty' ~/.claude/settings.json
```

Capture the EXACT shape of the `hooks` block in settings.json — Claude Code's hook config schema has shifted across releases. Build the merge to whatever shape you find. Document in your STATUS FINDING.

If the hook source has any hardcoded references to Joshua's paths (e.g., `/Users/joshuaizzard/...`), those need to be parameterized before vendoring. Most likely the hook uses `~` or `process.env.HOME` already, but verify.

## Test plan

- Unit tests for the settings.json merge function: empty hooks block, existing Stop array without our entry, existing Stop array WITH our entry (should no-op), malformed settings.json (gracefully error).
- Integration: install on a temp HOME → confirm both file and settings.json are correct → install again → confirm idempotent (no diff).
- Manual on Joshua's box (with backups): pretend it's a fresh install, run installer, confirm Y path works without clobbering existing entries.

## Coordination notes

- **T2 also touches `~/.claude/`** (writing to `~/.claude.json`, the MCP config). Coordinate so you don't both hold a file lock or step on each other's reads. Different files, but same parent dir — be careful in tests.
- **T1 may print a "session-end hook not found" hint** in the launcher boot output. If you add such a hint, mirror your install path.

## Out of scope

- Don't change the hook's behavior. Just vendor and install.
- Don't add per-project hook support. Joshua's setup is global-only.
- Don't touch CLI behavior. T1 owns the launcher.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-36-launcher-ui-parity/STATUS.md` under `## T4`. No version bumps. No commits. Stay in your lane.
