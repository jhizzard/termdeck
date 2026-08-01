# RESTART PROMPT — 2026-07-31 (post-Sprint-84) — publish wave + live applies + activation tail

**Audience: a fresh orchestrator session.** Sprint 84 is fully built, audited GREEN — and as of
the 2026-08-01 update pass, §2 items 1–5 are **DONE** (published, pushed, tagged, applied live,
crons running). What remains is the §2.6–2.7 activation tail, the §6 post-wrap addendum items,
and the ~08-13 gate. Read fully before acting; §6 carries the freshest state.

## 0. Arc position

Execution arc `SideHustles/TermDeck/EXECUTION-ARC-2026-07-30.md`: **Phases 0–3 COMPLETE; Phase 4
BUILD COMPLETE** (pulled forward from ~08-13 by Josh — at dispatch `memory_inbox` held exactly
1 row, so the promotion dry-run clock could not start). **The Phase 4 GATE (~2026-08-13) remains:**
Josh reviews ~2 weeks of clean promotion dry-run stats, then decides auto-promote + the write-flag
postures. Sprint 84 (2026-07-31): 3+1+1 on :3001, inject 18:07 ET → all lanes DONE+AUDIT-PASS
18:45 → FINAL-VERDICT GREEN 19:29 (the 43-min gap was a parked auditor, ORCH-nudged closed — the
verdict content was determined by 18:45). Committed, publish PENDING:
`@jhizzard/mnestra@0.12.0` (035 session-record RPC + provenance columns; 036 inbox purge + health
view), `@jhizzard/rumen@0.11.0` (extract-sweep backstop + `rumen-inbox-promote` cron restore
006/007/008), `@jhizzard/termdeck@1.17.0` + stack `1.15.0` (Sheets harvester, session-record
bridge channel, strict-map knob, vendored 035/036 + rumen 006–008, runbook overhaul, redact.js
NUL fix). **Everything ships dark — all three flags default OFF.** Full record:
`docs/sprint-84-write-side-completion/{PLANNING,STATUS}.md` (PLANNING §Resolution is the summary).

**The finding worth knowing cold:** the propose channel was ALREADY open to ChatGPT + Grok via
the `client_name` heuristic before this sprint — the operator map's Claude-only contents never
restricted them (heuristic fallback). Not an escalation (only `*-web` values can be minted, the
RPC re-checks server-side), but provenance was name-inferred. The strict-map knob
(`TERMDECK_BRIDGE_PROPOSE_STRICT_MAP`, default OFF) is the off-switch; flipping it is a posture
decision at the ~08-13 gate, with runbook Part B4's pre-built operator block.

## 1. Boot (fresh session)

1. `memory_recall(project="termdeck", query="Sprint 84 write-side completion session record sweep")`
2. `memory_recall(query="recent decisions promotion dry-run clock Phase 4 gate")`
3. Read `~/.claude/CLAUDE.md` and termdeck `./CLAUDE.md`; then this doc.
4. **Shard/index the prior orchestrator transcript — the arc continues and it is live
   substrate.** Session `cdd8d386-cc61-453f-9322-92db1f5d84a9` at
   `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck/cdd8d386-cc61-453f-9322-92db1f5d84a9.jsonl`
   holds the full Sprint 84 arc: all seven ORCH rulings (R1–R6 + the queued env-block call),
   the 035/036 collision reconciliation, the parked-auditor detection + nudge, and every
   close-out receipt. Procedure (exactly as the S83 doc executed for `cb6cb639`):
   (a) verify the hourly `~/.claude/session-index/` launchd has indexed + archived it
   (`grep -rl cdd8d386 ~/.claude/session-index/`; run `build-index.py`/`sync.sh` manually
   if not); (b) produce the complementary Mnestra summary — extract user/assistant TEXT
   turns from the JSONL (skip tool_use/tool_result noise, cap ~700 chars/turn, shard to
   ≤36K chars), prepend a one-line provenance header, feed each shard to
   `memory_summarize_session(project="termdeck")`; (c) for deep context mid-work, grep the
   JSONL or resume it:
   `cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume cdd8d386-cc61-453f-9322-92db1f5d84a9`
5. Substrate preflight only if dispatching panels: `GET /api/sessions` on the port Josh names.

## 2. Immediate tail (STATUS PASS 2026-08-01 ~13:10 ET: items 1–5 DONE, 6–7 open, 8 RESOLVED)

> **✅ 1–2 DONE 07-31 evening:** all four published + registry-verified (mnestra 0.12.0 / rumen
> 0.11.0 / termdeck 1.17.0 / stack 1.15.0); pushed + tagged (engram `ea7811d`/v0.12.0, rumen
> `9357658`/v0.11.0, termdeck `8be898b`/v1.17.0), gitleaks clean throughout.
> **✅ 3 DONE:** apply-s84-live.sh ran green — 035/036 applied (receipts pass), rumen 006/007
> applied, `rumen-extract-sweep` deployed, 008 applied; first sweep DRY-RUN: 150 candidates,
> would-write 461 entities + 248 triples (SR-7 density evidence). **⚠ BUT: `RUMEN_SWEEP_DRY_RUN`
> was NEVER unset — still set as of 08-01 13:07 ET — so the overnight 04:40 sweep wrote NOTHING.
> Unsetting it is now the top §6 action.**
> **✅ 4 DONE:** graph-consolidation cron live (jobid 29, 04:00 UTC), DRY_RUN cleared 07-31.
> **⚠ Verify its overnight output:** a 08-01 13:08 ET probe found 0 rows with
> `source_type='consolidation'` despite 94 overnight cron firings across the new jobs — either
> the summaries land under a different source_type (check S83's I4-b option (a) ruling + the
> edge-function logs) or the 04:00 run silently no-opped. First boot task.
> **✅ 5 DONE:** `~/.claude.json` mnestra env block applied 07-31 (backup
> `~/.claude.json.bak-2026-07-31-s84`) — panels spawned AFTER then get write-time extraction.
> **✅ 8 RESOLVED 07-31/08-01:** the Claude AI feedback arrived and was fully handled — see §6.

1. **Josh Passkey publish wave — strict RELEASE.md order, npm BEFORE push:**
   `@jhizzard/mnestra@0.12.0` → `@jhizzard/rumen@0.11.0` → `@jhizzard/termdeck@1.17.0` →
   `@jhizzard/termdeck-stack@1.15.0`. Every publish is `npm publish --auth-type=web`
   (Passkey, NEVER `--otp`). For termdeck: `npm pack --dry-run` first and confirm the tarball
   carries `packages/server/src/setup/mnestra-migrations/035_*.sql` + `036_*.sql`, the rumen
   `006/007/008` vendored migrations, and `packages/server/src/setup/rumen/functions/rumen-extract-sweep/index.ts`.
   Do NOT run `npm run sync-rumen-functions` blindly — the rumen repo's `rumen-extract-sweep`
   + bundled copy are already pinned `@0.11.0` and in sync (verify with `cmp` if the script ran).
2. **ORCH push + tags — only AFTER all four publishes succeed** (Sprint-35 lesson: origin/main
   must never claim a version npm doesn't have): `git push` in engram, rumen, termdeck; then tags
   per each repo's convention.
3. **Live applies** via `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/sprint-toolkit/apply-s84-live.sh`
   (sibling dir of the repo, NOT committed): engram **035 → 036** (receipts hard-fail; 035's
   receipt includes the RLS-enable + grant-revoke proof), rumen **006 → 007** → deploy
   `supabase functions deploy rumen-extract-sweep` (pin `npm:@jhizzard/rumen@0.11.0` is real
   only after step 1) → **008** (cron only after the function exists). Then the first sweep run
   with `RUMEN_SWEEP_DRY_RUN=1` — read `candidates` / `triples_found` / the capability line.
   Restoring `rumen-inbox-promote` @ `*/10` (006) is what **starts the promotion dry-run clock**.
4. **graph-consolidation cron** (Sprint-83 leftover, still pending unless already run):
   `sprint-toolkit/activate-graph-consolidation-cron.sh` — 04:00 UTC, staged for Josh's hand.
   Verify against `cron.job` before running (never double-schedule).
5. **`~/.claude.json` mnestra env block — ONLY after all panels close** (rewrite-race: a panel
   exit rewrites the file and clobbers a live edit): add `"env": {"MNESTRA_EXTRACT_ENABLED": "1"}`
   to the `mnestra` MCP entry so stdio panels finally reach write-time extraction (T3 gap 1;
   the sweep covers the backlog either way).
6. **Sheets activation (Josh, ~5 min,** `docs/SHEETS-INTAKE.md` **§ Activation):** mint the
   service account, share the sheet as **Editor** (not Viewer), set the 4 env vars, then
   `node packages/mcp-bridge/src/harvest/run.js --once` and confirm the real inbox row id.
   Until then T1's lane is dark and the Gemini/phone capture path does not exist.
7. **Bridge write-flag posture — decide at the ~08-13 gate, not before** (runbook Part B4/C):
   `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1` (Channel 2 on) and strict-map
   (`TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1` after pasting Part B4's 8-client operator block).
   Part B4 is flagged as worth doing **even with both channels off** — it concerns the channel
   that is already on.
8. **OPEN — Claude AI web-interface failure feedback task:** Josh to supply the content;
   nothing actionable until he does. Carry it forward, do not drop it.

## 3. Phase 4 gate (~2026-08-13)

Trigger: Josh reviews ~2 weeks of promotion dry-run stats ("show me the promotion dry-run
report" — `memory_inbox_health` + `cron.job_run_details` for `rumen-inbox-promote` +
promoter report rows). If clean → auto-promote flip decision, strict-map posture, Channel-2
activation (§2.7), and the SR-7 revisit with T3's ready-made density query (BACKLOG §A —
one `select` against `rumen_extraction_sweep` after the first live sweep).

## 4. Sprint 68-redux (standalone-shell capture) — after the gate or parallel Deck B

Unchanged from the S83 doc: re-scope first (Gemini-native-hook approach obsolete; redesign
around the Sprint-70 stdout-wrapper pattern). Staged briefs in `docs/sprint-68-standalone-shell-capture/`.

## 5. Watch items (not tasks)

- **`memory_inbox_health.alarm`** — fires when pending >7d; that means the drain died and the
  dry-run statistic is corrupt. One `select * from memory_inbox_health` answers it.
- **First real sweep pass after dry-run** — `rumen_extraction_sweep` ledger rows + entity counts
  moving off 0 is the graph layer finally eating; `triples_found` density feeds the SR-7 call.
- **RLS-was-off drift audit** (BACKLOG §A): whether OTHER tables besides `memory_sessions`
  (and 028's `memory_items`/`memory_relationships`) have hand-enabled RLS a clean chain misses.
- Label accumulation continues: `fit-platt` reruns unchanged once ≥100 real positives.
- Sheets no-CAS window + `ts`-edit re-propose semantics are ACCEPTED residuals (BACKLOG §A) —
  do not re-triage them as bugs.

## 6. Post-wrap addendum (2026-07-31 late → 2026-08-01) — freshest state, read before §2

Everything below happened AFTER the original wrap draft; it supersedes any §2/§5 line it touches.

**Open actions, in priority order:**
1. **Unset `RUMEN_SWEEP_DRY_RUN`** (still set 08-01 13:07 ET; every nightly sweep is a no-op
   until then): `cd ~/Documents/Graciella/rumen && supabase secrets unset RUMEN_SWEEP_DRY_RUN
   --project-ref <daily-driver-ref>`.
2. **Verify graph-consolidation's overnight output** (0 rows at `source_type='consolidation'`
   despite the cron firing — mapping or silent no-op; check edge-function logs + the S83 I4-b
   source_type ruling).
3. **Load the vault-regen launchd** (staged, NOT loaded; no nightly regen has run):
   `cp sprint-toolkit/com.jhizzard.mnestravault.plist ~/Library/LaunchAgents/ && launchctl load
   -w ~/Library/LaunchAgents/com.jhizzard.mnestravault.plist`. Regen now targets
   `/Volumes/Crucial X6/mnestra-vault` with a mount guard.
4. **Sheets activation** (§2.6, unchanged) and **doctrine ratify** (S83 leftover) remain open.
5. **Delete the old SSD vault** at `SideHustles/TermDeck/mnestra-vault/` once Josh confirms the
   external one opens (Obsidian is installed + registered on the Crucial X6 copy).
6. **Confirm the rig artifact is public** before Brad needs it (it started private):
   `https://claude.ai/code/artifact/93e57c23-e77e-44f0-a4ed-ba3af608af1c`.

**What landed post-wrap:**
- **Obsidian is fully live:** installed 1.13.4 (brew; free, no subscription), vault fresh-exported
  to `/Volumes/Crucial X6/mnestra-vault` (8,981 notes / 5,811 wikilinks, APFS), `.obsidian/`
  proven regen-safe, graph.json pre-tuned (orphans hidden, source_type color groups), first-time
  guide at `SideHustles/TermDeck/obsidian-first-time-guide.html`. Queued work item: MOC hub notes
  per project/community in vault-export for graph navigability.
- **Brad thread (WhatsApp, 3 sends, all `sent`-verified):** his setup-guide artifact was refreshed
  to the 0.12.0/036 stack and republished at the same URL; LESSON: share artifact links WITHOUT
  the `?org=` param — it blocks non-org viewers ("bad link"). His "store external chats?" question
  answered: guide = reads + quarantined proposals; full conversation-storage = the default-OFF
  session-record channel. **OWED to Brad: the two-line Channel-2 activation once he's up and
  running.** The session-index→Sheets rig now has its own replication artifact (local canonical:
  `SideHustles/TermDeck/session-index-sheets-rig.html`).
- **Operator board** (`execution-arc-operator.html`) synced to Phase-4-BUILD-COMPLETE state;
  Phase 5 marked NEXT ACTIONABLE (re-scope Sprint 68-redux per §4).
- **Send-routing doctrine (Mnestra'd):** the permission classifier blocks SUBAGENT sends to real
  external contacts — subagents diagnose/draft and return READY-TO-FIRE text; the MAIN session
  fires every external send.
- **Retrieval BACKLOG batch** from the claude.ai feedback audit pushed as termdeck `c7bf330`
  (recency-vs-keyword ranking, prose-supersession→structural conversion, scoreBandPercentile
  surfacing, web-surface `source_agent` NULL stamp); bridge port-resolver fix `1c52d3b` live
  (bounced 07-31 20:23 ET).
