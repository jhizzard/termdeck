# Handoff — Sprints 71 (MCP Bridge) + 72 (Grok Panel) — 2026-06-08

Two-deck 3+1+1 session. Live, evolving handoff so the **next sprint can harden** what shipped.

## Shipped / state
- **Sprint 72 — Grok web-chat panel — FINAL-VERDICT GREEN ✅ (verified genuine).**
  New `packages/web-chat-driver/` (CDP attach via Playwright `connectOverCDP`; screencast; input forwarding; `grok/` selectors+completion+inject), `web-chat` session type in `packages/server/src/index.js` (8 additive seams; `web-chat-grok` adapter), client canvas panel in `packages/client/public/app.js`. Posture-locked (headful, dedicated profile, localhost CDP, **Grok-only**). Root tests **473/473**. All 3 lanes AUDIT-PASS.
- **Sprint 71 — MCP Bridge — code-complete + fully audited (T1/T2/T3 AUDIT-PASS); FINAL-VERDICT held for the live Claude.ai connector round-trip.**
  New `packages/mcp-bridge/`: Streamable-HTTP MCP server + OAuth 2.1/PKCE + tunnels; read-only tools (Mnestra memory + TermDeck panel state); egress redaction + read-only policy + **default-deny** allowlist; connect docs (claude/chatgpt/grok) + `tunnel.md`.

## Pending (this session)
- **Deck A go-live = Josh's Claude.ai connector round-trip.** `cloudflared` install → tunnel → start bridge pinned to `PUBLIC_URL` → claude.ai custom connector → operator-secret consent → smoke test (`memory_recall`, `list_panels`). Then T3 posts DONE → deck-A FINAL-VERDICT → both GREEN → close-out.

## NEXT-SPRINT HARDENING BACKLOG
1. **README doc-drift (deck B, non-blocking):** `packages/web-chat-driver/README.md:64` still says `headful:false` adds `--headless=new`; code/tests reject it. Fix docs.
2. **`grok-web` provenance (deferred, S72 Blocker 3):** today `web-chat-grok` uses `sourceAgent:'grok'` (zero-touch). For accurate provenance, add `grok-web` to `ALLOWED_SOURCE_AGENTS` in the stack-installer hooks + byte-floor exemption for `web-chat`, bump the hook stamp, refresh the installed copy.
3. **Bridge ops hardening:** named cloudflared tunnel (stable hostname) vs ephemeral; Anthropic MCP Tunnels provisioning (verify current invocation); operator-secret rotation; make the redact denylist + allowlist first-class config (wizard step).
4. **Multi-provider connect:** validate ChatGPT (Developer Mode) + Grok (BYO-MCP) connect round-trips (docs exist).
5. **Grok panel live-hardening:** selector-drift maintenance (~4–8 wk cadence); completion-detector edge cases beyond timeout/quiet-only; verify long reasoning-turn behavior on the actual reasoning model.
6. **Brad open items (PR sweep):** mnestra **#15/#20** (privacy_tags — #15 awaits Josh's 4 answers; de-dup #20); termdeck **issue #12** (layout-focus + input-buffer-accumulation — *relevant to the new web-chat client input; review against it*); termdeck **#11** body has internal identifiers → scrub.
7. **Root test-glob:** wire `packages/mcp-bridge` + `packages/web-chat-driver` into root `npm test` (T3 flagged as ORCH close-out item).
8. **Monitor v2 polish:** POST regex still loose-matches a verb in prose (e.g. `DONE` inside a CHECKPOINT line) — anchor to the post-header verb position.

## Close-out (when BOTH decks GREEN)
Orchestrator-executed: kitchen-level memory harvest from both STATUS.md; version/CHANGELOG/BACKLOG; gitleaks (new packages — org literals ONLY in the external denylist, never in-repo); commit/publish/push/tag per `docs/RELEASE.md`; **Brad MD email → `bheath.tbhcoach@gmail.com`, BCC `admin@nashvillechopin.org`**; session-end self-email.
