# T2 — Server Seams + `web-chat-grok` Adapter

You are **T2** in Sprint 72. You wire a non-PTY `web-chat` session type into TermDeck's existing session/adapter/capture machinery, reusing the inject/read/capture paths the CLI panels already use.

## Boot
1. `memory_recall(project="termdeck", query="TermDeck web-chat session type adapter seams index.js spawnTerminalSession onPanelClose")`
2. `memory_recall(query="TermDeck adapter contract statusFor resolveTranscriptPath capture")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-72-grok-panel/PLANNING.md` (esp. "The 8 TermDeck seams") + `STATUS.md`
5. Read `docs/sprint-72-grok-panel/T2-server-seams-grok-adapter.md` (this)
6. Read the real code you extend: `packages/server/src/session.js`, `packages/server/src/index.js` (spawn/data/input/exit/onPanelClose/onPanelPeriodicCapture), `packages/server/src/agent-adapters/claude.js` (the adapter contract), `packages/server/src/agent-adapters/index.js`.

## Lane scope (own these)
- `packages/server/src/index.js` — add the `web-chat` branches at the 8 seams (PLANNING). The **`if (session.pty)` guards must not change existing PTY behavior** — additive only.
- `packages/server/src/agent-adapters/web-chat-grok.js` (new) — implement the adapter contract: `name`, `sessionType:'web-chat'`, `matches`, `statusFor` (from T3's completion detector), `resolveTranscriptPath` (return the conversation file so memory capture works), `costBand:'subscription'`, `sourceAgent:'grok-web'`. Register in `agent-adapters/index.js`.

## Tasks
1. `type:'web-chat'`, `pty:null` session creation; spawn branch boots T1's driver instead of node-pty.
2. Inbound: on a completed Grok response, run `analyzeOutput` + `transcriptWriter.append` + broadcast `{type:'output',data}` (reuse the existing WS frame).
3. Input: route `POST /api/sessions/:id/input` + WS `case 'input'` to the driver's inject (T3's `grok.inject`), **not** `pty.write`. The existing inject API + 4+1 two-stage submit must work unchanged from the orchestrator's view.
4. Status + memory capture via the adapter (`statusFor`, `resolveTranscriptPath`) so `onPanelClose`/`onPanelPeriodicCapture` capture to Mnestra exactly like CLI panels.

## Consume (don't author)
`driver.cdp.*` (T1), `driver.grok.inject` / `driver.grok.onComplete` (T3).

## Do NOT
Touch the client (`app.js` — T3), the driver internals (T1/T3), or `grok-models.js`. Break any existing PTY-panel path. Bump versions / CHANGELOG / commit.

## Post shape
`### [T2] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
A `web-chat` session creates, accepts injected text via `/input`, broadcasts driver output, reports status, and captures to Mnestra — with **existing PTY panels + root `npm test` unaffected** (T4 verifies no regression).
