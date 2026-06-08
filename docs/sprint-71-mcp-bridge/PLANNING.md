# Sprint 71 — The MCP Bridge (Workstream A)

**Created:** 2026-06-08 ~11:30 ET
**Pattern:** 3+1+1 (orchestrator + T1/T2/T3 workers + T4 Codex auditor)
**Home:** TermDeck (`packages/mcp-bridge/`) — decided 2026-06-08. The code lives in TermDeck; "The Harness" remains the strategy/brand layer.
**Parent plan:** `~/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/docs/PLAN-2026-06-08-mcp-bridge-and-interactive-chat-panels.md`

---

## Objective

Ship the **INBOUND** integration: a self-hosted remote **MCP server** ("the Bridge") that the consumer LLM chats connect to *via each provider's own sanctioned connector feature*, so they can **pull Mnestra memory** and **see live TermDeck terminal state** — with **zero scraping, zero browser automation, ToS-clean**.

This is the safe, high-leverage half of the chat integration. (The OUTBOUND half — driving a Grok chat panel — is Sprint 72 / Workstream B; not in this scope.)

### Why this is now buildable (June 2026)
Claude.ai (Custom Connectors), ChatGPT (Developer Mode), and Grok (Bring-Your-Own-MCP, shipped May 6 2026) all accept a **self-hosted remote MCP server** with **no verification gate**, over **Streamable HTTP + OAuth 2.1/PKCE**, behind a **public HTTPS endpoint**. Gemini's consumer app is the lone holdout (its MCP is CLI/Enterprise-only) — out of scope, no consumer connector exists.

---

## The one invariant that governs everything

When a connected chat calls a Bridge tool, the **tool RESULT flows back through that provider's cloud** (Anthropic / OpenAI / xAI). So the threat model is **inverted**: not "don't ingest bad input" but **"don't EGRESS secrets."** Every tool result is scrubbed by `src/redact.js` before it leaves the process. This is the load-bearing security property; T2 owns it and T4 adversarially audits it.

---

## Scope → lane map

| Phase | Deliverable | Lane |
|---|---|---|
| A0 | Package skeleton + egress-redaction keystone + tests | ✅ **orchestrator (landed pre-sprint)** |
| A1 | Streamable-HTTP MCP server, OAuth 2.1/PKCE, tunnels, connect Claude.ai | **T1** |
| A2 | Egress redaction hardening + read-only policy + approval gate + allowlist + leak-gate | **T2** |
| A3 | Read-only tools (Mnestra + TermDeck-state) + data-source clients | **T3** |
| A4 | Connect ChatGPT (Developer Mode) + Grok (BYO-MCP); per-provider docs | **T3** |
| A5 | Adversarial audit across all lanes (egress, read-only, auth, injection) | **T4 (Codex)** |

### Lane disjointness (own these, don't cross)
- **T1 — Transport / Auth / Tunnel.** Owns `src/server.js`, `src/auth.js`, tunnel config + `docs/tunnel.md`. Mounts T3's tools onto the SDK server; does not author tool logic.
- **T2 — Egress security / Policy.** Owns `src/redact.js` (extend the A0 keystone), `src/policy.js`, `test/redact.test.js`, `test/leak-gate.test.js`. Provides `withEgressRedaction` + policy guards as contracts T1/T3 consume.
- **T3 — Tools / Clients / Connect-docs.** Owns `src/tools/*.js`, `src/clients/*.js`, `docs/connect-*.md`. Every tool handler is registered through T2's `withEgressRedaction`; reads only.
- **T4 — Codex auditor.** Owns nothing in `src/`; reproduces and audits. Posts `[T4-CODEX]` findings + CHECKPOINTs.

---

## Contracts (so lanes don't block each other)

- `redact.redactDeep(value)` and `server.withEgressRedaction(handler)` already exist (A0). T2 hardens the rules; signatures are frozen.
- `policy.assertReadOnly(toolDef)` → throws if a tool declares a write/delete/exec capability. T1 calls it at registration time. **(T2 provides.)**
- `policy.requiresApproval(toolName)` → boolean; T1 marks the tool's MCP annotation accordingly. **(T2 provides.)**
- `policy.visiblePanels(allSessions)` → filtered list honoring the project/panel allowlist. T3's `list_panels`/`read_panel` call it. **(T2 provides.)**
- `clients.termdeck` wraps `GET /api/sessions`, `GET /api/sessions/:id/buffer` (read-only). **(T3 provides.)**
- `clients.mnestra` wraps `memory_recall` / `memory_search` read paths. **(T3 provides.)**

---

## Cross-cutting guardrails (release blocks if violated)

1. **Read-only manifest.** No tool may write, delete, or exec. `policy.assertReadOnly` enforced at registration; T4 verifies no bypass.
2. **Egress redaction on 100% of tool output.** Leak-gate test must pass: planted secrets in sample tool output are absent post-redact.
3. **No org literals (the internal Supabase project name, project ref, or Brad's personal project name) in any file OR any tool output.** They live ONLY in the external denylist (`~/.termdeck/bridge-redact.json` / `TERMDECK_BRIDGE_REDACT_LITERALS`), never in the repo. Gitleaks pre-commit enforces the repo half. (This guardrail itself must not name the literals — reference them, never spell them.)
4. **Never regress `packages/server/src/agent-adapters/grok-models.js`.** It deliberately retains the family-A Grok **reasoning** models per Joshua's directive; this sprint does not touch Grok routing, but no lane may "simplify" that module.
5. **Public-endpoint hygiene.** OAuth 2.1 + PKCE, rate limits, audience-bound tokens. Prefer Anthropic MCP Tunnels (Claude) + cloudflared (ChatGPT/Grok) over a raw open port. No localhost-exposed-to-internet shortcuts.
6. **No version bumps, no CHANGELOG, no commits inside a lane.** Orchestrator handles close-out per `docs/RELEASE.md`.

---

## Forward context (not this sprint, don't lose it)

- **Sprint 72 / Workstream B** = the interactive Grok web-chat panel (OUTBOUND). grok.com web chat is the **flat-rate (subscription) path to Grok's reasoning model** — the capability Grok Build CLI lacks. The `grok-models.js` switch (family A reasoning vs family B Grok Build) must stay intact for that.
- **Gemini CLI → Antigravity `agy` migration** is time-boxed (subscription serving stops **June 18 2026**) — tracked in Sprint 70, adjacent.
- **Decisions locked (2026-06-08):** build into TermDeck; tunnels = MCP Tunnels (Claude) + cloudflared (rest); Grok = custom MCP + Grok Build, reasoning switch preserved; ChatGPT = connector + Codex only (Codex + the Bridge ≈ ChatGPT-with-our-context, so no ChatGPT outbound panel).

---

## Acceptance (FINAL-VERDICT GREEN requires all)

- [ ] Bridge server runs, exposes read-only tools over Streamable HTTP behind OAuth 2.1/PKCE + a tunnel.
- [ ] **Claude.ai** connects and can `memory_recall` + `list_panels` (approval-gated), results visibly redacted.
- [ ] **ChatGPT** (Developer Mode) and **Grok** (BYO-MCP) connect; per-provider connect docs exist.
- [ ] Leak-gate + redaction suites green; T4 finds no egress leak, no write path, no auth bypass.
- [ ] `npm test` at repo root still green (no regression to existing TermDeck tests).
