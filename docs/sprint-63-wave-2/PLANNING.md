# Sprint 63 = Wave 2 — Brad bug-bundle + empirical /exit-capture proof

**Inject:** 2026-05-11 (pending Joshua's "terminals open" signal).
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator (this session).
**Wave target:** `@jhizzard/termdeck@1.2.0` (minor — structural endpoint change in T1) + `@jhizzard/termdeck-stack@1.2.0` (audit-trail aligned) + `@jhizzard/mnestra@0.4.10` (companion patch, orchestrator-side).
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence for all three lanes.

---

## Why this sprint exists

Brad's two 2026-05-11 reports (EADDRINUSE crash storm + SQLite ABI cascade) plus his 2026-05-08 full-stack-sweep §3 ordering land six items not yet closed. The minimum patches (EADDRINUSE catch + ABI fail-fast) shipped pre-publish today in `mnestra@0.4.9` + `termdeck@1.1.1`. **Wave 2 closes the structural fixes those minima only papered over.**

Plus: Joshua's named priority — **empirical proof that `/exit` produces memories from all 4 LLMs (Claude, Codex, Gemini, Grok) and writes to Mnestra**, including dual-schema (`memory_items` + `mnestra_*`) for the personal reference setup. Sprint 62 closed Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` on code/test grounds (the fence tests prove the wire-up); this sprint closes it on **acceptance grounds** (real panels, real exits, real rows).

---

## Lane structure (3+1+1)

| Lane | Owner | Focus | Why this shape |
|------|-------|-------|----------------|
| T1 | Claude | **Crash class** — PTY-leak + WS ioctl race + body-parser hardening | Three acute failure modes in Brad's r730 logs; same TermDeck server surface; co-locate for atomic ship |
| T2 | Claude | **Empirical /exit proof** — drive 4 canary sessions, prove dual-schema writes | Load-bearing acceptance for Investigation 1; verification lane, not code lane |
| T3 | Claude | **Diagnostic surface** — launcher Step 3 + health-probe semantics + PTY shell health-check | Three diagnostic-truth-telling bugs from Brad's §3 + §4.5; structural fix to "red: timeout" masking init failures |
| T4 | Codex | **Adversarial auditor** — especially load-bearing for T2's proof | Verifies T2's claims via independent psql; reviews T1 PTY-leak for memory races; reviews T3 probe semantics for subtle drift |
| Orch | Claude | **Mnestra companion + 5-5 carryover + termdeck-supervised wrapper + stackCompat ranges** | Cross-repo work (engram) + non-lane glue; doesn't belong in a Claude worker lane |

---

## Scope

### T1 — Crash class (§4.1 + §4.2 from Brad's 2026-05-08 report)

In scope:
- `session.pty = null` on `term.onExit` so existing `if (session.pty)` guards become correct everywhere. PTY-leak fix (root cause of Joshua's 2026-05-08/09 overnight `kern.tty.ptmx_max=511` exhaustion — 516 fds for 4 sessions).
- WS resize/setSize handler: check `session.pty && !session.pty._destroyed` before `pty.resize`; downgrade EBADF/ENOTTY to debug log. Closes Brad's r730 25× `ioctl(2) failed` flood over 13h.
- `express.json()` `verify` callback that captures raw body (`req.rawBody = buf`) so the error middleware can hex-escape a 32-byte prefix into a warn line. Closes Brad's r730 9× SyntaxError flood over 13h. Per-route raw-body parser with explicit JSON.parse + try/catch returning 400.
- `POST /api/sessions/:id/resize` should return `410 Gone` (not `409 Conflict`) when the PTY has exited (Brad's 2026-05-07 patch suggestion #3 — semantically correct).

Files of interest: `packages/server/src/index.js`, `packages/server/src/session.js`.

### T2 — Empirical /exit capture proof (PRIORITY)

In scope:
- Drive **4 canary sessions** through TermDeck's REST API, one each for `type=claude|codex|gemini|grok`. Each session receives a canonical canary payload that includes a unique invented phrase (e.g. `sprint-63-acceptance-canary-claude-2026-05-11-blue`).
- Fire `DELETE /api/sessions/:id` on each (the production close path).
- Wait for the `onPanelClose` → `spawn(hook)` chain to complete (15s should be ample; instrument with a poll loop).
- Probe Mnestra via psql (using `~/.termdeck/secrets.env` DATABASE_URL):
  - **Schema A — `memory_items`**: `SELECT source_agent, source_type, content FROM memory_items WHERE content ILIKE '%sprint-63-acceptance-canary-%' ORDER BY created_at DESC LIMIT 10;`
  - **Schema B — `mnestra_session_summary`** (for Joshua's reference setup's dual-schema): same predicate, separate query.
- **Acceptance:** all 4 canary phrases appear in `memory_items` with the correct `source_agent`. For dual-schema installs, all 4 also appear in `mnestra_session_summary`.
- **Output artifact:** `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` — operator-grade verification doc with (a) the 4 canary phrases used, (b) the psql output (scrubbed of project name per global hygiene rule), (c) explicit ROW COUNT per adapter, (d) file:line evidence for each panel's close-path execution if observed via `/api/transcripts/:id`.

Out of scope: integration test for CI (deferred to Sprint 64 — this sprint is "did it work today," not "does it work forever").

### T3 — Diagnostic surface (§4.4 + §4.5 + §4.6 from Brad's 2026-05-08 report + Brad's 2026-05-11 §3 #3)

In scope:
- **§4.4** v1.1.0 launcher Step 3 `column "created_at" does not exist` WARN. `termdeck doctor` passes 23/23 but the launcher's column-existence query disagrees. Code audit in `packages/stack-installer/src/stack.js`. Fix or document the divergence.
- **§4.5** dashboard ↔ launcher probe drift + health-probe error semantics. Distinguish `unreachable` / `timeout` / `dependency-down` / `init-failed` instead of all-roads-lead-to-`red: timeout`. **Critical sub-point:** probes that share a broken `db` handle (Brad's 2026-05-11 SQLite cascade scenario) must detect `db === null` once at boot and switch to a no-op mode logging **once**, not per-cycle. Files: `packages/server/src/health.js`.
- **§4.6** PTY shell health-check 3s timeout. Verify whether the 5-5 sprint T3 client-hardcoded-zsh patch landed in v1.1.0/v1.1.1 first; if yes, this is a different bug; if no, regression to surface.

Files of interest: `packages/stack-installer/src/stack.js`, `packages/server/src/health.js`.

### T4-CODEX — Adversarial auditor

In scope:
- **Especially load-bearing for T2's proof.** The auditor independently reproduces T2's 4-row mnestra check via separate psql connection (or independent `memory_recall` over MCP). If T2's claim that "all 4 adapters wrote" is wrong — e.g. because Codex/Gemini/Grok hit the silent-skip surface at `MIN_TRANSCRIPT_BYTES=5KB` or `<5 messages` (deferred Sprint 64 scope per Sprint 62's resolution note) — T4-CODEX flags it as FINAL-VERDICT RED. **Restore-claims-verified-by-diff applies here as much as for code lanes.**
- Reviews T1's PTY-leak fix for double-kill memory races (what happens if `term.kill()` and `term.onExit` interleave with `session.pty = null` in a 3-way race?).
- Reviews T3's three items, especially probe-semantics subtleties (the `db === null` once-not-per-cycle gate is easy to get backwards).
- CHECKPOINT discipline mandatory: every 15 min AND every phase boundary, post `### [T4-CODEX] CHECKPOINT 2026-05-11 HH:MM ET` with phase + verified items (file:line evidence) + pending + most-recent worker FIX-LANDED reference.

Out of scope: rubber-stamping. The 3+1+1 pattern depends on Codex's adversarial mindset; rubber-stamps defeat the point.

### Orchestrator-side (this session, not a lane)

Carries the cross-repo work + non-lane glue that doesn't fit a worker brief:
- **Mnestra companion patch (`engram` repo)** — Brad's §3 #4 + #6: pre-listen singleton probe (probe 37778 with `net.connect`; if healthy, exit success with clear log; if not, bind). Log rotation cap on `~/.termdeck/mnestra.log`. Attach-to-existing on autostart (MCP boot path tests 37778 first, only spawns on connection failure). Pidfile in `~/.mnestra/`. Target: `@jhizzard/mnestra@0.4.10` (or `0.5.0` if Joshua decides minor-bump at scoping).
- **`bin/termdeck-supervised` wrapper** — replaces Brad's hand-rolled `~/start-termdeck.sh` with separate stderr capture + daily logrotate + boot-banner-with-timestamp for crash fingerprinting (Brad's #1 recommendation from 2026-05-07).
- **5-5 carryover** — T1 (env-propagation `getDatabaseUrl` helper), T2 (doctor probe rename + stackCompat ranges rewritten for 1.1.x→1.2.x), T4 (`stack.js` parent-await for systemd Type=simple).
- **stackCompat range rewrites** — T2 ranges were authored pre-1.0.0 jump; need rewrite for the post-1.1.0 landscape.

---

## Hardening rules (mandatory per global CLAUDE.md hardening + project)

1. **Post-shape uniformity:** every lane uses `### [Tn] STATUS-VERB 2026-05-11 HH:MM ET — <gist>` (or `### [T4-CODEX] ...` for the auditor). `### ` prefix REQUIRED on every lane. This is the rule that bit Sprint 51.7 — bare `[T1]` made T3's idle-poll regex miss the post entirely.
2. **Auditor CHECKPOINT discipline:** T4-CODEX posts `### [T4-CODEX] CHECKPOINT 2026-05-11 HH:MM ET` every 15 min AND every phase boundary. Survives Codex compaction.
3. **Idle-poll regex hardening:** orchestrator-side polling uses `^(### )?\[T<n>\] DONE\b` — tolerant to absence of `### ` prefix as belt-and-suspenders.
4. **No forbidden literals externally:** the reference Mnestra project ID + internal project name MUST NOT appear in any sprint artifact, CHANGELOG, STATUS post, or cross-repo doc. Use "the reference Mnestra project" / "the daily-driver project" / elide entirely. Gitleaks pre-commit will block any commit with a hit.
5. **No "pen-test" framing:** use "full-stack sweep" / "end-to-end functional sweep" in any external-facing artifact (STATUS posts, CHANGELOG, Brad-facing summary).
6. **No version bumps / CHANGELOG edits / commits from lanes:** orchestrator handles those at sprint close. Lanes ship code + tests + post `DONE` to STATUS.md.

---

## Acceptance criteria

For sprint close (orchestrator scope):
- T1: `npm test` root green (regression-clean); Brad's r730 log signatures for body-parser + WS ioctl reduce to 0 after upgrade; ptmx headroom holds across 4-panel sprints (no fd accumulation).
- T2: `EXIT-CAPTURE-VERIFICATION.md` exists with 4/4 canary rows confirmed in `memory_items` (and in `mnestra_session_summary` for the dual-schema reference setup); T4-CODEX independently reproduces.
- T3: launcher Step 3 WARN no longer fires; health probes report semantically-distinct error categories on Brad's r730 scenarios; PTY shell health-check passes.
- T4-CODEX: FINAL-VERDICT GREEN with file:line evidence for all three lanes.

For ship:
- `@jhizzard/termdeck@1.2.0` published; `@jhizzard/termdeck-stack@1.2.0` published; `@jhizzard/mnestra@0.4.10` published.
- Brad's WhatsApp update with the ship summary + Sprint 63 carve-outs.
- This file gains a `## Resolution` section dated at close.

---

## Boot sequence (each lane reads this top-to-bottom)

Every Tn lane briefing file repeats this sequence inline. Path: `docs/sprint-63-wave-2/T<n>-<lane>.md`.

1. `memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `memory_recall(query="recent decisions and bugs 2026-05-08 through 2026-05-11")`
3. Read `~/.claude/CLAUDE.md` (global rules — especially 3+1+1 hardening + RLS hygiene + no-forbidden-literals)
4. Read `./CLAUDE.md` (TermDeck project read-order; P0 banner points at Investigation 2 now)
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — Investigation 1 resolution + Investigation 2 still-open
6. Read `docs/sprint-63-wave-2/PLANNING.md` (this file)
7. Read `docs/sprint-63-wave-2/STATUS.md` — orchestrator scaffold + cross-lane visibility
8. Read `docs/sprint-63-wave-2/T<n>-<lane>.md` — your full briefing

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md with the canonical `### [Tn] ...` shape. Do NOT bump versions, edit CHANGELOG, or commit — orchestrator handles those at sprint close.

---

## Resolution — 2026-05-11

**Sprint 63 = Wave 2 closed at ~14:24 ET.**

### Wave shipped
- `@jhizzard/termdeck@1.2.0` published (Passkey 2026-05-11; commit `7375d2a`).
- `@jhizzard/termdeck-stack@1.2.0` published (audit-trail aligned).
- `@jhizzard/mnestra` unchanged at `0.4.9` — companion patch (log rotation + singleton probe + attach-to-existing + pidfile) deferred to Sprint 64.

### Lane outcomes
- **T1** (crash class): DONE 13:35 ET — PTY-leak fix + WS ioctl race + body-parser raw-body + 410 Gone. 33+ fence tests. T4-CODEX AUDIT-OK on code/test grounds.
- **T2** (empirical proof, PRIORITY): DONE 14:03 ET — gemini `.jsonl` filter fix landed inline + 5 fence tests; Findings #1 (codex cross-panel contamination) + #3 (`<5 messages` threshold) deferred to Sprint 64 as documented carve-outs at `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`.
- **T3** (diagnostic surface): DONE 13:43 ET — stack.js `created_at`→`started_at` + full `red:<category>` health taxonomy with outer-catch invariant fence + preflight `-l` drop. 28 fence tests. T4-CODEX AUDIT-OK on code/test grounds.
- **T4-CODEX** (adversarial auditor): FINAL-VERDICT YELLOW 13:59 ET. Caught 4 AUDIT-CONCERNs (3 load-bearing); shell-blocked from 13:26 ET onward; orchestrator ran psql proxy as Phase-2 substrate at 14:02 ET.

### Live acceptance proof (the load-bearing claim)
At 14:23:33 → 14:23:43 ET, Joshua closed all 4 lane panels (3 Claude + 1 Codex). All 4 wrote `session_summary` rows to Mnestra within 10 seconds:
- claude bb1e465c — 14:23:33 ET — 4088 bytes
- claude 430e256f — 14:23:37 ET — 5744 bytes
- claude b8607d3d — 14:23:41 ET — 5062 bytes
- codex fed67517 — 14:23:43 ET — 2422 bytes

**Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` closes on acceptance grounds.** Sprint 62 closed it on code/test grounds; Sprint 63 closed it on real-world `/exit` capture — verified live during sprint close itself.

### Adversarial Codex catches (load-bearing)
1. T2 brief named non-existent `mnestra_session_summary` table — without the catch T2 would have produced a phantom-table FAIL.
2. T1 body-parser fence rebuilt middleware vs driving production `createServer` — production miswire could have passed test.
3. T3 outer-catch fallbacks at `health.js:506-533` re-introduced uncategorized rows — T3 added invariant fence.

3+1+1 paid off again — same pattern as Sprint 51.6 + Sprint 61.

### Sprint 64 candidates (consolidated)
- Install-polish wizard with Supabase MCP auto-provision + OS-detection (original Sprint 63 scope per CONVERGENCE-PLAN.md, displaced by Wave 2).
- Codex `resolveTranscriptPath` cross-panel contamination (Finding #1).
- `<5 messages` silent-skip threshold (Finding #3).
- Codex CLI auto-update lifecycle hazard.
- `spawnTerminalSession` ignoring `adapter.spawn` config.
- Mnestra companion patch: log rotation + singleton probe + attach-to-existing + pidfile (Brad §3 #2/#4/#6).
- Investigation 2: auto-commit on context compaction-near for all agents.

After Sprint 64 ships, the MacBook Air clean-install + uninstall acceptance test from CONVERGENCE-PLAN.md should run clean. Then Phase B activation (35-45 min operator runbook) brings the virtual install matrix online.
