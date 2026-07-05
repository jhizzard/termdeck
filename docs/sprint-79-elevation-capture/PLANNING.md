# Sprint 79 — Rumen elevation + capture gates — PLANNING

**Dispatched:** 2026-07-05 (Sunday) by the post-Sprint-80 orchestrator (Opus, uncapped).
**Model config (Brad email-3 ruleset, Fable-5 cap avoided):** ORCH = Opus; builders T1/T2/T3 = **Claude Sonnet** (uncapped; bump a lane to Opus only on genuinely hard reasoning); auditor T4 = **Codex**. **Zero Fable-5 anywhere.**
**Read WITH:** `DISPATCH-GUIDE.md` (this dir — the corrected overlay) + `../sprint-78-memory-doctrine-loop/ULTRAPLAN-2026-06-12.md` §3.4/§3.2/§4. This PLANNING is the sprint contract; the DISPATCH-GUIDE §3 holds the full per-lane scope; the ULTRAPLAN holds the design rationale + amendments. Briefs are HYPOTHESES — every lane re-verifies anchors at boot and posts divergences as FINDING.

---

## 0. What Sprint 79 delivers (the elevation loop's second half)

Sprint 78 shipped the doctrine **substrate** (registry + advisory MVP + recall telemetry — all LIVE). Sprint 79 builds the **elevation pipeline** that turns repeated kitchen lessons into ratified, recallable doctrine, plus the **capture gates** that feed it clean signal:

- **T1 (engram)** — capture gates: non-destructive reinforcement counting (the 0.88–0.95 dedup band stops clobbering, starts counting), provenance on the MCP path, granularity classifier + its mandatory recall consumer.
- **T2 (rumen)** — doctrine-scan: DB-side density clustering over the curated pool → Haiku synthesis → `doctrine_registry` staging rows (detect + synthesize only; NO memory_items writer — hard lane boundary).
- **T3 (termdeck)** — materialize + ratify: default-OFF worktree poller renders doctrine PRs; `termdeck doctrine ratify` flips status + **direct-INSERT** flow-back a recallable `source_type='doctrine'` memory row.
- **T4 (Codex)** — adversarial audit across all three repos.

---

## 1. GROUND TRUTH — verified on disk 2026-07-05 (supersedes the guide where numbers moved)

| Fact | Verified value | Owner |
|---|---|---|
| engram next-free migration | **028** (027_recall_telemetry is highest committed) | **T1 = 028** |
| engram doctrine ×1.5 boost migration | **029** | **T3 = 029** (HANDOFF w/ T1 on ordering) |
| rumen next-free migration | **004** (003_pg_cron_inbox_promote is highest) | **T2 = 004** |
| engram working tree | **DIRTY** — untracked `024_email_assistant_recall.sql` (out-of-sequence) + `docs/sprint-privacy-tags/`. Does NOT collide with 028, but T1 branches over it. | T1 stash-aware-branch or leave untracked |
| engram version | 0.7.0 (Sprint 78) → **0.8.0** | ORCH close-out |
| rumen version | 0.6.1 (07-01 hotfix) → **0.7.0** | ORCH close-out |
| termdeck / stack | 1.12.0 / 1.10.0 → **1.13.0 / 1.11.0** | ORCH close-out |

### Post-guide drift (the 06-13 guide cannot know these — both landed 07-01)
1. **§6.7 "batch the 1.11.1 / stack 1.9.1 supervise patch" is MOOT.** Sprint 80 already published `d5436cf` (start_bridge secret delivery) inside **v1.12.0**. Sprint 79 close-out is a clean 1.13.0 / stack 1.11.0 — nothing to batch-carry.
2. **Sprint 80 (v1.12.0) rewrote `packages/server/src/index.js` heavily** (input-API `\xNN` normalization, PTY crash guard, context telemetry, inject queue) + touched the CLI + client. **T3's index.js / CLI (`packages/cli/src/index.js`) line anchors from the guide WILL have drifted** — T3 must re-anchor at boot. rumen 0.6.1 (07-01) touched the tick pipeline (index/relate/synthesize/db/types) — **T2 re-verify README:188 / init-rumen anchors** for line drift.

---

## 2. Cross-lane seams → resolve via HANDOFF-REQUEST / HANDOFF-ACK (never silent)

- **(a) engram migration numbering — T1↔T3.** T1 owns **028** (capture gates). T3 owns **029** (the Mnestra `'doctrine'` ×1.5 recall boost, AMEND-14). Neither grabs the other's number. First mover posts `HANDOFF-ACK` confirming the split.
- **(b) rumen doctrine-scan cron wiring — T2↔T3.** The `doctrine-scan` Edge Function is auto-enumerated by `listRumenFunctions()`, BUT the **pg_cron SCHEDULE is NOT auto-wired**: `packages/cli/src/init-rumen.js` `SCHEDULE_MIGRATIONS` hardcodes only 002/003 matchers. Adding a doctrine-scan cron migration needs a **new matcher entry in `init-rumen.js` (a termdeck file → T3 owns the edit)**. The `init-rumen.js:965` README-flow-back wording fix is likewise a **termdeck edit → T3**, not pure-rumen T2. T2 posts HANDOFF-REQUEST for both; T3 acks.
- **(c) status-enum bridge — T3 boot FINDING.** Repo `doctrine/registry.jsonl` statuses = `['active','proposed','deprecated']` (`doctrine/index.js` validator). The rumen `doctrine_registry` staging table uses `candidate|drafted|proposed|ratified|rejected|superseded`. When T3's `ratify` materializes a rumen `'ratified'` row INTO registry.jsonl it MUST write repo-status **`'active'`** (or `'proposed'` pre-merge) — NOT `'ratified'`. Decide explicitly: map at the boundary (preferred) OR extend the repo enum + SCHEMA.md. Post the decision as a FINDING before landing.

---

## 3. LOCKED decisions (restate; workers do NOT re-litigate — DISPATCH-GUIDE §5)

- Haiku doctrine-scan cap **10 calls/scan**; inputs truncated per call.
- Granularity Haiku tier-2 ships **OFF** (env-gated); regex tier only this sprint.
- Density clustering: **mean pairwise similarity ≥ 0.85** (not bare connected-components), N≥3 AND (≥2 projects OR ≥21d spread).
- Flow-back is a **direct INSERT** `source_type='doctrine'` + explicit `stripPrivate` — NEVER through `memoryRemember` (its dedup would skip/corrupt the row). Regression test: a doctrine row stays recallable even when ≥0.88-similar to a cluster member.
- Scrub NEVER hardcodes forbidden strings — **reuse `doctrine/index.js::screenEntries`** (gitleaks shell-out w/ local `~/.gitleaks.toml`).
- doctrine-sync poller **default-OFF** — registers only when `TERMDECK_DOCTRINE_REPO` set AND boot preflight passes (git repo + remote + `gh auth` + gitleaks present). Brad's install never runs it.
- Materialization in a `git worktree` under `~/.termdeck/doctrine-work/` — never leaves Josh's live checkout dirty or on a doctrine branch.
- trigger_hints ship **shadow-mode only** (log, never inject) pre-ratification.
- Ratification = **ORCH auto-ratifies when shadow-trigger evidence is clean, Josh spot-checks after.** advise→gate PreToolUse deny = **Sprint 80**.
- summarize importance floor = **no-op now** (default 'minor'). Pruning moratorium **≥1 full sprint cycle** before acting on recall_count=0. Webhook stays **127.0.0.1-only**.
- Fail-soft everywhere: no-key doctrine-scan parks `status='candidate'` with a jobs note (distinguishable from a flatline), never throws.

---

## 4. The web-write fabric — NOT a 5th lane (DISPATCH-GUIDE §4)

The inbox→canonical promotion pass already exists (`rumen/src/promote.ts` v0.6.0 + bundled `inbox-promote` Edge Function). Keep the four-lane shape UNCHANGED. Activation (deploy `inbox-promote` + secrets + cron + flip `TERMDECK_BRIDGE_ENABLE_PROPOSE=1` + smoke) is **sequential infra folded into ORCH close-out on Josh's explicit go** (Sprint-76 "PROD activation = Josh decides at close" rule) — it flips a write surface on a public bridge. If Josh wants it audited, T4 takes the `propose→inbox→promote→recall` round-trip as an optional extra target.

---

## 5. Lane scope table (full detail in the T-briefs + DISPATCH-GUIDE §3)

| Lane | cwd / repo | Model | Core deliverable | Acceptance basis |
|---|---|---|---|---|
| **T1 Capture gates** | `~/Documents/Graciella/engram` | Sonnet | migration **028** (reinforcement_count/sprint_ref/rule_ref + `ingest_capture` RPC, 5 gates, 56-group dup collapse) + dedup rewrite (merge-not-clobber, keep-canonical) + MCP provenance expansion + `granularity.ts` + recall.ts TYPE_RANK downweight | supabase advisors 0011/0013 clean + live-store dry-runs; near-dup of a kitchen row → reinforcement_count++ NOT a new row; Rumen ticks don't flatline post-migration |
| **T2 doctrine-scan** | `~/Documents/Graciella/rumen` | Sonnet | migration **004** (doctrine_registry + doctrine_jobs, 5 gates) + `doctrine-scan` Edge Fn (density cluster → Haiku synth, shadow trigger_hints) — **DB-detect-only inside `rumen_*`; NO memory_items writer** | read-only dry-run: 3 known clusters (auditor-checkpoint/CPU-liveness/RLS) surface with sane membership; incoherent synthetic cluster splits; no-key path parks candidate; advisors clean |
| **T3 Materialize+ratify** | termdeck | Sonnet | `packages/server/src/doctrine-sync.js` (default-OFF worktree poller + gitleaks scrub + PR render) + `termdeck doctrine list\|ratify\|reject\|promote` + **direct-INSERT flow-back** + migration **029** + status-enum bridge | worktree PR from a synthetic drafted row leaves `git status` clean; ratify refuses while PR open; flow-back row recallable AND survives ≥0.88 similarity; poller never registers without env var; denylist fixture BLOCKED by scrub |
| **T4 Codex auditor** | termdeck (reads engram, rumen) | Codex | reproduce T2 clustering; attempt scrub-bypass leak (local-only fixture, string never committed); verify keep-canonical + flow-back dedup-bypass regression + default-OFF poller; five-gate SQL on every new object across BOTH repos; verify status-enum bridge | `### [T4-CODEX] FINAL-VERDICT ... GREEN/RED` with command-output evidence per claim |

---

## 6. Lane discipline (ALL lanes)

- **Post shape (uniform):** `### [T<n>] VERB 2026-07-05 HH:MM ET — gist` — VERB ∈ `FINDING | FIX-PROPOSED | FIX-LANDED | AUDIT-PASS | AUDIT-FAIL | CHECKPOINT | HANDOFF-REQUEST | HANDOFF-ACK | DONE`. Auditor uses `[T4-CODEX]`.
- **Idle-poll (tolerant):** `^(### )?\[T<n>\] DONE\b`.
- **Auditor CHECKPOINT** every 15 min + every phase boundary (phase#, verified-so-far w/ file:line, pending, latest FIX-LANDED ref) — STATUS.md is the only substrate that survives a compact.
- **PERIPHERY WATCH:** any cross-lane file touch → HANDOFF-REQUEST first.
- **Stay in lane.** No version bumps, no CHANGELOG edits, no commits — ORCH does close-out. Post FINDING/FIX-PROPOSED/DONE to STATUS.md.
- **Briefs are hypotheses:** first lane action = re-verify your anchors against the live tree; a brief↔code divergence is itself a FINDING.
- **Locked constraints:** termdeck = vanilla JS / CommonJS / zero-build (engram + rumen are natively TS — fine); five RLS gates on every new DB object; the forbidden-strings pair NEVER in any repo file / tarball / shipped artifact.

---

## 7. ORCH close-out (after FINAL-VERDICT GREEN)

1. Extract→Relate→Synthesize→Surface over full STATUS.md → write ~5–8 KITCHEN memories (ORCH-centralized harvest).
2. Version bumps (engram 0.8.0 / rumen 0.7.0 / termdeck 1.13.0 / stack 1.11.0), CHANGELOGs, BACKLOG, PLANNING Resolution, RESTART-PROMPT.
3. Migration apply (Josh-auth): engram 028/029 + rumen 004. `get_advisors` (0011/0013) on new objects.
4. gitleaks → **Josh npm publish (Passkey, publish-BEFORE-push, never --otp)** → ORCH commit + push + tags.
5. Optional (Josh go): web-write activation runbook (DISPATCH-GUIDE §4).
6. Brad reply (queue disposition + any June-9 cutover residue) + session-end email.

---

## 8. RESOLUTION — Sprint 79 SHIPPED (code-green) 2026-07-05

**Outcome: FINAL-VERDICT GREEN on code/tests; RED on live-landedness only (expected — ORCH applies migrations at close-out).** All three builders DONE, Codex T4 auditor thorough throughout.

- **T1 (engram)** DONE — migration 028 (capture gates + reinforcement-merge + `ingest_capture`), 029 (doctrine ×1.5 boost + 365d decay), dedup rewrite, MCP/webhook provenance, `granularity.ts` + recall downweight. `npm test` 257/257.
- **T2 (rumen)** DONE — migration 004 (doctrine_registry + doctrine_jobs), 005 (03:30 UTC cron), `doctrine-scan` Edge Function (density clustering + Haiku, shadow trigger_hints, fail-soft). 126/127.
- **T3 (termdeck)** DONE — `doctrine-sync.js` (default-OFF worktree poller + scrub reuse), `termdeck doctrine` CLI (embedding→insert→flip flow-back, no memoryRemember), installer wiring (004-before-005). Root suite 970/0-fail; doctrine 36/36.
- **T4 (Codex)** — caught the real bugs each with command evidence: the 028/029 `relationship_type` CHECK collision (→ 028 sole owner), the flow-back status-before-insert ordering + embedding-less-non-recallable path (→ reorder), the installer apply-path gap (004 tables never applied), and the 028 content_hash replay-safety + view-grant hygiene. All fixed + re-passed.

**Versions:** engram 0.7.0→0.8.0, rumen 0.6.1→0.7.0, termdeck 1.12.0→1.13.0, stack 1.10.0→1.11.0.

**Cross-lane seams — all resolved:** (a) 028/029 numbering (028 sole owner of the CHECK), (b) doctrine-scan cron (T2 authored rumen 004/005, T3 vendored verbatim + wired init-rumen), (c) status-enum bridge (map rumen `ratified`→repo `active`/`proposed` at the boundary).

**Deferred to Sprint 80 (ULTRAPLAN §6):** advise→gate PreToolUse deny tiers; hook→`ingest_capture` wiring (hook-tier noise controls); web-write activation runbook (DISPATCH-GUIDE §4, Josh-go-gated). Model note: **next session runs worker terminals on Opus 4.8.**

**Infra lesson this sprint:** host memory pressure (Chrome + Backblaze + orphaned Playwright MCP × 5) made ungated Supabase/MCP calls hang mid-lane; killed Playwright, told lanes to defer live SQL to ORCH close-out. Panels process *slowly* under pressure — widen liveness re-confirm windows. Never trust the status badge for liveness (CPU-delta + lastActivity only).
