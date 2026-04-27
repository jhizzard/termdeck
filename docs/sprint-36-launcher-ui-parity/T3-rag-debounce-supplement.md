# Sprint 36 — T3 supplemental scope: rag.js status_changed debounce

**Why this is now in T3's lane:** During Sprint 36's first inject (~17:28Z), T3's rapid tool cycling caused `packages/server/src/rag.js` to flood `[rag] write ... event=status_changed` lines to stdout — the operator zsh visible to Joshua. The server was killed at ~13:35 ET (cause still under investigation; likely either OOM, log-flood-induced kill, or a parallel lane's port-reclaim test killing the live PID). All four PTYs died as collateral. Re-injecting Sprint 36 without fixing the rag-flood means the next T3 work cycle is likely to re-trigger the same kill.

This is Deliverable D in your lane (after A=RAG toggle UI, B=dark veil, C=hard-refresh PTY loss). Order: D first (15 LOC, prevents recurrence during your other work), then A → B → C as previously sequenced.

## What to change

`packages/server/src/rag.js` — add a 1/sec/session debounce to `onStatusChanged` only. Other event types (session_created, command_executed, file_edited, session_ended) do NOT need debouncing — they're naturally rate-limited by user behavior. Status oscillation (`active ↔ thinking`) is the unique high-frequency case caused by Claude Code workers cycling tool calls.

## Suggested implementation (~15 LOC)

In `RAGIntegration` constructor, add:

```js
this._statusWriteAt = new Map(); // sessionId -> last write timestamp (ms)
this._statusDebounceMs = 1000;
```

Replace `onStatusChanged`:

```js
onStatusChanged(session, oldStatus, newStatus) {
  // Always pass through error transitions — those carry signal worth ingesting
  // every time. Debounce only the active ↔ thinking churn that floods the log
  // when a Claude Code worker cycles tool calls rapidly.
  const isError = newStatus === 'errored' || oldStatus === 'errored';
  if (!isError) {
    const now = Date.now();
    const last = this._statusWriteAt.get(session.id) || 0;
    if (now - last < this._statusDebounceMs) return;
    this._statusWriteAt.set(session.id, now);
  }
  this._recordForSession(session, 'status_changed', {
    from: oldStatus,
    to: newStatus,
    detail: session.meta.statusDetail,
    type: session.meta.type
  });
}
```

Cleanup: in `stop()`, also call `this._statusWriteAt.clear()` so a stop+start cycle releases retained references. (Map entries are bounded by active session count, so this is more about tidiness than memory.)

## Test plan

- Add `tests/rag-status-debounce.test.js`: simulate 100 status_changed events for the same session within 100ms — assert exactly 1 `_recordForSession` call. Then advance fake clock 1100ms, fire one more, assert 2 total. Then fire an `errored` transition mid-burst, assert it's not debounced.
- Manual: run a fresh dashboard with a worker doing rapid tool cycles; confirm `[rag] write ... event=status_changed` lines come at most once/sec/session, not dozens/sec.

## Out of scope

- Don't rate-limit other event types. Future sprint can revisit if any other class proves floody.
- Don't change the log format — keep the existing `[rag] write project=... source=... session=... event=...` line so log-grep tooling and Joshua's mental model stay intact.
- Don't move the debounce to `_recordForSession` (the lower layer) — keep it in the event-handler so the layer below stays a pure write path.

## Sprint contract

Append to `docs/sprint-36-launcher-ui-parity/STATUS.md` under `## T3` as a Deliverable-D-prefixed entry. No version bumps. No commits. Lane discipline.
