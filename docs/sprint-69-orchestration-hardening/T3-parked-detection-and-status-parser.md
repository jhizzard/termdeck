# T3 — `meta.parked` Detection + STATUS.md Parser (Gemini, worker)

You are **T3**, the Gemini worker lane in Sprint 69 (Orchestration Hardening). You ship two pieces that together replace the broken `meta.status`-based orchestrator polling: (1) a `meta.parked` derived field on each session and (2) a STATUS.md parser endpoint.

The shared contract is in `docs/sprint-69-orchestration-hardening/PLANNING.md`. The proposal at `docs/sprint-69-orchestration-hardening/PROPOSAL.md` §4.4 + §4.5 has the algorithm details and the parser response shape.

## Working assumptions for Gemini

Your panel's shell cwd is `/Users/joshuaizzard/.gemini/antigravity/scratch/chopin_scheduler` (Maestro repo) — NOT the TermDeck repo. **First action:** `cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` (then verify with `pwd`).

You do not have Mnestra MCP `memory_recall`. The brief is self-contained — every kitchen-lesson you need is inlined below. If you have access to a web search or file-read tools, use them; otherwise rely on the brief + the repo source.

## Your lane (file ownership)

**Write (new):**
- `packages/server/src/parked-detection.js` — the `meta.parked` derivation function.
- `packages/server/src/sprints/status-parser.js` — the STATUS.md parser.
- `tests/parked-detection.test.js`
- `tests/sprint-status-parser.test.js`

**May edit:**
- `packages/server/src/sessions.js` (or wherever `GET /api/sessions` is built) — add the `meta.parked` field to the per-session response shape. Find the function that constructs the per-session metadata object; add `parked: await detectParked(session)` (or sync, depending on whether buffer access is async).
- The route-mount file — register `GET /api/sprints/status` (single endpoint, accepts `?file=<path>` query).

**Do NOT touch:** T1's template-engine files; T2's inject/nudge endpoint files; T4's test file.

## Kitchen-lesson context (inlined for you, no memory_recall needed)

**Why `meta.status` is unreliable.** TermDeck's `GET /api/sessions` returns `meta.status = "active"` and `meta.statusDetail = "Using tools"` based on PTY-byte-write events. When a Claude Code panel finishes a task and shows its completion banner ("Cogitated for 8m 11s" in gray text), the PTY does NOT see a status-change event — the panel is sitting idle, but the API persistently reports it as active. The orchestrator polling this field for parked-lane detection sees "still working" indefinitely. This wasted ~70 minutes in Maestro Sprint 2 (2026-05-19) before the user manually detected the bug.

**Why tail-only STATUS.md polling is wrong.** Workers post LANDED inside their own `## T<n>` section — which lives BEFORE the orchestrator's appended `## Orchestrator` section. An orchestrator that only reads `sed -n '<last_n>,$p'` (tail) misses every worker LANDED inserted in the middle of the file. The correct algorithm scans the WHOLE file each tick and compares per-lane timestamps.

**Completion-banner regex.** Claude Code's completion banners observed in the wild (Maestro Sprint 2):
- `Cogitated for \d+m \d+s`
- `Churned for \d+m \d+s`
- `Brewed for \d+m \d+s`
- `Cooked for \d+m \d+s`
- (Other Claude Code verbs observed in earlier sessions: `Mused`, `Pondered`, `Wandered`, `Crafted`. Include them in the regex.)

Codex / Gemini / Grok completion banners aren't yet catalogued. If you can discover them from your own CLI's completion behavior or from open-source CLI source code, add them. Otherwise document the v1 coverage as "Claude Code only" and proceed.

## Tasks

1. **Baseline.** `cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm test 2>&1 | tail -10`. Record baseline pass/fail.

2. **`parked-detection.js`.** Export `detectParked(session) → boolean`:
   - If `session.meta.status !== "active"` → `false`.
   - If `session.meta.lastActivity` is within the last 5 minutes → `false` (it's genuinely active).
   - Otherwise: read the session's buffer (last ~200 lines). Use whatever buffer-access API the TermDeck server already exposes internally — find the existing internal call site that powers `GET /api/sessions/:id/buffer`.
   - Apply the completion-banner regex. If matched in the last ~50 lines → `true`. Otherwise `false`.
   - Document the algorithm in a comment block at the top of the file.

3. **Hook `meta.parked` into `GET /api/sessions`.** Find where the per-session metadata object is assembled (search for the response-shape construction near the `/api/sessions` GET handler). Add a `parked: detectParked(session)` field. If the construction is sync and `detectParked` ends up async (because of buffer access), bubble the async correctly — don't break the existing endpoint.

4. **`sprints/status-parser.js`.** Export `parseStatusMd(filePath) → object`:
   - Read the file (fail gracefully if missing: return `{lanes: {}, open_red_count: 0, last_orchestrator_post: null, last_final_verdict: null}`).
   - Lane regex (matches every post): `^### \[(T\d+(?:-[A-Z]+)?)\] (FINDING|PROPOSE|LANDED|DONE|AUDIT-RED|AUDIT-CONCERN|CHECKPOINT|FINAL-VERDICT|STATUS|RULING) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET — (.*?)$`
   - For each match, accumulate per-lane state:
     - `lanes[laneTag] = { last_post: {verb, timestamp, line}, posts: [{verb, timestamp, line, gist}, ...], landed_since_last_red: <bool> }`.
     - `landed_since_last_red` is true iff the lane has a LANDED whose timestamp is > the most recent AUDIT-RED against this lane (look for AUDIT-RED posts whose gist mentions the lane tag or whose orchestrator routing names this lane).
   - `open_red_count` — count AUDIT-RED posts from T4-* without a subsequent matching LANDED.
   - `last_orchestrator_post` — most recent `[ORCH]` post.
   - `last_final_verdict` — most recent FINAL-VERDICT (auditor or orchestrator).
   - Return the structured object per PROPOSAL §4.5.

5. **Mount `GET /api/sprints/status?file=<path>`.** Single handler: validates `file` query, calls `parseStatusMd(file)`, returns the structured JSON.

6. **Tests** (≥8 per file):
   - **parked-detection:** session active + recent lastActivity → not parked; session active + old lastActivity + no banner in buffer → not parked; session active + old lastActivity + Cogitated banner → parked; session active + old lastActivity + Churned banner → parked; session active + old lastActivity + Brewed/Cooked/Mused/Pondered → parked; session inactive → not parked; buffer-fetch failure handled gracefully (don't crash the /api/sessions endpoint).
   - **status-parser:** parse the actual `~/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-2-intake-hop/STATUS.md` (783-line real-world fixture from Maestro Sprint 2 — copy it to `tests/fixtures/sprint2-status.md`) and assert lane counts + landed_since_last_red decisions match reality (T1 landed multiple times, T2 once, T3 multiple, T4-CODEX has FINAL-VERDICT); missing file returns empty structure; malformed STATUS.md doesn't crash; the open_red_count correctly counts open vs. closed REDs.

## Discipline

- Post `### [T3] FINDING / PROPOSE / LANDED / DONE 2026-05-20 HH:MM ET — <gist>` to STATUS.md (absolute path: `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-69-orchestration-hardening/STATUS.md`). Use `cat >> <file>` or your editor's append-mode write — do not overwrite the file.
- Run `npm test` before every LANDED.
- Post `### [T3] DONE 2026-05-20 HH:MM ET — <verdict>` when complete.
- Do not bump versions, touch CHANGELOG, or `git commit`.
