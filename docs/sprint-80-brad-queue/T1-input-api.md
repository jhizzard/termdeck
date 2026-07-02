# T1 — Input-API lane (BR-1 + FR-4)

You are T1 in Sprint 80 (Brad Queue). You own the `POST /api/sessions/:id/input` surface in `packages/server`. Nothing else. Boot sequence:

1. `memory_recall(project="termdeck", query="inject two-stage submit body-parser input route")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-80-brad-queue/PLANNING.md` + `STATUS.md`
5. Read this brief, then RE-VERIFY every anchor below (briefs are hypotheses; post drift as FINDING)

## BR-1 — `\xNN` normalization on /input (P0)

**Verified anchors (2026-07-01):**
- `express.json()` mounted at `packages/server/src/index.js:621`; Sprint 63 parse-error handler at `:661-680` (logs `[body-parser] entity.parse.failed …` and returns structured 400 — Brad's R730 log shows exactly this line firing).
- Input route: `index.js:2384 app.post('/api/sessions/:id/input', …)`; server-sequenced submit lives in `packages/server/src/pty-submit.js` (`{submit:true}`, v1.10.1).

**Failing shape (reproduce FIRST, as a failing test):**
```
curl -X POST :3000/api/sessions/<id>/input -H 'Content-Type: application/json' \
  -d '{"text":"\x1b[200~You are T1…\x1b[201~"}'
```
Bash single quotes make `\x1b` four literal characters → invalid JSON escape → 400 → inject lost; caller doesn't check → panel idles forever (Brad's cascade chain).

**Fix (locked decision — PLANNING §3.1/§3.2):** pre-parse middleware scoped to `POST` + `/\/api\/sessions\/[^/]+\/input$/` that rewrites `\xNN` → `\u00NN` (case-insensitive hex) in the raw body, then parses and sets `req.body` such that `express.json()` skips re-parsing (Brad's reference patch consumes the stream so body-parser's `isFinished` check short-circuits — verify that mechanism holds on express 5.2/body-parser 2.x rather than trusting it). Malformed-after-normalization bodies still 400 with the extended `hint` field. Keep all other routes strict.

**Tests (packages/server/tests/ — inside the npm glob, NOT repo root):**
- literal `\x1b[200~…\x1b[201~` → PTY receives real ESC bytes (assert on the PTY write spy)
- proper `` → byte-identical behavior to today
- mixed/uppercase `\X1B`, `\x00`, `\xff` edges
- **the hazard case:** a payload whose *intent* is the 4-char text `\x1b` (e.g. quoting docs) — assert current (converted) behavior and document it in `docs/ARCHITECTURE.md` § input API; implement the opt-out only if cheap
- non-`/input` route with `\x1b` still 400s

## FR-4 — inject queue vs human in-progress typing

Server tracks `inputBufferLength`/`inputBufferPreview` (verify where — likely `session.js`). When an API inject arrives while the buffer is non-empty AND the last human keystroke is recent (define window, ~3–5s), enqueue instead of writing; flush FIFO on submit (CR) or clear (Ctrl-C/Ctrl-U/Esc). Per-panel opt-out flag; default ON for orchestrator-role panels only (Brad's ask). Cover: queue-then-flush order, no interleave mid-line, queue TTL so a stale inject can't fire minutes later into a different context (pick + document a TTL), interaction with `{submit:true}` path in `pty-submit.js`.

## Lane discipline

Post `### [T1] FINDING|FIX-PROPOSED|FIX-LANDED|DONE 2026-MM-DD HH:MM ET — gist` to STATUS.md (exact shape, `### ` prefix mandatory). Example: `### [T1] FIX-LANDED 2026-07-02 10:14 ET — \xNN normalization + 6 tests green`. No version bumps, no CHANGELOG, no commits. Cross-lane touch (e.g. anything in `session.js` T2 also edits) → HANDOFF-REQUEST first. When done: post DONE with test counts + file:line evidence.
