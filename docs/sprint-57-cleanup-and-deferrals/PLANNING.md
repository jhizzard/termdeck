# Sprint 57 — Post-Sprint-56 cleanup + Sprint 55 Tier 3 deferrals + HN-post readiness

**Status:** Plan placeholder authored 2026-05-05 ~13:45 ET, immediately after Sprint 56 closed the synthesis bug + verified `rumen_insights` count moved from 321 → 367 (+46) on the daily-driver project. The 4-day flatline is structurally over for Joshua. Sprint 57 cleans up the catch-up overrides, lands the deferred Sprint 55 findings, and clears the path to an HN-shareable post.

**Pattern:** Mixed shape — small mandatory cleanup tasks (revert env vars, Brad outreach) PLUS the Sprint 55 Tier 3 punch list (8+ findings) PLUS the Playwright P0 architectural fix. Likely runs as 3+1+1 with Codex auditor since it's code-shipping work in 3 packages.

**Target ship:** `@jhizzard/termdeck@1.0.12` + `@jhizzard/termdeck-stack@0.6.12` + possibly `@jhizzard/rumen@0.5.4` (if the upstream `started_at` createJob fix lands). Wall-clock estimate: 90-150 min depending on whether the Playwright `--isolated` fix is straightforward or invasive.

## MANDATORY P0 — runs FIRST in this sprint, before anything else

### 1. Revert Sprint 56 catch-up env-var overrides

After the Rumen backlog drains (~2 hours from Sprint 56 close, autonomous over the cron schedule), the override env vars must be unset so future cron ticks revert to the rumen-package defaults (72h lookback / 10 sessions per tick). Leaving them set means every cron tick scans 120 days of history and processes up to 80 sessions — wasteful in steady-state, expensive in Anthropic API calls.

**Pre-condition check:**
```bash
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')
psql "$DATABASE_URL" -c "SELECT count(*) AS still_unprocessed FROM memory_sessions WHERE rumen_processed_at IS NULL AND ended_at IS NOT NULL AND summary IS NOT NULL AND summary <> ''"
# expect: 0 (or near-zero — a few in-flight sessions OK)
```

**Revert command:**
```bash
supabase secrets unset RUMEN_LOOKBACK_HOURS_OVERRIDE RUMEN_MAX_SESSIONS_OVERRIDE \
  --project-ref luvvbrpaopnblvxdxwzb
```

**Verify:**
```bash
supabase secrets list --project-ref luvvbrpaopnblvxdxwzb | grep -E "RUMEN_(LOOKBACK|MAX_SESSIONS)_OVERRIDE"
# expect: zero matches
```

**No redeploy needed** — supabase secrets are read fresh per Edge Function invocation. The next cron tick (within 15 min) will run with rumen-package defaults.

### 2. Verify post-revert behavior on the daily-driver project

After the next cron tick fires post-revert:
```bash
psql "$DATABASE_URL" -c "SELECT substr(id::text, 1, 8) as id, started_at, completed_at, sessions_processed, insights_generated FROM rumen_jobs ORDER BY created_at DESC LIMIT 3"
```
Expected: `sessions_processed = 0` (no fresh sessions in 72h to process; backlog already drained), or `sessions_processed = N` matching whatever new sessions Joshua generated since Sprint 56.

## Sprint 55 Tier 3 deferrals — should ship in this sprint

In priority order:

### 3. Playwright `--isolated` flag (P0 architectural defect from Sprint 55 takeover)

Pre-Sprint-57: Playwright MCP shares one Chrome profile across ALL Claude Code sessions on the machine. T2's UI cells in Sprint 55 hijacked Joshua's parallel-project browser tabs.

Fix: add `--isolated` to the Playwright MCP args in `~/.claude.json` (or whatever config path is canonical for the user). Verify via two simultaneous Claude Code sessions, both calling `mcp__playwright__browser_navigate`, observing TWO independent browser instances spawned.

Memory: `~/.claude/projects/<termdeck>/memory/feedback_playwright_takeover_critical.md` documents the bug in full + the fix direction.

### 4. Flashback negative-feedback persistence (Class I-adjacent silent feedback no-op)

Pre-Sprint-57: user marks a flashback "useless" via the UI. The endpoint records dismissal, but the SURFACE-side query at `packages/server/src/index.js:1058-1100` doesn't consult the `dismissed_at` history before emitting the next proactive hit. Same low-confidence flashback resurfaces.

Fix: add a `WHERE NOT EXISTS (SELECT 1 FROM flashback_events WHERE memory_id = X AND dismissed_at IS NOT NULL)` predicate to the surface query. OR wire the modal feedback ("Not relevant" / "This helped") to a durable endpoint that updates a `flashback_events.user_disposition` column.

T4-Codex Sprint 55 audit addendum at `docs/sprint-55-full-stack-sweep/T4-SWEEP-CELLS.md` has the full diagnosis.

### 5. Dashboard resize-recovery (UX layout-health guard)

Pre-Sprint-57: rapid Playwright resize chain crushed the panel grid into the corner; manual window-resize did NOT trigger reflow.

Fix per Codex's refined proposal: add a post-resize layout-health assertion + forced reflow, NOT just another resize listener (Codex's audit explicitly says the fix shape is the layout-health guard). `packages/client/public/app.js` already wires `window.resize` to debounced `fitAll()` + observes each terminal container with `ResizeObserver`. Need a separate health-check that verifies `#termGrid` itself recovered to usable viewport width after resize.

### 6. T2 API findings (5 deferred from Sprint 55 Phase A)

- F-T2-2: RAG state model — API exposes 2-state boolean, UI surfaces 3-state. Design clarification or unification.
- F-T2-3: Flashback `errorLineStart` pattern matches the literal substring "Error" too aggressively. Pattern tightening.
- F-T2-4: `/api/graph/all` payload size 1.2 MB / 862 ms. Pagination or streaming.
- F-T2-6: RAG state model 2-state vs 3-state (sister of F-T2-2). Decide unified semantics.
- T2 matrix Grok costBand correction (doc-only fix in `T2-SWEEP-CELLS.md` — Codex caught the inaccuracy).

### 7. T2 UI cells deferred (B.10-B.15)

Re-run in controlled-context Playwright session AFTER #3 lands. B.10 mobile/narrow viewport, B.11 panel label inline-edit, B.12 status button disambiguation, B.13 quick launch buttons, B.14 Rumen insights briefing chip, B.15 keyboard shortcuts.

### 8. T1 install-path side-findings (Sprint 55)

- `search_memories()` RPC missing on the daily-driver project (Joshua's box state). Audit-upgrade gap. Possibly mig 005/006 has an idempotency hole. Sprint 55 T1 Cell 20 side-finding.
- Joshua's GLOBAL install on rumen 0.4.4 (latest 0.5.3 now) — auto-upgrade strategy?

### 9. Cross-doctor coverage gap (Sprint 55 T1 Cell 20)

`termdeck doctor` and `mnestra doctor` have intentionally disjoint probe sets, but the surfaces don't disclose the gap to the user. A fresh user running ONE doctor doesn't know there's a sibling probe set covering different ground. Sprint 57 candidate: a `--full` flag on either binary that runs both, OR a top-of-output note pointing at the sibling.

### 10. Sprint 45 upstream rumen-package fix — `createJob` started_at NULL

`~/Documents/Graciella/rumen/src/index.ts:177` — `createJob` INSERT omits `started_at` and the column has no default, leaving 1546+ rumen_jobs rows with NULL started_at over time. Two-line patch: add `started_at` to the INSERT VALUES tuple with `NOW()`. Sprint 45 shipped a TermDeck-side `COALESCE(started_at, completed_at)` read-side fix; the upstream patch removes the workaround once it lands.

If this lands in Sprint 57, ship as `@jhizzard/rumen@0.5.4` cross-repo wave.

## Out of Sprint 57 scope (Sprint 58+)

- **Cost-monitoring expandable dashboard panel** (original Sprint 51 vision). Per-agent subscription-vs-per-token billing exposure. Reads each adapter's `costBand` field. Sprint 58 candidate.
- **Migration-authoring linter** (multiple Sprint 51.x sister incidents canonized this pattern). Sprint 58+ polish.
- **Maestro / chopin-scheduler SaaS readiness.** Independent of TermDeck; resumes after Joshua's mail merge.

## HN/Twitter post readiness gate

After Sprint 57 closes Tier 3 + reverts overrides + verifies cron-default behavior on the daily-driver project, run a final dogfood probe:

1. `rumen_insights` count continues growing past 367 (verifies steady-state insights flow under defaults).
2. `mnestra doctor --json` returns 0 RED, 0 YELLOW (or YELLOWs documented and acceptable).
3. `termdeck doctor` returns "All packages up to date" when stack is fully installed; "no stack packages detected" when not.
4. Re-run Sprint 55 T2's API cell matrix — F-T2-1 confirmed fixed (malformed JSON returns JSON 400, not HTML).

If all 4 pass: **GREEN POST READY.** Joshua drafts HN/Twitter post leveraging Sprint 55 SWEEP-CELLS.md as evidence of the proactive-sweep posture + Sprint 56's empirical fix verification (count moved 321 → 367+).

If any fail: Sprint 58+ closes the gap before posting.

## Brad outreach (post-Sprint-57, NOT in sprint scope)

Brad has v1.0.7 from yesterday + the WhatsApp drafts mentioning v1.0.6/7. He is unaware of Sprint 56's actual fix (rumen 0.5.3 with rebuilt dist) and Sprint 57's overrides revert. After Sprint 57 closes:

1. Send Brad a single WhatsApp via wa.me deep-link inject:
   - "Insights flow is finally fixed. Sprint 54's relate.ts edit didn't ship — npm tarball had stale dist. Sprint 56 rebuilt + republished as rumen 0.5.3. Backlog catch-up via env-var override, now drained. New `prepublishOnly` guard prevents the recurrence class. **You'll want @latest** — `npm install -g @jhizzard/termdeck@latest && termdeck init --rumen --yes`. After your next session-end fires, your insights count will move."
2. **Do NOT mention Sprint 56's catch-up override step to Brad** — his backlog will be similar to Joshua's, but the orchestrator should NOT advise him to set the override env vars without supervision (Anthropic API costs + 504 timeout aesthetics could damage trust). Just have him upgrade; future sessions will populate naturally.
3. Brad outreach is single-shot — Joshua's auto-send WhatsApp automation means draft = sent. Re-read every word before opening the URL.

## What "working for everyone" means after Sprint 57

| User class | Status after Sprint 56 close | Status after Sprint 57 close |
|---|---|---|
| Joshua (daily-driver project) | ✅ Insights flowing; backlog draining; catch-up overrides active | ✅ Steady-state, defaults, full functionality |
| Brad (jizzard-brain) | ❌ Still on v1.0.7 with stale dist; insights blocked | ✅ After Brad-outreach + upgrade: insights work for fresh sessions |
| Fresh new installs (`npx @jhizzard/termdeck-stack`) | ✅ All fixes in latest; works out of box | ✅ Same |
| Existing users with old versions (`@jhizzard/termdeck < 1.0.10`) | ❌ Same as Brad — needs upgrade | ❌ Needs upgrade; no auto-upgrade path exists yet |

**The "everyone" answer is a graduated YES** — the FIX exists for everyone, but each existing user needs to upgrade to consume it. Fresh installs are clean. Brad-class users need a 30-second upgrade pass. The framework has no auto-upgrade mechanism (Sprint 58+ candidate per `auto-upgrade strategy?` follow-up in #8 above).

## Acceptance criteria

1. **Override env vars unset** — verified by `supabase secrets list | grep` returns zero matches.
2. **Cron returns to defaults** — next post-revert cron tick uses 72h lookback / 10 sessions.
3. **Sprint 55 Tier 3 closed or explicitly deferred to Sprint 58.** Each finding either has a FIX-PROPOSED diff applied OR a written deferral with rationale.
4. **Playwright `--isolated`** verified by two simultaneous Claude Code sessions running `mcp__playwright__browser_navigate` and observing two independent browser instances.
5. **HN-readiness gate passes** OR concrete Sprint 58 plan is authored to close gaps.

## Pre-sprint substrate (verify before fire)

```bash
date '+%Y-%m-%d %H:%M ET'

# All packages live + at expected versions
npm view @jhizzard/termdeck version          # expect 1.0.11 (current at Sprint 56 close)
npm view @jhizzard/termdeck-stack version    # expect 0.6.11
npm view @jhizzard/mnestra version           # expect 0.4.3
npm view @jhizzard/rumen version             # expect 0.5.3

# Backlog state — should be near-zero by Sprint 57 start
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')
psql "$DATABASE_URL" -c "SELECT count(*) AS still_unprocessed FROM memory_sessions WHERE rumen_processed_at IS NULL AND ended_at IS NOT NULL AND summary IS NOT NULL AND summary <> ''"

# rumen_insights at Sprint 57 start (should be ~600+ after backlog fully drains: 367 + (249 / batch_avg_emit_rate))
psql "$DATABASE_URL" -c "SELECT count(*) FROM rumen_insights"

# Override env vars (should still be SET pre-Sprint-57)
supabase secrets list --project-ref luvvbrpaopnblvxdxwzb | grep -E "RUMEN_(LOOKBACK|MAX_SESSIONS)_OVERRIDE"
```

## Cross-references

- Sprint 55 SWEEP-CELLS files: `docs/sprint-55-full-stack-sweep/T1-SWEEP-CELLS.md` (5 install-path FIX-PROPOSED diffs), T2-SWEEP-CELLS.md (5 API findings + 6 UI deferrals), T3-SWEEP-CELLS.md (synthesis-bug diagnosis), T4-SWEEP-CELLS.md (Codex audit + 8 own cells)
- Sprint 56 commits: rumen `57976d6`, termdeck `86a0199` + `095c234`
- New feedback memories canonized 2026-05-04/05: codename scrub, WhatsApp auto-send, no-pen-test framing, serial-when-uncertain, Playwright takeover critical, Sprint 55 outcomes
