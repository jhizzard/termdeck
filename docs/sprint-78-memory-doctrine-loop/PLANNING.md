# Sprint 78 — Doctrine substrate + agent-facing advisory + recall telemetry

**Status:** Plan of record, staged for 3+1+1 dispatch. Authored from `ULTRAPLAN-2026-06-12.md` §4 (lane tables) + §5 (decisions, now locked below) by ORCH on 2026-06-13.
**Pattern:** 3+1+1 — 3 Claude workers (T1/T2/T3) + 1 Codex auditor (T4) + ORCH.
**Repos touched:** termdeck (T1, T2), engram/mnestra (T3). rumen untouched this sprint (it's the Sprint 79 elevation surface).
**Read first:** `ULTRAPLAN-2026-06-12.md` (full design rationale + every amendment). This PLANNING is the executable dispatch distillation; the ULTRAPLAN is the why.

---

## 1. Goal — close the 3 highest-leverage edges of the memory→doctrine loop

The system already detects problems (Flashback) and compiles incidents into prose, but the loop is open at three edges. Sprint 78 closes them with the least new machinery:

1. **No mid-task recall ever reaches an agent** → a machine-readable **doctrine registry** (the substrate every later stage consumes) + a **live-advisory MVP** that re-routes the existing error trigger into the agent's PTY instead of a browser toast.
2. **Zero recall telemetry** ("never recalled" is uncomputable) → a **recall-hit log** so every future pruning/elevation threshold is data-driven. Telemetry must start accumulating NOW (≥1 sprint cycle of data before anyone acts on `recall_count=0`).
3. (Prereq pulled forward) **The :37778 webhook has no auth and binds all interfaces** → shared-secret + 127.0.0.1 default. Item ZERO of T3; prerequisite for ever shipping anything to a second machine.

Sprint 79 (separate dispatch) builds the elevation pipeline (Rumen doctrine-scan → ratify → flow-back) + the capture gates that feed it clean signal.

---

## 2. Locked decisions (§5 — resolved 2026-06-13)

These bind the lane scopes. Workers do not re-litigate them.

| # | Decision | Resolution |
|---|---|---|
| 1a | doctrine-scan Haiku cap | 10 calls/scan (~<$0.05/wk) — approved *(Sprint 79)* |
| 1b | granularity Haiku tier-2 | **Ship OFF, env-gated; validate against the 3 known clusters first** *(Sprint 79)* |
| 1c | recall-log volume + retention | one batched insert/recall; **90-day** retention then rollup-purge |
| 1d | periodic-capture embed cost | keep per-tick embeds until the Sprint 80 embed-skip fix (deferred) |
| 2 | advisory rate limits | 5/session, 1/10min, once-per-(session,dedup_key), 24h per-entry cooldown, 3-injected/lane/hr hard budget→ORCH overflow, quarantine at 3-unheeded-with-recurrence + 7d auto-expiry, ≤120 tok/advisory, 5-min queue TTL — **ratified as the shipping defaults** |
| 3a | who ratifies doctrine PRs | **ORCH may auto-ratify when shadow-trigger evidence is clean; Josh spot-checks after** *(Sprint 79 + global CLAUDE.md close-out step)* |
| 3b | advise→gate PreToolUse deny tier | **Build in Sprint 80**, for exactly 2 machine-checkable gates: publish-before-push, migration-creating-public-table-without-RLS |
| 3c | `proposed>7d` staleness | surface in sprint-dispatch preflight only (not the session-end email) *(Sprint 79)* |
| 4 | pruning moratorium | **Yes** — nobody acts on `recall_count=0` for ≥1 full sprint cycle (~4–6 wk) |
| 5 | summarize importance floor | **Start at 'minor' = no-op; tighten with telemetry later** *(Sprint 79)* — Sprint 78 does not drop facts |
| 6 | webhook secret/bind | **127.0.0.1-only** default, secret in `~/.termdeck/secrets.env`; LAN bind override documented only when asked |
| 7 | severity promotion | real block surfaces = git hooks + sprint-inject refusal + (Sprint 80) PreToolUse deny; **everything else warn/advise indefinitely** |

---

## 3. Hard constraints (release-blocking if violated)

- **termdeck = vanilla JS / CommonJS `require()` / zero build step.** T1 + T2 files are `.js` CJS, fail-soft. (engram TS is fine — the no-TS lock is termdeck-scoped.)
- **Five RLS hygiene gates** on every new DB object (T3): RLS enabled; no `WITH CHECK (true)`/PUBLIC; `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` then targeted `GRANT`; `SET search_path = public, pg_catalog`; no raw anon-key write path. Verify with `get_advisors` (0011/0013) post-apply.
- **The forbidden internal-project-name + project-ref pair** NEVER in any repo file, tarball, shipped artifact, STATUS.md, or advisory text. T1's registry loader + any advisory path runs a gitleaks forbidden-string screen at load.
- **STATUS.md is append-only** — never mutated by tooling. "Downgrade"/"lint" verdicts are advisory tags, never edits.
- **Fail-soft everywhere a gate rides a critical path** — `recordGateEvent`/advisor/rls-audit never throw into a hook/commit/inject/PTY path. Errors log + exit 0.
- **Briefs are hypotheses.** Every file:line anchor was verified 2026-06-11/12; re-verify at boot and post divergences as `FINDING`. Migration numbers especially: **025 + 026 already exist on disk in engram** — T3 lands at the next free number, verified at boot.
- **No version bumps / CHANGELOG / commits inside a lane.** ORCH handles all close-out.

---

## 4. Lanes (3+1+1)

Full scope + amendments in ULTRAPLAN §3.1–3.3 + §4. Per-lane briefs at `T<n>-*.md`.

### T1 — Doctrine registry core (termdeck, CJS zero-build)
**Owns:** `doctrine/registry.jsonl`, `doctrine/SCHEMA.md`, `doctrine/index.js`.
- `registry.jsonl`: one JSON object/line — `id, title, severity, scope(universal|operator-local), audience, trigger, check{regex|script|sql|manual}, enforcement{surface, max_severity, ref}, source{incident, memory_recall_query}, advisory{one_line ≤200 chars, procedure_path, cooldown_hours}, status, version`.
- `doctrine/index.js`: `loadDoctrine({event,cwd,audience})` merging repo registry + `~/.claude/doctrine/registry.local.jsonl` overlay (AMEND-1, Joshua-only rules — never in repo/tarball; the repo carries only a stub for the scrub rule, no pattern text) + `~/.termdeck/doctrine-local/` overlay; per-entry try/catch trigger compilation; **max_severity-per-surface validation** (AMEND-3 — server-monitor & inject-advisory capped at `warn`; status-append rules structurally advisory forever; validator REJECTS entries claiming block on those surfaces); forbidden-strings screen via gitleaks shell-out, fail-soft if absent; `recordGateEvent` (try/catch, never throws) + `shouldNotify(rule_id, dedupe_key)` cooldown/budget throttle backed by doctrine_events (per-rule 30-min cooldown default, hard 3-advisories/lane/hr, overflow→ORCH).
- **Seed** ~8 universal advisory entries: publish-before-push, RLS five gates, two-stage-inject ban, STATUS grammar, CHECKPOINT cadence, tolerant idle-poll regex, DONE-with-open-YELLOW, secrets-in-commits. + inventory entries for already-mechanized rules + `check.type=manual` honesty entries for prose residue (so coverage stats can't lie).
- Add `doctrine/` to `package.json` files whitelist + stack-installer vendoring with **full-file version stamp** (never the 4KB-head stamp that already failed); Brad's registry is read-only, `audience:'all'` entries only, baked at publish.
- **Acceptance:** behavior tests in the npm-test glob (load/merge/validate/throttle/screen); an entry claiming `block` on a `server-monitor` surface FAILS validation; `npm pack --dry-run` cites `doctrine/` lines AND shows NO local-overlay file; gitleaks clean on every shipped file; `loadDoctrine` succeeds with both overlays absent.

### T2 — Advisor MVP (termdeck, CJS zero-build)
**Owns:** `packages/server/src/advisor/{index,suppress,deliver}.js`.
- **T-ERR only, registry-only lookup** (A1 — Tier-2 Mnestra config flag exists, default OFF): extend the `onErrorDetected` handler (`index.js:2134-2237`) to also call `advisor.onTrigger` AFTER the existing toast.
- **Suppression** (consumes T1's `shouldNotify`): 5/session, 1/10min, once-per-(session,dedup_key), per-entry cooldown; quarantine non-silent (WS toast + 7d auto-expiry + requires a recurrence signal, never mere missing ACK); suppressed candidates logged with reason.
- **Delivery:** extract `injectText()` from the two-stage sprint-inject primitive into a shared helper (two-stage paste + idle gate on buffer `status` + `/poke` fallback) — **and reuse the v1.10.1 `{submit:true}` server contract now that it exists** (`POST /input {submit:true}` collapses the two-stage dance + returns `submitted`/`status` — prefer it over racing a separate `\r`). Queue-on-thinking with 5-min TTL drop (A3). Payload `[ADVISOR <id>] <one_line>. Procedure: <path>. ADV-ACK <id> optional.` ≤120 tok.
- **Telemetry:** `advisory_events` SQLite table (flashback_events sibling); `GET /api/advisor/{diag,stats}`; ADV-ACK detection in analyzeOutput (best-effort); toast frame extended with `agent-injected:true/false`. **Supabase sync OUT of scope** (offline-complete per A10).
- **Acceptance (behavior, not file-existence — INSTALLER-PITFALLS ledger #16):** force a registry-matching error in a non-Claude panel → `[ADVISOR]` block lands in the PTY **only at idle**, `advisory_events` row written; repeat 5× → suppression rows with reasons, no spam; delete the registry file → advisor no-ops with one logged warning (fail-soft); ADV-ACK in output flips the outcome to acked.

### T3 — Recall telemetry + webhook hardening (engram)
**Owns:** webhook-server hardening + new migration (next free number — **verify on disk; 025/026 taken**) + recall-log write points.
- **ITEM ZERO (blocker):** webhook shared-secret header (read from `~/.termdeck/secrets.env`, checked before `dispatchOp` at `webhook-server.ts:282-303`) + default bind **127.0.0.1** with env override (`webhook-server.ts:379` currently binds all interfaces).
- **Migration:** `memory_recall_log` (`memory_id, query_hash, query_preview` [gitleaks-shape-redacted], `score, rank, surface, source_session_id, source_agent, cited, created_at`) + `log_recall_hits(jsonb)` RPC (SECURITY DEFINER, **five gates**) + batched/statement-level `recall_count` + `last_recalled_at` denormalization (NO hot-row storms) + **90d** retention purge via pg_cron after rollup.
- **Fire-and-forget write points** (`.catch` + counter, **NEVER awaited** — recall latency must be unchanged): `recall.ts` (returned set ONLY — not the 10–40 over-fetched candidates), `search.ts`, `layered.ts` (index logs; `memory_get` marks `cited=true`), `recall_graph.ts`, `webhook-server.ts` surface tagging.
- New webhook `op:'feedback'` `{memory_id, event:'cited'|'dismissed'}` — T2's flashback clicked route POSTs it (small cross-lane seam → **HANDOFF-REQUEST if T2's file is touched**).
- **Acceptance:** `curl` without secret → 401; with secret → ok; bind verified 127.0.0.1. MCP `memory_recall` produces exactly K log rows for K returned hits (not 10–40 candidates); recall latency unchanged (log write not awaited); `get_advisors` shows zero new RLS/search_path lints; `memory_get` marks `cited`; purge job registered.

### T4 — Codex auditor (termdeck cwd, read access to engram)
**Adversarial, file:line evidence, never spec-trust (Sprint 74 Grok precedent — landed-ness by grep/diff):**
- Independently reproduce T2's e2e with a **different error class**; fatigue probe (same error 6× across 2 panels — verify budgets bind); attempt to plant a forbidden-string in a registry advisory line → verify the loader screen rejects it; verify T1 in-glob + tarball gates by RUNNING the scripts, not reading specs; run the five-gate SQL against T3's new objects; verify fail-soft by breaking inputs (delete registry, unset secret, malformed overlay).
- **CHECKPOINT every 15 min + every phase boundary** (compaction discipline). **FINAL-VERDICT GREEN/RED** with file:line evidence per claim; every AUDIT-PASS cites a command output or diff, never a brief.

---

## 5. Lane discipline (every lane)

- **Post shape (uniform, all lanes incl. workers):** `### [T<n>] VERB 2026-MM-DD HH:MM ET — <gist>` where VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / AUDIT-PASS / AUDIT-FAIL / CHECKPOINT / HANDOFF-REQUEST / HANDOFF-ACK / DONE. Auditor posts as `[T4-CODEX]`.
- **Tolerant idle-poll regex** for cross-lane waits: `^(### )?\[T<n>\] DONE\b`.
- **Auditor CHECKPOINT** mandate: phase number+name, what's verified (file:line), what's pending, most-recent worker FIX-LANDED ref — at every phase boundary AND ≥ every 15 min.
- **PERIPHERY WATCH:** post a FINDING if you touch a file another lane owns; **HANDOFF-REQUEST/ACK** for the one known cross-boundary seam (T3's `op:'feedback'` ↔ T2's flashback clicked route).
- **In-lane:** post to STATUS.md only; no version bumps, no CHANGELOG, no commits — ORCH owns close-out.

---

## 6. Pre-sprint intel (briefs-are-hypotheses — re-verify at boot)

- engram migrations **025 + 026 already exist on disk** → T3's recall-log lands at the next free number; verify at boot, post divergence as FINDING.
- `sprint-frontmatter.js` exists at `packages/server/src/sprint-frontmatter.js` (Sprint 47) — do NOT write a new parser; doctrine frontmatter is additive keys on it (Sprint 80 concern, not 78).
- The advisor reuses the **flashback funnel** (`flashback-diag.js:177-234`) + the sprint-inject two-stage primitive + now the **v1.10.1 `{submit:true}`** server contract (`packages/server/src/index.js` /input route).
- `onErrorDetected` handler: `index.js:2134-2237`. `webhook-server.ts:379` binds all interfaces (T3 item zero).

---

## 7. Close-out (ORCH-centralized — workers only post DONE)

After FINAL-VERDICT: ORCH reads the full STATUS.md, runs an Extract→Relate→Synthesize→Surface pass, writes ~5–8 dense **kitchen-level** memories itself (not per-lane). Then: version bumps (per RELEASE.md), CHANGELOG, BACKLOG, ULTRAPLAN/PLANNING Resolution, RESTART-PROMPT, gitleaks, migration apply (Josh auth), commit, hand-off for npm publish (Josh Passkey), push, tag. Five-gate `get_advisors` check on T3's objects before publish.

---

## 8. ORCH rulings (post-brief-authoring 2026-06-13 — these SUPERSEDE any contradicting brief text)

The parallel brief-authoring pass surfaced six cross-lane ambiguities. Resolved:

1. **Test location (T1 — load-bearing).** The npm-test glob is ONLY `packages/*/tests/**` (server/cli/stack-installer) + `packages/mcp-bridge/test/*` + `packages/web-chat-driver/tests/*`. The repo-root `tests/` dir is NOT in the glob. All Sprint 78 behavior tests — including tests for the top-level `doctrine/index.js` module — land in **`packages/server/tests/`**. A test dropped in root `tests/` silently never runs (satisfies file-existence, fails the ledger-#16 behavior bar).

2. **Two distinct cooldown layers — do NOT conflate.** T1's `shouldNotify` is the **per-RULE registry-stage throttle**: 30-min default cooldown + the hard 3-advisories/lane/hr budget (overflow→ORCH). T2's suppression is the **per-ENTRY advisory layer**: the §2-row-2 24h per-entry cooldown + 5/session + 1/10min + once-per-(session,dedup_key). They stack; neither replaces the other. T1 owns the 30-min/3-per-hr knob; T2 owns the 24h/5/1-per-10min knobs.

3. **`op:'feedback'` HANDOFF directionality (T2↔T3).** To avoid the both-assume-the-other deadlock: **T3 owns the receiver end-to-end** — the `op:'feedback'` webhook handler AND the load-bearing server-side cited signal (`memory_get` → `cited=true`), which is the cited path that must work for Sprint 78. The **client-side flashback-click → feedback POST caller is OPTIONAL for Sprint 78** (it lives in `app.js`/`index.js`, outside T2's owned set). If T2 ships it, T2 opens a HANDOFF-REQUEST to T3 to pin the payload shape first; if not, it's a Sprint 80 follow-up. **Neither lane blocks on the client caller** — T3's acceptance is met by the receiver + `memory_get`-cited path alone.

4. **`package.json` files whitelist (T1).** Add SCOPED entries — `doctrine/index.js`, `doctrine/registry.jsonl`, `doctrine/SCHEMA.md` — NOT a `doctrine/**` wildcard, so a stray local file in `doctrine/` can never tarball. (The Joshua-only overlay lives at `~/.claude/doctrine/registry.local.jsonl` and the operator overlay at `~/.termdeck/doctrine-local/` — both OUTSIDE the repo, so unreachable by any repo glob; the scoped entries are belt-and-suspenders + satisfy the "tarball shows NO local-overlay file" acceptance.)

5. **T3 secret-gate anchor corrected (briefs-are-hypotheses).** The PLANNING §4/§6 anchor "before `dispatchOp` at `webhook-server.ts:282-303`" is STALE — `:282` is inside `handleObservation`. The secret gate belongs in the **HTTP request handler at ~`webhook-server.ts:339-343`** (immediately before `const result = await dispatchOp(body, deps)`), so it covers every op uniformly. `webhook-server.ts:379` binding all interfaces is confirmed. Migration is **027** (026 is highest).

6. **Migration column ownership (forward note for Sprint 79).** `recall_count` + `last_recalled_at` denorm columns on `memory_items` are owned by **T3 / migration 027 (this sprint)**. Sprint 79 T1's `memory_items` additions (`reinforcement_count`, `sprint_ref`, `content_hash`, …) are DIFFERENT columns — Sprint 79 staging must NOT re-add `recall_count`/`last_recalled_at` (collision guard).

---

*Dispatch: ORCH preflight `GET /api/sessions` (substrate verification — 4+ panels at the termdeck cwd) → two-stage inject of the 4 briefs (paste-all, 400ms settle, submit-all; never single-stage) → monitor STATUS.md → close-out harvest.*
