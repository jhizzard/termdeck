# Sprint 67 · T1 — Hook field-deployment

**Lane:** T1 (Claude worker) · **Sprint:** 67 — Field-deployment integrity · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence: `memory_recall` ×3 → `~/.claude/CLAUDE.md` → `./CLAUDE.md` → `docs/RESTART-PROMPT-2026-05-19-sprint-68-staged.md` → `docs/INSTALLER-PITFALLS.md` → `PLANNING.md` → `STATUS.md` → this file.

## Your mission

Make the Sprint-64 `PreCompact` hook *verified-firing* on the daily-driver, and **root-cause + fix the systemic reason the installer's hook-refresh path let `memory-session-end.js` go stale for ~6 weeks.** You own the installer refresh path and the verification procedure. You do NOT own CI/GitHub (T2) or docs (T3).

**The one-off file refresh is already done.** On 2026-05-19 the stale May-4 `~/.claude/hooks/memory-session-end.js` was surgically replaced with the Sprint-64 bundled version (backup `~/.claude/hooks/memory-session-end.js.bak.20260519-134416`). **Do not redo it.** Your job is the *systemic* fix so it cannot recur.

## Deliverables

**1.1 — Verify the `PreCompact` hook fires.**
`~/.claude/settings.json` is confirmed (2026-05-19) to have both a `SessionEnd` and a `PreCompact` hook group wired — so wiring is *not* the open question. The open question is whether the hook *fires and writes*. Deliver a concrete verification procedure: trigger a real context compaction (operator action), then confirm a `source_type='pre_compact_snapshot'` row lands in Mnestra. If it does not fire, root-cause it — hook path, missing env vars (`SUPABASE_*` / `OPENAI_API_KEY`), or a hook-script error in `~/.claude/hooks/memory-pre-compact.js`. Wiring `settings.json` is classifier-blocked for you; if a change is needed, emit the exact JSON + a one-line operator instruction.

**1.2 — Root-cause the `runHookRefresh` staleness.**
The daily-driver's `memory-session-end.js` sat at May 4 through Sprints 64/65/66. Determine *why*: (a) a logic bug in `runHookRefresh` (`packages/cli/src/init-mnestra.js`) or `installPreCompactHook` (`packages/stack-installer/src/index.js`) — e.g. the signature-version comparison, or the refresh not covering both hook files; (b) the daily-driver's global `termdeck` being 1.4.0 vs 1.5.0 published (Class G — stale CLI); or (c) the refresh path simply was never run since May 4. Post the root cause as a FINDING with file:line evidence.

**1.3 — Fix it.**
Per the root cause: if a logic bug, fix `runHookRefresh` so it reliably refreshes **both** `memory-session-end.js` and `memory-pre-compact.js` whenever the bundled version is newer (INSTALLER-PITFALLS Class N — lockstep; Class M — confirm a write-path exists for *each* hook). If the issue is silent-success-on-no-refresh, make a should-have-refreshed-but-didn't case *visible* (Class I). If the root cause is "never run," the deliverable shifts to making the refresh-miss detectable (a `termdeck doctor` probe: "is the installed hook older than the bundled one?") + documenting the upgrade path.

**1.4 — Tests.**
`node --test` coverage that drives `runHookRefresh` from a **stale prior-version starting state** (a pre-Sprint-64 hook on disk) and asserts both hooks end up current. INSTALLER-PITFALLS checklist item #13 — the e2e must not start from the developer's already-current state.

## Files you'll touch

- `packages/cli/src/init-mnestra.js` — `runHookRefresh`
- `packages/stack-installer/src/index.js` — `installPreCompactHook` / `installSessionEndHook` if the bug is there
- a test file under `packages/cli/` or the repo `tests/` glob (confirm it is inside `npm test`)

## Not your lane

CI/GitHub hygiene (T2). Doc rewrites (T3). No version bumps, no CHANGELOG, no commits.

## Lane discipline

Post `### [T1] <VERB> 2026-MM-DD HH:MM ET — <gist>`. Post the 1.2 root cause as a FINDING early — it shapes 1.3. Flag operator-dependent steps (the compaction trigger, any `settings.json` change) explicitly so the orchestrator can pause for Joshua.
