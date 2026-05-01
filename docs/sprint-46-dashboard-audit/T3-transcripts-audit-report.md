# Sprint 46 — T3 audit report: Transcripts panel

**Lane:** T3 — Transcripts panel audit (`app.js:4339+`, `packages/server/src/transcripts.js`, `index.js:1548–1607`).
**Auditor session:** T3 (TermDeck Sprint 46 inject 2026-05-01).
**Method:** read every code path in scope, then probe each endpoint live (`http://127.0.0.1:3000`) to compare actual response shapes against client expectations, then walk the panel surfaces in the same order as the brief.
**Live data baseline used:** 4 sessions in `/api/transcripts/recent?minutes=60` (chunk counts 117 / 116 / 163 / 104), 50 hits on `/api/transcripts/search?q=sprint`, 1776 chunks / 81 KB joined content on `/api/transcripts/:sessionId`.

## Roll-up

| # | Surface | Verdict | Severity | Action this sprint |
|---|---|---|---|---|
| 1 | Open / close modal | works | — | none |
| 2 | Recent tab — populate | **broken** | HIGH | **fixed** (client renderer) |
| 3 | Recent tab — empty state | works | — | none |
| 4 | Search tab — switch | works | — | none |
| 5 | Search tab — query (content) | works | — | none |
| 5b | Search tab — time chip | **broken** | LOW | **fixed** (client renderer) |
| 6 | Search tab — empty result | works | — | none |
| 7 | Click into session | works | — | none |
| 8 | Copy-to-clipboard | works | — | none |
| 9 | Back button | works | — | none |
| 10 | Cross-check Sprint 45 T4 launcher refactor | clean | — | none |
| 11 | Performance (large session) | sub-optimal | LOW | deferred (Sprint 47+) |
| 12 | Concurrency / live update | works (by design — no polling) | — | documented |
| bonus | Server-side metadata enrichment (`type`/`project`) | gap (not stored in transcripts table) | LOW | deferred (Sprint 47+) |
| bonus | TUI-spinner spam in stored content | data-quality | LOW | deferred (Sprint 47+) |
| bonus | `escapeHtml` defined twice in `app.js` | code hygiene (pre-existing) | INFO | deferred (out of audit scope) |

**Net for sprint:** 2 broken surfaces fixed in-lane (~25 LOC client + 18 LOC test), 3 sub-optimal items documented and deferred to Sprint 47+. No regressions introduced; all 4 contract tests stay green.

## Per-surface walkthrough

### 1. Open / close modal — works

- Topbar button `#btn-transcripts` injected by `setupTranscriptUI()` (`app.js:4339`), positioned before `#btn-status`. Probed for endpoint availability (`/api/transcripts/recent?minutes=1`); only un-hidden if the server returns non-404. Today: server returns 200 → button visible.
- Click handler wires to `openTranscriptModal()`. Adds `.open` class to `#transcriptModal`, calls `transcriptSwitchView('recent')` which then auto-fetches recent.
- Close paths: `#transcriptClose` button, `#transcriptBackdrop` click, and Escape keydown on the modal element. All three call `closeTranscriptModal()` which strips `.open`.
- `transcriptState.modalOpen` is set true/false but no other code reads it. Cosmetic — does not break anything. Documented as dead state, not worth touching this sprint.

### 2. Recent tab — populate (BROKEN, fixed)

**Reproducer (pre-fix):** open the panel against today's data. Each row showed `<shortId>` + `shell` + "0 lines" + an empty `<pre>` preview, regardless of how many chunks the session actually held.

**Root cause:** **client/server contract mismatch.** Server (`/api/transcripts/recent`) returns:

```json
{ "sessions": [ { "session_id": "...", "chunks": [ {chunk_index, content, raw_bytes, created_at}, ... ] }, ... ] }
```

Pre-fix renderer (`renderRecentTranscripts`) expected each session to expose `type`, `project`, `lines` (string array) or `preview`, and `totalLines` — none of which the server sends. The renderer never read `sess.chunks`, so:

- `lines = sess.lines || sess.preview || []` → `[]`
- `lineCount = sess.totalLines || lines.length` → `0`
- `type = sess.type || 'shell'` → always `'shell'`
- `project = sess.project || ''` → always blank
- `lines.slice(-6).join('\n')` → empty string

**Fix (in this sprint):** `app.js:4485` rewritten to read `sess.chunks` directly. New behaviour:

- `totalChunks = chunks.length` (or `sess.totalLines` if a future server enrichment supplies it).
- `previewChunks = chunks.slice(0, 6).reverse()` — server returns chunks in DESC `created_at` order (most-recent first), so the first 6 entries are the newest; reversed for natural top-down reading.
- `previewText = previewChunks.map(c => c.content).join('')`, with a `sess.preview` fallback if a future enrichment supplies one.
- `type` falls back to `'session'` when chunks exist (otherwise `'shell'`).

**Why client-side fix, not server enrichment:** the transcripts table doesn't carry session `type` / `project` columns; deriving them requires joining the live in-memory `sessions` map, which is exactly the state that's gone after a crash (the very scenario this panel was built for in Sprint 6 T3). The renderer-side fix is correct and minimal. **Server-side enrichment** (writing session metadata to a new column on `termdeck_transcripts`, or persisting a small sessions table) is a Sprint 47+ candidate.

**Contract test added:** `tests/transcript-contract.test.js` recent-shape test now asserts `chunk.content` is a string and `chunk_index` is present, locking the field names that the renderer relies on.

### 3. Recent tab — empty state — works

When `data.sessions` is empty/missing, body shows `<div class="transcript-empty">No recent transcript activity</div>`. Verified by inspection; today's live data has 4 sessions so couldn't reproduce live, but the branch is unchanged and trivial.

### 4. Search tab — switch — works

Click on `[data-view="search"]` calls `transcriptSwitchView('search')` which:
1. Toggles tab `.active` class.
2. Shows the search bar (`#transcriptSearchBar`) and focuses the input.
3. Hides the back button.
4. If a previous search produced results, re-renders them; otherwise shows the "Type to search transcript content" empty state.

### 5. Search tab — query — works (content), broken-then-fixed (time chip)

- Debounced 400ms after each keystroke; minimum query length 2.
- Endpoint: `GET /api/transcripts/search?q=…`. Live probe with `q=sprint` returned 50 results.
- Each result renders shortId + a `<pre class="tr-line">` with `highlightMatch` wrapping the query in `<mark class="tr-highlight">`. Content: works.

**Time chip (BROKEN, fixed):** server returns `created_at` (ISO 8601). Pre-fix renderer read `result.timestamp`, which the server never sends → time chip never rendered. **Fix:** `app.js:4547` now reads `result.timestamp || result.created_at`, with `Date(...).getTime()` validity check before `toLocaleTimeString()` so a future malformed timestamp doesn't surface as `Invalid Date`. Contract test now pins `created_at` presence on each search result.

### 6. Search tab — empty result — works

Server returns `{ results: [] }` for queries with no FTS matches. Renderer shows `<div class="transcript-empty">No matches found</div>`. Verified live with `q=zzzzzzzzqqqqqxxxxxx` → 0 results.

### 7. Click into session — works

Clicking any `.transcript-session` (Recent) or `.transcript-result` (Search) row triggers `loadTranscriptReplay(sessionId)`:
1. Sets `transcriptState.view = 'replay'`.
2. Shows the back button, hides the search bar.
3. Fetches `/api/transcripts/:sessionId` (full chunks).
4. Calls `renderTranscriptReplay(data)`.

Server returns `{ content: <joined string>, lines: <array of chunk content>, chunks: <chunk objects> }`. Renderer joins via `data.content || data.lines?.join('\n')` — works since `content` is non-empty. Live probe: 81 KB content, 1776 lines, 1776 chunks — rendered fine.

### 8. Copy-to-clipboard — works

`#transcriptCopyBtn` click handler calls `navigator.clipboard.writeText(content)`; on success, button text changes to "Copied!" + `.copied` class for 2s, then reverts. The `.catch(() => {})` swallows clipboard-permission failures silently — minor sub-optimal UX (no visible failure message if clipboard is denied), but not in scope to fix here.

### 9. Back button — works

`#transcriptBack` is hidden until `view === 'replay'`. Click handler `transcriptGoBack()`:
1. Clears `replaySession` + `replayData`.
2. Switches back to whichever list view was last active (search if any cached search results, else recent).
3. Re-renders cached data immediately (so the user sees the previous list snapshot, not a re-fetch flash).

Subtle behaviour: `transcriptSwitchView('recent')` itself re-fetches `/api/transcripts/recent`, so the cached render at line 4448 gets replaced by the fresh result moments later. Net effect: better UX with cached snapshot. Documented as intended.

### 10. Cross-check Sprint 45 T4 launcher refactor — clean

Launcher refactor at `app.js:2453+` (`launchTerminal`, registry-driven `state.agentAdapters` matching). Confirmed `transcriptState`, `setupTranscriptUI`, and the panel's render functions are not referenced anywhere inside the launcher block (`grep -i transcript` over lines 2422–2520 → no hits). The two surfaces share an enclosing IIFE scope but have no functional crossover, so Sprint 45 T4 did not introduce a regression here.

Code-hygiene FYI (pre-existing, not a Sprint 45 regression): `app.js` defines `function escapeHtml(str)` twice — at line 2693 and again at line 4296. Bodies are identical (`div.textContent` round-trip). Second definition shadows the first; benign but worth a future cleanup pass.

### 11. Performance — sub-optimal

The session-detail view renders the full transcript as a single `<pre>` containing the joined content. Today's worst-case session is 81 KB / 1776 chunks — modern browsers handle this fine.

Sprint 47+ candidate: virtualised render or paginated load (e.g. accept `?limit=500&offset=N` on `/api/transcripts/:sessionId`, lazy-load on scroll). Not currently a defect — out-of-budget for this audit.

### 12. Concurrency / live update — by design

Panel is a snapshot view, not a live feed. Re-opening the modal re-fires `fetchRecentTranscripts()`, but session-detail does not poll. The transcript writer flushes every 2s, so a session-detail view loaded at T+0 will be 0–2s stale. This matches the panel's stated purpose (crash recovery, search). No code change needed; documented for collaborator clarity.

## Bonus findings (deferred to Sprint 47+)

### Server-side metadata enrichment

`termdeck_transcripts` stores only `(session_id, chunk_index, content, raw_bytes, created_at)`. Session `type` / `project` are gone after a crash, exactly when the recovery panel matters most. Future enhancement: persist a small `termdeck_sessions(session_id, type, project, command, created_at, closed_at)` table written on session create/close, then JOIN in `getRecent`. Estimated ~80 LOC server + 12 LOC client. Not in this sprint's budget.

### TUI-spinner content spam

Sample chunk content from a Claude session: `"\r✻\r\r\n\r\n\r\n\r\n\r\n\r\n"` repeated dozens of times — Claude's spinner redraws. `stripAnsi()` (`transcripts.js:11`) strips CSI/OSC escape sequences but leaves the printable spinner glyphs and `\r\n` noise. Search results highlight `\r✻` rows just as readily as substantive content. Cleanup approach: reject chunks that are pure repeated single-glyph + whitespace, or strip them before insert. Estimated ~20 LOC. Not a Sprint 46 deliverable; queue as Sprint 47+ candidate alongside metadata enrichment.

### `escapeHtml` duplicate

Pre-existing duplicate definition at `app.js:2693` and `:4296`. Both bodies identical. Second wins for everything below it. Functionally fine; collapse during a future code-hygiene pass — not within audit scope.

## Files changed this sprint

| File | LOC delta | Why |
|---|---|---|
| `packages/client/public/app.js` | +12 / −5 | `renderRecentTranscripts` reads `sess.chunks`; `renderSearchResults` reads `result.created_at` |
| `tests/transcript-contract.test.js` | +18 / 0 | Renderer-contract assertions on chunk/result field names |

Total: ~25 LOC net additions, well under the ≤150 LOC lane budget. Two contract assertions added to lock in field names against future regression.

## Verification

- `node --check packages/client/public/app.js` → syntax OK.
- `TERMDECK_URL=http://localhost:3000 node --test tests/transcript-contract.test.js` → 4 / 4 pass (new assertions included).
- Manual code review — all surfaces walked end-to-end in code; live endpoints probed for shape match.
- Browser walkthrough: recommended for orchestrator at sprint close (the renderer fix is purely client-side; deterministic from the live endpoint shape, but a visual confirm in Chromium is the canonical verdict for the audit).
