# T2 — Empirical /exit capture proof (PRIORITY)

You are T2 in Sprint 63 = Wave 2. **Your lane is THE load-bearing acceptance for Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md`.** Sprint 62 closed it on code/test grounds (fence tests prove the wire-up). This sprint closes it on **acceptance grounds** — real panels, real `/exit` events, real Mnestra rows.

## Boot sequence

1. `mcp__mnestra__memory_recall(project="termdeck", query="adapter session-end writer source_agent /exit capture")`
2. `mcp__mnestra__memory_recall(query="Sprint 62 onPanelClose memory_items mnestra_session_summary dual-schema")`
3. Read `~/.claude/CLAUDE.md` (global rules — especially no-forbidden-literals and no-pen-test-framing)
4. Read `./CLAUDE.md` (TermDeck project read-order)
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` IN FULL — both the question and the Resolution section for Investigation 1
6. Read `docs/sprint-63-wave-2/PLANNING.md`
7. Read `docs/sprint-63-wave-2/STATUS.md`
8. Read this file in full
9. Read `packages/server/src/index.js:192-223` (`onPanelClose`), `packages/server/src/index.js:1163` (`term.onExit` registration), `packages/server/src/index.js:1353-1363` (`DELETE /api/sessions/:id` route)
10. Read `packages/server/tests/adapter-session-end-writer.test.js` — the Sprint 62 fence tests; understand how they prove the wire-up; then design the live acceptance test as the next layer up

Then begin.

## What you are proving

> **When the operator types `/exit` (or hits `DELETE /api/sessions/:id`) in a TermDeck panel running any of Claude, Codex, Gemini, or Grok, the panel's transcript writes a `session_summary` row to Mnestra. For dual-schema reference installs (Joshua's personal setup), the write lands in BOTH `memory_items` AND `mnestra_session_summary`.**

If any of the 4 adapters silently skips the write, this lane is FINAL-VERDICT RED until you root-cause why and either fix it (in-lane) or post a scope question to orchestrator for help.

## Method

### Step 0 — Pre-flight

Confirm Mnestra is firing on Joshua's machine:
```bash
curl -s http://127.0.0.1:37778/healthz | jq .
```
Expected: `{"ok": true, "version": "0.2.x", "store": {"rows": <N>, "last_write": "..."}}` with `last_write` non-null. If unreachable, post `### [T2] FINDING 2026-05-11 HH:MM ET — mnestra serve unreachable, sprint blocked on substrate` and idle.

Confirm `~/.termdeck/secrets.env` has a populated `DATABASE_URL` (you'll need it for the live psql probe). DO NOT print the value into STATUS.md.

### Step 1 — Generate 4 canary phrases

Each phrase MUST be unique enough that grep can't false-match historical rows. Use:
- `sprint-63-acceptance-canary-claude-2026-05-11-${random4}`
- `sprint-63-acceptance-canary-codex-2026-05-11-${random4}`
- `sprint-63-acceptance-canary-gemini-2026-05-11-${random4}`
- `sprint-63-acceptance-canary-grok-2026-05-11-${random4}`

Post `### [T2] FINDING 2026-05-11 HH:MM ET — canary phrases` to STATUS.md so T4-CODEX can use the same phrases for independent verification.

### Step 2 — Drive 4 panels

For each adapter `claude|codex|gemini|grok`:
1. `POST /api/sessions {"type": "<adapter>"}` → get `id`.
2. Inject a non-trivial prompt that includes the canary phrase. Use the same two-stage paste+submit pattern from the orchestrator inject (bracketed paste + 400ms settle + `\r`). Make it substantive — `MIN_TRANSCRIPT_BYTES=5KB` threshold means a one-liner gets silent-skipped.
3. Wait for the adapter to produce a response (poll `/api/sessions/:id/buffer` for `status: 'active'` after `'thinking'`).
4. `DELETE /api/sessions/:id` — the production close path.

The session-end writer fires asynchronously via `spawn(hook)`. Allow ~15s for the chain to complete per panel.

### Step 3 — Probe Mnestra

Via psql with DATABASE_URL:

```sql
-- Schema A: memory_items (canonical)
SELECT source_agent, source_type, project, length(content) AS bytes, content
  FROM memory_items
 WHERE content ILIKE '%sprint-63-acceptance-canary-%'
   AND created_at > NOW() - INTERVAL '30 minutes'
 ORDER BY created_at DESC
 LIMIT 20;

-- Schema B: mnestra_session_summary (dual-schema reference install)
SELECT source_agent, length(summary) AS bytes, summary
  FROM mnestra_session_summary
 WHERE summary ILIKE '%sprint-63-acceptance-canary-%'
   AND created_at > NOW() - INTERVAL '30 minutes'
 ORDER BY created_at DESC
 LIMIT 20;
```

### Step 4 — Acceptance gate

- **Schema A:** 4 distinct rows, one per `source_agent IN ('claude', 'codex', 'gemini', 'grok')`. Each row's `content` contains the matching canary phrase.
- **Schema B:** 4 distinct rows, same shape, in `mnestra_session_summary`.
- If either schema returns <4 rows, **DO NOT post `DONE`.** Post `### [T2] FINDING 2026-05-11 HH:MM ET — <adapter X> wrote 0 rows; investigating` and root-cause.

Known silent-skip surfaces (per Sprint 62 Resolution section):
- `MIN_TRANSCRIPT_BYTES = 5KB` at the hook level — adapter transcripts under 5KB are silent-skipped. Mitigate by feeding substantive content.
- `<5 messages` threshold — too short a conversation also silent-skips.
- `ALLOWED_SOURCE_AGENTS` whitelist — claude/codex/gemini/grok/orchestrator. Other source_agent values get rejected.

If a real silent-skip surface bites, surface it as FINDING with file:line evidence; orchestrator may scope-expand to ship a fix or punt to Sprint 64.

### Step 5 — Artifact

Author `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` with:
- The 4 canary phrases used (full).
- The exact `POST /api/sessions` + `DELETE /api/sessions/:id` cURLs.
- The psql output for both schemas. **Scrub the project ID + internal project name per global hygiene rule** (use "the reference Mnestra project" or elide).
- Row counts per adapter per schema.
- Timestamp range (`created_at` window).
- File:line evidence for the `onPanelClose` → `spawn(hook)` chain (cite `packages/server/src/index.js:192-223` + `:1353-1363`).
- A "what would have failed silently" section listing the silent-skip surfaces you checked but didn't trip.

Then post `### [T2] DONE 2026-05-11 HH:MM ET — 4/4 adapters proven both schemas; artifact at docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`.

## Hygiene reminders

- **NEVER include the literal reference Mnestra project ID or internal project name in any STATUS post, FINDING, or artifact.** Gitleaks pre-commit will block. Use "the reference Mnestra project" or elide.
- **NEVER use "pen-test" framing** in this sprint's external-facing artifacts. Use "end-to-end functional sweep" or "acceptance verification."
- **No version bumps / CHANGELOG / commits** from this lane — orchestrator handles at sprint close.

## Post discipline

`### [T2] STATUS-VERB 2026-05-11 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING (frequent — this lane is exploratory) → FIX-PROPOSED (if you need to ship a fix to close a silent-skip surface) → DONE.

T4-CODEX will independently reproduce. Plan for the auditor's queries to match yours — share canary phrases via STATUS.md.
