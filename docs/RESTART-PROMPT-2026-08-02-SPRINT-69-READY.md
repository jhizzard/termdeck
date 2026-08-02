# RESTART PACKAGE — 2026-08-02 — SPRINT 69 READY (the no-break-in-continuity edition)

**Audience: the next orchestrator, booting with a free context window.** This doc SUPERSEDES
`RESTART-PROMPT-2026-08-01-evening-final.md` and every wrap email. It is written so you can
act as if you were the 36a78c3b session with a 2M window: complete state, complete queue,
complete doctrine capsule. Trust §4's live-state table over any memory row that disagrees.

---

## §0 Complete ledger since the last clean boot (2026-08-01 13:31 ET → 2026-08-02 morning)

**Aug-1 (the monumental day, all FULLY SHIPPED):**
1. Rumen **0.11.1** — graph-consolidation `category` CHECK fix (`fc47885`/`v0.11.1`,
   function redeployed, live-verified: first 20 `consolidation_summary` rows).
2. S84-doc §6 tail closed: `RUMEN_SWEEP_DRY_RUN` unset · vault-regen launchd loaded ·
   session `cdd8d386` sharded (34 facts).
3. **Sprint 68-REDUX** (PATH shims = standalone codex/grok/agy capture): 3+1+1 on :3001,
   inject 15:29 → FINAL-VERDICT GREEN 16:51; gate 1311/1306/0; termdeck **1.18.0** + stack
   **1.16.0** on npm; termdeck main+tag `v1.18.0` at `1d15012`; docs commit `e65759b`.
   Canaries row-verified (grok `85e86311`, codex `74cf2626`, agy `e36b15fb`).
4. Day-one **field bug** fixed + field-proven: bare `npm i -g` staged shims WITHOUT the rc
   PATH fence → fence appended to `~/.zshrc` (backup `.bak-2026-08-01-shimfence`), doctor
   **12/12**; Josh's real codex session captured end-to-end (row `f5cdbc97…`).
5. **Sheets intake ACTIVATED + autonomous**: SA at `~/.termdeck/credentials/
   sheets-harvester.json` (600); sheet `1ThPD_diXz9M9CJCFYkBIbKTBgqnvNNw2abkrPOmoRNI` tab
   `Intake` (shared: the SA as Editor + jhizzard@gmail.com); env in `secrets.env` +
   `supervisor.env`; launchd `com.jhizzard.termdeck-sheets-harvest` (300s `--once` passes,
   logs `~/.termdeck/sheets-harvest{,.err}.log`). First two proposals landed; **the
   promoter's judge is LIVE** — it rejected the first test row `rejection_reason=
   'recipe-level'` (kitchen-vs-recipes doctrine enforced; correct verdict on test ephemera).
6. **Gemini truth table settled** (dialog PDF `SideHustles/Append Row to Spreadsheet.pdf`):
   Gemini-web = read/fetch + CREATE-new only, can NEVER edit existing files, and it
   hallucinated append-success twice — the **in-sheet Gemini side panel is the only
   reliable Gemini writer**; Gemini-web READ of live sheets is accurate → the read-ramp
   mirror design is validated (BACKLOG).
7. **Brad thread**: upgrade email drafted `r-3237204466250592958` (to brad@nacho-money.com,
   cc admin@ — Josh reviews/sends; contains the Channel-2 two-liner that discharges the owed
   item) + three WhatsApps sent (upgrade TL;DR · laptop-first-server-at-sprint-boundary
   ruling · go-now green light). **SIGNATURE RULE instituted**: agent-authored external
   messages sign "— Josh's Claude Orchestrator", never "— Josh" (global CLAUDE.md + Mnestra).
8. Board + `EXECUTION-ARC` position → **Phase 5 COMPLETE**; the arc's remaining substance is
   the ~08-13 promotion gate (4.5–4.7).

**Aug-2 (morning):**
9. **Vault-regen root cause + fix**: launchd fired on time at 01:30 and died exit 127 —
   launchd's default PATH lacks `/usr/local/bin`, so bare `node` at
   `sprint-toolkit/vault-nightly-regen.sh:18` was command-not-found. Fix ON DISK:
   `export PATH="/usr/local/bin:$PATH"` at script top (script-only — launchd re-reads the
   script each fire, NO launchctl reload needed). Manual regen ran green ~10:00 ET:
   **vault 8,981 → 9,118 notes (+137), wikilinks 5,811 → 5,970 (+159)** — the overnight
   consolidation + sweep output IS in the vault. Tonight's 01:30 fire works as-is.
10. **Vault-readability research complete** → `docs/VAULT-READABILITY-RESEARCH-2026-08-02.md`
    — the Sprint-69 scope (below). BACKLOG carries it as PRIME candidate.
11. **Brad's email ASSESSED (msg `19fc2cd5c711ed8a`, from `bheath.tbhcoach@gmail.com` — his
    primary sender; nacho-money is secondary): three bugs from his 1.16.0 laptop canary, ALL
    verified against source. Does NOT fold into Sprint 69** (installer surface, not
    exporter). (a) Native Windows: npm spawns without `shell:true`
    (`stack-installer/src/index.js:247,254,344` + unswept `launcher.js:77,244`,
    `uninstall.js:990`) + no PowerShell branch in `_detectRcTarget` (`:1341-1369`) — no
    working native-Windows path; Brad unblocked via WSL. (b) THE IMPORTANT ONE (2nd field
    occurrence): `init --mnestra` audit-upgrade blind-applied 034's DROP+ADD source_type
    CHECK against his 53K-row production store which deliberately carries extra values —
    atomic fail, zero damage, but the runner (`init-mnestra.js:415-430`) has no
    dry-run/skip/reconcile and ADD CONSTRAINT takes ACCESS EXCLUSIVE + full scan on live
    data. Two BACKLOG items appended (win32-vs-WSL-only decision; dry-run/check +
    pg_constraint-introspecting UNION rebuild). Threaded reply **SENT 08-02 10:26 ET**
    (thread `19fc2cd5c711ed8a`; asks for his exact SQL error + extra source_type list —
    fold his answer into the migration-safety design when it arrives).

**Wrap-email lineage (reconciled 08-02 10:30):** the 17:40 edition was sent Aug-1 (thread
`19fbf461bf4fd597`, stale); the 19:56 draft was discarded; the **definitive wrap is draft
`r6809648686114337811`** (2026-08-02 10:30, pointer-layer twin of THIS doc — Josh sends it
to himself). Brad emails: upgrade SENT 08-01 20:33 (thread `19fbfe07c64bbd52`), bug-reply
SENT 08-02 10:26. This doc remains the canonical detail layer.

---

## §1 Boot sequence (run in order, no skipping)

1. `memory_recall(project="termdeck", query="Sprint 69 vault readability prime candidate consolidation member_ids")`
2. `memory_recall(query="recent decisions Brad signature rule launchd PATH sheets judge recipe-level")`
3. Read `~/.claude/CLAUDE.md` (global rules — note the NEW SIGNATURE RULE §, the 3+1+1
   mandates, inject mechanism, monitor doctrine).
4. Read termdeck `./CLAUDE.md` (read-order; CRITICAL-READ-FIRST both P0s long closed —
   confirm you read it, one line).
5. Read THIS doc fully. Then `docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` (the Sprint-69
   scope). Skim `docs/BACKLOG.md` head + its four 2026-08-01/02 appends.
6. `memory_recall` for whatever topic Josh signals at session start.

## §2 Work queue (ordered; 1–3 before any sprint talk)

**1. Commit the doc drift** (research doc + this doc + BACKLOG appends + evening-final
touch-ups). The permission classifier has been blocking orchestrator git mutations in the
prior session — if blocked, hand Josh this paste:
```
! cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && git add docs/BACKLOG.md docs/RESTART-PROMPT-2026-08-01-evening-final.md docs/RESTART-PROMPT-2026-08-02-SPRINT-69-READY.md docs/VAULT-READABILITY-RESEARCH-2026-08-02.md && git commit -m "docs: 2026-08-02 — vault regen PATH fix record, readability research (Sprint-69 scope), Sprint-69-ready restart package" && git push
```
(Also sweep `sprint-toolkit/vault-nightly-regen.sh` if Josh wants the toolkit dir versioned —
historically it is NOT committed; leave unless told.)

**2. Overnight verification** (do it whenever booted — the data exists now; recipes exact):
- All verification via **read-only psql / execute_sql + edge-function logs — NEVER
  `memory_recall` (read-side gap hides fresh rows), NEVER the cron ledger alone** (dispatch
  ≠ execution; the category bug hid exactly there).
- Consolidation drain: `select count(*), max(created_at) from memory_items where
  source_type='consolidation_summary';` — expect >20 and rising nightly toward ~72; the
  04:00 UTC runtime log line should read `written=N` with N>0 and zero errors.
- First real sweep: `select status, count(*) from rumen_extraction_sweep group by 1;` +
  entity counts off zero (`select count(*) from memory_entities where created_at > now() -
  interval '2 days';`) + the 04:40 UTC `rumen-extract-sweep` runtime logs; `triples_found`
  density feeds the SR-7 gate item.
- Promoter stats: `select status, count(*) from memory_inbox group by 1;` + the `*/10`
  `[rumen-promote]` logs — the dry-run record the ~08-13 gate reviews.
- Sheets harvest health: `tail ~/.termdeck/sheets-harvest.log` (a pass every 300s; quiet
  `scanned=N proposed=0 already=N` lines are healthy).

**3. JSONL sharding of session `36a78c3b-a8bd-4759-9e7d-501583d640f9`** (the biggest session
ever — Aug-1 13:31 through Aug-2; treat as live substrate). EXACT procedure:
   a. Verify the hourly indexer swept it: `grep -rl 36a78c3b ~/.claude/session-index/` —
      expect hits in `sessions.json`/`INDEX.md`/`archive/`. If absent, run the index's
      `build-index.py`/`sync.sh` manually first.
   b. Source: `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck/36a78c3b-a8bd-4759-9e7d-501583d640f9.jsonl`.
   c. Extract TEXT turns only: each JSONL line is an object; keep `type` ∈ {user, assistant};
      from `message.content` take string content or list items with `type=="text"` (SKIP
      tool_use/tool_result/thinking blocks and `<system-reminder…` wrappers); skip empty.
   d. Cap each turn at ~700 chars (append " …[truncated]"); prefix `[user] `/`[assistant] `.
   e. Shard: join turns with blank lines into chunks ≤36,000 chars. A working extractor from
      the prior session (adapt SRC + provenance):
      `/private/tmp/claude-501/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck/36a78c3b-a8bd-4759-9e7d-501583d640f9/scratchpad/shard-cdd8d386.py`
      (scratchpads are session-scoped — copy the pattern, don't depend on the path surviving).
   f. Prepend each shard a one-line provenance header: session id, date span, arc gist
      ("S68-REDUX ship + field bug + Sheets/Gemini activation + vault readability"), shard
      i/N, total turn count.
   g. Feed each shard to `memory_summarize_session(project="termdeck")`. Expect a large
      session → likely 4-8 shards; report facts-stored counts.

**4. Brad follow-ups**: fold the msg-`19fc2cd5c711ed8a` agent verdict (Mnestra) into Sprint
69 or BACKLOG; if Josh hasn't sent the upgrade-email draft `r-3237204466250592958`, remind
him once. All Brad sends sign "— Josh's Claude Orchestrator".

**5. SPRINT 69 — VAULT READABILITY — inject when Josh says go.** Scope =
`docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` §3 (code-grounded; verified facts: exporter
is `packages/cli/src/vault-export.js`; `renderNote()` reads `metadata.consolidation` but
never renders `member_ids` as wikilinks; fixture `packages/cli/tests/vault-export.test.js:95`
proves data flow; no `tags`/`date`/`aliases` frontmatter today; nothing emits graph.json;
regeneration is atomic per run so renames are safe). Suggested 3+1+1: **T1** exporter
topology (P0-1 member links + `up:` backlinks + `hub:true`; P0-2 frontmatter; P0-3 Home +
MOCs) · **T2** projection surfaces (P1-4 folder routing, P1-5 `Memories.base` emission —
READ the official Bases YAML syntax first, P1-6 write-if-missing `graph.json`) · **T3**
golden-file test overhaul + docs + P2 triage (weekly rollups, date-prefix filenames, typed
fields) · **T4** Codex adversarial audit (fresh-export-to-empty-dir acceptance: open in
Obsidian, hubs render, no orphan cloud; goldens byte-stable across two runs). Wave guess:
termdeck 1.19.0 + stack 1.17.0 (audit-trail). Acceptance MUST include a real vault regen on
the daily driver + eyeball in Obsidian. Author PLANNING/STATUS/briefs from this + the
research doc; inject via the standard two-stage protocol (§3 capsule below).

## §3 Sprint-runtime doctrine capsule (so you run it without recall round-trips)

- **Preflight**: `GET http://127.0.0.1:<port>/api/sessions` on the port Josh names (ports.json
  at `~/.termdeck/ports.json` may exist now — resolver order env → ports.json → probe
  3000/3001/3002). 4 panels at the termdeck repo cwd; map creation-order → T1/T2/T3; the
  codex panel → T4 regardless of position.
- **Inject**: two-stage per panel — POST `\x1b[200~<brief>\x1b[201~` (no CR) to
  `/api/sessions/:id/input`, ~250ms gaps across panels, 400ms settle, then `\r` alone.
  Verify buffers engage within 8s; `poke {methods:['cr-flood']}` only a panel that never
  engaged. Prior session's reusable scripts: `/tmp/inject-s68r-prompts.js`,
  `/tmp/nudge-panel-s68r.js` (generic: `node nudge-panel-s68r.js <sid> <esc|noesc> <textfile>`).
- **Monitors (3, background, relaunch on fire)**: STATUS watcher (anchored regex
  `^(### )?\[(T[1-4](-CODEX)?)\] (BLOCKED|AUDIT-FAIL|AUDIT-PASS|DONE|FINAL-VERDICT)[^a-z]`;
  count with `grep -cE | head -1`, NEVER `|| echo 0` — that two-line bug silently killed
  wake notifications for 40 min); CPU-subtree delta monitor (BADGE-FREE: subtree CPU delta =
  ground truth, buffer re-read fresh only at alert; WEDGE = 'Using tools' + flat ≥180s;
  **prune each lane from the alert set at its DONE** — stale-badge parks on finished lanes
  caused 3 false fires; before ANY Esc-recovery grep the board for a DONE newer than the
  flatline); strand-healer (unsent input across 2 ticks while not working → one `\r`).
- **Wedge repair ladder**: ground-truth first (work children in the subtree? a live canary/
  build child that is network-bound is NOT a wedge); then Esc → 1.2s → context-rich two-stage
  nudge naming exactly what changed. Mnestra MCP recall hangs under pressure — lanes verify
  via read-only psql. Playwright MCPs are the known hang/OOM vector — cull freely.
- **Seams**: rulings bind prospectively — after every ruling, diff board timestamps and nudge
  crossed lanes with the delta. Cross-lane 2-line fixes: explicit ORCH authorization on the
  board beats re-opening a closed lane. Auditor "narrow the ruling or I fail it" requests get
  explicit narrowed rulings.
- **Close-out (orchestrator-only)**: read full STATUS → kitchen harvest (5-8 dense rows) →
  version bumps + CHANGELOG (dense house style) + PLANNING §Resolution + BACKLOG + restart
  doc → `npm test` full gate → `npm pack --dry-run` BOTH tarballs (file list goes to
  STDERR — capture `2>&1`) → gitleaks-gated commit (token-shaped fixtures must be
  concatenated in source; local gitleaks ≠ GitHub push protection) → Josh Passkey publish
  (npm BEFORE push, `--auth-type=web`, E404 = stale session → `npm login --auth-type=web`)
  → push + tag → dogfood. RELEASE.md is the strict order; read it at close.

## §4 Live-state table (trust over memories)

| Surface | State |
|---|---|
| npm | termdeck **1.18.0** · stack **1.16.0** · mnestra 0.12.0 · rumen **0.11.1** |
| termdeck git | main = origin = `e65759b`, tag `v1.18.0` @ `1d15012`; uncommitted: the §2.1 doc set |
| Vault | `/Volumes/Crucial X6/mnestra-vault` — **9,118 notes / 5,970 wikilinks**, fresh Aug-2 ~10:00; regen script PATH-FIXED on disk; nightly 01:30 ET fire healthy from tonight |
| Shims | ACTIVE, doctor 12/12; fence in `~/.zshrc`; new terminals capture codex/grok/agy; panels excluded by design; gemini out of scope |
| Sheets intake | LIVE + autonomous (launchd 300s); sheet `1ThPD_…oRNI` tab `Intake`; judge live (rejects recipe-level) |
| Nightly (UTC) | 03:00 graph-inference · 03:45 rumen-reinforce · 04:00 graph-consolidation (real writes, ~52 backlog draining) · 04:20 inbox-purge · 04:40 extract-sweep (real writes) |
| launchd (user) | termdeck-supervise · termdeck-watchdog · **mnestravault (PATH-fixed script)** · **termdeck-sheets-harvest** · gitmirror 03:15 |
| Flags OFF (gate ~08-13) | auto-promote · `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` · `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` |
| Web writes | Claude/ChatGPT/Grok → bridge propose (live) · Gemini → in-sheet side panel ONLY (web Gemini cannot edit files; validated read = future mirror ramp) |
| Brad | Fully current: upgrade email SENT (08-01 20:33) + 3 WhatsApps; laptop-first ruled; his 3 verified 1.16.0 bugs BACKLOG'd; bug-reply SENT (08-02 10:26) — awaiting his SQL error + extra source_type list |

## §5 Operator items (Josh's, unchanged + new)

~08-13 gate (promotion review → auto-promote flip; strict-map Part B4 paste; session-record
flag; SR-7 with sweep density) · doctrine ratify · delete old SSD vault
(`SideHustles/TermDeck/mnestra-vault/`) once X6 confirmed · send the definitive wrap draft
`r6809648686114337811` to yourself (all Brad sends are done).

## §6 Documentation map

| Doc | Holds |
|---|---|
| THIS doc | Canonical continuity package |
| `docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` | Sprint-69 scope: patterns, code-grounded P0/P1/P2, plugins, lane split |
| `docs/RESTART-PROMPT-2026-08-01-evening-final.md` | Aug-1 evening detail (superseded, still accurate for its span) |
| `docs/sprint-68-redux-standalone-shell-capture/{PLANNING,STATUS}.md` | Full S68R record; PLANNING §Resolution = summary |
| `docs/BACKLOG.md` | Sprint-69 prime candidate + read-ramp (validated) + lockstep fix + harvest-supervise + 5 skips + read-side recency ranking |
| `SideHustles/TermDeck/EXECUTION-ARC-2026-07-30.md` + `execution-arc-operator.html` | Arc: Phases 0-5 COMPLETE; gate remains |
| `SideHustles/TermDeck/sheets-intake-activation.html` + `docs/SHEETS-INTAKE.md` | Intake ramp operator guide + spec |
| `SideHustles/Append Row to Spreadsheet.pdf` | Gemini capability dialog (evidence for the read-ramp) |
| `docs/RELEASE.md` · `docs/INSTALLER-PITFALLS.md` | Strict release order · installer failure taxonomy (read before those surfaces) |

## §7 Resume command for the prior session (full mental model, alternative to fresh boot)

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume 36a78c3b-a8bd-4759-9e7d-501583d640f9
```
