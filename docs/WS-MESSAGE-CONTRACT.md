# WebSocket Message Contract

This document is the source-of-truth for every WebSocket message type the TermDeck server emits and every handler the client implements. The contract is enforced by `tests/ws-handler-contract.test.js` (Sprint 40 T1).

**Why this exists:** Sprint 39's 9-day Flashback regression was caused by `packages/client/public/app.js` having no `case 'proactive_memory':` branch in either of its two `ws.onmessage` switches. Server-side WS push worked correctly; every emitted frame went into the void. Sprint 40 ships the contract test that prevents this class of bug; this doc is its human-readable companion.

## Connection topology

TermDeck has one WebSocket server (`wss` on the same port as HTTP, default 3000). Clients connect with `?session=<session-id>` to receive that session's frames. The server-side `wss.on('connection', ...)` handler at `packages/server/src/index.js:1665` wires per-connection handlers.

The browser client opens TWO `ws.onmessage` handlers per session:
1. **Main panel WS** (`packages/client/public/app.js:230`) — opened on session-create, lives for the panel's lifetime.
2. **Reconnect WS** (`packages/client/public/app.js:1245`) — opened by `reconnectSession(id)` if the main WS drops. Must have feature parity with the main panel WS or messages received during the reconnect window are silently dropped.

Some message types are addressed to a single session's WS (`session.ws.send(...)`); others are broadcast to all connected clients via `wss.clients.forEach(client => client.send(payload))`.

## Message types (alphabetized)

### `config_changed`
- **Emitted at:** `packages/server/src/index.js:1252` (`PATCH /api/config` handler)
- **Recipients:** broadcast to all `wss.clients` via `wss.clients.forEach`
- **Frame shape:** `{ type: 'config_changed', config: <full-config-payload> }`
- **Client handler:** Both switches. Update `state.config`, re-render settings panel, refresh RAG indicator.
- **Idempotent:** yes. Multiple receipts settle the same state.
- **Sprint origin:** Sprint 36 T3 Deliverable A.
- **Sprint 40 fix:** reconnect WS was missing this case (silent drop on reconnected sessions). Added.

### `exit`
- **Emitted at:** `packages/server/src/index.js:818-819`
- **Recipients:** the session's `session.ws` only.
- **Frame shape:** `{ type: 'exit', exitCode: <number> }`
- **Client handler:** Both switches. Update panel meta to `status: 'exited'`, dim the panel.
- **Sprint origin:** project genesis.

### `meta`
- **Emitted at:** `packages/server/src/index.js:1693` (initial connect ack), `index.js:1719` (client-requested meta refresh on `case 'meta':` in the inbound switch).
- **Recipients:** the session's `session.ws` only.
- **Frame shape:** `{ type: 'meta', session: <full-session-toJSON> }`
- **Client handler:** Both switches. `updatePanelMeta(id, msg.session.meta)`.
- **Sprint origin:** project genesis.

### `output`
- **Emitted at:** `packages/server/src/index.js:799` (every PTY data event)
- **Recipients:** the session's `session.ws` only.
- **Frame shape:** `{ type: 'output', data: <string> }`
- **Client handler:** Both switches. `terminal.write(msg.data)` to the xterm.js instance.
- **Sprint origin:** project genesis. Highest-volume frame type.

### `proactive_memory`
- **Emitted at:** `packages/server/src/index.js:885` (Flashback `onErrorDetected` handler, after a successful Mnestra hit)
- **Recipients:** the session's `session.ws` only.
- **Frame shape:** `{ type: 'proactive_memory', hit: { content, source_type, project, similarity, created_at } }`
- **Note: the `hit` field is a SINGLE memory object, not an array.** Sprint 33's e2e test asserted on `.memories[]` (an array shape that never matched the production single-hit emit) — corrected by Sprint 39 close.
- **Client handler:** Both switches. `showProactiveToast(id, msg.hit)`.
- **Sprint origin:** Sprint 6 (Flashback feature).
- **Sprint 39 history:** silent for ~9 days because both client switches lacked the `case 'proactive_memory':` branch. The 3-line orchestrator-applied fix at sprint close restored the toast.

### `status_broadcast`
- **Emitted at:** `packages/server/src/index.js:1746` (periodic `setInterval(..., 2000)`)
- **Recipients:** broadcast to all `wss.clients`.
- **Frame shape:** `{ type: 'status_broadcast', sessions: [<session-meta>, ...] }`
- **Client handler:** Both switches. `updateGlobalStats(msg.sessions)` → triggers per-panel `updatePanelMeta` updates.
- **Sprint origin:** Sprint 18 (audit-debt close).

## Adding a new message type — checklist

Whenever you add a new WS emit on the server, you MUST update at least three places. The contract test enforces (1) and (2); (3) is a courtesy to future readers.

1. **Add the case to both `ws.onmessage` switches in `packages/client/public/app.js`** (main panel + reconnect). Even if the reconnect path doesn't strictly need to react, the parity test at `tests/ws-handler-contract.test.js` will fail if the case sets diverge.
2. **If the new type is emitted on a single session's WS** (`session.ws.send(...)`), make sure the emit site happens AFTER the WS is attached. The Flashback bug stayed silent in part because some emits ran before `setBridge` wiring; instrumentation in T1's diag (`/api/flashback/diag`) catches this class.
3. **Document the type in this file** — emit site (file:line), recipients, frame shape, client handler responsibility, sprint origin.

If a new type SHOULD NOT be handled by a particular switch (e.g. main panel WS gets per-session `output` but reconnect WS deliberately ignores high-volume output and replays from server-side history), record the omission in the `ALLOWED_OMISSIONS` map at the top of `tests/ws-handler-contract.test.js`. Better than a silent `case` gap.

## Common shapes the contract test does NOT cover

- The contract test verifies that handlers EXIST. It does not verify they DO THE RIGHT THING. A handler that just calls `console.log(msg)` and discards the payload would pass the contract test but break the user-facing feature. Per-handler unit tests are still required.
- The contract test scans `JSON.stringify({ type: '<X>', ...})` patterns in server JS source. It does not catch types emitted via dynamic strings (`JSON.stringify({ type: someVar })`) or constructed via spread (`JSON.stringify({ ...frame })`). All current emits use the literal `type: 'X'` form, but a future refactor that introduces a registry-driven emit shape would need a parallel update to the scanner.
- The contract test does not verify the FRAME SHAPE. The `proactive_memory` frame's `hit` (single) vs `hit.memories[]` (array) shape mismatch was Sprint 33's silent failure — the contract test would still have caught the missing handler, but not the shape drift inside it. Per-route schema tests are the right tool for shape verification.
