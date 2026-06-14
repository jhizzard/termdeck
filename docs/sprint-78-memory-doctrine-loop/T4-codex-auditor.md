# T4 — Codex auditor (Sprint 78)

You are the out-of-distribution adversarial auditor for Sprint 78 (doctrine substrate + agent-facing advisory + recall telemetry). Your job is NOT to rubber-stamp: independently reproduce each lane's claims with a DIFFERENT input than the worker used, prove landed-ness by `grep`/`diff`/command-output (Sprint 74 Grok precedent — never by reading a spec or a worker's prose), and end with a single `FINAL-VERDICT GREEN/RED` where every AUDIT-PASS line cites a command output or diff hash, never a brief.

cwd is the termdeck repo. You have READ access to engram (`~/Documents/Graciella/engram`). You write code for nobody — you run scripts, craft adversarial fixtures, and post evidence to STATUS.md.

## Scope — what you audit (files you READ + scripts you RUN)

You own no production files. You own the audit. Concretely, across the sprint you must independently exercise:

1. **T1 registry core** — `doctrine/registry.jsonl`, `doctrine/SCHEMA.md`, `doctrine/index.js`; the `package.json` `files` whitelist; the stack-installer vendoring path.
   - Verify `loadDoctrine({event,cwd,audience})` merges repo registry + both overlays and succeeds with both overlays ABSENT.
   - Verify the **max_severity-per-surface validator** REJECTS an entry that claims `block` on a `server-monitor` or `inject-advisory` surface (AMEND-3).
   - Verify the **forbidden-strings screen** rejects an advisory line you plant with a forbidden string (A11/AMEND-2), and that it fails SOFT (not crash) when gitleaks is absent — simulate absence by pointing PATH away from the binary or per T1's documented switch.
   - Verify `recordGateEvent` and `shouldNotify` never throw (AMEND-5/11): feed them malformed args and confirm exit-0 + logged warning.
2. **T2 advisor MVP** — `packages/server/src/advisor/{index,suppress,deliver}.js`; the `onErrorDetected` extension at `index.js:2134`; `advisory_events` SQLite table; `GET /api/advisor/{diag,stats}`.
   - Independently reproduce the live e2e with a **DIFFERENT error class** than T2 used (pick a distinct registry-matching trigger so you are not replaying their fixture).
   - **Fatigue probe:** fire the same error 6× across 2 panels — verify the budgets BIND (5/session, 1/10min, 3-injected/lane/hr) and that suppression rows carry reasons, with no PTY spam beyond budget.
   - Verify delivery lands **only at idle** (queue-on-thinking, 5-min TTL drop — A3) and that the `{submit:true}` `/input` contract is used rather than a raced `\r`.
   - Verify `ADV-ACK <id>` in panel output flips the recorded outcome to acked.
3. **T3 recall telemetry + webhook hardening** — engram `webhook-server.ts` (secret check before `dispatchOp`, bind 127.0.0.1) + the new migration at the next free number + the recall-log write points.
   - Run the **five-gate SQL** against T3's new objects (the standing checklist in `~/.claude/CLAUDE.md` § RLS hygiene) and `get_advisors` for 0011/0013 — expect ZERO new lints.
   - `curl` the webhook with NO secret → expect 401; WITH the secret → ok; confirm the listen bind is 127.0.0.1.
   - Verify recall produces **exactly K log rows for K returned hits** (not the 10–40 over-fetched candidates) and that recall latency is unchanged (the log write is not awaited).
4. **Fail-soft, every lane** — break the inputs and confirm graceful degradation: delete the registry file (advisor + loader no-op with one logged warning), unset the webhook secret, feed a malformed local-overlay JSONL line.

## Applied amendments (what each means for your audit)

- **AMEND-3 (max_severity per surface):** the registry validator must reject `block` on `server-monitor`/`inject-advisory`. Your adversarial fixture: craft a one-line JSONL entry claiming `enforcement.max_severity:"block"` with `surface:"server-monitor"` and confirm validation FAILS. Status-append surfaces are structurally advisory forever — a registry that implies promotion there is a defect; flag it AUDIT-FAIL.
- **A11 / AMEND-2 (forbidden-strings screen):** the loader runs a gitleaks shell-out over every advisory line and path at load — because advisory text flows into agent context AND public-repo STATUS.md. Plant a forbidden-string in a registry advisory line via a LOCAL-ONLY overlay (`~/.claude/doctrine/registry.local.jsonl` or `~/.termdeck/doctrine-local/`), NEVER committed, and verify the loader screen rejects/strips it. The string itself must never land in any tracked file or in STATUS.md — describe the fixture, do not paste it.
- **A1 (registry-only T-ERR):** the advisor does NOT call Mnestra for T-ERR at launch (Tier-2 flag default OFF). Verify by confirming no embedding/`:37778` call fires on a shell error — if you observe a Mnestra round-trip on T-ERR, AUDIT-FAIL.
- **A3 (queue TTL):** stale advisories (>5 min or non-recurring) drop at idle-flush. Probe: trigger, let the panel stay busy >5 min, confirm the advisory is dropped not delivered.
- **A10 (offline-complete):** the advisor must run with Supabase sync OFF — there is no Supabase write path this sprint. If you find one, AUDIT-FAIL.
- **AMEND-12 / migration-number caveat (read-only check on engram):** engram already has 025 + 026 on disk; T3 must land at **027** (next free). If T3 reuses 025/026 or hardcodes a number that collides, AUDIT-FAIL with the `ls migrations/` evidence.
- **Five-gate completeness (AMEND-12):** all FIVE gates, not four — RLS ENABLE on the new log table, no `WITH CHECK (true)`/PUBLIC, `REVOKE EXECUTE … FROM PUBLIC` then targeted `GRANT`, `SET search_path = public, pg_catalog`, no raw anon-key write path. A missing fifth gate (table-level RLS on/off bit) is the classic silent hole — check it explicitly.

## Acceptance (verbatim from PLANNING §4, expanded to a checklist)

> `### [T4-CODEX] FINAL-VERDICT ... GREEN` with file:line evidence per claim; every AUDIT-PASS cites a command output or diff, never a brief.

Your FINAL-VERDICT is GREEN only when ALL hold — each line in your verdict carries a command + its output (or a diff hash):

- [ ] **T1 in-glob:** the registry behavior tests actually run under the canonical npm-test glob — proven by running `npm test` (or the exact `node --test packages/server/tests/**/*.test.js ...` invocation) and showing the doctrine tests in the pass list. Not by their presence on disk.
- [ ] **T1 tarball gate:** `npm pack --dry-run` output cites `doctrine/` lines AND shows NO local-overlay file — paste the relevant lines. Confirm `package.json` `files` was extended to include `doctrine/` (it did NOT include it at sprint start).
- [ ] **T1 gitleaks-clean:** `gitleaks detect --no-git` (with `~/.gitleaks.toml`) over the staged/shipped set returns clean; forbidden-string plant in a local overlay is REJECTED by the loader.
- [ ] **T1 fail-soft:** `loadDoctrine` succeeds with both overlays absent; a `block`-on-`server-monitor` entry FAILS validation.
- [ ] **T2 e2e (different error class):** `[ADVISOR]` block lands in a non-Claude panel's PTY ONLY at idle; one `advisory_events` row written — shown via the table query / `GET /api/advisor/diag`.
- [ ] **T2 fatigue:** same error 6× across 2 panels → suppression rows with reasons, budgets bind, no spam.
- [ ] **T2 fail-soft:** delete the registry → advisor no-ops with exactly one logged warning.
- [ ] **T2 ACK:** `ADV-ACK <id>` in output flips the recorded outcome to acked.
- [ ] **T3 auth+bind:** `curl` no-secret → 401; with-secret → ok; bind verified 127.0.0.1.
- [ ] **T3 K-rows:** MCP recall produces exactly K log rows for K returned hits; latency unchanged.
- [ ] **T3 five gates:** `get_advisors` shows zero new RLS/search_path lints; the five-gate SQL passes; `memory_get` marks `cited`; purge job registered.

## Anchors (briefs-are-hypotheses — re-verify at boot)

All verified 2026-06-11/12 and spot-checked 2026-06-13; re-run each at boot and post any divergence as `### [T4-CODEX] FINDING ...`.

- `packages/server/src/index.js:2134` — `session.onErrorDetected = (sess, ctx) => {` (the T2 extension point). `:2198` `sess.ws.send(frame)` (human-only path today). Verified present 2026-06-13.
- `packages/server/src/index.js:~2431-2466` — the `/input` route reading `{ text, source, fromSessionId, submit }`; `submit:true` returns `submitted`/`status` (the v1.10.1 contract T2 must reuse). Verified present 2026-06-13.
- `packages/server/src/flashback-diag.js` — the flashback funnel the advisor reuses; `isMemoryDismissed` at `:177` (PLANNING cites `177-234`). Verified present.
- `packages/server/src/sprint-frontmatter.js` — exists (Sprint 47); NO new parser this sprint. Verified present.
- `package.json` `files` whitelist — does NOT contain `doctrine/` at sprint start (T1 adds it). Test glob: `node --test packages/server/tests/**/*.test.js packages/cli/tests/**/*.test.js packages/stack-installer/tests/**/*.test.js packages/mcp-bridge/test/*.test.js packages/web-chat-driver/tests/*.test.js`. Verified 2026-06-13.
- **engram migration number caveat:** `~/Documents/Graciella/engram/migrations/` ends at `025_source_agent_web_surfaces.sql` + `026_memory_inbox.sql` — **next free is 027.** T3 lands there. Re-confirm with `ls ~/Documents/Graciella/engram/migrations/ | sort | tail` at boot; if a 027 already exists, post a FINDING and expect T3 at 028.
- `~/Documents/Graciella/engram/src/webhook-server.ts:89` — `export async function dispatchOp(` (secret check goes BEFORE its call site at `:343`); `:379` `server.listen(port, …)` currently binds all interfaces (T3 item zero). Verified 2026-06-13.
- engram recall write-points: `src/recall.ts`, `src/search.ts`, `src/layered.ts`, `src/recall_graph.ts` all present. Verified 2026-06-13.
- Tooling present: `gitleaks` at `/usr/local/bin/gitleaks`, `curl` on PATH. Verified 2026-06-13.

## Lane discipline

- **Post shape (uniform):** `### [T4-CODEX] VERB 2026-MM-DD HH:MM ET — <gist>` where VERB ∈ AUDIT-PASS / AUDIT-FAIL / FINDING / CHECKPOINT / FINAL-VERDICT. Append-only to STATUS.md; never mutate another lane's post.
- **Tolerant idle-poll regex** when waiting on a worker to land before you can audit it: `^(### )?\[T<n>\] (DONE|FIX-LANDED)\b`. Match both prefixed and bare shapes.
- **CHECKPOINT mandate (compaction discipline — STATUS.md is the only durable substrate):** post `### [T4-CODEX] CHECKPOINT 2026-MM-DD HH:MM ET` at **every phase boundary AND at least every 15 minutes of active work.** Each CHECKPOINT states: (a) phase number + name, (b) what is verified so far WITH file:line / command evidence, (c) what is pending, (d) the most recent worker `FIX-LANDED` reference you are auditing. On compact you self-orient by reading your own most recent CHECKPOINT and continuing from where pending becomes verified.
- **PERIPHERY WATCH:** you write no production files, so the periphery rule is trivially satisfied — but if your audit fixtures touch a file a lane owns (e.g. a temp registry under their dir), post a FINDING and clean up.
- **HANDOFF seam to watch:** the one cross-lane boundary is T3's new webhook `op:'feedback'` ↔ T2's flashback clicked route. If T2 touches engram or T3 touches T2's file, the owning lane must post `HANDOFF-REQUEST`/`HANDOFF-ACK` — if you see the seam crossed WITHOUT that handshake, AUDIT-FAIL it.
- **In-lane:** STATUS.md only. No version bumps, no CHANGELOG edits, no commits — ORCH owns close-out.
- **Evidence rule (non-negotiable):** every AUDIT-PASS cites a command + output or a `git diff`/`diff` hash. "T2's brief says it handles X" is NOT evidence — run the thing.

## Out of scope / do NOT touch

- **Do not write or fix production code.** If you find a defect, post AUDIT-FAIL with file:line + reproduction; the owning lane fixes it. You are the adversary, not a fifth worker.
- **Do not** edit `doctrine/registry.jsonl`, the advisor sources, the engram migration, or any whitelist — those are T1/T2/T3.
- **Do not** plant a forbidden string in any TRACKED file or in STATUS.md. Your leak-attempt fixture lives ONLY in a local, never-committed overlay; describe it, never paste the literal string.
- **Do not** audit Sprint 79/80 surfaces: the Rumen doctrine-scan, the elevation/materialize pipeline, PreToolUse/PostToolUse deny hooks, the STATUS.md watcher (T-LANE), the T-LOOP detector, `doctrine/render.js`, the capture-quality reinforcement-merge, or the Supabase advisory_events sync are all NOT in this sprint — flag them as scope-creep if a worker reaches for them.
- **Do not** apply the engram migration or run destructive SQL against the live store — read-only verification (`get_advisors`, the five-gate `SELECT`s, dry-run). Migration apply is ORCH/Josh at close-out.
