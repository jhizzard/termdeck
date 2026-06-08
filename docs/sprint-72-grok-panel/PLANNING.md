# Sprint 72 — Interactive Grok Web-Chat Panel (Workstream B)

**Created:** 2026-06-08 ~12:35 ET
**Pattern:** 3+1+1 (orchestrator + T1/T2/T3 + T4 Codex auditor)
**Deck:** port **3001** (runs in parallel with Sprint 71 on port 3000)
**Home:** TermDeck — new `packages/web-chat-driver/` + a `web-chat-grok` adapter + a client canvas panel
**Parent plan:** `~/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/docs/PLAN-2026-06-08-mcp-bridge-and-interactive-chat-panels.md`

---

## Objective

Ship the **OUTBOUND** integration: a TermDeck **`web-chat` panel** that shows a *real, logged-in* grok.com session the human can use directly, AND that the orchestrator can inject a prompt into / read the response from — "use Grok like a terminal." This is the **flat-rate (subscription) path to Grok's reasoning model**, which Grok Build CLI lacks (it rejects `reasoningEffort` → HTTP 400; see `packages/server/src/agent-adapters/grok-models.js`).

## Posture — read before any code (non-negotiable)

This is interactive co-pilot automation, **not** scraping. Every design choice keeps us inside the "normal paying subscriber" envelope:

- **Grok ONLY.** grok.com is the one provider whose consumer ToS has no anti-automation clause (🟢). **Do NOT** build automation for claude.ai or gemini.google.com (🔴 — paying-subscriber bans; Google cascades to Gmail/Workspace) or chatgpt.com (use Codex + the Sprint-71 connector instead).
- **Real headful Chrome, human present, low volume.** Sidecar Chrome with a **dedicated `--user-data-dir`** (Chrome 136+ blocks CDP on the default profile) where the human is logged into Grok. **Never headless, never stealth-patching, never the default profile, never bulk/autonomous scraping.**
- **✅ Browser launch APPROVED (Joshua, 2026-06-08).** Real Chrome in Playwright is OK this session; the prior colliding ClaimGuard Chrome was `kill -9`'d to free the resource. **Bring up against the local fixture first (good practice), then proceed to live grok.com validation.** The posture above still applies in full.

## Scope → lane map

| Phase | Deliverable | Lane |
|---|---|---|
| B0 | CDP harness: `connectOverCDP` + screencast→canvas + input forwarding + dedicated-profile mgmt (fixture-then-live) | **T1** |
| B1 | TermDeck `web-chat` session type — the 8 integration seams + `web-chat-grok` adapter | **T2** |
| B2 | Layered completion detection + selector resilience + client canvas panel render | **T3** |
| B3 | Adversarial audit — ToS posture, CDP security, no-regression | **T4 (Codex)** |

### Lane disjointness (own these, don't cross)
- **T1 — CDP / render bridge.** Owns `packages/web-chat-driver/src/cdp/*` (transport, screencast, input forwarding, profile launch). Does NOT touch the TermDeck server/client or Grok-specific selectors.
- **T2 — Server seams + adapter.** Owns the `web-chat` branches in `packages/server/src/index.js` (spawn/data/input/status/capture) and the new `packages/server/src/agent-adapters/web-chat-grok.js`. Server-side only — **does not touch the client.**
- **T3 — Detection + selectors + client.** Owns `packages/web-chat-driver/src/grok/*` (completion detection, per-adapter locators, inject/extract) and the client canvas panel in `packages/client/public/app.js`. **Sole owner of the client file** (single big file — collision risk).
- **T4 — Codex auditor.** Owns nothing in source; reproduces + audits. Posts `[T4-CODEX]`.

## The 8 TermDeck seams (from the Sprint-71 integration audit — T2's map)
1. Session model `session.js:138-221` → `type:'web-chat'`, `pty:null`.
2. Spawn branch `index.js:~1343` → `if(session.pty)` guard + web-chat branch (boot the driver, not node-pty).
3. Inbound data (parallel to `term.onData` `index.js:~1556`) → on Grok response: `analyzeOutput` + `transcriptWriter.append` + broadcast `{type:'output',data}`.
4. Input `index.js:~2818` WS `case 'input'` + `POST /api/sessions/:id/input` `~1912` → route injected text to the driver's "type into composer + send", **not** `pty.write()`. (The existing inject API + two-stage submit must keep working unchanged.)
5. Status → adapter `statusFor()` from the completion detector (not PTY escapes).
6. Adapter `agent-adapters/index.js:~26` → register `web-chat-grok` (contract per `claude.js:11`; `costBand:'subscription'`).
7. Memory capture `onPanelClose` `index.js:272` + `onPanelPeriodicCapture` `index.js:333` → adapter `resolveTranscriptPath` returns the conversation file → auto-captures to Mnestra like the CLI panels.
8. Client `app.js:~475` → branch `createTerminalPanel` on `type==='web-chat'` → canvas + input box instead of xterm; reuse the `{type:'output'}` dispatch + grid wrapper.

## Contracts
- `driver.cdp.attach({userDataDir, port})` → session handle (T1). `driver.cdp.screencast(onFrame)` + `driver.cdp.sendInput(evt)` (T1).
- `driver.grok.inject(handle, text)` + `driver.grok.onComplete(handle, cb)` → final response text (T3).
- `web-chat-grok` adapter consumes the driver; `index.js` seams consume the adapter (T2).

## Guardrails (release blocks if violated)
1. **Grok-only; posture preserved** (headful, dedicated profile, human-present, low-volume; never headless/scraping; never claude.ai/gemini/chatgpt).
2. **✅ Browser launch APPROVED (Joshua, 2026-06-08)** — real Chrome in Playwright OK; prior colliding ClaimGuard process killed. Fixture-first, then live grok.com. Posture still applies.
3. **Never regress `grok-models.js`** (family-A reasoning intact) or break existing PTY panels — the `if(session.pty)` guards must not change PTY behavior.
4. **Sole client-file owner is T3.** No other lane edits `packages/client/public/app.js`.
5. **No root `package.json`/lockfile churn** (Sprint 71 runs in parallel on the same repo). Keep installs inside `packages/web-chat-driver`.
6. **No version bumps / CHANGELOG / commits in-lane.** Orchestrator closes out.

## Forward context
- Pairs with **Sprint 71** (port 3000, the MCP Bridge / INBOUND). Independent files; no cross-deck overlap.
- Future: a second adapter (ChatGPT for GPT-only features) is deferred — Codex + the Bridge covers ChatGPT for now.

## Acceptance (FINAL-VERDICT GREEN)
- [ ] CDP harness round-trips against a local fixture, then live grok.com: screencast renders, human input forwards, programmatic inject + completion-detect + extract works.
- [ ] `web-chat` session type wired through all 8 seams; existing PTY panels unaffected; root `npm test` green.
- [ ] Client renders a `web-chat` panel (canvas + input) without breaking the grid.
- [ ] T4: posture compliant, CDP secure (dedicated profile, no secret/`grok-models` regression).
