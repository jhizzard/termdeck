# T2 — Advisor MVP (Sprint 78)

**Mission:** Close the delivery gap — re-route the *already-proven* Flashback error trigger out of the human-only browser toast and into a non-Claude agent's PTY, registry-driven, suppression-throttled, idle-gated, fully offline, fail-soft. You are the first instrumented recall consumer; the toast stays in parallel and now reports whether the agent was injected.

This is **vanilla JS / CommonJS `require()` / zero-build / fail-soft**. Nothing you write may throw into the PTY / WS / `onErrorDetected` critical path. Errors log and exit 0.

---

## Scope — files you own

You own a new directory: `packages/server/src/advisor/{index,suppress,deliver}.js` (CJS, zero-dep). You make exactly ONE additive edit outside it: a call site appended to the existing `onErrorDetected` handler in `index.js`. You also add an SQLite table + two GET routes.

### `advisor/index.js` — orchestration + trigger entry
- `onTrigger({ session, ctx, db, deps })` — the single entry the `onErrorDetected` handler calls **after** the existing toast send. Pipeline: build a `dedupe_key` from the normalized error signature → **registry-only lookup** via T1's `loadDoctrine({ event:'T-ERR', cwd, audience })` (A1 — see below) → if a registry entry matches, run it through `suppress.shouldDeliver(...)` → if cleared, hand to `deliver.injectAdvisory(...)` → write the outcome to `advisory_events`. Every stage wrapped in try/catch; any failure logs `[advisor]` and returns without disturbing the caller.
- Registry-only means: match the error text against registry entries' `trigger`/`check.regex`. **Tier-2 Mnestra fuzzy recall is gated behind a config flag that exists but ships default OFF** (A1). Do not wire an embedding call into the T-ERR path.
- Constructs the payload (≤120 tokens): `[ADVISOR <id>] <one_line>. Procedure: <path>. ADV-ACK <id> optional.`

### `advisor/suppress.js` — the throttle layer (consumes T1's `shouldNotify`)
- `shouldDeliver({ db, sessionId, ruleId, dedupeKey })` → `{ deliver: bool, reason }`. Enforces the ratified shipping defaults (PLANNING §2 row 2): **5/session, 1/10min, once-per-(session, dedup_key), per-entry cooldown** (delegate the per-rule cooldown/budget to T1's `shouldNotify(rule_id, dedupe_key)` — do not re-implement it; this lane consumes it).
- **Quarantine** (A12): non-silent. When a rule hits the quarantine threshold (3 unheeded-*with-recurrence* — never mere missing ADV-ACK), emit a WS toast, expose a distinct state in `/api/advisor/stats`, **7-day auto-expiry**. Quarantine requires a recurrence signal; ACK is best-effort, not a ritual.
- Every suppressed candidate is logged to `advisory_events` with its `reason` (e.g. `rate_session`, `rate_10min`, `dup_key`, `cooldown`, `quarantined`).

### `advisor/deliver.js` — idle-gated PTY delivery
- `injectText(...)` — **extract the two-stage paste primitive from `sprint-inject.js` into this shared helper** so both the sprint runner and the advisor use one code path. The helper does: bracketed-paste body (`\x1b[200~…\x1b[201~`) → settle → submit. **Reuse the v1.10.1 `POST /input {submit:true}` server contract** (index.js `/api/sessions/:id/input`, the `submit === true` branch) — it collapses the two-stage dance server-side and returns `{ submitted, status }`. Prefer it over racing a separate `\r` write (A-delivery).
- `injectAdvisory({ session, payload, deps })` — **idle gate**: deliver ONLY when the buffer `status` is idle (never `thinking` — never interrupt a turn). **Queue-on-thinking with a 5-min TTL drop** (A3): if the panel is mid-turn, queue; flush at next idle; at flush, **drop advisories older than ~5 min** or whose signature hasn't recurred. `/poke` (cr-flood) fallback if the submit doesn't land (mirror the sprint-inject verify-then-poke loop).

### Telemetry + edits
- **`advisory_events` SQLite table** — a `flashback_events` *sibling*. Add inline `CREATE TABLE IF NOT EXISTS` + indexes in `database.js` following the exact `FLASHBACK_EVENTS_INLINE_SQL` pattern (database.js:26-44). Columns at minimum: `id, fired_at, session_id, project, rule_id, dedupe_key, error_text, delivered (0/1), suppressed_reason, agent_injected (0/1), acked_at, created_at`.
- **`onErrorDetected` edit** — in `index.js` at the handler (verified `session.onErrorDetected = (sess, ctx) =>` at **2134**; the existing `sess.ws.send(frame)` toast is at **2198**). Append a single fail-soft `advisor.onTrigger(...)` call **after** the toast send. Do not move, reorder, or wrap the existing toast logic.
- **`GET /api/advisor/diag`** and **`GET /api/advisor/stats`** — register two app routes (mirror the existing flashback-diag route style). `diag` = recent advisory_events rows; `stats` = counts, suppression-reason histogram, quarantine state.
- **ADV-ACK detection** — best-effort scan in the `Session.analyzeOutput` path (`session.js`): if the agent's output contains `ADV-ACK <id>`, mark the matching `advisory_events` row acked. Best-effort, never load-bearing.
- **Toast frame** — extend the existing `proactive_memory` frame with `agent-injected: true/false` so the human toast reports whether the agent got the inject.

**Supabase sync is explicitly OUT of scope this sprint** (A10 — the advisor is offline-complete; the nightly sync is config-gated additive, Sprint 80/81).

---

## Applied amendments (ULTRAPLAN §3.3)

- **A1 (binding):** T-ERR is **registry-only** at launch. Tier-2 Mnestra recall is a per-trigger-class config flag, **default OFF for T-ERR**. Rationale: ~8 registry entries means "Tier-2 on registry miss" would make every shell error an embedding call across 4 panels (the 196-fire / 11%-dismissal noise profile). → Your `index.js::onTrigger` does registry match only; the flag plumbing may exist but is never enabled in this lane.
- **A3:** queued-advisory TTL — at idle-flush, drop T-ERR advisories older than ~5 min or whose signature hasn't recurred. Stale delivery trains channel-blindness. → `deliver.js` queue carries a timestamp; flush filters by age + recurrence.
- **A10:** advisor runs 100% offline; Supabase advisory-sync is out of scope. → No Supabase writes from this lane.
- **A11:** the **registry loader runs the forbidden-strings screen** over every advisory line + path at load (T1 owns the screen via gitleaks shell-out). You consume already-screened advisory text — but advisory text flows into agent context AND into public-repo STATUS.md, so **never echo raw error text that could carry a secret into an advisory line**; the `<one_line>` you inject comes from the registry entry, not from the live error tail.
- **A12:** quarantine is never silent or permanent — WS toast + distinct `/api/advisor/stats` state + 7-day auto-expiry; requires a recurrence signal, never mere missing ADV-ACK. → implemented in `suppress.js`.
- **A-delivery (PLANNING §4 + §6):** reuse the **v1.10.1 `{submit:true}` contract** — it returns `submitted`/`status` so you detect a stuck inject deterministically instead of racing a bare `\r`. Single-stage `<text>\x1b[201~\r` remains BANNED.
- **AMEND-5 consumption (T1):** rate-limiting lives in T1's registry stage (`shouldNotify` backed by `doctrine_events`: per-rule 30-min cooldown, hard 3-advisories/lane/hr, overflow→ORCH). **Consume it — do not duplicate the cooldown/budget logic.** Your `suppress.js` adds only the per-session / 10-min / dedup-key / quarantine layers on top.

---

## Acceptance (verbatim PLANNING §4, expanded — BEHAVIOR, not file-existence; INSTALLER-PITFALLS ledger #16)

Live e2e against a running TermDeck with a non-Claude panel:

- [ ] **Force a registry-matching error in a non-Claude panel** → the `[ADVISOR <id>] …` block lands in that panel's PTY **only at idle** (mid-turn → it queues, then flushes at next idle, not before).
- [ ] **An `advisory_events` row is written** for the delivered advisory (`delivered=1`, `agent_injected=1`).
- [ ] **Repeat the same error 5×** → subsequent attempts produce **suppression rows with explicit reasons** (`rate_session` / `rate_10min` / `dup_key` / `cooldown`), **no PTY spam** — the agent is not flooded.
- [ ] **Delete / rename the registry file** → advisor **no-ops with exactly one logged warning** (fail-soft); `onErrorDetected`, the toast, and the PTY are entirely undisturbed.
- [ ] **`ADV-ACK <id>` appears in the panel output** → the matching `advisory_events` row flips to **acked**.
- [ ] **Queue-on-thinking + 5-min TTL:** an advisory queued while the panel is mid-turn for >5 min is **dropped at flush**, not delivered stale.
- [ ] **`GET /api/advisor/diag` and `/stats`** return live data (recent events + suppression-reason histogram + quarantine state).
- [ ] **Toast frame** carries `agent-injected: true/false`.
- [ ] Fail-soft proven by breaking inputs (no registry, malformed entry, panel exited mid-inject) — none throw into the PTY/WS path.

---

## Anchors (briefs-are-hypotheses — re-verify at boot, post divergence as FINDING)

Verified against the live tree 2026-06-13 by the brief author; re-confirm at boot. Any drift → `### [T2] FINDING …`.

- `packages/server/src/index.js:2134` — `session.onErrorDetected = (sess, ctx) => {` (handler start).
- `packages/server/src/index.js:2198` — existing `sess.ws.send(frame);` toast send → your `advisor.onTrigger(...)` call goes **after** this, fail-soft.
- `packages/server/src/index.js:2184` — `flashback_events` persist comment (the fire is recorded here before the WS frame; use the same DB handle).
- `packages/server/src/index.js:2353` — `app.post('/api/sessions/:id/input', …)`; the **`submit === true` branch at ~2466**; return body assembled ~2532 (`{ ok, bytes, replyCount, status, inputBufferLength, submitted? }`). `submitted` present only when `submit:true`.
- `packages/server/src/index.js:2680` — `GET /api/sessions/:id/buffer` (the idle/thinking status source; register your `/api/advisor/*` routes nearby).
- `packages/server/src/sprint-inject.js` — two-stage primitive: `buildPayload` (~59, `\x1b[200~…\x1b[201~`), `settleMs:400` (~42), stage-2 lone-`\r` (~212), verify-then-`/poke` (~222-260), `module.exports` (~270). **Extract `injectText()` from here into your `deliver.js` shared helper** — do not fork the logic.
- `packages/server/src/flashback-diag.js:61` — `pickNextNonDismissed`; `:85` `getRecentFlashbacks` — model `advisor/diag` + suppression on this funnel's shape.
- `packages/server/src/database.js:26-44` — `FLASHBACK_EVENTS_INLINE_SQL` + indexes; **clone this exact pattern** for `advisory_events`. The migration loader is at `:175-182`.
- `packages/server/src/session.js` — `Session.analyzeOutput` + `this.onErrorDetected` (`:217`); ADV-ACK detection rides the `analyzeOutput` path.
- **Cross-lane (do not edit):** T1 ships `doctrine/index.js::loadDoctrine` + `shouldNotify` + `recordGateEvent` — you `require()` them. If T1's signatures aren't landed when you reach the consume point, stub against the PLANNING §4 contract and post `### [T2] FINDING` naming the gap.
- **Migration-number caveat (engram lane T3 only — not you):** engram migrations **025 + 026 already exist on disk**; T3 lands at the next free number. You add SQLite tables via `database.js` inline SQL, not engram migrations — no number to claim, but flag it if you see drift in T3's seam.

---

## Lane discipline

- **Post shape (uniform, every post):** `### [T2] VERB 2026-MM-DD HH:MM ET — <gist>` where VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / HANDOFF-REQUEST / HANDOFF-ACK / DONE. Append-only to STATUS.md — never mutate prior posts.
- **Tolerant idle-poll regex** for any cross-lane wait: `^(### )?\[T<n>\] DONE\b`.
- **HANDOFF seam (the one known cross-boundary):** T3 adds a webhook `op:'feedback'` and wants T2's **flashback clicked route** to POST it. **If T3's change requires touching a file you own (the flashback/advisor client→server feedback path), post `### [T2] HANDOFF-REQUEST …` and wait for `HANDOFF-ACK` before either side edits.** Do not silently co-edit. (This seam is small; default is T3 owns the webhook side, you own the POST call site only if it lands in your files.)
- **PERIPHERY WATCH:** if you must touch any file another lane owns (notably `index.js` beyond the single `onErrorDetected` append, or anything in T1's `doctrine/`), post a `### [T2] FINDING …` first and coordinate — your sanctioned `index.js` edits are the one `onTrigger` call + the two `/api/advisor/*` routes + the `database.js` table; anything beyond that is periphery.
- **In-lane:** post to STATUS.md only. **No version bumps, no CHANGELOG edits, no commits** — ORCH owns all close-out.

---

## Out of scope / do NOT touch

- **Tier-2 Mnestra fuzzy recall for T-ERR** — flag exists, ships OFF; do not enable or wire an embedding call into the T-ERR path (A1).
- **T-LOOP, T-LANE, T-GATE triggers** and the PreToolUse/PostToolUse Claude-channel hooks — Sprint 80 (A2/A4/A6/A8). You ship **T-ERR only**.
- **Supabase advisory_events sync** — out of scope (A10); SQLite only this sprint.
- **The registry itself** (`doctrine/registry.jsonl`, `doctrine/SCHEMA.md`, `doctrine/index.js`, seed entries, gitleaks screen, stack-installer vendoring) — that's **T1**. You consume `loadDoctrine`/`shouldNotify`/`recordGateEvent`; you never author or edit them.
- **engram migrations, `memory_recall_log`, `log_recall_hits` RPC, webhook secret/bind, the `op:'feedback'` webhook handler** — that's **T3**. You only POST to `op:'feedback'` from your clicked route IF the call site lands in your files (HANDOFF first).
- **Version bumps / CHANGELOG / commits / migration apply / publish** — ORCH close-out only.
- **`sprint-frontmatter.js`** — do not extend; doctrine frontmatter is a Sprint 80 concern.
