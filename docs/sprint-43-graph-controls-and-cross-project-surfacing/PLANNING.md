# Sprint 43 — Graph controls, cross-project surfacing, init-rumen wizard repair, Telegram orchestration

**Status:** Planned. Inject when Joshua returns to TMR work after his next non-TermDeck push (Chopin in Bohemia / Maestro / ClaimGuard).
**Target version:** `@jhizzard/termdeck` v0.12.0 (minor — graph viewer gets first-class controls, cross-project surfacing gets a real audit trail, the init-rumen wizard becomes safe for fresh users, and Telegram becomes a first-class orchestration channel).
**Companion bumps anticipated:** `@jhizzard/termdeck-stack@0.4.7` (audit-trail). Mnestra and Rumen unchanged unless T3 (cross-project surfacing) discovers the surfacing path needs a Mnestra-side change.
**Last-published baselines (2026-04-29 morning):** `termdeck@0.11.0`, `mnestra@0.3.3`, `termdeck-stack@0.4.6`, `rumen@0.4.4`. The 0.11.0 ship closed Sprint 42's TMR substrate hardening — graph-inference cron is now active and ticked once successfully (368 cron-inferred edges, 45 cross-project, on petvetbid).

## Why this sprint

Sprint 42 closed the substrate gaps (graph cron alive, PTY reaper, project removal, drag/drop). Joshua's wake-up audit on 2026-04-29 surfaced **four follow-ups** that are now blocking the "TermDeck for outside users" story:

1. **Graph viewer is sparse and lacks controls** (1,042 termdeck nodes, 392 edges, **719 isolated nodes** — 69% of the graph has zero connections). The cron will close some of the gap over time, but the visualization needs first-class controls (hide isolated, min-degree filter, time-window slider, layout presets) so the graph is USEFUL even at current density. The screenshot Joshua shared on 2026-04-29 morning shows a sea of disconnected purple dots with two visible clusters — accurate to the data, but unhelpful as a navigation surface.

2. **Cross-project surfacing is unverifiable.** Joshua has not seen any flashbacks fire yet. The flashback-diag ring is in-memory only — server restart erases the audit trail. There is no persisted record of "did flashback fire when I needed it?" This blocks Joshua's stated concern: *"I want to be sure the learnings are surfacing in proper ways and times to benefit the other projects."* Without persistence, that question is unanswerable.

3. **`init --rumen` wizard is broken for fresh installs.** Sprint 42 close-out hit `Error: entrypoint path does not exist (supabase/functions/rumen-tick/index.ts)` because `rumenFunctionDir()` (`packages/server/src/setup/migrations.js:76`) falls back to a directory that's never populated, AND the npm `@jhizzard/rumen` package doesn't ship `supabase/functions/`. T3 in Sprint 42 was scoped to migration 003 templating, not this resolution path. Joshua manually deployed the Edge Function from the `~/Documents/Graciella/rumen` repo — that workaround doesn't generalize to fresh users.

4. **Telegram MCP is not configured.** Joshua wants to inject + orchestrate from anywhere via Telegram (analogous to the WhatsApp pattern but for inject/status — not just messaging). Currently configured MCPs: `adbliss`, `imessage`, `memory`. No telegram. This is a force-multiplier for the "orchestrate from phone in bed" pattern that worked beautifully on Sprint 42 — Telegram adds bidirectional control that the WhatsApp-only path doesn't offer.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Graph viewer controls** | Add four first-class controls to the graph viewer toolbar: (a) **hide isolated nodes** toggle (would hide 69% of termdeck graph at current density — surfaces the actual structure); (b) **min-degree filter** slider (1, 2, 3+) so users can drill to highly-connected hubs; (c) **time-window filter** (last 7 days / 30 days / 90 days / all) reading from `memory_items.created_at`; (d) **layout selector** (force-directed default, hierarchical for supersedes-chains, radial for hubs). State persists in URL query string (existing `writeUrlState` handles this for the project + mode params). NEW `tests/graph-controls.test.js` covers the filter pure-function behavior with stubbed node/edge data. Acceptance: at default density the graph goes from "sea of disconnected dots" → readable cluster view in one toggle. | `packages/client/public/graph.html` (toolbar — add four control elements next to existing edge-type filters), `packages/client/public/graph.js` (filter functions + state hooks, URL state, layout switch), `packages/client/public/style.css` (control styling), NEW `tests/graph-controls.test.js` |
| **T2 — Flashback persistence + audit dashboard** | The Sprint 39 flashback-diag ring is in-memory; this lane persists each fire to a NEW `flashback_events` table in the local SQLite (mirror to Mnestra is OUT OF SCOPE — flashback is a per-install concern, not a memory-system concern). Schema: `id INTEGER PRIMARY KEY, fired_at TIMESTAMP, session_id TEXT, project TEXT, error_text TEXT, hits_count INTEGER, top_hit_id TEXT, top_hit_score REAL, dismissed_at TIMESTAMP NULL, clicked_through BOOLEAN`. NEW route `GET /api/flashback/history?since=ISO8601&limit=N` returns recent fires. NEW `/flashback-history.html` dashboard page with table + filter + click-through funnel chart (did the user actually use the flashback hit?). This is the audit Joshua needs to answer "did the system surface the right thing at the right time?" | NEW `migrations/00X_flashback_events.sql` (TermDeck SQLite, not Mnestra Postgres), `packages/server/src/flashback-diag.js` (extend `recordFlashback` to also INSERT to SQLite), NEW route in `packages/server/src/index.js`, NEW `packages/client/public/flashback-history.html` + `flashback-history.js`, NEW `tests/flashback-events.test.js` |
| **T3 — `init --rumen` wizard repair** | Fix the `rumenFunctionDir()` resolution path in `packages/server/src/setup/migrations.js:76` so the `init --rumen` wizard works on fresh installs. Three options, pick one: (a) ship `@jhizzard/rumen`'s `supabase/functions/` directory in the npm package's `files` array (1-line change in `~/Documents/Graciella/rumen/package.json` + republish); (b) bundle the Rumen Edge Function source into TermDeck's `packages/server/src/setup/rumen/functions/` directory (mirror the migrations pattern; CI sync from sibling rumen repo at release time); (c) detect the source from a known set of paths (legacy: `~/Documents/Graciella/rumen`, npm global, npm local). Lane brief makes the call empirically — option (b) is the recommendation because it matches how migrations are bundled and avoids an extra rumen publish on each TermDeck release. Pair with: extend `init --rumen` to ALSO deploy `graph-inference` (currently it only deploys `rumen-tick`; T1 from Sprint 42 deployed graph-inference manually). | `packages/server/src/setup/migrations.js:76` (`rumenFunctionDir()` resolution), `packages/cli/src/init-rumen.js::deployFunction` (extend to deploy both functions or factor out the deploy step), NEW `packages/server/src/setup/rumen/functions/{rumen-tick,graph-inference}/` (if option b chosen), NEW `tests/init-rumen-deploy.test.js` |
| **T4 — Telegram MCP integration** | Add `telegram-bot-mcp` (or equivalent — lane brief picks one; `chigwell/telegram-mcp` is the current community leader) to `~/.claude.json` `mcpServers`. Document the bot-creation flow: BotFather → `/newbot` → token → set as `TELEGRAM_BOT_TOKEN` env var. Add Joshua's chat ID as `TELEGRAM_CHAT_ID`. Test the round-trip: orchestrator sends `getUpdates` to read inbound messages from Joshua's phone, sends outbound notifications via `sendMessage`. Document in `docs/TELEGRAM-ORCHESTRATION.md` the pattern: Joshua sends "inject sprint 44" from phone → orchestrator polls Telegram → fires inject script → notifies back via Telegram. This is the bidirectional analog to the WhatsApp `wa.me` pattern (which is one-way: orchestrator sends, Joshua reads). NEW global memory entry recording the Telegram chat ID + bot username + permanent authorization to send to that chat. | `~/.claude.json` (mcpServers entry), NEW `docs/TELEGRAM-ORCHESTRATION.md`, memory entry (CONTACT — permanent), `~/.termdeck/secrets.env` (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) |

## Out of scope (Sprint 44+)

- **Cross-Mnestra federation** — pulling memories from another instance's Mnestra. Out per Sprint 38.
- **Realtime collaborative graph editing** — out per Sprint 38.
- **Graph-aware recall in Flashback path** — would consume Sprint 38's `memory_recall_graph` RPC. Sprint 44+ candidate.
- **Per-project recency half-life in `memory_recall_graph`** — Sprint 44+.
- **`mnestra doctor` subcommand** — Brad's third upstream suggestion 2026-04-28. Still queued; not in this sprint because the substrate concerns (T1-T4) take priority.
- **LLM-classification pass on residual 40 chopin-nashville rows** — Sprint 41 verdict was that those are mostly correctly-tagged competition content. Not worth the API spend unless that audit changes.
- **Auto-detection of project boundaries from on-disk markers (`package.json`, `.git`)** — Sprint 41 PROJECT_MAP relies on regex against cwd; auto-detection is richer. Sprint 44+.

## Acceptance criteria

1. **T1:** At default density (1042 nodes / 392 edges for termdeck), toggling "hide isolated" reduces visible nodes from 1042 → 323 (~31% — only nodes with at least one edge). Min-degree=2 reduces further to ~120. Time-window=last 7 days shows recent activity isolation. Layout switcher visibly changes node arrangement. URL state persists across reload. Tests pass deterministically with stubbed inputs.
2. **T2:** Every flashback fire writes one row to `flashback_events`. After 7 days of normal use, the dashboard shows ≥ 1 fire (or it surfaces "0 fires — flashback might not be firing, or the underlying RAG isn't returning hits — investigate"). Click-through funnel correctly reflects user behavior on the toast.
3. **T3:** `init --rumen` succeeds on a fresh machine without manual workarounds. Both `rumen-tick` and `graph-inference` Edge Functions deploy. Migration 002 + 003 apply with correct project-ref substitution.
4. **T4:** Joshua can send "status" from his Telegram bot chat → receive a structured status reply (sprint state, last cron tick, edge count). Joshua can send "inject sprint 44" → orchestrator fires inject script and replies with session IDs + status. Bot operates only with Joshua's chat ID (allowlist).
5. **Net:** all four lanes ship in ≤ 25 minutes wall-clock. (Sprint 41 was 9 min; Sprint 42 was 12 min. The cumulative-dependency chains in Sprint 43 are looser than Sprint 42's, so should be fast.)

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

```bash
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql

# 1. Cron health: graph-inference-tick should be active. Confirm last_run.
$PSQL "$DATABASE_URL" -c "SELECT jobname, schedule, active, last_run FROM cron.job_run_details WHERE jobname = 'graph-inference-tick' ORDER BY start_time DESC LIMIT 5;"

# 2. Termdeck-project graph density. Drift since Sprint 42 close (392 edges).
$PSQL "$DATABASE_URL" -c "
  WITH td AS (SELECT id FROM memory_items WHERE project='termdeck' AND is_active=true)
  SELECT count(*) AS edges FROM memory_relationships r
   JOIN td s ON r.source_id=s.id JOIN td t ON r.target_id=t.id;"

# 3. Cross-project edges from cron — should be > 45 (Sprint 42 close baseline).
$PSQL "$DATABASE_URL" -c "
  SELECT count(*) FROM memory_relationships
   WHERE inferred_by LIKE 'cron-%';"

# 4. Telegram bot env vars present?
test -n "$TELEGRAM_BOT_TOKEN" && echo "BOT_TOKEN set" || echo "BOT_TOKEN missing — T4 needs Joshua to create bot first"
```

If `graph-inference-tick` hasn't ticked since Sprint 42's manual fire, flag the cron health regression to Joshua before injecting.

## Inject readiness

When Joshua signals "starting Sprint 43" after the next non-TermDeck push:

1. Restart TermDeck server first (latest published v0.11.0 with T2 PTY reaper running).
2. Open 4 fresh Claude Code panels in TermDeck.
3. Open a 5th panel as overnight orchestrator (paste the Sprint 43 prompt block from the bottom of this doc).
4. Say "terminals open, inject Sprint 43" — the orchestrator session fires `/tmp/inject-sprint43-prompts.js` with the two-stage submit pattern.

## Paste-ready prompt block for the overnight orchestrator session

```
You are the orchestrator for TermDeck Sprint 43 (graph controls + cross-project surfacing + init-rumen wizard repair + Telegram orchestration). Joshua has returned from a non-TermDeck push and is ready to fire the next TMR sprint. Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 43 graph controls hide isolated min-degree time window flashback persistence rumenFunctionDir Telegram MCP")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-43-graph-controls-and-cross-project-surfacing/PLANNING.md (this sprint's authoritative plan + lane briefs + paste-ready inject sequence)
7. Read the four lane briefs: T1-graph-controls.md, T2-flashback-persistence.md, T3-init-rumen-wizard-repair.md, T4-telegram-mcp.md.
8. memory_recall(project="termdeck", query="Sprint 42 close-out graph-inference cron 365 edges 45 cross-project PTY reaper init-rumen wizard rumen-tick deploy bug")

Then begin: confirm 4 fresh sessions exist via GET /api/sessions sorted by meta.createdAt. Run the pre-sprint substrate probe (PLANNING.md § "Pre-sprint substrate findings"). If graph-inference cron has gone quiet since Sprint 42 manual fire, flag the regression first. Otherwise fire the Sprint 43 inject using the two-stage submit pattern. Stay in orchestrator mode until all four lanes report DONE in STATUS.md, then run close-out: bump versions (termdeck 0.11.0→0.12.0, termdeck-stack 0.4.6→0.4.7), update CHANGELOG, draft session-end email, commit + give Joshua publish commands. Do NOT publish to npm; do NOT push if tests have new failures; do NOT enable any new pg_cron job without confirming the LATERAL+HNSW rewrite EXPLAIN plan is still healthy.
```

## Anticipated coordination notes

- **T1 ↔ T2** are independent — graph viewer controls vs. flashback persistence. No file overlap.
- **T1 ↔ T3** — both touch `packages/server/src/setup/` adjacent areas (T1 doesn't touch setup; T3 does). No conflict.
- **T2 ↔ T3** — T2 adds a SQLite migration; T3 doesn't touch the SQLite path. No conflict.
- **T2 ↔ T4** — T2 adds a server route + new dashboard page; T4 adds an MCP server entry in `~/.claude.json`. No file overlap (one is repo, one is global config).
- **T3 ↔ T4** — independent. T3 fixes the wizard; T4 adds an external orchestration channel.

## Dependencies on prior sprints

- **Sprint 42 substrate is the prerequisite.** Graph-inference cron must be active (confirmed at Sprint 42 close, 368 edges on first manual tick).
- **Sprint 41 PROJECT_MAP** is canonical for the project taxonomy that T2's flashback dashboard filters by.
- **Sprint 39 flashback-diag** is the in-memory ring T2 extends to a persisted store. Don't replace it — augment it (the in-memory ring stays for the live UI; the SQLite table is the audit trail).

## Joshua's roadmap context (2026-04-29 morning)

Sprint 43 is **post-next-non-TermDeck-push**. Joshua's queue (re-confirmed 2026-04-29):

1. Sprint 42 (DONE) — TMR substrate hardening
2. **Significant progress on other projects** ← Joshua is here next
3. Sprint 43 (this) — graph controls + cross-project surfacing + wizard repair + Telegram

The doc is INJECT-READY. When Joshua decides to fire it, the lane structure + paste-ready prompt + acceptance criteria are all set.

## Open questions for Joshua before inject

- **T4 bot scope:** does the Telegram bot need to be PUBLIC (someone else could DM it) or PRIVATE (allowlist of one chat: Joshua's)? Recommendation: PRIVATE allowlist — orchestration channels with code-execution authority should never be open to drive-by DMs.
- **T1 layout presets:** the lane brief lists three (force-directed, hierarchical, radial). Should there be more (concentric, grid)? Recommendation: ship the three; defer expansion to user feedback.
- **T2 SQLite vs Postgres:** is `flashback_events` per-install (SQLite, lane brief recommendation) or shared (Postgres / Mnestra)? Per-install matches the per-install nature of flashback (each user's PTY error patterns are different). Shared would surface cross-instance patterns but loses per-user tuning. Lane brief picks per-install; revisit if Joshua wants federation later.
