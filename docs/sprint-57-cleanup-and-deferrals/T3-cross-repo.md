# T3 — CROSS-REPO lane

**Role:** Claude worker, Sprint 57.
**Scope:** Rumen `createJob` `started_at` upstream fix (#10, in `~/Documents/Graciella/rumen`) + Playwright `--isolated` config (#3, in `~/.claude.json`).

## Goal

Land the Sprint 45 upstream fix that removes the TermDeck-side `COALESCE(started_at, completed_at)` workaround, and close the Sprint 55 architectural defect where Playwright MCP shares one Chrome profile across all Claude Code sessions on the machine.

## Pre-flight reads

1. `docs/sprint-57-cleanup-and-deferrals/PLANNING.md`
2. `docs/sprint-57-cleanup-and-deferrals/STATUS.md`
3. `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/memory/feedback_playwright_takeover_critical.md` (full bug + fix direction)
4. `~/Documents/Graciella/rumen/src/index.ts:177` (the `createJob` INSERT that omits `started_at`)
5. `~/Documents/Graciella/rumen/src/index.ts` (full file context — read it end-to-end, this is a different repo than your sprint cwd)
6. `~/.claude.json` (current Playwright MCP `args`)

## Tasks

### Task 3.1 — Rumen `createJob` `started_at` fix (#10)

**Symptom (Sprint 45 root cause):** `~/Documents/Graciella/rumen/src/index.ts:177` — `createJob` INSERT VALUES tuple omits `started_at`. The column has no DB default. Result: 1546+ `rumen_jobs` rows have NULL `started_at` over time. Sprint 45 shipped a TermDeck-side `COALESCE(started_at, completed_at)` read-side fix at the doctor probe + dashboard render layer.

**Fix:** Two-line patch — add `started_at` to the INSERT VALUES tuple with `NOW()` (or `new Date().toISOString()` if the codebase uses JS Dates). Keep behavior identical for `completed_at` (which is set by `markDone` later).

**Files to edit:**
- `~/Documents/Graciella/rumen/src/index.ts` line 177 (the INSERT) — add `started_at: new Date().toISOString()` (or equivalent depending on the existing object shape).

**Critical constraint:** This is a **separate repo** from your sprint cwd. Edits land there, but the global discipline rule still applies: **no version bumps, no CHANGELOG, no `git commit`** in `~/Documents/Graciella/rumen`. Orchestrator coordinates the rumen 0.5.4 publish wave at sprint close.

**Verification:**
- `cd ~/Documents/Graciella/rumen && npm run build` — TypeScript compiles cleanly.
- `cd ~/Documents/Graciella/rumen && npm test` — existing tests pass (or document why a missing test should be added).
- Confirm `dist/index.js` is rebuilt — the Class K bug from Sprint 55 (source-fix committed, dist not rebuilt → npm publish ships pre-fix code) is the canonical failure mode for this exact kind of rumen-side fix. After build, `grep "started_at" dist/index.js` should show the new line.

### Task 3.2 — Playwright `--isolated` config (#3)

**Symptom (Sprint 55 takeover catastrophe):** Playwright MCP shares one Chrome profile across ALL Claude Code sessions on the machine. T2's UI cells in Sprint 55 hijacked Joshua's parallel-project browser tabs. P0 architectural defect.

**Fix:** Add `--isolated` to the Playwright MCP `args` array in `~/.claude.json`.

**Find the right block:** Open `~/.claude.json`. Search for `"playwright"` in the `mcpServers` object. The current shape is approximately:
```json
"playwright": {
  "type": "stdio",
  "command": "npx",
  "args": ["@playwright/mcp@latest"],
  ...
}
```
Add `"--isolated"` to the `args` array so it becomes `["@playwright/mcp@latest", "--isolated"]`.

**Verification:**
- Document a verification plan in your `### [T3] FIX-PROPOSED` post: open two simultaneous Claude Code sessions, both call `mcp__playwright__browser_navigate` to different URLs, observe TWO independent browser instances spawned (not one shared profile).
- Do NOT actually exercise `mcp__playwright__*` tools yourself in this lane — that's exactly the takeover bug we're closing. Verification is the orchestrator's call after sprint close (or Sprint 58's #7 task).

## Discipline (universal — read STATUS.md § Lane discipline)

- **Post shape:** `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (with the `### ` prefix).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish` — even in the `~/Documents/Graciella/rumen` repo.
- **Stay in lane.** Don't touch T1's server work or T2's API/UI work. Cross-lane reads OK.
- **Append-only STATUS.md.**
- **Class K vigilance:** After Task 3.1 build, explicitly grep `dist/index.js` to prove the rebuild reflects your source change. If the dist is stale, post `### [T3] BLOCKED` with evidence.

## Success criteria

1. `### [T3] FIX-LANDED` posts for Tasks 3.1 and 3.2 with file:line evidence.
2. Task 3.1: `cd ~/Documents/Graciella/rumen && npm run build && grep "started_at" dist/index.js` shows the new field — Class K avoided.
3. Task 3.2: `~/.claude.json` Playwright `args` array contains `"--isolated"` (`grep -A 5 '"playwright"' ~/.claude.json` confirms).
4. T4-CODEX audits the rumen diff (especially the Class K dist-rebuild proof).
5. `### [T3] DONE 2026-05-05 HH:MM ET` posted with summary.
