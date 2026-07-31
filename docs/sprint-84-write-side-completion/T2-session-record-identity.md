# T2 — `memory_session_record` tool + ChatGPT/Grok identity-map extension

**You are T2 in Sprint 84 (Write-Side Completion).** Your lane is arc steps 4.4 + 4.8: give web-surface conversations an end-of-session capture path, and open the proposal channel to ChatGPT and Grok.

## Scope

1. **`memory_session_record` bridge tool** (new file under `packages/mcp-bridge/src/tools/`): lets a connected web surface (claude.ai today; ChatGPT/Grok once your identity maps land) record an end-of-conversation session summary that lands in `memory_sessions` in the shape the Rumen tick already sweeps (ground-truth the canonical `memory_sessions` schema — Sprint 51.6 reconciled it; match the rich shape, don't invent a new one). The tool is the WEB equivalent of the panel-close capture path.
   - Auth/identity: source_agent comes from the connector identity map, fail-closed — same posture as `memory_propose` (Sprint 76). No identity → no write.
   - Input contract: summary text (required), optional project, optional structured facts array. Cap sizes defensively; reject empty.
   - Registration: `src/tools/index.js` + bridge tool count. Note `/healthz` `tools` count will change — assert the new count in tests, and flag in STATUS that the operator-visible healthz number moves (7→8) so nobody reads it as drift.
2. **Identity-map extension to ChatGPT + Grok** (`packages/mcp-bridge/src/policy.js::loadProposeMap/mapClientToSourceAgent`): extend the Sprint-76 fail-closed map so ChatGPT-connector and Grok-connector OAuth clients map to `chatgpt-web` / `grok-web` (canonical enum values — they already exist in mnestra's source_agents vocabulary; do NOT mint new ones). Read `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` Part B for how the claude.ai identity was written; produce the equivalent operator block for the other two (config lines Josh pastes, not code he edits).
3. **Propose-channel parity:** whatever gating (`TERMDECK_BRIDGE_ENABLE_PROPOSE`-style) applies to `memory_propose` applies identically to `memory_session_record`. If you add a new env gate, default OFF and document it.

## Boot sequence

1. `memory_recall(project="termdeck", query="bridge propose identity map fail-closed Sprint 76 memory_sessions schema")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-84-write-side-completion/PLANNING.md` then `STATUS.md`
4. Read `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md`. Then this brief. Ground-truth `policy.js`, `server.js:416` area, `tools/propose.js`, `tools/index.js` before writing.

## Acceptance bar

- Tests: identity-map fail-closed for unknown client (no write, explicit error), correct source_agent for each of the three mapped connectors, session-record row lands in canonical `memory_sessions` shape, size caps enforced, gate-OFF path inert, healthz tool count asserted.
- One live-shaped proof: boot the bridge in test harness, call the tool as a mapped client, SELECT the row back, assert the Rumen tick's picker query WOULD select it (replicate the picker's WHERE clause verbatim — the S83 T2 pattern: prove against the consumer's own query, not your assumption of it).
- No `memory_inbox` schema changes from this lane; if you need one, SCHEMA-READY first (PLANNING contract 1).

## Lane discipline

You own `policy.js` this sprint; T1 does not touch it. Stay out of T1's harvester and T3's cron/sweep surface. Post `### [T2] VERB 2026-MM-DD HH:MM ET — <gist>` for FINDING / FIX-PROPOSED / FIX-LANDED / SCHEMA-READY / BLOCKED / DONE. No version bumps, no CHANGELOG, no commits.
