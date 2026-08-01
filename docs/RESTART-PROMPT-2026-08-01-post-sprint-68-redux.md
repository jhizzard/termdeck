# RESTART PROMPT — 2026-08-01 (post-Sprint-68-REDUX) — publish pending, then the ~08-13 gate

**Audience: a fresh orchestrator session.** Sprint 68-REDUX (standalone-shell capture via PATH
shims) is BUILT, audited **FINAL-VERDICT GREEN 16:51 ET**, committed — publish PENDING (Josh
Passkey). This closes Phase 5 of `SideHustles/TermDeck/EXECUTION-ARC-2026-07-30.md`; after the
publish wave the arc's remaining substance is the **~08-13 promotion gate** (4.5–4.7).

## 0. What shipped today (2026-08-01, one session)

1. **Rumen 0.11.1** — graph-consolidation `category` CHECK fix (S83 dry-run masked it; first
   live cron run wrote 0 rows on constraint 23514). Published + pushed + tagged + function
   redeployed + live-verified: first 20 `consolidation_summary` rows ever (`written=20, 0
   errors`); remaining ~52 qualifying communities drain nightly at 04:00 UTC.
2. **§6 tail closed**: `RUMEN_SWEEP_DRY_RUN` unset (04:40 sweeps write real); vault-regen
   launchd loaded (`com.jhizzard.mnestravault`); session `cdd8d386` sharded → 34 Mnestra facts.
3. **Sprint 68-REDUX** (3+1+1 on :3001, inject 15:29 ET → GREEN 16:51 ET): PATH shims
   `~/.termdeck/shims/{codex,grok,agy}` — content-marker resolution, `script(1)` PTY tee,
   canonical-redactor drain, durable envelope + `raw_transcript_path`, D1′ OR-guard dedup
   (`TERMDECK_PANEL_SESSION` now set server-side), installer/refresh/uninstall/doctor, 97
   fences, gate 1311/1306/0. Live acceptance row-verified per CLI (grok `85e86311`, codex
   `74cf2626`, agy `e36b15fb`). Full record:
   `docs/sprint-68-redux-standalone-shell-capture/{PLANNING,STATUS}.md` (PLANNING §Resolution
   is the summary).

## 1. Boot (fresh session)

1. `memory_recall(project="termdeck", query="Sprint 68 redux shipped PATH shims standalone capture")`
2. `memory_recall(query="recent decisions promotion gate consolidation drain")`
3. Read `~/.claude/CLAUDE.md`, termdeck `./CLAUDE.md`, then this doc.
4. Shard/index the prior orchestrator transcript per the standing §1.4 procedure (S84 doc):
   session id in the wrap email's §5 resume command; verify `~/.claude/session-index/` has it,
   then text-turn shards → `memory_summarize_session(project="termdeck")`.

## 2. Immediate tail

1. **Josh Passkey publish wave — strict RELEASE.md order, npm BEFORE push:**
   `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm publish --auth-type=web`
   then `cd packages/stack-installer && npm publish --auth-type=web`
   (`@jhizzard/termdeck@1.18.0`, `@jhizzard/termdeck-stack@1.16.0`; tarballs pre-verified —
   shims + redact.js + all three vendored rumen functions incl. the new graph-consolidation).
2. **ORCH after publish**: registry-verify both → `git push origin main` → tag `v1.18.0` +
   push tag → `npm i -g @jhizzard/termdeck@1.18.0` dogfood (§ RELEASE.md verification) —
   the global install also delivers the ports.json-writing server + the shims via stack refresh.
3. **Shim activation on the daily driver** (operator or ORCH): `npx @jhizzard/termdeck-stack`
   (or `termdeck init --mnestra` refresh) to stage `~/.termdeck/shims/` + the rc PATH fence,
   then `termdeck doctor` — expect shim-first PATH order, three real-binary resolutions
   (grok SKIP-with-reason acceptable on machines without it).
4. **Operator board** (`SideHustles/TermDeck/execution-arc-operator.html`): flip Phase 5 to
   COMPLETE after the publish wave lands (text-only edits — checked boxes must stay mapped).

## 3. The ~08-13 gate (unchanged from the S84 doc §3)

Promotion dry-run review (`memory_inbox_health` + `cron.job_run_details` for
`rumen-inbox-promote` + promoter reports) → auto-promote flip; strict-map posture (runbook
Part B4); `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD`; SR-7 revisit with sweep density (now real:
first live sweep + consolidation rows exist). **Sheets activation remains open** (Josh ~5 min,
`docs/SHEETS-INTAKE.md`) — it starts the intake volume the gate wants to observe. Also still
open from S84: doctrine ratify; delete old SSD vault after Obsidian-on-X6 confirmed; Brad's
two-line Channel-2 activation when he's up.

## 4. Watch items

- **Nightly graph-consolidation** (04:00 UTC): expect `written>0` each night until the ~52
  backlog drains; `consolidation_summary` rows growing. If a night writes 0 with communities
  qualifying — read the edge-function runtime logs, not just cron.job_run_details (the
  dispatch ledger proves nothing; today's bug hid there).
- **First real extract-sweep** (04:40 UTC): `rumen_extraction_sweep` ledger + entity counts
  moving off 0; `triples_found` density feeds SR-7.
- **Read-side recall gap** (BACKLOG): fresh canary/session rows verified by direct query do
  not surface via `memory_recall` — likely the recency-vs-keyword ranking item. Bites any
  session that "verifies" writes via recall; verify by psql until fixed.
- **5 uncharacterized pre-existing test skips** (BACKLOG) — `total == pass` is false.
- **Mnestra MCP recall hangs under memory pressure** — three panel wedges + one ORCH-side
  statement timeout today. Sprint verification moved to read-only psql by ruling; consider a
  root-cause item if it recurs on an unloaded host.

## 5. Sprint-runtime lessons this sprint added (for the next 3+1+1)

- Wedge detectors must consult lane-completion state: a DONE lane parks wearing a frozen
  `Using tools` badge indefinitely — 3 of 6 monitor fires today were stale-badge parks on
  finished lanes. Prune completed lanes from the alert set at each DONE.
- Before Esc-recovering a "wedged" lane, grep the board for a DONE newer than the CPU
  flatline — T1's "third wedge" was a completed lane; the recovery was harmless but wasted.
- Rulings bind prospectively and DONE posts cross them in flight (twice today) — after every
  ruling, diff post timestamps and nudge the crossed lane with exactly the delta.
- The watcher-regex `|| echo 0` double-print bug silently disabled wake notifications for
  ~40 min — monitors are code too; when a monitor is quiet through visible board activity,
  suspect the monitor before celebrating the quiet.
