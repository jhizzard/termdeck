# Sprint 73 — Provenance + Installer Productization (Deck A of the 73/74 double sprint)

**Staged:** 2026-06-10 ~15:45 ET by ORCH (session 4b85a761). **Repo:** termdeck (this repo).
**Companion deck:** Sprint 74 (engram/mnestra repo) — `docs/sprint-74-mnestra-provenance-and-db-integrity/`.
**Pattern:** 3+1+1 (T1–T3 Claude workers, T4 Codex auditor, ORCH in the long-running session).

## Objective

Close the three highest-priority Josh-side items from the 2026-06-09 restart-doc queue that
are termdeck-repo work: (1) the deliberately-gated grok-web provenance flip (deferred #5 —
release-sensitive bundled hooks), (2) the `termdeck init --bridge` guided wizard step
(phase 2 of today's Tier 5 docs, PR #23), (3) the orch/xterm input-accumulation audit
promised publicly on termdeck#12.

## Lanes

| Lane | Scope | Brief |
|---|---|---|
| T1 | grok-web provenance flip + bundled-hooks update (ATOMIC with Sprint 74 T1) | `T1-grok-web-provenance.md` |
| T2 | `termdeck init --bridge` wizard step (Tier 5 automation) | `T2-init-bridge-wizard.md` |
| T3 | Input-accumulation audit + fix (termdeck#12, second half) | `T3-input-accumulation-audit.md` |
| T4 | Codex adversarial auditor across T1–T3 | `T4-codex-auditor.md` |

## Cross-deck atomicity (READ THIS, T1 + T4)

Sprint 73 T1 (`sourceAgent:'grok-web'` + hooks `ALLOWED_SOURCE_AGENTS`) and Sprint 74 T1
(mnestra `source_agents` enum + recall filter) MUST ship in the same release window or
filter-by-agent silently breaks. Neither lane publishes anything (lanes never publish);
the ORCH sequences the coordinated release at close. T1's DONE post must explicitly state
what Sprint 74 T1 must have landed for the pair to be safe.

## Hard constraints

- T1 and T2 touch the installer/bundled-hooks surface → **`docs/INSTALLER-PITFALLS.md` is a
  mandatory read** before writing code; every change must trace to a pitfall class it avoids.
- No version bumps, no CHANGELOG edits, no commits, no publishes inside any lane.
- Zero-build-step, vanilla JS, CommonJS in server code. No new dependencies without a
  FINDING post justifying it.
- Tests: every code change lands with tests; suite must stay green (`npm test` from root).

## Acceptance (ORCH judges at close)

1. T1: web-chat-grok rows write `source_agent='grok-web'`; hooks accept + byte-floor-exempt
   it; hook stamps bumped; refresh path verified; pairing note posted.
2. T2: `termdeck init --bridge` runs idempotently, scaffolds config, prints operator-only
   steps (launchctl/systemctl) instead of attempting them; INSTALLER-PITFALLS traceability
   table in the lane's DONE post.
3. T3: input-accumulation bug reproduced (or proven already-fixed with evidence), fixed with
   regression test, and a draft public reply for termdeck#12 posted in STATUS.md.
4. T4: AUDIT-PASS/AUDIT-FAIL verdict per lane with file:line evidence + FINAL-VERDICT.

## Lane discipline (all lanes)

- Post shape, ALL posts: `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
  (FINDING / FIX-PROPOSED / FIX-LANDED / BLOCKED / DONE). The `### ` prefix is mandatory.
- Idle-polls (if any) use the tolerant regex `^(### )?\[T<n>\] DONE\b`.
- Auditor additionally posts `### [T4-CODEX] CHECKPOINT ...` at every phase boundary and at
  least every 15 minutes (see T4 brief).
