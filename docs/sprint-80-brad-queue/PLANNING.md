# Sprint 80 — Brad Queue (BR-1 inject fix + context telemetry/enforcement + FR polish)

**Authored 2026-07-01 ~18:50 ET by the orchestrator, from Brad's 2026-06-26 consolidated queue (2 BRs + 6 FRs, received by email) + the 2026-06-26 cascade postmortem.** Josh authorized autonomous prep; no panels were open at authoring time, so this sprint is **dispatch-ready, not dispatched**. Inject via the two-stage pattern when 4 panels exist at this cwd.

**Numbering note:** Sprint 79 (elevation capture, `docs/sprint-79-elevation-capture/DISPATCH-GUIDE.md`) was authored 2026-06-13 and **never dispatched**. It remains queued and is NOT superseded by this sprint. Sprint 80 jumps the queue because it is field-blocking for TermDeck's only external production user.

---

## 1. Why this sprint (context)

- **2026-06-26 ~15:10 UTC:** Brad's R730 fleet crashed. 4 of 5 orch panels had run to 356K–999K context with no rotation. Root chain: BR-1 (inject-to-new-panel silently dead) → self-rotation failed → orchs rode to the 1M wall → host crash. Brad rebuilt externally (`orch-token-watchdog.py` systemd timer) but wants TermDeck to own this natively (FR-5 + FR-6).
- **BR-1 root cause (Brad's log pull, confirmed against our tree):** v1.11.0 moved `packages/server` to express 5 (`^5.2.1`, bundles body-parser 2.x). Bash/curl inject callers send JSON containing the literal 4-char sequence `\x1b` — an **invalid JSON escape**. `express.json()` rejects it; our Sprint 63 handler (`packages/server/src/index.js:661-680`) logs `[body-parser] entity.parse.failed … Bad escaped character` and returns a structured 400 — **but orch callers don't check the response**, so the inject vanishes silently and the new panel never boots. Brad runs a local pre-middleware patch on his R730 (normalizes `\xNN` → `\u00NN` on `/input` routes only) — treat it as a reference implementation, not gospel.
- **Same session (2026-07-01):** the separate Rumen outage on Brad's Mnestra project (edge tick riding to the platform 150s wall since 06-28) was root-caused and fixed — rumen `ed5e233` (v0.6.1: job budget + DB/LLM timeouts) + termdeck `564e788` (bundled wrapper watchdog). The rumen **0.6.1 npm publish is still pending Josh's Passkey** and MUST ride this sprint's publish wave.

## 2. Scope — the 3+1+1 lanes

| Lane | Owns | Items |
|---|---|---|
| T1 | `/api/sessions/:id/input` surface (server) | **BR-1** parse fix + error-contract hardening; **FR-4** inject-vs-human-typing queue |
| T2 | Context telemetry + enforcement (server + client) | **FR-5** per-panel token counter; **FR-6** `maxContextK` enforcement |
| T3 | UX/roles/caps + release prep | **FR-1** transcript newest-first toggle; **FR-2** `master-orchestrator` role tier; **FR-3** panel-cap config; CHANGELOG/version-bump staging |
| T4 | Codex auditor | Independent repro of BR-1 (Brad's exact curl shape), adversarial probe of the `\xNN` normalization hazard, FR-6 kill-action safety, cross-lane drift |

Lane briefs: `T1-input-api.md`, `T2-context-telemetry.md`, `T3-ux-roles-release.md`, `T4-codex-auditor.md`. **Briefs are hypotheses** — re-verify every anchor at boot; post divergences as FINDING.

## 3. Locked decisions (workers do not re-litigate)

1. **BR-1 fix is server-side and route-scoped.** Normalize `\xNN` → `\u00NN` **only** on `POST /api/sessions/:id/input` bodies, before JSON parse (Brad's reference shape). All other routes keep strict parsing. Known hazard: a payload that *intends* the literal 4-char text `\x1b` (e.g. injecting documentation that quotes the bracketed-paste pattern) gets silently converted to a real ESC byte. Accepted for this route — real-ESC intent dominates on `/input` — but T1 documents it in `docs/ARCHITECTURE.md` and T4 probes it. Optional (lane discretion): a documented opt-out for callers that want strict bytes.
2. **The 400 stays loud and gets louder.** Keep the Sprint 63 structured-400 + server log; extend the response body with a `hint` naming the exact fix (`use , or rely on the server-side \xNN normalization now applied to this route`). Silent-swallow by callers was half the outage.
3. **FR-6 default action = `notify`.** `inject` and `kill` are opt-in per config. TermDeck never kills a session by default, and never kills a session whose status is mid-tool-use without a grace pass — T2 designs the guard, T4 audits it.
4. **FR-5 context source = session JSONL on disk** (newest `*.jsonl` under `~/.claude/projects/<encoded-cwd>/`, last assistant turn `usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`). Additionally `contextK` joins `PATCHABLE_META_FIELDS` (`packages/server/src/session.js:658`) so external watchdogs (Brad's) can write it; lane defines and documents precedence when both sources exist.
5. **Publish wave:** `@jhizzard/termdeck@1.12.0` + `@jhizzard/termdeck-stack@1.10.0` + `@jhizzard/rumen@0.6.1` (already committed on rumen main). Rides: `d5436cf` (supervise webhook-secret fix, unversioned since Sprint 78 close), `564e788` (rumen-tick wrapper watchdog), and this sprint. Passkey publishes are Josh's; npm-before-push order per `docs/RELEASE.md` — STRICT.
6. **FR-3 deliverable is config-first.** If no TermDeck-imposed hardcoded cap exists (2026-07-01 grep found none in `index.js`), the deliverable becomes: a `maxPanels` config key (default generous, documented per-OS PTY notes in README) + a clear 429 JSON when the configured cap is hit. Do not invent a lower default than current behavior.

## 4. Acceptance

- **BR-1:** Brad's exact failing shape — `curl -d '{"text":"\x1b[200~boot\x1b[201~"}'` (literal backslash-x) — lands in the PTY as real ESC-wrapped paste; a spawned panel transitions to `thinking` after a two-stage inject. Regression: valid `` payloads unchanged; non-`/input` routes still strict-400.
- **FR-4:** with `inputBufferLength > 0` + recent human keystrokes, N API injects queue and flush in order after submit/clear; zero interleaving.
- **FR-5:** panel header shows live `NNK ctx` with WARN/OVER color thresholds, no CLI involved.
- **FR-6:** with `maxContextK: 400` set and action `inject`, no panel exceeds 400K without the configured intervention firing (verified by test harness writing synthetic JSONL turns).
- **FR-1:** newest-first toggle on transcript view, persisted (localStorage), default unchanged.
- **FR-2:** `PATCH /api/sessions/:id {"role":"master-orchestrator"}` renders a gold border; `orchestrator` renders silver; role validated in `ALLOWED_SESSION_ROLES` (`packages/server/src/index.js:168`).
- **FR-3:** 30+ panels spawn on Linux with `maxPanels` raised; cap breach returns a clear 429.
- Full `npm test` green at root; no repo-root test-glob regressions.

## 5. Runtime protocol

Global CLAUDE.md § 3+1+1 applies in full: two-stage inject (single-stage BANNED), post shape `### [T<n>] VERB 2026-MM-DD HH:MM ET — gist`, tolerant idle-poll regex `^(### )?\[T<n>\] DONE\b`, T4 CHECKPOINT every 15 min + phase boundaries, ORCH runs the 3-monitor stack + shepherds parked lanes, ORCH-centralized close-out + kitchen-memory harvest. In-lane: no version bumps, no CHANGELOG edits, no commits.

## 6. ORCH close-out extras (this sprint)

1. Publish wave per § 3.5 (Josh Passkey required — if still away, stage everything and hand off).
2. **Reply email to Brad** (his 06-26 thread): queue disposition per item, BR-1 fix shape vs his local patch (he can drop it after upgrading), FR-5/FR-6 usage, plus answers to his still-open 06-09 cutover questions (two-instances-per-host, flush-before-recall in the bridge, Gemini OAuth path — most were answered by Sprints 71–76 features; consolidate).
3. Confirm Brad's Rumen recovered post-0.6.1-publish + his redeploy (WhatsApp sent 2026-07-01 with interim wrapper instructions).
4. Sprint 79 remains next in queue — do not cannibalize.

---

## 7. RESOLUTION (2026-07-01, ORCH close-out)

**FINAL-VERDICT GREEN** (T4-CODEX 21:39 ET) — all lanes DONE, all audit targets PASS/refuted with evidence. Full server suite 512/512/0/0.

Shipped: BR-1 route-scoped `\xNN` normalization + hint (T1); **INCIDENT pty-crash fix** — the unplanned P0 that surfaced when the live :3001 deck died mid-sprint on node-pty's unhandled `'error'` re-throw; one guarded listener in `spawnTerminalSession`, natively reproduced + verified by T4 (T1); FR-4 inject-vs-typing queue (T1); FR-5 context counter + FR-6 `maxContextK` enforcement (T2); FR-1 transcript toggle + FR-2 master-orchestrator tier + FR-3 `maxPanels` cap (T3); release staging (T3). Two AUDIT-FAILs raised and remediated in-flight (T1 ARCHITECTURE.md gap, T2 patch-fallback render); the 3+1+1 auditor caught both pre-ship.

Corrections vs plan: rumen 0.6.1 was published mid-session pre-dispatch (wave = 2 Passkey publishes, not 3); no third rumen-tick copy exists in stack-installer (staging doc hypothesis — installer consumes the termdeck bundle); FR-3's premise inverted (no hardcoded cap ever existed; deliverable became the configurable guard).

Carry-forward: root-glob `npm test` MCP/bridge hang (BACKLOG § A); Sprint 79 elevation-capture next in queue; on-prem Mnestra+Rumen + `memory_items`→`mnestra_*` migration remain unscoped asks from Brad's 06-26/06-09 mails.

Incident learning (kitchen): the sprint fixed the exact crash class that interrupted it — the deck died from an unhandled PTY-socket error mid-dispatch, lanes were respawned with `claude --resume` (zero lost work), and the crash became audit target #0 and shipped fixed the same night.
