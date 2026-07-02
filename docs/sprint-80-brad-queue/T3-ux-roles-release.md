# T3 — UX/roles/caps + release-prep lane (FR-1 + FR-2 + FR-3)

You are T3 in Sprint 80 (Brad Queue). You own the three smaller FRs plus release staging (staging only — ORCH executes the close-out). Boot sequence:

1. `memory_recall(project="termdeck", query="session roles panel border transcript view client app.js")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-80-brad-queue/PLANNING.md` + `STATUS.md`
5. Read this brief, then RE-VERIFY anchors (briefs are hypotheses; post drift as FINDING)

## FR-2 — `master-orchestrator` role tier (do first; smallest, unblocks Brad's fleet legibility)

- Add `'master-orchestrator'` to `ALLOWED_SESSION_ROLES` (`packages/server/src/index.js:168`).
- Client CSS: `.term-panel.role-master-orchestrator` gold border; `.term-panel.role-orchestrator` moves to silver/grey (`packages/client/public/app.js` + stylesheet — find where role classes are applied). Check chips/legend/role badges for hardcoded role lists; update all of them (grep `'orchestrator'` across client).
- Acceptance: `PATCH /api/sessions/:id {"role":"master-orchestrator"}` → gold; existing orchestrator panels → silver; invalid roles still 400.

## FR-1 — transcript newest-first toggle

- Transcript/session-log UI lives around `packages/client/public/app.js:5708` (`transcriptState`, `btn-transcripts`). Add a per-user toggle (localStorage persistence) that renders entries newest-first. Default unchanged (oldest-first). Keep it pure-client — no server change.

## FR-3 — panel-count cap → config

- **Verify first:** 2026-07-01 grep found NO hardcoded `maxPanels`-style cap in `index.js`. Find what Brad actually hit at 30–40 panels: check `POST /api/sessions` (`index.js:2285`) for guards, any spawn-time limits, and plausible non-TermDeck ceilings (ulimit, node-pty). Post a FINDING with the truth before coding.
- Deliverable per PLANNING §3.6: `maxPanels` config key (config.yaml + env override), clear 429 JSON on breach, README section with per-OS PTY headroom notes (Linux default kernel pty max 4096 — an app cap is the only realistic bottleneck; macOS differs). If no app cap exists today, ship the configurable guard defaulting to a value ≥ current effective behavior so nothing regresses.

## Release staging (STAGING ONLY — no bumps, no commits in-lane)

Prepare a `RELEASE-STAGING.md` in this sprint dir for the ORCH close-out: draft CHANGELOG entries for termdeck 1.12.0 + stack 1.10.0 covering (a) this sprint's items, (b) `d5436cf` supervise webhook-secret fix (unversioned since Sprint 78), (c) `564e788` rumen-tick wrapper watchdog, (d) note that `@jhizzard/rumen@0.6.1` publishes in the same Passkey session. Cross-check `docs/RELEASE.md` order + the stack-installer audit-trail bump requirement. Draft the Brad reply-email skeleton (PLANNING §6.2) — per-item queue disposition + the 06-09 cutover answers (two-instance support, bridge flush-before-recall semantics, Gemini OAuth path — pull truth from Sprints 71–76 CHANGELOG/docs, don't guess).

## Lane discipline

Post `### [T3] VERB 2026-MM-DD HH:MM ET — gist` (exact shape, `### ` prefix). Client `app.js` is shared with T2's header work — coordinate via HANDOFF-REQUEST if you touch the panel-header region. No version bumps, no CHANGELOG edits outside the staging draft, no commits. DONE post includes test counts + screenshots-or-DOM-assert evidence for the visual items.
