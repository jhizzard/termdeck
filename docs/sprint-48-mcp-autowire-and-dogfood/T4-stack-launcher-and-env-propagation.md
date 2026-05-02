# Sprint 48 — T4: Global stack launcher (`termdeck-stack start|stop|status`) + PTY env-var propagation

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Two related deliverables that together make the stack usable for outside users (not just Joshua running from a cloned repo):

1. **Global launcher.** Today the canonical full-stack boot is `./scripts/start.sh` from the termdeck repo root. Outside users (Brad et al.) install via `npm i -g @jhizzard/termdeck-stack` and then... have nothing — the stack-installer is a one-shot setup wizard, not a persistent launcher. T4 adds `termdeck-stack start|stop|status` subcommands to the global package, porting the bash logic into JS.
2. **PTY env-var propagation.** Discovered Sprint 47 close-out: 0 `session_summary` rows have ever landed in Mnestra because `memory-session-end.js` hits `env-var-missing` on `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` every time. TermDeck server spawns Claude Code panels via `spawnTerminalSession` (`packages/server/src/index.js` ~767-820) but doesn't merge `~/.termdeck/secrets.env` into the PTY env. Two-line server-side fix unlocks the file-based Stop hook.

T4 is independent of T1/T2/T3 — different package (`@jhizzard/termdeck-stack`) and different file (`packages/server/src/index.js`). No coordination needed; ship both deliverables.

## Files

### Deliverable 1: global launcher

- NEW `packages/stack-installer/src/launcher.js` (~150 LOC). The TS-free JS port of `scripts/start.sh`. Exports `startStack(opts)`, `stopStack()`, `statusStack()`.
- EDIT `packages/stack-installer/src/index.js` — add subcommand dispatch at the top: if `argv[2]` is `start|stop|status`, route to `launcher.js`; otherwise the existing wizard runs (preserves backwards compat with `npx @jhizzard/termdeck-stack`).
- EDIT `packages/stack-installer/package.json` — `bin` already points at `./src/index.js`. Add `bin.termdeck-stack-start` for direct shorthand if useful; not strictly required since the subcommand form covers it.
- NEW `packages/stack-installer/tests/launcher.test.js` (~80 LOC, ~6 tests) — unit-test `startStack` against a mocked `child_process.spawn`. Don't actually start a real server in tests; the dependency on a real Mnestra HTTP port + Rumen + Supabase makes integration testing flaky in CI.
- EDIT `docs/GETTING-STARTED.md` — replace `cd termdeck && ./scripts/start.sh` with `npx @jhizzard/termdeck-stack start` (or `termdeck-stack start` if globally installed) as the canonical command.

### Deliverable 2: PTY env-var propagation

- EDIT `packages/server/src/index.js` — in `spawnTerminalSession()` (lines ~767-820 per the PLANNING sketch; verify line numbers in current source), merge `~/.termdeck/secrets.env` into the spawned PTY's env. Pattern: read with the same dotenv-subset parser used in `mcp-autowire.js` / `stack-installer/src/index.js`, then `env: { ...process.env, ...termdeckSecrets, ...sessionSpecificEnv }`.
- NEW `tests/pty-env-propagation.test.js` (~60 LOC, ~4 tests) — spawn a session that runs `node -e 'console.log(process.env.SUPABASE_URL)'` and assert the env var is visible to the PTY child.
- DOCUMENT in `packages/stack-installer/assets/hooks/README.md` — note that the env vars are now delivered via PTY-spawn merge AND via the optional `~/.zshrc` source line.

### (Optional, time-permitting): `~/.zshrc` source-line offer

- EDIT `packages/stack-installer/src/index.js` wizard step — after writing `~/.termdeck/secrets.env`, offer to add `set -a; source ~/.termdeck/secrets.env; set +a` to `~/.zshrc` so standalone (non-TermDeck) Claude Code launches inherit the secrets.
- This is OPTIONAL for T4. Skip if Deliverable 1 + 2 fill the lane.

## `startStack` API

```js
// packages/stack-installer/src/launcher.js
async function startStack({ port = 3000, mnestraPort = 37778, verbose = false } = {}) {
  // 1. Verify ~/.termdeck/secrets.env has SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
  //    If missing → suggest running `npx @jhizzard/termdeck-stack` (the wizard).
  // 2. Verify mnestra binary is on PATH (`mnestra --version` should succeed).
  //    If missing → suggest `npm i -g @jhizzard/mnestra@latest`.
  // 3. Verify rumen binary is on PATH (skip if user opted out at install).
  // 4. Spawn mnestra serve (HTTP webhook) on $mnestraPort. Health-check :37778/health.
  // 5. Spawn rumen tick scheduler. Health-check via `rumen status`.
  // 6. Spawn termdeck server on $port. Health-check via http://127.0.0.1:$port/api/health.
  // 7. Print numbered step summary (matches the existing scripts/start.sh output style).
  // 8. Return { mnestraPid, rumenPid, termdeckPid, port }.
}
```

## Acceptance criteria

1. `npx @jhizzard/termdeck-stack start` boots the full stack from a fresh shell with no repo clone required. Visible at `http://127.0.0.1:3000`.
2. `npx @jhizzard/termdeck-stack stop` cleanly terminates all three processes (records pid file at `~/.termdeck/stack.pid`).
3. `npx @jhizzard/termdeck-stack status` prints health of all three components.
4. Subcommand dispatch is backwards-compat: `npx @jhizzard/termdeck-stack` (no args) still runs the wizard.
5. PTY env propagation: a Claude Code panel spawned via TermDeck has `SUPABASE_URL` visible to its child processes (test asserts via `tests/pty-env-propagation.test.js`).
6. `memory-session-end.js` hook landing rate moves from 0% to >0% after this lane closes (requires running a real Claude Code session post-merge to verify; document the verification in your DONE post).
7. `docs/GETTING-STARTED.md` reflects the new global command as the canonical onboarding step.
8. No regressions to existing tests.

## Coordination

- T4 is INDEPENDENT of T1/T2/T3 — different package, different files, different concerns. Ship in parallel without blocking or being blocked.
- The launcher does NOT auto-wire MCP configs — that's T1/T2/T3's job. T4's launcher just boots the three processes; users still need `claude mcp add mnestra ...` (which the wizard already does for Claude) or wait for T1/T2/T3 to finish for the other agents.
- If T1/T2/T3 finish before you, consider whether `startStack()` should also call `ensureMnestraBlock(adapter)` for each known agent's config. That feels right but is scope creep — add to your DONE post as a Sprint 49 follow-up rather than expanding T4 mid-flight.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 48 global stack launcher start.sh termdeck-stack start stop status PTY env propagation memory-session-end")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (you might need to bump termdeck-stack to 0.5.0 — orchestrator decides at close, but read the protocol so your changes don't conflict with it)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/scripts/start.sh (the bash original you're porting)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/index.js (search for `spawnTerminalSession` — the env-merge target)
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/src/index.js (the existing wizard you're extending with subcommand dispatch)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
