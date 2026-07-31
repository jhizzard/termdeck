# Sprint 84 — "Write-Side Completion" — PLANNING

**Dispatched:** 2026-07-31 ~18:15 ET · 3+1+1 on :3001 · Phase 4 of `EXECUTION-ARC-2026-07-30.md`, pulled forward from ~2026-08-13 by Josh.

## Why pulled forward

The Phase 4 gate (auto-promote flip) requires ~2 weeks of clean promotion dry-run stats. At dispatch, `memory_inbox` holds **exactly 1 row** (rejected, 2026-07-30 — Josh's Phase 1.6 test). There is no write-side volume, so the dry-run clock cannot even start. Every intake ramp this sprint ships starts that clock sooner. The auto-promote flip itself stays gated on Josh's review at ~2026-08-13 — it is NOT in this sprint's scope.

## Dispatch-time ground truth (ORCH-verified, 2026-07-31 ~17:50 ET)

- Stack live: mnestra 0.11.0 / rumen 0.10.0 / termdeck 1.16.0 / stack 1.14.0. Migration 034 applied live, receipt green.
- `graph-consolidation` deployed + first DRY-RUN sane (555 components, 72 qualifying, 2 too_large skipped-not-truncated, largest 756). Live cron 04:00 UTC staged for Josh's hand (classifier blocks ORCH prod writes).
- Cite channel LIVE: 3 cited rows in `memory_recall_log` (first real positives, this ORCH session's boot citations).
- **`memory_inbox`: 1 row total.** And the runbook Part A `*/10` inbox-promote pg_cron is **absent from `cron.job`** (jobs present: rumen-tick */15, graph-inference 03:00, recall-log-purge 03:17, doctrine-scan 03:30, rumen-reinforce 03:45). Ground-truth why (never scheduled vs unscheduled) before re-adding.
- **Write-time extraction telemetry is ZERO** (`memory_entities`=0, `memory_entity_mentions`=0) despite `MNESTRA_EXTRACT_ENABLED=1` in `~/.termdeck/supervisor.env` and 25 memories written since the 17:35 ET bounce. Hypothesis: the flag reaches only the supervisor/bridge process env — stdio MCP servers (Claude Code panels) and SQL-direct paths never see it. T3 ground-truths; the sweep is the systemic answer either way.

## Lanes

- **T1 — Google Sheets intake ramp + harvester** (arc 4.2). Service-account Sheets read → forward into the same inbox-insert path `packages/mcp-bridge/src/tools/propose.js` uses. Append-only; mark-forwarded-never-delete (forwarded stamp lives in the sheet, not deletion). This is the Gemini-web + phone quick-capture path.
- **T2 — `memory_session_record` + ChatGPT/Grok identity maps** (arc 4.4 + 4.8). New bridge tool feeding `memory_sessions` for the Rumen tick; extend the Sprint-76 fail-closed connector identity map (`packages/mcp-bridge/src/policy.js::loadProposeMap/mapClientToSourceAgent`) to `chatgpt-web` + `grok-web`.
- **T3 — Inbox hygiene + extraction sweep** (arc 4.3 + S83 fold-ins). inbox-purge cron (90-day, non-pending only) + pending-age alarm (pending >7d = drain broken) + restore/verify the missing inbox-promote cron + rumen sweep phase for `ingest_capture` writes that bypass write-time extraction (BACKLOG §A). **SR-7 (`memory_entity_relationships`) is CONDITIONAL** — post FINDING with telemetry first; ORCH rules.
- **T4 — Codex adversarial auditor.** Independent reproduction, WIP audit BEFORE FIX-LANDED, CHECKPOINT discipline, non-superuser replay for any migration.

## Contracts between lanes

1. **Inbox-insert contract:** T1's harvester and T2's session tool both terminate in Mnestra writes. Whoever needs a new RPC or column on `memory_inbox`/`memory_sessions` posts `SCHEMA-READY` with the exact signature BEFORE building against it; the other lanes adopt verbatim. One reconciliation ruling max (S83 pattern).
2. **Cron namespace:** T3 owns all pg_cron additions this sprint. T1's harvester cadence, if cron-driven, is REQUESTED from T3 via STATUS post, not self-scheduled. Stagger: nothing at 03:00–04:00 UTC (owned), nothing at */15 (rumen-tick).
3. **source_agent vocabulary:** canonical enum already includes `chatgpt-web`, `grok-web`, `gemini-web`, `claude-web`. Sheets-originated proposals use `gemini-web` unless the sheet row carries an explicit source column. No new enum values without SCHEMA-READY.

## Hard rules (all lanes)

- No version bumps, no CHANGELOG edits, no commits, no publishes — ORCH close-out only.
- Any new migration MUST pass a **non-superuser** apply on a production-shaped container (S83 lesson: the discriminator is the role, not the PG version) and the five RLS/privilege gates (`~/.claude/CLAUDE.md` § Supabase RLS).
- Post shape, ALL lanes, no exceptions: `### [T<n>] VERB 2026-MM-DD HH:MM ET — <gist>`. Example: `### [T1] FIX-LANDED 2026-07-31 18:40 ET — harvester forward path green on live inbox`.
- Idle-poll regex when waiting on another lane: `^(### )?\[T<n>\] DONE\b` (tolerant form). But do NOT background-poll — end turn; ORCH shepherds handoffs.
- The literal internal Supabase project name/ref never appears in any committed artifact — use `<project-ref>` or "the daily driver."

## Out of scope

Auto-promote flip (Josh gate ~08-13) · Sheets *UI/phone shortcut* (Josh operator step; T1 documents the sheet schema + activation README) · Leiden consolidation upgrade · Sprint 68-redux · anything touching `memory_hybrid_search`.

## Verdict flow

Workers → DONE. T4 → AUDIT-PASS/AUDIT-FAIL per lane → FINAL-VERDICT (GREEN/RED) when all three lanes DONE + audits pass. ORCH handles close-out (versions, CHANGELOG, gitleaks, commit, publish hand-off to Josh, memory harvest).

## Resolution (2026-07-31)

**FINAL-VERDICT GREEN at 19:29 ET** — inject 18:07, all three workers DONE + all three T4 AUDIT-PASS by 18:45 (~38 min inject→all-lanes-clean), **zero unresolved AUDIT-FAILs, zero RED verdict cycles**. The 18:45→19:29 gap was a **43-minute parked-auditor stall**: T4 had posted its last AUDIT-PASS and parked at the prompt without issuing FINAL-VERDICT; ORCH detected the park and nudged it closed (the § parked-lanes-do-not-auto-resume doctrine earning its keep — the verdict content was already fully determined by 18:45, the gap was pure shepherding latency). Full lane record in STATUS.md; this section is the close-out summary.

### Per-lane outcomes

- **T1 (Sheets intake harvester) — AUDIT-PASS 18:42.** Five modules under `packages/mcp-bridge/src/harvest/`, zero new dependencies (SA-JWT via `node:crypto`, transport via the Bridge's own `clients/http.js`), zero schema change (fingerprint rides `metadata.sheets`), forwarding through the SAME `clients/mnestra.js::propose()` op every web connector uses. 50 tests / 243 bridge suite green. Ships dark behind `TERMDECK_SHEETS_INTAKE_ENABLED`; activation is a documented ~5-min operator step (`docs/SHEETS-INTAKE.md` — no Google credential exists on the box, R6 ruled no mid-sprint mint).
- **T2 (session-record channel + identity maps) — AUDIT-PASS 18:44.** engram migration 035 (provenance columns + `memory_session_record` RPC, server-minted `web:<agent>:<key>` session_id, double-narrowed upsert, 15 reason codes, five gates + the RLS-was-off closure), TS mirror + webhook op (501 on pre-84 deps, never a 200 for a write that did not happen), bridge tool + `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` gate + `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` knob, vendored 035 + probe + `BUNDLE_MAX` 35. Headline dispatch-time finding stands on the record: **the propose channel was ALREADY open to ChatGPT + Grok via the `client_name` heuristic** — the strict-map knob is the operator's off-switch for name-inferred identity, posture call parked at the ~08-13 gate.
- **T3 (inbox hygiene + extraction sweep) — AUDIT-PASS 18:37.** engram 036 (settled-only purge + `memory_inbox_health` drain-liveness view), rumen 006 (promoter cron restored as canonical `rumen-inbox-promote` @ `*/10`, both-name collapse), 007 (sweep ledger), 008 (04:40 UTC cron), `src/extract-sweep.ts` (~640 LOC) + Edge Function. The sprint's structural upgrade: T3's finding that **all three write paths miss extraction — including the promoter's own INSERT** — turned the sweep from hygiene into the prerequisite for T1/T2's intake ramps. SR-7 recommendation: NO on zero evidence, with the evidence path built (`triples_found` telemetry; the ruling is now a query).
- **T4 (Codex adversarial auditor) — 6 catches, all fixed in-flight, every one independently re-verified before its AUDIT-PASS:** (1) the **035/036 migration-number collision** flagged BEFORE either lane built against a filename (→ R4); (2) the **sweep suite not release-gated** + a test-harness Anthropic-SDK handle keeping the runner open (→ wired into `npm run test`, and the fix yielded a production improvement — lazy client construction); (3) **T1 fingerprint catch 1**: a row whose text mutated between read and stamp was marked forwarded without the new text ever being proposed; (4) **T1 fingerprint catch 2** (the more important call): the half-fix's two disagreeing hashes still stamped over same-text source/project edits (→ ONE fingerprint over A–D as both dedup key and pre-stamp guard); (5) **doc-surface catch 1**: the runbook's §A3 AND Rollback blocks preserved the two-name cron hazard R3b had ruled out (the Rollback instance was the worse one — an operator would have believed the drain stopped while it kept promoting); (6) **doc-surface catch 2**: the operator activation path documented only the propose channel, a JSON shape the CSV parser silently zero-parses, and a stale healthz count. Non-superuser replays for every migration (T4's own container, `rolsuper=false`), hostile fixtures independently rerun, file-diff-over-worker-prose throughout.

### The rulings

1. **R1 (18:20)** — strict-map ratified as proposed: heuristic stays default, knob ships default-OFF; the flip is an operator-posture call at the ~08-13 gate, alongside the promotion review.
2. **R2 (18:20)** — migration 035 SCHEMA-READY ratified; the server-minted session_id prefix named as the load-bearing defense for T4 to audit specifically.
3. **R3 (18:20) + R3b (18:24)** — promoter restore: migration is the single source of truth; R3b corrected cadence to `*/10` on T3's contract-2 argument (at `*/15` the promoter fires simultaneously with rumen-tick on every tick), delivered as NEW rumen 006 superseding the immutable shipped 003.
4. **R4 (18:24)** — collision reconciled: 035 belongs to T2 (posted first, ratified in R2 — renumbering a ratified contract reopens it for no gain); T3's hygiene migration renumbers to 036, content unchanged.
5. **R5 (18:24)** — T3's sibling-module deviation approved: `rumen-extract-sweep` as its own function + cron, not a tick phase — the tick-budget starvation argument is decisive and matches the reinforce/doctrine-scan/graph-consolidation precedent.
6. **R6 (18:24)** — T1's faked-transport E2E accepted, no mid-sprint credential mint; quarantine-not-coerce and the `packages/mcp-bridge/src/harvest/` placement (tarball analysis) ratified.
7. **Queued, not mid-sprint:** the `~/.claude.json` mnestra `env` block (`MNESTRA_EXTRACT_ENABLED=1`) applies only AFTER panels close — live-editing that file under three running Claude panels risks a rewrite race on panel exit.

### Shipped versions

| package | version | status |
|---|---|---|
| `@jhizzard/mnestra` | **0.12.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/rumen` | **0.11.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/termdeck` | **1.17.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/termdeck-stack` | **1.15.0** | committed (audit-trail bump), publish pending |

### What ships dark

Every behavior change in this sprint is flag-gated and **all three flags default OFF**: `TERMDECK_SHEETS_INTAKE_ENABLED` (harvester runner exits immediately without it), `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` (tool absent from the listing, not present-and-erroring), `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` (OFF-path byte-identical to pre-84 behavior, T4-verified). Nothing changes on any install — Josh's or Brad's — until an operator sets a flag. The one non-flag change a `termdeck init --mnestra` picks up is migrations 035/036 themselves: additive columns, two RPCs, a view, no rewrite of existing rows.

### What starts the promotion dry-run clock

The sprint's headline goal — the Phase-4 gate needs ~2 weeks of clean promotion dry-run stats, and the clock could not start on a 1-row inbox — advances only when the operator tail executes:

1. **Live applies** (post-publish): engram 035 → 036; rumen 006 → 007 → deploy `rumen-extract-sweep` (pin 0.11.0 is real only after publish) → 008. First sweep run `RUMEN_SWEEP_DRY_RUN=1`.
2. **The restored promoter cron** (`rumen-inbox-promote` @ `*/10`, rumen 006) — this is the drain whose liveness the 2-week statistic measures; `memory_inbox_health` alarms if it dies.
3. **Operator activation**: Sheets (mint SA, share sheet as Editor, 4 env vars, `run.js --once`), the panels-closed `~/.claude.json` extract-flag block, and the ~08-13 posture decisions (strict-map ON + `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` per runbook Part B4/C).

Auto-promote remains OUT of scope — Josh's ~2026-08-13 review gate, unchanged.

**Full operator tail + restart context: `docs/RESTART-PROMPT-2026-07-31-post-sprint-84.md`.**
