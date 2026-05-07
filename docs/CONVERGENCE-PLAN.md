# TermDeck Convergence Plan — End-State + Sprint Sequence

**Authored:** 2026-05-07 ~17:15 ET, in response to Joshua's pull-back: *"I want the end in sight now of a stable product that can be installed anywhere easily, and just as easily uninstalled. It needs to enforce security. How close are we to being able to do a fresh install and uninstall on my Macbook to test this? I feel like we are lost in an endless cycle of little things now."*

This doc is the single source of truth for "where are we going and how do we get there." It supersedes the unstructured collection of items spread across BACKLOG.md, INSTALLER-PITFALLS.md, LAUNCH-READINESS.md, IDEAS-AND-STATUS.md, sprint planning stubs, and memory_remember entries. Read this first; drop into the source docs only when scoping a sprint.

---

## The end-state

A user — Joshua, Brad, or any of the 3+ external testers, or someone reading a Hacker News post — types one command on a clean machine and 60 seconds later has the full TermDeck + Mnestra + Rumen stack working with security enforced by default. They can type one other command and the entire stack is gone, leaving zero trace.

**Acceptance test:** on Joshua's Macbook, in this exact order:

```bash
# 1. Tear down current install (manual today; will be one command after Sprint 61)
termdeck-stack uninstall

# 2. Fresh install
npm install -g @jhizzard/termdeck-stack
termdeck-stack

# 3. Verify everything works:
#    - Wizard auto-detects no Supabase project, offers to provision via Supabase MCP
#    - Migrations apply with RLS-on baseline
#    - termdeck doctor → all green
#    - Memory_sessions writes on /exit
#    - Flashback fires in daily flow
#    - Sprint inject works
#    - File-drop / image-paste works in panels

# 4. Tear down again
termdeck-stack uninstall

# 5. Verify clean state:
#    - No ~/.termdeck/
#    - No mnestra MCP entry in ~/.claude.json
#    - No ~/.claude/hooks/memory-session-end.js (or migrated cleanly to a versioned name)
#    - No LaunchAgents (when nightly mirror-backups feature lands)
#    - No orphaned Supabase project (or explicit user-confirmed retention)
#    - npm uninstall -g @jhizzard/termdeck-stack leaves nothing behind
```

If that sequence runs clean on your Macbook, TermDeck is shippable to Hacker News.

---

## What's been envisioned, planned, or postponed — complete inventory

Sources merged: BACKLOG.md (all sections), CHANGELOG.md `[Unreleased] Planned`, INSTALLER-PITFALLS.md (14 failure classes), LAUNCH-READINESS.md, IDEAS-AND-STATUS.md, all `docs/sprint-*/PLANNING.md`, every `memory_remember` entry tagged termdeck.

### Active P0 (BACKLOG § P0)

1. **v1.0.14 hotfix bundle** (5 items, Sprint 60 PLANNING.md authored 2026-05-07) — body-parser hardening + WS ioctl race + per-adapter idle-detection + launcher stderr separation + log rotation. Surfaced by Brad's 2026-05-07 crash forensic + Sprint 59 in-flight friction.
2. **Per-adapter idle/parked status detection** — Sprint 60 Item 1, P0 promotion 2026-05-07. Bit Sprint 59 twice in 90 min.
3. **Stack-installer upgrade-detection path** — Brad's open P0 since 2026-05-02. Schema-vs-package drift on `npm install -g @latest` against an existing install.
4. **Memory_sessions ingestion break** — largely closed by Sprint 51.6 (bundled hook fix). Verify it's still healthy on Joshua's daily-driver.
5. **Flashback not firing in daily flow** — open since 2026-04-27. Joshua: "I still have not seen a SINGLE FLASHBACK." Likely PATTERNS.error regex-too-narrow in `session.js`.
6. **Brad's empty-Mnestra ingestion fix** — Mnestra-direct session-end hook. Largely closed Sprint 38.

### A. Correctness gaps

- V4-1 Rumen `relate` embedding test coverage (4 failure modes, zero unit tests)
- V4-3 Mnestra direct-bridge contract drift (`memory_hybrid_search` arg count + return field name)
- V4-5 Auth brute-force rate limiting (no IP throttle, strict-equality token compare)
- V4-6 Security/deployment doc drift (`SECURITY.md` cookie name mismatch, `DEPLOYMENT.md` health endpoint mismatch)
- Migration-001 idempotency (CREATE OR REPLACE FUNCTION return-type collision on re-run)
- Rumen-MCP gap (memories via MCP have NULL `source_session_id`, never reach Rumen Extract)

### B. Adoption levers

- **Supabase MCP in setup wizard** — *highest-leverage adoption lever in the backlog*. Cuts setup from 15+ manual steps to "paste 2 credentials, click 3 buttons."
- Fully-local Mnestra path (V5-1) — SQLite + local embeddings, opt-in zero-external-deps mode
- One-click install button — web page or CLI wizard that detects + provisions + migrates + writes config + starts everything

### C. DX improvements

- ✅ PTY drag/drop (shipped Sprint 42)
- ✅ File drop + clipboard image paste (shipped Sprint 59)
- Control panel dashboard for agent permission prompts (V5-3)
- `app.js` feature-module split (>3000 LOC, growing)
- Multi-tab dashboard sync hardening
- Per-panel cwd switch (Sprint 52+ candidate)

### D. Scaling concerns

- Multi-user data validation (V5-2) — required before any beyond-localhost story
- MCP bridge verification (V5-5) — `mnestra-bridge` MCP mode has no contract test
- Edge inference for legacy tables — `memory_items` only today
- Cross-Mnestra-instance graph federation
- Mnestra connection-topology routing layer (Brad's 4-project ask)

### D.5 Sprint 52+ candidates

- Blog post — "The 3+1+1 pattern: how a Codex auditor caught four bugs in fourteen minutes"
- 3+1+1 compaction-vulnerability hardening (Codex CLI PreCompact hook + auditor checkpoint mandate)
- 3+1+1 pattern adoption across all projects (Maestro, PVB, ClaimGuard, etc.)
- Memory-budget tracking table — expected vs actual memory writes per sprint
- Active health dashboard — synthetic /exit pings, scheduled mnestra doctor, expected-vs-actual reconciliation
- Cost-monitoring panel (Sprint 51 deferred vision) — per-agent subscription-vs-per-token billing exposure

### E. Risky dependency upgrades (deferred indefinitely)

- Express 5 migration (currently pinned at 4.x)
- Mnestra Zod 4 migration (Mnestra at Zod 3.x)
- Node 18 → 20 LTS bump

### F. Companion artifacts

- v0.8.0 / v0.9.0 / v0.10.0 / v1.0.0 / v1.0.13 blog posts
- docs-site updates (joshuaizzard.com)

### What's MISSING from every existing plan that Joshua is asking for

1. **`termdeck-stack uninstall` command** — no doc, no sprint, no memory entry mentions this. Build it.
2. **Security-by-default at install time** — partially exists (auth token enforcement when binding non-localhost; gitleaks operator-side), but not enforced as part of the install ceremony. RLS-on baseline migration is queued but not authored. SECURITY DEFINER REVOKE EXECUTE pattern is operator-discipline, not migration-enforced.
3. **Fresh install + uninstall acceptance-test harness** — Sprint 58 catch-net is fresh-install-only. Uninstall has zero coverage.
4. **OS-aware install paths** — Brad's r730 (Linux) and Joshua's Macbook (macOS) have different env shapes; the wizard treats them as one. Brad's 9-finding report was largely "this doesn't work the same on Linux."

---

## The convergence path — 4 sprints, ~1-2 weeks of focused work

This is the prescription. Each sprint is small enough to ship in 1-3 days. After Sprint 63, the acceptance test above runs clean on your Macbook.

### Sprint 60 — v1.0.14 hotfix bundle (already PLANNING'd; ~1.5-2h same-day cadence)

**Status:** PLANNING.md authored 2026-05-07; ready to execute.

**Items:** 5 single-orchestrator fixes (idle-detection, body-parser hardening, WS ioctl race, launcher stderr, log rotation). Closes Brad's crash-forensic noise + the orchestrator's idle-detection blind spot.

**Ship gate:** v1.0.14. Independent of Sprints 61-63; can ship today or tomorrow.

### Sprint 61 — Uninstall + fresh-install acceptance harness (~2-3 days)

**This is the keystone sprint.** Without it, the convergence test is impossible.

**Scope:**
1. **`termdeck-stack uninstall` command.** Removes:
   - `~/.termdeck/` (config, secrets, db, db-wal, db-shm, transcripts, uploads tempdirs)
   - `~/.claude.json` mnestra MCP entry (preserve any other entries)
   - `~/.claude/hooks/memory-session-end.js` (or move to `.bak.<timestamp>` for retention)
   - `~/.claude/settings.json` Stop/SessionEnd entries pointing at the bundled hook
   - LaunchAgents `com.jhizzard.termdeck.*` if present
   - `npm uninstall -g @jhizzard/termdeck-stack` confirmation
   - **Does NOT touch** the user's Supabase project or migrations by default — that's user data. Add `--purge-supabase` flag for explicit nuke (drops Mnestra schemas: `memory_items`, `memory_relationships`, `memory_sessions`, `rumen_*`, etc.).
   - Idempotent: re-runs say "already uninstalled" cleanly.
2. **Fresh-install test matrix.** Activate Sprint 58's catch-net Phase B (test Supabase + 10 GH secrets — ~15 min operator action, then standing). Adds:
   - macOS install-smoke job (currently only ubuntu-24.04 + 4 Dockerfiles)
   - Uninstall step at the end of every fixture: install → run doctor → uninstall → verify clean
   - "Re-install after uninstall" probe — install ; uninstall ; install ; verify state matches first install
3. **Stack-installer upgrade-detection path** (Brad's open P0). Schema introspection diff against bundled migration set; apply missing migrations on re-run. Closes Class A.

**Ship gate:** v1.1.0 (minor bump for the uninstall feature). Both `@jhizzard/termdeck` and `@jhizzard/termdeck-stack` move to 1.1.0.

**Acceptance:** the test sequence at the top of this doc runs clean on Joshua's Macbook AND on the GH Actions matrix.

### Sprint 62 — Security-by-default at install (~1-2 days)

**Scope:**
1. **Mnestra 0.4.7 RLS-on baseline migration.** Every public-schema table in a fresh Mnestra install ships RLS-on. New tables added in any future migration must include `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (lint check enforces this).
2. **SECURITY DEFINER REVOKE EXECUTE FROM PUBLIC migration.** All bundled functions explicitly REVOKE from PUBLIC + GRANT to service_role. New `mnestra doctor` probe lints for any function still callable from anon/authenticated.
3. **Search_path pinned on every function** (already partially in 0.4.6; verify and lint).
4. **Wizard refuses to apply migrations against a Supabase project that fails the 5-gate hygiene check** unless `--accept-existing-state` is passed (for upgrades from pre-0.4.7).
5. **Auth brute-force rate limiting** (V4-5 from BACKLOG). `crypto.timingSafeEqual` + IP throttle on `auth.js` token compare.
6. **Auth token mandatory for non-localhost binds** (already enforced; verify + add migration warning if config.host != 127.0.0.1 and no token).

**Ship gate:** Mnestra 0.4.7 + termdeck audit-trail bump. Can ride alongside Sprint 61 if the auditor capacity exists; otherwise next.

### Sprint 63 — Install-polish wizard (~2-3 days)

**Scope:** the long-promised "interactive setup wizard." Closes Brad's friction tax and the EXTERNAL-INSTALL-READINESS calibration.

1. **Supabase MCP-driven auto-provision.** User pastes Supabase OAuth token; wizard creates the project, applies all migrations, writes secrets.env, wires MCP, installs hooks. End-to-end ~60 seconds.
2. **OS-detection branching.** macOS vs Linux paths handled distinctly: shell defaults, npm-global path locations, LaunchAgents vs systemd units, `--include=optional` defaults.
3. **Schema-generation auto-detection.** Probe whether the user's existing Supabase project (if any) is canonical Mnestra (memory_items + 6 RPCs) or vestigial (mnestra_*_memory tables); branch accordingly.
4. **Self-heal end-of-wizard probes.** End every wizard run with the doctor probe set + a re-emit of any setting that drifted (per Class N).
5. **Re-install detection.** If `~/.termdeck/secrets.env` already exists, offer "use existing" / "purge and start over" / "merge" rather than failing.

**Ship gate:** v1.2.0 (minor bump for the wizard rewrite). TermDeck is HN-postable after this.

---

## What we are NOT doing in the convergence path (and why)

These are real items but not on the convergence critical path. They go to a post-v1.2.0 backlog.

- Express 5 / Zod 4 / Node 20 LTS upgrades (Section E) — risk-only, no user-visible win
- Cost-monitoring panel (Sprint 51 deferred) — feature, not convergence
- 3+1+1 blog post + docsite refresh — narrative work, queues for after v1.2.0
- Per-panel cwd switch — DX nicety
- Graph federation — multi-instance scaling, premature
- App.js feature-module split — refactoring, premature
- Active health dashboard — proactive monitoring, valuable but post-v1.2.0
- Memory-budget tracking table — same shape as health dashboard
- Edge inference for legacy tables — premature

After v1.2.0 ships, pick from this list based on user signal. Until then, focused convergence is the play.

---

## Why we've been in a hotfix cycle (and how we exit)

Sprints 51.5 → 51.6 → 51.7 → 51.8 → 51.9 → 52 → 53 → 54 → 55 → 56 → 57 → 58 → 59 are mostly Brad-driven. Brad surfaces a regression → hotfix sprint → ships → Brad surfaces the next layer → hotfix sprint → ships. Each sprint is small and well-scoped, but the AGGREGATE is reactive: we're patching field findings, not closing the install ceremony.

This is the right shape when distribution is 1 user (Brad). It's the wrong shape when distribution is 3+ external testers (which it became 2026-05-07) or going to be ~50 (post-HN).

The exit: stop treating Brad's reports as individual sprint triggers. Group them into convergence-shaped sprints (61, 62, 63) that ship the missing install/uninstall/security primitives. After v1.2.0, Brad's reports become "did the new install path break?" instead of "did this specific bug recur?" — and the answer for new-class bugs is in the new fixture matrix, not a new hotfix sprint.

---

## How we use this doc going forward

- When a new field-finding lands (Brad, the 2 other testers, anyone else), check whether it's already covered by a queued convergence sprint. If yes, note it in the sprint's PLANNING.md. If no, it goes to the post-v1.2.0 backlog.
- Don't open a new hotfix sprint without checking whether the issue is closed by the next convergence sprint.
- Re-read this doc at the start of every sprint planning session. It's the load-bearing reference for "what are we doing and why."

---

## Cross-references

- Sprint 60 PLANNING (v1.0.14 hotfix bundle): `docs/sprint-60-v1014-hotfix-bundle/PLANNING.md`
- BACKLOG (P0 + categorized): `docs/BACKLOG.md`
- INSTALLER-PITFALLS taxonomy (14 failure classes A-O): `docs/INSTALLER-PITFALLS.md`
- LAUNCH-READINESS (HN-day checklist, partially superseded by Sprint 63 plan): `docs/LAUNCH-READINESS.md`
- Global rules: `~/.claude/CLAUDE.md`
- Project rules: `CLAUDE.md`
- Most recent restart prompt: `docs/RESTART-PROMPT-2026-05-07.md`
