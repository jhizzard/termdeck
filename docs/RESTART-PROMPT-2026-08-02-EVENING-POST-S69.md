# RESTART PACKAGE — 2026-08-02/03 — POST-SPRINT-69, SPRINT 70+71 DUAL-DECK READY

**Audience: the next orchestrator, booting fresh — act as if you were session `680c5f56`
with a 2M-token window.** Supersedes `RESTART-PROMPT-2026-08-02-SPRINT-69-READY.md` (keep
for S68R→S69 history; its queue is fully executed). Trust §3's live-state table over any
memory row that disagrees.

**⚡ STANDING DIRECTIVE (Josh, 2026-08-03): the next sprints run IN PARALLEL ON TWO
TERMDECKS** — two decks (expect two ports, e.g. :3001 + :3002; resolve via
`~/.termdeck/ports.json` / probe), each carrying its own 3+1+1. Natural split: **Deck A =
Sprint 70 Graph-Boosted Recall** (mnestra/engram read-side: walk-edge expansion, entity
triggering, hub coarse-to-fine, structural staleness) · **Deck B = Sprint 71 Objective
Tier** (engram tier-0 schema + termdeck injection surfaces + rumen anti-drift jobs). The
two share an interface seam (tier-0 rows must be pin-able above chain results) — author an
explicit cross-deck contract in both PLANNINGs before inject. S81 is the dual-deck
precedent (8-panel dual-deck 3+1+1; recall it). ONE orchestrator shepherds both decks; the
3-monitor stack runs PER DECK.

## §1 Session 680c5f56 ledger (2026-08-02, ~10:39 → ~19:35 ET)

1. **Boot queue executed in full** (the SPRINT-69-READY §2 queue): doc drift was already
   committed (`550336e`/`316cc89`) · overnight verification GREEN via read-only SQL —
   consolidation drain 40 rows (04:01 UTC fire wrote ~20), first real extract-sweep 99 ok /
   1 transient "Request timed out", 540 entities + 290 triples + 383 mentions (SR-7 density
   evidence now EXISTS), sheets harvest healthy · session `36a78c3b` sharded → **41 facts**.
2. **GATE-RECORD FLAG:** 2 `memory_inbox` rows have `status='promoted'` WITH real
   `promoted_memory_id` targets (claude-web, Aug-1 ~20:46 ET) — the judge is executing REAL
   promotions, not dry-run marks. Reconcile against the "auto-promote OFF until ~08-13"
   framing at the gate review. Recorded, not acted on.
3. **Sprint 69 (Vault Readability) FULLY SHIPPED**: authored + injected 10:55 (monitors
   pre-armed by subagent per Josh's directive) → **FINAL-VERDICT GREEN 11:26** (~31 min,
   zero RED verdict cycles; rulings R-1 atomicity correction / R-2 ten-item / R-3 dangling
   narrowing; `wroteGraph` same-file seam break fixed in-flight). Shipped: **termdeck
   1.19.0 + stack 1.17.0** on npm (Josh Passkey), commit `d805c5b`, tag `v1.19.0` pushed,
   global dogfooded. Daily-driver regen at close: **9,171 notes + Home + 31 MOCs + 40
   linked hubs + Memories.base; Josh's tuned graph.json left byte-untouched** (write-if-
   missing proven live). Record: `docs/sprint-69-vault-readability/{PLANNING,STATUS}.md`,
   CHANGELOG [1.19.0]. Six follow-on BACKLOG items.
4. **Brad arc CLOSED** (thread `19fc2cd5c711ed8a`): his forward `19fc3838325033d0` was a
   byte-identical copy of his original (diff-proven; near-miss: an "it's empty" WhatsApp
   was intercepted by Josh pre-send — kitchen lesson stored on verifying subagent NEGATIVE
   findings). His R730 orchestrator ("termdeck-updates-ORCH" — Brad now runs a symmetric
   drafting orchestrator) then delivered the real data OUT-OF-THREAD: **his store is 50,385
   of 53,118 rows (~94.9%) foreign source_types** (doc 34,583 · expert_insight 11,895 ·
   conversation 3,888 · gemini_gem 2 · rumen_pending_link 14 · rumen_stale_flag 2 · test 1;
   writers: pkachu/rumen/others) and **deliberately has NO source_type constraint** (their
   2026-07-12 self-fix). That BREAKS the planned arm-introspecting UNION rebuild →
   **four-branch design now recorded in BACKLOG §A** (probe by constraint DEFINITION not
   name; found → arms ∪ bundled ∪ DISTINCT data + `ADD NOT VALID`+`VALIDATE`; absent+rows =
   SKIP-with-doctor-warning DEFAULT, widened install opt-in only; absent+empty = bundled
   list). Brad released from the verbatim-SQL-error ask (fixtures assert SQLSTATE 23514 +
   constraint name). **FR-8 filed** (§C: scoped read-only credential mode; wrinkle = recall
   writes citation telemetry since Sprint 83). Reply **SENT 16:20 ET** (`19fc422fbdec880e`).
   Docs commit `c73e64d` pushed. Nothing owed either direction.
5. **Wrap-email lineage:** the definitive S68R wrap was confirmed SENT 10:35 ET
   (`19fc2e6e18d795b2` = sent form of draft `r6809648686114337811`) — a stale-operator-list
   near-miss (kitchen lesson stored: verify operator items against live surfaces before
   repeating asks).
6. **Memory harvest:** Sprint-69 record + 5 sprint kitchens + Brad store profile + 2
   process kitchens (subagent-negative-findings; stale-operator-lists) — 9 rows total.

## §1.5 Aug-3 addendum (this session continued into 2026-08-03)

7. **Sprint 69 acceptance FULLY CLOSED**: Josh's Obsidian eyeball verified hubs + members
   opening normally (the member-click failure was Obsidian's stale metadata cache after
   the in-place 9,171-file regen — fixed by full quit + reindex; the vault was correct
   throughout, filesystem-verified) and **`#ProjectFeed` RENDERS ROWS** — the one
   undocumented Bases construct (`this.<noteProperty>`) is **CERTIFIED working**; all 31
   MOCs carry live self-filtering feeds. PLANNING §Resolution updated.
8. **Sprint 70 PRIME candidate filed** (`c6e5305`): **Graph-Boosted Recall** — live
   diagnosis `memory_recall_graph(...)` returned `d0=6`, ZERO graph neighbors (the walk
   expands only via `memory_relationships`, ignoring the entire 034 substrate: 540
   entities + mentions, 40 communities, typed edges). Scope in BACKLOG §A: walk-edge
   expansion · keyword→entity triggering · hub coarse-to-fine (the Karpathy/Graphify
   "compiled knowledge" posture — Graphify itself evaluated and passed over) · structural
   staleness (folds the recency-ranking + prose-supersession items).
9. **Sprint 71 candidate filed** (`46baeb3`): **Objective Tier** — Josh's hierarchical
   anti-drift design: tier-0 objectives (5-15/project) always-injected + PreCompact
   re-injected + pinned above recall + ratification-only mutation + rendered atop
   Home/MOCs; rumen contradiction-scan + objective-coverage jobs; the synthesis =
   "CLAUDE.md for every agent, generated from the store" (Claude Code's layered
   enforcement — CLAUDE.md/hooks/skills/plan-mode — moved server-side so codex/grok/agy
   shells + web surfaces get identical tier-0).
10. Brad's Sprint-70-era reply may arrive in-thread; the installer-safety batch stays
   design-ready as the sprint-after candidate.

## §2 Work queue for the next session

1. **Boot per §4, then author the DUAL-DECK sprint set** (per the standing directive
   above): `docs/sprint-70-graph-boosted-recall/` + `docs/sprint-71-objective-tier/`
   PLANNING/STATUS/lane briefs from the two BACKLOG entries (both are inject-ready scope;
   re-read them in full — they carry the evidence and the design). Author the cross-deck
   seam contract into both.
2. **Fan a SUBAGENT to shard session `680c5f56`** as complementary context enrichment
   (exact procedure in the wrap email §7 and mirrored here): JSONL at
   `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck/680c5f56-53fd-4d97-bcda-2d51c4a4610a.jsonl`;
   extract text turns (skip tool/thinking/system-reminder), 700-char cap, `[user]`/
   `[assistant]` prefixes, ≤36k-char shards, provenance header (span 2026-08-02 10:39 →
   2026-08-03 ~13:15 ET, arc "Sprint 69 ship + Brad grounding + graph-intelligence +
   Objective Tier scoping"), feed each shard to
   `memory_summarize_session(project="termdeck")`, report facts-stored counts.
3. **Preflight BOTH decks** (`GET /api/sessions` per port), monitors live per deck BEFORE
   inject (subagent-built, orchestrator-launched — the S69 pattern), two-stage inject.
4. **~08-13 promotion gate prep** (operator-led): promotion dry-run review → auto-promote
   flip · strict-map Part B4 · session-record flag · SR-7 revisit (now armed: 290 triples
   / 99 items) · RECONCILE the 2 real promotions vs "auto-promote OFF" (§1.2).
5. **Sprint-after candidates** (BACKLOG): installer-safety batch (DESIGN-READY) ·
   Gemini read-mirror · harvest-supervise · shim lockstep · 5 uncharacterized skips.

## §3 Live-state table (trust over memories)

| Surface | State |
|---|---|
| npm | termdeck **1.19.0** · stack **1.17.0** · mnestra 0.12.0 · rumen 0.11.1 |
| termdeck git | main = origin = `c73e64d`; tag `v1.19.0` @ `d805c5b`; tree clean of sprint work (historical untracked stragglers remain, deliberate) |
| Vault | `/Volumes/Crucial X6/mnestra-vault` — NEW LAYOUT VERIFIED IN OBSIDIAN (hubs, members, Bases views, **ProjectFeed certified rendering rows**): Home.md + moc/ (31) + communities/ (40) + notes/<project>/ (7,986) + snapshots/ (1,145) + Memories.base; graph.json = Josh's tuning (untouched); nightly 01:30 ET regen runs the NEW exporter (repo checkout) |
| Next sprints | **DUAL-DECK PARALLEL (Josh directive 2026-08-03)**: Deck A Sprint 70 Graph-Boosted Recall · Deck B Sprint 71 Objective Tier; both BACKLOG entries inject-ready (`c6e5305` + `46baeb3`); cross-deck seam contract required pre-inject |
| Deck | :3001 deck still executes 1.18.0 from memory until restart; global termdeck = 1.19.0 (dogfooded); panels parked-complete, safe to close |
| Nightly (UTC) | 03:00 graph-inference · 03:45 rumen-reinforce · 04:00 graph-consolidation (draining ~72) · 04:20 inbox-purge · 04:40 extract-sweep · 05:30 vault regen (01:30 ET) |
| Flags OFF (gate ~08-13) | auto-promote (BUT see §1.2 promoted-rows flag) · strict-map · session-record |
| Brad | Fully closed; his orchestrator may reply in-thread; four-branch design + FR-8 recorded; store profile in Mnestra |

## §4 Boot sequence (next session)

1. `memory_recall(project="termdeck", query="session 680c5f56 final state Sprint 70 71 dual deck ready pointers")`
2. `memory_recall(project="termdeck", query="graph boosted recall d0 diagnosis objective tier anti-drift")`
3. `memory_recall(query="Brad store profile four-branch migration reconcile FR-8")`
4. Read `~/.claude/CLAUDE.md` · termdeck `./CLAUDE.md`
5. Read THIS doc fully. Read `docs/BACKLOG.md` §A: the Sprint-70 PRIME entry + the
   Objective Tier entry IN FULL (they are the sprint scopes). Skim the four-branch item +
   §C FR-8.
6. `memory_recall` for whatever topic Josh signals. Then execute §2.
