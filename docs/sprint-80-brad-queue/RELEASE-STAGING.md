# Sprint 80 — Release Staging (DRAFT for ORCH close-out)

**Author:** T3 (release-prep lane). **Status:** staging only — no version bumps, no
CHANGELOG edits, no commits happened in-lane. ORCH executes the actual close-out.
**T1/T2 CHANGELOG wording below is PROVISIONAL** — reconcile against their final
`FIX-LANDED` posts before publishing (this doc was drafted while T1/T2 were still
in flight). Publish is a **Josh-Passkey** step per `docs/RELEASE.md` (STRICT).

---

## 1. Version wave

| Package | From (published) | → Target | Change type |
|---|---|---|---|
| `@jhizzard/termdeck` | 1.11.0 | **1.12.0** | minor — this sprint (BR-1 + FR-1…FR-6) + `d5436cf` supervise fix |
| `@jhizzard/termdeck-stack` | 1.9.0 | **1.10.0** | minor — **real code change** `564e788` rumen-tick watchdog (NOT audit-trail-only this time) + audit-trail align to termdeck 1.12.0 |
| `@jhizzard/rumen` | 0.6.1 | 0.6.1 | **ALREADY PUBLISHED + live on npm** (see §4 correction) |

**Correction to the brief / PLANNING §3.5:** the brief said rumen `0.6.1` "publishes in
the same Passkey session." Ground truth (`npm view @jhizzard/rumen version` → `0.6.1`)
+ ORCH DISPATCHED post (20:52 ET, "rumen 0.6.1 published + live on npm") confirm it
is **already shipped**. So the Passkey session this wave needs is **two publishes**
(termdeck + stack-installer), **not three**. rumen is done.

---

## 2. Draft CHANGELOG — `@jhizzard/termdeck@1.12.0`

> Insert at the TOP of `CHANGELOG.md`, above `## [1.11.0]`. Format matches the
> existing `### Added / Fixed / Security-Changed / Notes` shape.

```markdown
## [1.12.0] - 2026-07-0X

### Fixed
- **BR-1 — `POST /api/sessions/:id/input` silently dropped bash/curl injects
  carrying literal `\xNN` escapes.** [T1 — CONFIRM WORDING vs T1 FIX-LANDED]
  v1.11.0's express-5 / body-parser-2 upgrade rejects the invalid JSON escape
  `\x1b`; the Sprint 63 structured-400 fired but orch callers didn't check the
  response, so injects vanished and new panels never booted. Fix: normalize
  `\xNN` → `\u00NN` on `/input` bodies before JSON parse, route-scoped; all
  other routes stay strict. The 400 stays loud and gains a `hint`. Known,
  documented hazard: a payload intending the literal 4-char text `\x1b` on
  `/input` is converted to a real ESC byte (real-ESC intent dominates on this
  route).

### Added
- **FR-1 — transcript newest-first toggle** (T3). The full-transcript Replay view
  gains a per-user "newest first / oldest first" toggle, persisted in
  `localStorage['termdeck.transcripts.newestFirst']`. Default unchanged
  (oldest-first). Pure-client; copy-to-clipboard is WYSIWYG (matches the shown
  order). New pure helper `orderTranscriptContent()`.
- **FR-2 — `master-orchestrator` role tier** (T3). A distinct top tier above
  `orchestrator` for fleet legibility: `master-orchestrator` renders a **gold**
  border + `ORCH★` badge; plain `orchestrator` moves to **silver** + `ORCH`
  badge. Both pin to the ORCH row. `PATCH /api/sessions/:id {"role":"master-orchestrator"}`
  is validated by the shared `ALLOWED_SESSION_ROLES` whitelist (POST + PATCH).
  The one-click "mark orch" toggle now promotes to `master-orchestrator`, so the
  pre-existing one-click gold affordance is preserved; plain silver
  `orchestrator` is the fleet path set via the API.
- **FR-3 — `maxPanels` config + clear 429** (T3). TermDeck imposed **no** panel
  cap before this (verified); Brad's ~30-40-panel ceiling was host/PTY/RAM
  exhaustion. New `maxPanels` config key (default `null` = unlimited = zero
  regression), overridable by `TERMDECK_MAX_PANELS` env > `config.yaml`. When a
  positive cap is set and the live-panel count reaches it, `POST /api/sessions`
  returns a structured `429 {code:'panel_cap_reached', limit, current, hint}`.
  Counts live panels only (dead panels never block a spawn); internal respawn +
  sprint-runner bypass the cap so recovery is never blocked. README "Panel cap"
  section documents per-OS PTY headroom.
- **FR-4 — inject-vs-human-typing queue** (T1). [PROVISIONAL — confirm vs T1
  FIX-LANDED: API injects queue + flush in order behind in-flight human
  keystrokes; zero interleaving.]
- **FR-5 — per-panel context counter** (T2). [PROVISIONAL — confirm vs T2
  FIX-LANDED: panel header shows live `NNK ctx` with WARN/OVER thresholds, read
  from the session JSONL on disk; `contextK` joins `PATCHABLE_META_FIELDS` for
  external-watchdog writes.]
- **FR-6 — `maxContextK` enforcement** (T2). [PROVISIONAL — confirm vs T2
  FIX-LANDED: opt-in ceiling with default action `notify`; `inject`/`kill`
  opt-in, kill guarded against mid-tool-use.]

### Security / Changed
- **`d5436cf` — supervise delivers `MNESTRA_WEBHOOK_SECRET` to the bridge on
  restart** (unversioned since Sprint 78). The supervisor wrapper
  (`packages/cli/assets/supervise/termdeck-supervise.sh` + `scripts/…`) now
  exports the webhook secret into the bridge child env on restart, so a
  supervised bridge doesn't 401 against a fail-closed mnestra ≥ 0.7.0 webhook.

### Notes
- Sprint 80 ("Brad Queue"), 3+1+1 (T1 input-api / T2 context-telemetry / T3
  ux-roles-release / T4 Codex auditor). [ORCH: add FINAL-VERDICT + final test
  counts.] Server suite at T3 hand-off: **499 pass / 0 fail / 0 skip** (T3 files);
  full-tree count to be stamped by ORCH from the closing run.
- Mid-sprint incident: the `:3001` deck crashed on a server-side uncaught
  exception, correlated with the v1.10.1 `POST /input {submit:true}` path (T1/T4
  audit target — see STATUS INCIDENT 21:02 ET). If T1 lands a crash fix, add it
  here.
- Companion: `@jhizzard/termdeck-stack@1.10.0`. `@jhizzard/rumen@0.6.1` already
  live (job-budget + DB/LLM timeouts, closes the edge-tick 150s-wall outage).
```

---

## 3. Draft CHANGELOG — `@jhizzard/termdeck-stack@1.10.0`

> **This is NOT an audit-trail-only bump** — `564e788` is a real code change to
> a bundled Edge Function. NB: `packages/stack-installer/CHANGELOG.md` is **stale
> at `[1.3.0]`** while published is `1.9.0` (the 1.4.0–1.9.0 bumps were recorded
> only in the root `CHANGELOG.md` Notes, not this file). ORCH decision: add the
> `[1.10.0]` entry, and optionally backfill 1.4.0–1.9.0 headers, or add a
> one-line "1.4.0–1.9.0 tracked in root CHANGELOG" pointer.

```markdown
## [1.10.0] — 2026-07-0X

### Fixed
- **`564e788` — rumen-tick wrapper watchdog.** The bundled `rumen-tick` Edge
  Function (`src/setup/rumen/functions/rumen-tick/index.ts`) gains a watchdog
  that self-aborts at ~140s — a race ahead of the platform's 150s hard kill —
  so a slow tick returns a clean result instead of being killed mid-write. Pairs
  with `@jhizzard/rumen@0.6.1` (job budget + DB/LLM timeouts) to close Brad's
  edge-tick outage (riding to the 150s wall since 06-28).

### Documentation
- Audit-trail: validated against `@jhizzard/termdeck@1.12.0` (Sprint 80 close).
```

---

## 4. Publish checklist (ORCH + Josh Passkey) — per `docs/RELEASE.md` STRICT

1. **Bump versions:** `package.json` → `1.12.0`; `packages/stack-installer/package.json`
   → `1.10.0`. (rumen NOT touched — already at 0.6.1 live.)
2. **`npm run sync-rumen-functions`** (RELEASE.md step 1). ⚠ **Reconcile the
   rumen-tick watchdog** across the three copies: canonical `~/Documents/Graciella/rumen`
   → the server bundle (`packages/server/src/setup/rumen/functions/rumen-tick/`)
   → the stack-installer bundle (`packages/stack-installer/src/setup/rumen/functions/rumen-tick/`,
   where `564e788` landed). Confirm the watchdog is present + identical in all
   three and the `__RUMEN_VERSION__` placeholder is restored before packing.
3. **`npm pack --dry-run`** — confirm both rumen-tick + graph-inference are in
   the tarball; confirm README "Panel cap" section + any FR-5/FR-6 config assets.
4. **Publish termdeck** from repo root: `npm publish --auth-type=web` (**Passkey,
   NOT `--otp`**). Josh taps.
5. **Publish stack-installer**: `cd packages/stack-installer && npm publish --auth-type=web`.
6. **Push** `git push origin main` — ONLY after both publishes succeed
   (publish-before-push is unconditional).
7. **Tag** `v1.12.0` (+ push tag; pre-push gitleaks may scan history — see
   Sprint 65 remote-tag-push note if it trips).
8. **Verify:** `npm view @jhizzard/termdeck version` == 1.12.0;
   `@jhizzard/termdeck-stack` == 1.10.0.

**Release-hygiene gates (standing):** gitleaks pre-commit/pre-push must pass; no
internal-project-name / project-ref literals in any shipped artifact (this doc is repo-internal, but
the CHANGELOG + email are external — scrub); RLS five-gates N/A (no schema change
this sprint).

---

## 5. Brad reply-email skeleton (his 2026-06-26 thread) — for ORCH §6.2

> Voice: peer-developer (no "Great question!", real file refs, honest gaps).
> **Scrub internal-project-name / project-ref literals.** WhatsApp auto-sends — so this is EMAIL,
> composed as a Gmail draft/reply, not injected.

**Subject:** Re: TermDeck queue — Sprint 80 shipped (BR-1 + FR-1…6) + your 06-09 answers

**Queue disposition (2026-06-26 items):**
- **BR-1 (inject-to-new-panel silently dead):** Fixed server-side, route-scoped —
  `\xNN`→`\u00NN` normalization on `/input` before JSON parse; the 400 also got a
  `hint`. You can **drop your local R730 pre-middleware patch** after upgrading to
  `@jhizzard/termdeck@1.12.0`. One documented trade-off: on `/input`, a payload
  that literally means the 4 chars `\x1b` now becomes a real ESC — real-ESC intent
  dominates on that route.
- **Second Brad bug — Rumen edge-tick outage** (riding to the 150s wall since
  06-28): fixed via `@jhizzard/rumen@0.6.1` (job budget + DB/LLM timeouts, already
  live on npm) + a bundled `rumen-tick` wrapper watchdog (~140s self-abort) in
  `@jhizzard/termdeck-stack@1.10.0`. Confirm your Mnestra project's insights
  resumed after your redeploy (WhatsApp interim wrapper sent 07-01).
- **FR-1 transcript newest-first:** shipped (Replay-view toggle, persisted).
- **FR-2 master-orchestrator tier:** shipped — gold `master-orchestrator` vs
  silver `orchestrator`, both pinned; for a fleet, `PATCH {role:'orchestrator'}`
  the workers and promote one to `master-orchestrator` for the gold master panel.
- **FR-3 panel cap:** there was **no** TermDeck cap before — your ~30-40 ceiling
  was host PTY/RAM exhaustion. New `maxPanels` (config or `TERMDECK_MAX_PANELS`)
  gives you a clean `429 panel_cap_reached` instead of a silent host crash. Set it
  to what your R730 can actually drive; README has per-OS PTY notes.
- **FR-4 inject-vs-typing queue / FR-5 per-panel `NNK ctx` / FR-6 `maxContextK`
  enforcement:** shipped [ORCH: confirm final shapes vs T1/T2 — FR-6 defaults to
  the non-destructive `notify`; `inject`/`kill` are opt-in]. These land natively
  what your external `orch-token-watchdog.py` was doing.

**Your still-open 06-09 cutover questions (most now answered by Sprints 71–76):**
1. **Two instances per host:** supported by port isolation — run the second deck
   with `--port <N>` (or `TERMDECK_PORT=<N>`); the CLI liveness-probes the live
   instance instead of cascade-killing it, and the dual-deck sprints proved two
   decks on one host (Mnestra `:37778` shared). **[ORCH: verify current state of
   full `TERMDECK_HOME`/`TERMDECK_CONFIG` + separate-session-DB + per-instance
   auth-token isolation before promising it — don't overclaim beyond port
   isolation.]**
2. **Flush-before-recall (bridge):** **No read-after-write staleness.** The
   webhook `remember` op is fully synchronous — embed → dedup-match → insert are
   all `await`ed before the HTTP 200. There is no half-state: a memory is either
   committed-with-embedding (immediately recallable via `memory_hybrid_search`,
   which requires a non-null embedding) or absent — never "pending a reindex." The
   recall path has no cache/TTL/read-replica (Postgres read-committed). The only
   window is the ~1-2s in-flight embed latency of the capture itself, not a sync
   cycle (Sprint 74 T3 + Grok auditor, with a real write-then-immediate-recall
   verdict test). Related fix: auto-capture hooks now embed with
   `text-embedding-3-large@1536` to match the recall side (Sprint 73 hook v5) —
   earlier `3-small` rows were a rank-quality issue, never a staleness one.
3. **Gemini OAuth path:** Gemini **web** has no MCP connector surface (not a
   bridge client). Gemini **Enterprise** does (custom MCP connector, preview) but
   **cannot** Dynamic-Client-Register — it needs a static `client_id` +
   `client_secret`. Sprint 75 added a pre-seeded static OAuth client to the bridge
   for exactly this; setup is in `packages/mcp-bridge/docs/connect-gemini-enterprise.md`.
   Needs a Gemini Enterprise **Standard** seat (~$30-35/mo; the $21 Business
   edition lacks the custom MCP connector). Separately, the free Gemini **CLI**
   OAuth serving path retired ~2026-06-18; the binary survives via the
   Antigravity CLI (`agy`).

**Deferred (not this sprint):** Sprint 79 (elevation capture) remains next in the
queue; on-prem Mnestra+Rumen (06-26 big ask) and the `memory_items`→`mnestra_*`
schema migration are separate scoped efforts.

---

## 6. Open items for ORCH before publish
- [ ] Reconcile termdeck 1.12.0 CHANGELOG FR-4/FR-5/FR-6/BR-1 wording vs T1/T2 final FIX-LANDED.
- [ ] If T1 lands a `{submit:true}` crash fix, add it to the 1.12.0 Fixed section + Notes.
- [ ] Decide stack-installer CHANGELOG backfill (1.4.0–1.9.0) vs pointer.
- [ ] Run `sync-rumen-functions` + verify the rumen-tick watchdog across all 3 copies (§4.2).
- [ ] Stamp final full-tree test counts into the 1.12.0 Notes.
- [ ] Confirm the two-instances-per-host answer scope (port-only vs full home/config isolation) before sending Brad's email.
