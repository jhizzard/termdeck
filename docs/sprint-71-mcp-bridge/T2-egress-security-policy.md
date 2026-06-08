# T2 — Egress Security & Policy (the keystone lane)

You are **T2** in Sprint 71 (MCP Bridge). You own the load-bearing security property: **nothing secret egresses, nothing can mutate, nothing un-allowlisted is visible.** Tool results transit the provider's cloud — assume every connected chat is hostile (prompt-injected).

## Boot
1. `memory_recall(project="termdeck", query="MCP Bridge egress redaction read-only policy allowlist")`
2. `memory_recall(query="MCP-connector egress security inverted threat model gitleaks redaction")`
3. Read `~/.claude/CLAUDE.md` (esp. the gitleaks + no-internal-project-name + Supabase-hygiene sections) and `./CLAUDE.md`
4. Read `docs/sprint-71-mcp-bridge/PLANNING.md` + `STATUS.md`
5. Read `packages/mcp-bridge/src/redact.js` + `test/redact.test.js` (the A0 keystone — **8/8 green**; you harden it)

## Lane scope (own these)
- `packages/mcp-bridge/src/redact.js` — extend the A0 ruleset. Add/triage: high-entropy base64/hex secrets (conservative — false positives mangle benign output), connection strings (`postgres://…`, `redis://…`), email/PII policy (decide + document), and ensure the external denylist covers the bare-string project-ref case. Keep it dependency-free.
- `packages/mcp-bridge/src/policy.js` — provide the contracts T1/T3 consume:
  - `assertReadOnly(toolDef)` — throw if a tool declares write/delete/exec (belt-and-suspenders even though no write tools exist).
  - `requiresApproval(toolName)` — true for terminal-state tools (`read_panel`, `recent_activity`), false for memory reads.
  - `visiblePanels(allSessions)` — filter to the project/panel allowlist (default-deny; allowlist from `~/.termdeck/bridge-allowlist.json` / env).
- `packages/mcp-bridge/test/redact.test.js` + `test/leak-gate.test.js` — the leak-gate runs *sample tool output for every registered tool* through `scan()` and FAILS if any secret survives. This is a release gate.

## Tasks
1. Harden redaction; document what each rule catches and the false-positive posture.
2. Implement `policy.js` per the contracts above.
3. Author the **leak-gate**: enumerate registered tools (coordinate with T3 on sample fixtures), assert `scan(redact(sampleOutput)).clean` for each. Wire it so root `npm test` (or the package test script) runs it.
4. Verify the external denylist path scrubs org literals end-to-end **without** any such literal appearing in the repo (use a fixture literal in tests, like the A0 `ACME-INTERNAL-XYZ`).

## Do NOT
- Build the server/transport (T1) or the tools/clients (T3). Hardcode any org literal (the internal Supabase project name / ref / Brad's project name) anywhere — those are external-denylist values, and gitleaks will (correctly) block them. Touch `grok-models.js`. Bump versions / CHANGELOG / commit.

## Post shape
`### [T2] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
Redaction hardened + documented; `policy.js` contracts implemented; **leak-gate green across all T3 tools**; no org literal in-repo.
