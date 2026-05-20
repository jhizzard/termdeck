# T2 — Sprint Inject + Nudge Endpoints (Codex, worker)

You are **T2**, the Codex worker lane in Sprint 69 (Orchestration Hardening). You ship two API endpoints that turn 4-5 hand-rolled boot-prompt files + a Node inject script into a single HTTP call. T1 (Claude) builds the template engine you consume.

The shared contract is in `docs/sprint-69-orchestration-hardening/PLANNING.md` (read first). The proposal at `docs/sprint-69-orchestration-hardening/PROPOSAL.md` has the body-shape details in §4.2 and §4.3.

## Your lane (file ownership)

**Write (new):**
- `packages/server/src/sprints/inject.js` — `POST /api/sprints/inject` handler.
- `packages/server/src/sprints/nudge.js` — `POST /api/sprints/nudge` handler.
- `tests/sprint-inject.test.js`, `tests/sprint-nudge.test.js`.

**May edit:**
- The TermDeck server's route-mount file (likely `packages/server/src/index.js` or `packages/server/src/routes.js` — check the existing route registration pattern) to register the two new endpoints.

**Do NOT touch:** T1's template-engine files; T3's parked-detection / status-parser files; T4's test file. If you find a bug in T1's exported engine, post `### [T2] FINDING ... → ROUTED TO T1` and proceed against an assumed-fixed contract.

## Cross-lane coordination

You need T1's template engine. T1 will post `### [T1] PROPOSE 2026-05-20 HH:MM ET — template engine exported as <shape>` BEFORE shipping the engine itself. Read that post and plan your inject body against it.

While T1 is still building, you CAN write the endpoint stubs, the request-validation logic, the two-stage submit code (HTTP / `http` module against `127.0.0.1:3000/api/sessions/:id/input`), and the test scaffolding. The only thing that must wait for T1 is the `require('./templates/template-engine').loadTemplate(...)` call inside the inject handler.

Idle-poll regex for T1's LANDED (tolerant of missing `### ` prefix): `^(### )?\[T1\] (LANDED|DONE)\b`.

## Tasks

1. **Baseline.** `cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm test 2>&1 | tail -10`. Record baseline pass/fail.

2. **`POST /api/sprints/inject` (`inject.js`).** Body shape per PROPOSAL §4.2:
   ```
   {
     panels: [{tag, sessionId, role, lane_brief}, ...],
     variables: { sprint_name, sprint_dir, project_name, ... }
   }
   ```
   Steps the handler does:
   - Validate body: every panel has `tag` + `sessionId` + `role` ∈ {`worker`, `auditor`, `orchestrator`}; `variables` is an object.
   - For each panel: `GET /api/sessions/:sessionId` (server-internal call OR direct session-store lookup — match the existing pattern in the server). Read `meta.type` to determine CLI. Reject 400 if session doesn't exist.
   - For each panel: call T1's `loadTemplate(metaType, role, {...variables, lane_brief, lane_tag: panel.tag})`. If T1 throws `MissingVariableError`, propagate as 400 with the missing variable names.
   - **Two-stage submit** (this is the load-bearing pattern from `~/.claude/CLAUDE.md`):
     - Stage 1 (paste): for each panel, `POST /api/sessions/:id/input` with `text = '\x1b[200~' + rendered_template + '\x1b[201~'`. 250ms gap between panels.
     - Settle 400ms.
     - Stage 2 (submit): for each panel, `POST /api/sessions/:id/input` with `text = '\r'`. 250ms gap.
   - After submit, wait ~5s and snapshot `meta.status` per panel. Include in the response.
   - Response shape: `{ ok: true, panels: [{tag, sessionId, status: <meta.status>, statusDetail: <meta.statusDetail>, lastActivity: <ISO>}, ...] }`.

3. **`POST /api/sprints/nudge` (`nudge.js`).** Body shape per PROPOSAL §4.3:
   ```
   {
     panels: [{tag, sessionId}, ...],
     kind: "post-landed-reminder" | "status-check" | "tooling-failure-recover" | "custom",
     context: { open_red, test_repro, custom_text }  // optional, kind-specific
   }
   ```
   Steps:
   - Validate body. `kind` must be one of the 4. For `custom`, `context.custom_text` is required.
   - Pick the nudge text:
     - `post-landed-reminder` → built-in template: "ORCHESTRATOR NUDGE — Sprint <name>. T4 audit found <open_red.file_line> with repro <test_repro>. Your fix should land as `### [T<n>] LANDED ...` to STATUS.md once tests pass + auditor verifies."
     - `status-check` → "ORCHESTRATOR STATUS-CHECK. STATUS.md has been silent for N minutes. Post a `### [T<n>] CHECKPOINT` with your current progress, or `LANDED` if done."
     - `tooling-failure-recover` → "ORCHESTRATOR RECOVERY — your shell tooling appears to have died. POST a final TOOLING-FAILURE CHECKPOINT to STATUS.md with what you've verified so far. The orchestrator will spawn a codex-rescue subagent as the verification fallback."
     - `custom` → use `context.custom_text` verbatim.
   - Run two-stage submit per panel (same as inject's stage 1+2).
   - Response: `{ ok: true, panels: [{tag, sessionId, status, statusDetail, lastActivity}, ...] }`.

4. **Route registration.** Find where existing routes are mounted (search for the existing `/api/sessions` POST handler — the route table is colocated). Mount `/api/sprints/inject` and `/api/sprints/nudge`. Both are POST.

5. **Tests** (`tests/sprint-inject.test.js` + `tests/sprint-nudge.test.js`, ≥8 each):
   - **inject tests:** valid 4-panel inject runs both stages and returns the expected response shape; missing-variable returns 400 naming the variable; unknown role returns 400; non-existent sessionId returns 400; the two-stage timing is exercised (use sinon or test fakes to verify the 400ms settle between stages); template integration uses T1's `loadTemplate` (mock T1's module + assert it was called with `(meta.type, role, vars)`); CLI auto-detection from `meta.type` works for claude-code / codex / gemini / grok.
   - **nudge tests:** each `kind` builds the expected text; `custom` uses `custom_text` verbatim; `post-landed-reminder` requires `context.open_red` and `context.test_repro`; missing context returns 400; two-stage submit fires per panel.

## Discipline

- Post `### [T2] FINDING / PROPOSE / LANDED / DONE 2026-05-20 HH:MM ET — <gist>` to STATUS.md (absolute path: `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-69-orchestration-hardening/STATUS.md`). Your panel's cwd is Maestro; you must `cd` to TermDeck first.
- Run `npm test` before every LANDED.
- Post `### [T2] DONE 2026-05-20 HH:MM ET — <verdict>` when complete.
- Do not bump versions, touch CHANGELOG, or `git commit`.
