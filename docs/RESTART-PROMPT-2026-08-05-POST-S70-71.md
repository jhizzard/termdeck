# RESTART PACKAGE — 2026-08-05 — POST-SPRINT-70+71 (dual-deck GREEN), PUBLISH + LIVE-APPLY PENDING

**Audience: the next orchestrator.** Supersedes `RESTART-PROMPT-2026-08-02-EVENING-POST-S69.md`
(its §2 queue fully executed). Trust §2's live-state table over any memory row that disagrees.

## §1 Session ledger (2026-08-05 evening session, ~19:00 → close)

1. **Billing investigation (Josh's first priority) CLOSED.** The Aug-1 near-miss ($900
   Console credits bought, ~nothing consumed, refunded Aug-4 — NEVER frame as a burn; full
   analysis in `docs/ANTHROPIC-KEY-PANEL-ENV-FIX-2026-08-04.md`, found untracked in-tree):
   TermDeck fed `ANTHROPIC_API_KEY` into every panel env via TWO vectors (secrets.env PTY
   merge + inherited server `process.env`). Fix SHIPPED in 1.20.0 (B-T2): key in
   `SECRETS_EXCLUDED_FROM_PTY` + new `scrubSpawnEnv`/`SECRETS_EXCLUDED_FROM_SPAWN_ENV`
   for the inherited vector + doctor probe + flipped lock-in fences. Today's fleet was
   verified subscription-billed (rejected key fingerprint ×3 in `~/.claude.json` +
   oauthAccount admin@nashvillechopin.org + panels booted past the dialog).
2. **Sprints 70+71 dual-deck SHIPPED-GREEN**: inject 19:34 ET (after a 6/8 parked-lane
   recovery pass at 19:51) → Deck A FINAL-VERDICT GREEN 20:33 → Deck B GREEN/RATIFY 20:53.
   Records: `docs/sprint-70-graph-boosted-recall/` + `docs/sprint-71-objective-tier/`
   (PLANNING §Resolution both). CHANGELOGs: termdeck [1.20.0], mnestra [0.13.0],
   rumen [0.12.0]. Memory harvest: 7 rows (record + 6 kitchens) + the pre-sprint billing
   kitchen.
3. **Session 680c5f56 sharded** → 42 facts (+1 updated) via subagent.
4. **Gemini WebChat read-loop answered**: read-mirror sheet shipped dark in 1.20.0
   (`TERMDECK_GEMINI_MIRROR`), redaction-gated; operator shares the sheet to the
   Gemini-authed account as reader.

## §2 Live-state table (trust over memories)

| Surface | State |
|---|---|
| Versions (bumped, NOT yet published) | termdeck **1.20.0** · stack **1.18.0** · mnestra **0.13.0** · rumen **0.12.0** |
| Live npm (still) | termdeck 1.19.0 · stack 1.17.0 · mnestra 0.12.0 · rumen 0.11.1 |
| Live store | PRE-070/071: 037/038/rumen-009/010 authored + rollback-proven, NOT applied |
| Operator gates | (a) publish wave ×4 via Passkey (`npm publish --auth-type=web`, RELEASE.md order: sync-rumen-functions → pack check → termdeck → stack → mnestra → rumen → push); (b) live-apply: `bash docs/sprint-70-graph-boosted-recall/apply-s70-s71-live.sh`; (c) comment `ANTHROPIC_API_KEY` line in `~/.termdeck/secrets.env` + restart decks key-free + `/status` check in fresh panel; (d) `npm i -g @jhizzard/termdeck@1.20.0` dogfood |
| Dark flags (new) | `MNESTRA_GRAPH_RECALL` · `MNESTRA_TIER0_INJECT` · `TERMDECK_GEMINI_MIRROR` · rumen objective-guard crons (registered, deactivated) — flip after live soak |
| Decks | :3001/:3002 servers still run global 1.19.0 WITH the key in env (see gate c); panels all parked-complete, safe to close |
| ~08-13 promotion gate | UNTOUCHED this session: promotion dry-run review · auto-promote flip · strict-map B4 · session-record flag · SR-7 revisit · reconcile the 2 real promotions |
| Brad | Nothing owed; his orchestrator may reply in-thread (four-branch + FR-8 stand) |

## §3 Work queue for the next session

1. Boot per §4. If the operator gates (§2) are still pending, walk Josh through them
   FIRST (publish before push — RELEASE.md is STRICT; the sync-rumen-functions step
   matters because rumen shipped a NEW Edge Function this wave).
2. Post-live-apply verification: run the apply script's verification block; then the
   Sprint-70 acceptance probe on the canonical query (`memory_recall_graph_boosted`
   returns entity/community neighbors, not d0-only).
3. Soak, then staged flag flips: `MNESTRA_GRAPH_RECALL` → `MNESTRA_TIER0_INJECT` →
   seed first tier-0 objectives via `objective_ratify` (termdeck project first) →
   rumen guard crons on. Each with a rollback path.
4. BACKLOG §A "Sprint 70/71 follow-ons" block: AUTH_TOKEN + apiBilling opt-in ·
   objectives.ts comments · bundle rumen-objective-guard into init --rumen ·
   GATE-6 custom-role scope · publish-gate fail-open decision · Sprint 70's termdeck
   consumption half (hub-first flashback + session-start entity scan) — natural next
   PRIME.
5. ~08-13 promotion gate prep (operator-led, unchanged from prior package).

## §4 Boot sequence (next session)

1. `memory_recall(project="termdeck", query="Sprint 70 71 dual deck record graph boosted objective tier")`
2. `memory_recall(project="termdeck", query="billing safety ANTHROPIC_API_KEY panel env near miss")`
3. Read `~/.claude/CLAUDE.md` · termdeck `./CLAUDE.md`
4. Read THIS doc fully; skim both sprint dirs' PLANNING §Resolution.
5. `memory_recall` for whatever topic Josh signals. Then execute §3.
