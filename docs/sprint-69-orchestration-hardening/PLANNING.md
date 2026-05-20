# Sprint 69 — 3+1+1 Orchestration Hardening

**Branch:** `sprint-69-orchestration-hardening` (off `main` at `447cbe3`)
**Goal (one line):** ship the TermDeck primitives that prevent Maestro-Sprint-2-style operational slop in future 3+1+1 sprints, so Maestro Sprint 3 (Phase 5B real-data validation) inherits a hardened orchestration loop.

## Source-of-truth references

- **`PROPOSAL.md`** in this dir (309 lines) — the full sprint proposal authored 2026-05-19 by the Maestro Sprint 2 orchestrator. Read FIRST; this PLANNING document is its operationalization.
- Maestro Sprint 2 STATUS.md (the failure-mode evidence): `~/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-2-intake-hop/STATUS.md` (Maestro repo)
- Mnestra kitchen-lessons (saved 2026-05-19): recall via `memory_recall(query="3+1+1 orchestration kitchen-lesson Sprint 2 2026-05-19")`. Three load-bearing lessons:
  - `meta.status` is NOT authoritative for "is this panel actually doing work" (parked-done panels show as `active using tools`).
  - "Tests pass" ≠ "LANDED posted" — workers' natural completion sense skips the substrate-update step.
  - Tail-only STATUS.md polling misses worker LANDEDs posted inside their own sections; whole-file scan is required.

## Why this sprint exists (TL;DR)

Maestro Sprint 2 shipped GREEN (suite 545/0/1xfail; technical success) but cost ~90 minutes of orchestration slop driven by **TermDeck primitives, not by worker behavior**. Every failure traces to a TermDeck-side fix:

| Failure mode | Sprint 2 cost | Fix lane |
|---|---|---|
| Boot-prompt boilerplate (4-5 hand-rolled files per sprint) | ~1 hr/sprint | T1 — template engine |
| No `POST /api/sprints/inject` (orchestrator writes Node script every time) | ~10 min/sprint | T2 — inject endpoint |
| No `POST /api/sprints/nudge` (parked-lane recovery is 50-line inject script) | ~10 min/recovery | T2 — nudge endpoint |
| `meta.status` stale for parked Claude Code panels (completion banner doesn't refresh PTY-driven status) | ~70 min false polling | T3 — `meta.parked` detection |
| Tail-only STATUS.md polling misses mid-file worker LANDEDs | ~40 min false silence | T3 — STATUS.md parser |
| No default orchestrator polling loop (orchestrator just "waits") | first 41-min silence in Sprint 2 | (CLAUDE.md amendment) |

This sprint eats its own dog food: built BY the same 3+1+1 orchestration pattern we're hardening. The auditor (T4 Grok) explicitly verifies that the new primitives would have prevented Sprint 2's slop.

## Mixed-model 3+1+1 — Josh's lineup

| Lane | CLI | Role | Owns | Brief |
|---|---|---|---|---|
| T1 | **claude-code** | worker | Boot-prompt template engine + `share/termdeck/templates/` defaults + `~/.termdeck/templates/` override + variable substitution | `T1-template-engine.md` |
| T2 | **codex** | worker | `POST /api/sprints/inject` + `POST /api/sprints/nudge` endpoints; reuses T1's template engine | `T2-inject-nudge-endpoints.md` |
| T3 | **gemini** | worker | `meta.parked` detection (buffer-content parsing for completion-banner regex) + `GET /api/sprints/status` STATUS.md parser | `T3-parked-detection-and-status-parser.md` |
| T4 | **grok** | auditor | Independent end-to-end Maestro-Sprint-2 replay; verifies no `meta.status` reads in the orchestrator path, no manual `[ORCH] STATUS` proxy-LANDED needed, no parked-lane misses | `T4-grok-adversarial.md` |

**Lineup rationale.** Four distinct models = maximum blind-spot diversity. Auditor model (Grok) shares no training history with worker models (Claude/Codex/Gemini), maximising the adversarial-catch ROI documented in Mnestra (Maestro Sprint 2 — Grok-the-auditor's equivalent T4 Codex caught 3 architecturally-distinct landed defects worker self-tests missed).

## Lane file ownership (do NOT cross)

- **T1 (Claude):**
  - Write (new): `packages/server/src/templates/template-engine.js`, `share/termdeck/templates/cc-worker.txt`, `share/termdeck/templates/cc-auditor.txt`, `share/termdeck/templates/cc-orchestrator.txt`, `share/termdeck/templates/codex-worker.txt`, `share/termdeck/templates/codex-auditor.txt`, `share/termdeck/templates/gemini-worker.txt`, `share/termdeck/templates/gemini-auditor.txt`, `share/termdeck/templates/grok-worker.txt`, `share/termdeck/templates/grok-auditor.txt`, `tests/template-engine.test.js`.
  - May edit: `packages/server/src/index.js` (export the template engine for T2 to use), `package.json` (if a new file needs to ship in `files`).
- **T2 (Codex):**
  - Write (new): `packages/server/src/sprints/inject.js`, `packages/server/src/sprints/nudge.js`, `tests/sprint-inject.test.js`, `tests/sprint-nudge.test.js`.
  - May edit: `packages/server/src/routes.js` (or equivalent — the file that mounts API routes) to register the two endpoints.
- **T3 (Gemini):**
  - Write (new): `packages/server/src/parked-detection.js`, `packages/server/src/sprints/status-parser.js`, `tests/parked-detection.test.js`, `tests/sprint-status-parser.test.js`.
  - May edit: `packages/server/src/sessions.js` (or wherever `GET /api/sessions` lives) to add the derived `meta.parked` field to the response, and the route mount file for `GET /api/sprints/status`.
- **T4 (Grok):**
  - Write (new): `tests/sprint-69-audit.test.js` — independent end-to-end fixtures.
  - May edit: a source file ONLY on a confirmed defect, after posting `### [T4-GROK] AUDIT-RED` first. The orchestrator routes the fix to the owning worker lane.

If a worker finds a bug in another lane's code, POST `### [T<n>] FINDING <DATE HH:MM ET> → ROUTED TO T<m> — <file:line + reasoning>` and do not silently work around it. Orchestrator adjudicates.

## v1 scope of each feature (do not over-extend)

### T1 — Template engine
- 10 templates: `(claude-code, codex, gemini, grok) × (worker, auditor)` + `claude-code/orchestrator`. (Other CLI×orchestrator combinations are deferred — Claude is the only orchestrator-CLI today.)
- Each template is a UTF-8 text file with `{{variable}}` substitution. Simple regex replace; no Mustache/Handlebars import.
- `metadata.yaml` per template OR a single `templates.manifest.json` declaring required variables per template (T1's call — pick one, document choice).
- Storage: defaults ship at `packages/server/share/termdeck/templates/`. Filesystem override at `~/.termdeck/templates/`. Override resolution: per-file (`~/.termdeck/templates/cc-worker.txt` overrides the default `cc-worker.txt` only; other templates fall through).
- API: `loadTemplate(cliType, role, variables) → string`. Errors if any required variable is missing.
- 10+ tests covering: default load, override load, missing-var error, all-vars-present render, CLI-type unknown error, role-unknown error, the `cc-worker` template's content matches the proposal §4.1 example.

### T2 — Inject + Nudge endpoints
- `POST /api/sprints/inject`:
  - Body shape per PROPOSAL.md §4.2.
  - Server: auto-detect CLI type per session via `meta.type`. Pick template via T1's engine. Substitute variables. Run two-stage submit (paste-stage all panels with 250ms gap → settle 400ms → submit-stage with 250ms gap).
  - Return: per-panel result + initial 5s post-submit `meta.status` snapshot.
  - Errors: 400 on missing sessionId / unknown role / unknown template / missing required variable.
- `POST /api/sprints/nudge`:
  - Body shape per PROPOSAL.md §4.3.
  - `kind` enum: `post-landed-reminder`, `status-check`, `tooling-failure-recover`, `custom` (with `text` in body for custom).
  - Server: pick or accept text → bracketed-paste → settle → submit (same two-stage as inject, single-panel batch usually).
  - Return: per-panel result.
- 8+ tests covering: inject happy path (4 panels), inject one-panel error (rolls back others? — T2's design call), nudge each `kind`, nudge custom with text, inject reads template correctly, scope-mismatch errors.

### T3 — `meta.parked` + STATUS.md parser
- `meta.parked` field added to `GET /api/sessions` response per PROPOSAL.md §4.4.
  - Algorithm: `meta.status == "active"` AND `meta.lastActivity > 5 min ago` AND buffer (last 200 lines) contains regex `(Cogitated|Churned|Brewed|Cooked|Mused|Pondered|Wandered) for \d+m \d+s` → `meta.parked = true`. Otherwise `false`.
  - Tested patterns matter: the regex is the load-bearing detail. Add gemini/grok/codex completion banners if known (T3's research call — if unknown, document and stick with the 7 Claude Code ones).
- `GET /api/sprints/status?file=<path>`:
  - Parse a STATUS.md per PROPOSAL.md §4.5.
  - Returns the structured form documented in §4.5.
  - Lane regex: `^### \[T(\d+)(-[A-Z]+)?\] (FINDING|PROPOSE|LANDED|DONE|AUDIT-RED|AUDIT-CONCERN|CHECKPOINT|FINAL-VERDICT) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET — (.*)$`.
  - `landed_since_last_red` derives from: for each lane, the latest `LANDED` timestamp vs. the latest `AUDIT-RED` timestamp from T4 against this lane.
- 8+ tests covering: parked detection across 5+ completion banners + lastActivity edge cases, STATUS.md parse with realistic fixtures (use Maestro Sprint 2's actual STATUS.md as a fixture if helpful), the `landed_since_last_red` decision matrix, malformed-STATUS.md graceful failure.

### T4 — Grok adversarial audit
- Build the Maestro Sprint 2 replay test: simulate the inject + nudge cycles that Sprint 2 needed, using the new endpoints. Run against actual TermDeck server (or a test harness).
- Verify each of the 5 Sprint 2 failure modes (PROPOSAL §1) would NOT occur with the new endpoints. File:line evidence required per claim.
- Audit each worker lane independently — do NOT borrow worker fixtures. Build minimal payloads from scratch.
- Audit cross-lane handoffs:
  - T1 template engine called from T2 inject endpoint: does the call shape match what T1 actually exports?
  - T2 inject endpoint reads `meta.type` from `GET /api/sessions`: does T3's `meta.parked` extension still let T2 see `meta.type`?
  - T3 parser reads STATUS.md from disk: does T2 nudge's `post-landed-reminder` template name the same file path T3 parses?
- Post `### [T4-GROK] CHECKPOINT YYYY-MM-DD HH:MM ET — Phase N / <name>` at every phase boundary AND at least every 15 minutes. STATUS.md is the only substrate that survives panel compaction.
- FINAL-VERDICT only after the orchestrator closes the sprint OR all 3 workers post DONE.

## Done-when (sprint `/goal` criterion)

1. T1 template engine works: `loadTemplate("claude-code", "worker", {sprint_name: "..."})` returns the substituted string. 10 templates exist on disk. Override path works.
2. T2 `POST /api/sprints/inject` accepts the documented body, runs two-stage submit, returns per-panel result. `POST /api/sprints/nudge` accepts the 4 `kind` values.
3. T3 `meta.parked` field present in `/api/sessions` response, computed from buffer-content + lastActivity. `GET /api/sprints/status?file=<path>` returns structured form.
4. T4 replay-test passes: simulated Maestro-Sprint-2 inject + nudge cycle works end-to-end with the new endpoints; no manual orchestrator nudges needed.
5. Full TermDeck suite green: `npm test` ≤ existing baseline (whichever it is — T1 establishes at boot).
6. CLAUDE.md amendments (PROPOSAL.md §5.1, §5.2, §5.3) drafted as new files under `docs/sprint-69-orchestration-hardening/CLAUDE-amendments/` for Josh to land manually into `~/.claude/CLAUDE.md`.

## Out of scope (deferred to a follow-up sprint)

- Web UI for `/api/sprints/*` endpoints.
- Template versioning / migration tooling.
- Integration with non-TermDeck workflow orchestrators (GitHub Actions / Linear).
- Multi-orchestrator coordination (one session running multiple parallel sprints).
- Gemini/Grok/Codex completion-banner research if their patterns aren't quickly discoverable from a single web search — defer with a TODO; ship with Claude Code patterns only for v1.

## Open items / risks

- **T1 + T2 ordering.** T2's inject endpoint needs T1's template engine. T2 may need to idle-wait on T1's LANDED before final integration tests. T2 can sketch + stub against an expected interface while waiting; coordinate via STATUS.md `### [T2] PROPOSE — interface assumption ...` post if T1's exported shape differs.
- **T3's `meta.parked` regex completeness.** Sprint 2 only confirmed Claude Code's "Cogitated / Churned / Brewed / Cooked" patterns. Codex / Gemini / Grok completion banners aren't yet documented in Mnestra. T3 documents what's covered + what's TBD; T4 verifies the v1 coverage is enough.
- **Mixed-CLI worker discipline.** This is the FIRST 3+1+1 sprint where each worker is a different CLI. Gemini and Grok don't have Mnestra MCP — their boot prompts skip `memory_recall` and rely on the brief + read-file access. The brief MUST be self-contained enough that they don't need memory recall.
- **Eating own dog food caveat.** This sprint runs with the OLD orchestration (the slop we're fixing) because the new features don't exist yet. The orchestrator will manually do STATUS.md-driven polling per the kitchen-lesson correction, not `meta.status`-driven polling. T4 verifies the replay test would have prevented the slop.

## CLAUDE.md amendments (per PROPOSAL.md §5) — orchestrator drafts these

Three text files under `docs/sprint-69-orchestration-hardening/CLAUDE-amendments/` — to be landed manually by Josh in `~/.claude/CLAUDE.md`:

1. `worker-discipline.md` — "Done-when (mandatory): tests green AND LANDED posted AND auditor reacted" clause.
2. `auditor-synchronize-on-LANDED.md` — "synchronize-on-LANDED" clause for auditor briefs.
3. `orchestrator-default-polling.md` — "default polling discipline" clause; STATUS.md-driven, `meta.parked`-aware, 270s tick cadence.

These are NOT TermDeck code — they're documentation Josh applies to his global CLAUDE.md. The orchestrator (this session) authors them at sprint close.
