# tests/fixtures/flashback-production-flow

Fixtures + documentation for `tests/flashback-production-flow.test.js` (Sprint 39 T4).

## What the test depends on

The test runs against the running TermDeck server (`TERMDECK_URL` env, default `http://localhost:3000`). It does NOT spin up its own server, so the suite needs:

1. **A live TermDeck server** with `/api/health`, `/api/rag/status`, `/api/sessions`, `/api/sessions/:id/input`, `/api/transcripts/:id`, and the WebSocket endpoint at `ws://.../ws?session=<id>`.
2. **Mnestra reachable** — `/api/health` must report `mnestra_reachable: passed`.
3. **SQLite present** — `/api/rag/status` must return `localEvents: <number>` (absent → SQLite is null and `rag_events` cannot be observed).
4. **A non-empty termdeck-tagged corpus.** Pre-flight probe POSTs `/api/ai/query` with `{ question: "shell error cat no such file or directory", project: "termdeck" }`. If the response carries zero memories, the test skips with a `needs-backfill` directive — Sprint 39 T3's `011_project_tag_backfill.sql` migration must run first.
5. **Real `/bin/zsh` and `/bin/bash`** on the runner. Each missing binary skips its test case independently.

The test cleans up every session it creates via `DELETE /api/sessions/:id` in `after()`.

## What the test asserts (and what it does NOT assert)

**Asserted:** the server-side WebSocket-push pipeline works end-to-end. After spawning a real interactive shell and sending `cat /nonexistent/file/path`, the server emits a `{ type: 'proactive_memory', hit }` frame within 5 seconds, and the hit carries non-empty content with `project ∈ {'termdeck', null}`.

**Not asserted (out of test reach):** that the browser UI renders a toast. The client-side `app.js` `ws.onmessage` switch handles `output / meta / exit / status_broadcast / config_changed` — there is no `case 'proactive_memory':` branch. The client's flashback path is the indirect one: `status_broadcast` (every 2s) → `updateGlobalStats` → `updatePanelMeta` → `triggerProactiveMemoryQuery` (which POSTs `/api/ai/query` itself and renders a toast on a hit). A node test cannot exercise the DOM rendering, so the test is silent on whether the toast actually appears.

## Why the test passes on the Sprint 38 baseline

When this lane shipped (2026-04-27 evening, after Sprint 38 close at HEAD `876ecae`), both test cases (zsh + bash) passed against the live server. The brief expected baseline failure; the actual outcome contradicts that expectation.

The diagnostic block in each test prints, among other things, the `status_broadcast` race signal:

```
[T4] status_broadcast frames captured: 1; frames showing this session as 'errored': 0
(if 0/1, the client-pull flashback path is losing the 2s-vs-50ms race — Sprint 39 hypothesis)
```

That `0/N` ratio is the actual user-facing regression mechanism:

- `_detectErrors` flips `meta.status='errored'` and immediately fires `onStatusChange` (server-side, no debounce).
- The next PTY chunk (the bash/zsh prompt landing ~10–50 ms later) flips `meta.status` back to `'idle'` via `_updateStatus` (writes the field immediately; the `onStatusChange` *callback* for that transition is debounced 3s, but the field itself is current).
- The periodic `status_broadcast` polls every 2 seconds (`setInterval(..., 2000)` in `index.js:1740`).
- `errored` is therefore live for ~50 ms inside a 2000 ms cycle — caught by `status_broadcast` ~2.5 % of the time.
- Joshua's client almost never sees `status='errored'` in any broadcast → `triggerProactiveMemoryQuery` is almost never invoked → no toast → 9 days of silence.

The server-side WebSocket-push path (`{ type: 'proactive_memory', hit }`) IS firing correctly and IS reaching the WS — the client just has no handler for it.

## Implications for Sprint 39 lanes

- **T2 (PATTERNS rcfile-noise audit):** strong hypothesis disproved on Joshua's runner. The pre-trigger transcript captured 0 PATTERNS.error/shellError matches; the 30 s rate limiter was not burned by rcfile noise.
- **T3 (project-tag mismatch + chopin-nashville backfill):** disproved for the WS-push path. The bridge returned `termdeck`-tagged content correctly. The backfill is still worth shipping for corpus hygiene, but it was not the flashback-blindness root cause.
- **The actual fix surface:** either (a) add `case 'proactive_memory': showProactiveToast(id, msg.hit); break;` to the client `ws.onmessage` switch (smallest, most reliable — uses the path the server already emits), or (b) make the server push a per-session `'meta'` frame on every `status` change instead of only on initial WS connect, so `status_broadcast` polling timing stops mattering. Option (a) is the smaller surface area.

## Files in this directory

Currently README only — no fixture data files. The test relies on:
- The runner's actual `/bin/zsh` and `/bin/bash` binaries (and whatever rcfiles they load).
- The live Mnestra corpus on the host (no synthetic seed data).

Pre-recorded zsh/bash transcripts and a synthetic seed snapshot were considered but deferred — TermDeck's `POST /api/sessions` body schema does not accept per-call `env` overrides, so we cannot point a session at a fixture-controlled `ZDOTDIR` without server-side changes (out of T4 lane scope). When T2/T3 ship and the test stops being a pure smoke test, fixture seed data may be added here.
