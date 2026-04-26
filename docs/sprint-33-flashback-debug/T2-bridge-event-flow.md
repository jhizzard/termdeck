# T2 — Bridge event flow

You are Terminal 2 in Sprint 33 / Flashback debug. Your lane: between `onErrorDetected` firing and Mnestra getting queried, plus the WebSocket emit back to the client. If the analyzer fires but no query happens, OR the query response isn't getting to the client, your lane is the suspect.

## Read first
1. `docs/sprint-33-flashback-debug/PLANNING.md` — pipeline diagram
2. `docs/sprint-33-flashback-debug/STATUS.md` — protocol
3. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. `packages/server/src/rag.js` — RAGIntegration class. Look at the constructor, where it's instantiated, and how it subscribes to session error events.
5. `packages/server/src/mnestra-bridge/index.js` — the bridge with three modes (direct / webhook / MCP). How is mode selected? Does each mode actually fire a query when called?
6. `packages/server/src/index.js` — find where `proactive_memory` WS frames are emitted. Search for `proactive_memory` literal.

## You own
- `packages/server/src/rag.js`
- `packages/server/src/mnestra-bridge/` (index.js + any submodules)
- `packages/server/src/index.js` — but ONLY the `proactive_memory` emit block. No other edits.
- `tests/failure-injection.test.js`

## You do NOT touch
- T1/T3/T4 files (session.js, anything in ~/Documents/Graciella/engram/, tests/flashback-e2e.test.js)

## Audit checklist (post each as a FINDING)

1. **Is `RAGIntegration` (or whatever rag.js's class is named) instantiated when RAG is enabled?** Trace from `index.js` server boot → does it new up rag.js? Check what gets registered as the `onErrorDetected` callback on each session — that's the wire from T1's lane to yours.
2. **When `handleSessionError(session, errCtx)` (or equivalent) fires, what happens?** Does it call `mnestra-bridge.query(...)`? Does it await the response? Does it emit anything back to the client? Trace each step.
3. **Which mnestra mode is config'd in `~/.termdeck/config.yaml`?** Check `rag.mnestraMode` — likely `direct` or `webhook`. For each mode, verify the corresponding code path actually attempts a network call. If `direct` mode never opens a connection, that's broken.
4. **Direct mode**: instantiates a Postgres client and queries `memory_hybrid_search()` (or whichever RPC). Are the parameters correct? (Sprint 21's bug was sending 9 args to an 8-arg function.)
5. **Webhook mode**: POSTs to `MNESTRA_WEBHOOK_URL/mnestra` with `{ op: 'recall', ...args }`. Is the URL correctly resolved from secrets.env? Does the POST succeed? Body shape correct?
6. **MCP mode**: spawns `mcp-server-mnestra` as a child and JSON-RPCs over stdio. If config says MCP but the binary isn't on PATH, this silently fails.
7. **proactive_memory WS frame**: when mnestra returns a match above threshold, where does `index.js` emit `{ type: 'proactive_memory', ... }` to the panel's WebSocket? Find the line. Is the threshold check inside server-side or client-side? If server-side and threshold is e.g. 0.7 but Mnestra's actual top-similarity for Josh's errors is 0.55, no toast ever fires.
8. **Live probe**: with the existing four-panel TermDeck running, intentionally trigger an error in a panel that should have a similar memory in Josh's store (e.g. `psql 'postgres://bad@...' -c 'select 1'` if there's a past Postgres-connect failure memory). Run `tail -f` on whatever logs the bridge emits, or add console.log temporarily to count calls.
9. **Run `tests/failure-injection.test.js`** — what does it cover? Does it exercise the full bridge path?

## Decision criteria

- **CONFIRMED-OK**: rag.js wired to sessions; mode is consistent with config; bridge actually fires; threshold reasonable; WS emit lands.
- **BROKEN-AT bridge wiring**: rag.js exists but isn't registered as session.onErrorDetected. The console.log T1 saw was real.
- **BROKEN-AT bridge query**: query fires but Mnestra returns 0 rows for known-similar errors → could be Mnestra side (T3's lane) OR a wrong-arg / wrong-RPC call here.
- **BROKEN-AT WS emit**: query returns matches but the WS frame never goes out, OR the threshold is too aggressive for current corpus similarity scores.

## Output

- `FINDING` line per category above with evidence.
- `FIX-PROPOSED` if surgical fix found.
- `DONE` when done.
- No version bumps, no CHANGELOG, no commits.

## Reference memories
- `memory_recall("rag.js mnestra bridge direct webhook MCP modes")`
- `memory_recall("queryDirect 8-argument function recency_weight decay_days")` — Sprint 21 root cause
- `memory_recall("proactive_memory websocket flashback toast")`
- `memory_recall("RAG outbox data-loss synced flag")` — Sprint 6 audit fix
