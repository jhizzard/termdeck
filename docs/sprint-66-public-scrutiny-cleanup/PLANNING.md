# Sprint 66 — Public-scrutiny cleanup: CI reliability + Sprint-65 reception + dependency hygiene

**Authored:** 2026-05-17 by the orchestrator session, after TermDeck's first real wave of external scrutiny.
**Inject:** 4 panels already open on `http://127.0.0.1:3000` — T1/T2/T3 Claude + T4 Codex. Inject on Joshua's go.
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator.
**Wave target:** `@jhizzard/termdeck@1.4.1` patch by default (reception fixes are bug-shaped; CI changes are mostly non-package). Bump to `1.5.0` only if T2 lands a major dependency upgrade or T1 adds a genuinely new public API surface — orchestrator decides at close-out.
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence for all three lanes; the `CI` workflow genuinely green (all 4 jobs); the README badge green and honest; Brad can engage both Sprint-65 features (chip rail + ORCH tag) on his existing setup without destroying and recreating panels.

---

## Why this sprint exists

TermDeck got its first real external scrutiny on 2026-05-16/17. It surfaced four things — none catastrophic, all corrosive to credibility if left:

1. **CI has been red for ~6 days** (across Sprints 63/64/65) while `npm test` stayed 375/375. The README's `install-smoke` badge shows "failing" to every visitor. The redness is four separate causes, none a product bug — see T3.
2. **Sprint 65 shipped two headline features Brad cannot see.** The project-filter chip rail and the ORCH-pin both shipped correctly in 1.4.0 — verified: `npm view gitHead` = `cc883b7`, and the published `app.js` is byte-identical to the repo. But two design decisions make them invisible in Brad's exact situation. Sprint 65 solved the technical edge cases and missed the human-reception case. See T1.
3. **5 stale open PRs** — 4 Dependabot major-version bumps idle for weeks, 1 internal docs PR (superseded, closed 2026-05-17). A repo with idle PRs and a red badge reads as unmaintained. See T2.
4. **Mnestra/Rumen look abandoned** — both repos are fully in sync with npm and simply quiet (recent sprints were all TermDeck-side), but to an outsider two stale-looking repos beside a hyperactive TermDeck reads as a dead memory layer. Addressed orchestrator-side at close-out, not a lane.

Three of these are lane-shaped and converge into one cleanup sprint.

---

## Lane structure (3+1+1)

| Lane | Owner | Focus |
|------|-------|-------|
| T1 | Claude | **Sprint-65 reception gap** — make the chip rail discoverable with a single project; make `meta.role` mutable post-spawn + add a UI affordance to tag a live panel as orchestrator |
| T2 | Claude | **Dependency hygiene** — triage the 4 open Dependabot major-version PRs against TermDeck's CommonJS / no-build / Node-20-22 constraints; bump the safe ones in-tree, document the rest |
| T3 | Claude | **CI reliability** — green the `CI` workflow end-to-end (both lint steps + docs-lint), make the three secret-gated workflows skip-neutral, re-point the README badge, write the secret re-provisioning runbook |
| T4 | Codex | **Adversarial auditor** — independently reproduce and verify all three lanes; CHECKPOINT discipline |
| Orch | Claude | Front D (Brad's Rumen redeploy hand-off); Mnestra/Rumen signal-of-life; version/CHANGELOG/commit/publish/push/tag; memory harvest; closing the Dependabot PRs T2 supersedes |

**T4 is the Codex panel** — confirmed by Joshua. The orchestrator maps the Codex session to T4 at inject regardless of grid position.

---

## Scope summary (full detail in each lane brief)

### T1 — Sprint-65 reception gap (`T1-reception-gap.md`)

Sprint 65's chip rail and ORCH-pin are in Brad's installed 1.4.0, but invisible to him because:
- **Chip rail:** `shouldShowChipRow()` (`app.js:734`) hides the rail when there are fewer than 2 distinct projects. Brad's dead-panel reaper left him 1 live panel → 1 project → the rail correctly self-hides. Brad's 2026-05-13 spec asked for an *always-visible* rail.
- **ORCH pin:** the gold border + ORCH badge only engage for a panel whose `meta.role === 'orchestrator'`, and `meta.role` is **immutable post-spawn** (`app.js:916` comment) with **no UI to set it**. Brad's existing orchestrator panel has no role → no treatment, and no way to fix without destroying and recreating the panel via the API.

T1 makes the chip rail discoverable (render it whenever there is ≥1 project) and makes `meta.role` **mutable** — a new endpoint to change a live session's role + a UI affordance ("mark as orchestrator") so Brad can tag his existing panel in place.

### T2 — Dependency hygiene (`T2-dependency-hygiene.md`)

Four open Dependabot major-version PRs: `express` 4.22.1→5.2.1 (#4), `open` 10.2.0→11.0.0 (#7), `@anthropic-ai/sdk` 0.39.0→0.93.0 (#9, dev dep), `uuid` 9.0.1→14.0.0 (#10). Each is a major bump with real breaking-change risk against TermDeck's hard constraints (CommonJS `require()` in the server, zero build step, Node 20/22). T2 evaluates each against actual in-repo usage, bumps the genuinely-safe ones in-tree (edit `package.json` + `package-lock.json`, `npm test` must hold 375/375), and documents a clear merge/hold/close verdict for each. The orchestrator closes the superseded Dependabot PRs at close-out.

### T3 — CI reliability (`T3-ci-reliability.md`)

The `CI` workflow is **doubly-broken** and the three integration workflows fail on absent secrets. Verified diagnosis (full file:line map in the brief):
- `lint-conventions` step 1: 4 bare `catch {` blocks + the grep wrongly scans bundled Rumen Edge Function `.ts` mirrors.
- `lint-conventions` step 2 (hidden behind step 1): ~10 pre-existing `console.error` issues — camelCase tags the regex rejects, a comment containing the literal string, and untagged user-facing messages.
- `docs-lint`: 2 stale "Engram" refs in a historical restart-prompt doc.
- `install-smoke` / `macos-install-smoke` / `systemd-nightly`: all GitHub Actions secrets are absent (`gh secret list` returns empty) — infra, not code.

T3 greens `CI` end-to-end, makes the secret-gated workflows skip-neutral when secrets are absent, re-points the README badge to `CI` once it is genuinely green, and writes the secret re-provisioning runbook (Joshua chose "skip now, re-provision in S66").

### T4 — Codex auditor (`T4-codex-auditor.md`)

Independent adversarial review: reproduce each lane's claims, audit WIP before FIX-LANDED, surface shared-assumption blind spots. Especially load-bearing for T1's role-mutation race conditions, T2's CJS-compatibility claims, and T3's skip-not-fail correctness (a skipped job must not mask a genuine install regression when secrets ARE present).

### Orchestrator-side

Front D (Brad's stale `rumen-tick` Edge Function — a separate Brad-facing hand-off, not a lane); Mnestra/Rumen "signal of life" touch at close-out; version bump + CHANGELOG + commit + publish hand-off + push + tag; orchestrator-centralized kitchen-memory harvest from STATUS.md; closing the Dependabot PRs that T2's in-tree bumps supersede; the two classifier-blocked GitHub writes (branch protection, PR #11) pending Joshua.

---

## Hardening rules (mandatory — global CLAUDE.md + project)

1. **Post-shape uniformity:** every lane posts `### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` to STATUS.md. The `### ` prefix is REQUIRED. T4 posts `### [T4-CODEX] ...`.
2. **Auditor CHECKPOINT discipline:** T4 posts `### [T4-CODEX] CHECKPOINT ...` at every phase boundary and at least every 15 minutes — phase, what's verified with file:line evidence, what's pending, last FIX-LANDED reference.
3. **Idle-poll regex hardening:** any lane polling for another posts with the tolerant `^(### )?\[T<n>\] DONE\b`.
4. **No forbidden literals in committed files** — no internal Supabase project names or refs anywhere in `docs/sprint-66-*`, code, or commit messages. The gitleaks pre-commit hook enforces this.
5. **No "pen-test" framing** — "adversarial sweep" / "end-to-end functional sweep".
6. **No version bumps / CHANGELOG edits / commits from lanes** — orchestrator does those at close-out.
7. **Supabase RLS hygiene** — this sprint is client + server JS + CI config; no new SQL functions expected. If a migration appears, the 5 hygiene gates apply.

---

## Acceptance criteria

**For sprint close (T4-CODEX FINAL-VERDICT GREEN, file:line evidence per lane):**

- **T1:** chip rail renders with ≥1 project (discoverable, not hidden behind the 2-project threshold); `meta.role` is mutable on a live session via a new endpoint with whitelist validation; a UI affordance tags a panel as orchestrator and the gold border + ORCH badge appear without recreating the panel; `status_broadcast` reflects the change; tests updated.
- **T2:** a documented merge/hold/close verdict for each of the 4 Dependabot PRs; any in-tree dependency bumps keep `npm test` at 375/375; no CommonJS `require()` breakage; no build step introduced.
- **T3:** `CI` workflow green — all 4 jobs (`syntax`, `lint-conventions` both steps, `docs-lint`, `install`); `install-smoke` / `macos-install-smoke` / `systemd-nightly` skip-neutral (not failing) when their secrets are absent, and still run fully when secrets are present; README badge points at `CI` and is green; `docs/sprint-66-public-scrutiny-cleanup/CI-SECRET-REPROVISIONING.md` runbook authored.
- **T4-CODEX:** FINAL-VERDICT GREEN with file:line evidence for all three lanes.

**For ship (orchestrator scope):**

- `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` version-bumped, CHANGELOG entry added, published (Passkey by Joshua), committed, pushed, tagged.
- This file gains a `## Resolution` section.
- `docs/RESTART-PROMPT-2026-05-17-post-sprint-66.md` authored.
- Dependabot PRs T2 superseded are closed; the 2 classifier-blocked GitHub writes resolved or handed to Joshua.

---

## Boot sequence (each lane reads this top-to-bottom)

1. `mcp__mnestra__memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `mcp__mnestra__memory_recall(query="Sprint 65 close v1.4.0 CI red Brad chip ORCH reception")`
3. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs since Sprint 65")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/RESTART-PROMPT-2026-05-16-post-sprint-65.md` (most-recent restart prompt)
7. Read `docs/sprint-66-public-scrutiny-cleanup/PLANNING.md` (this file)
8. Read `docs/sprint-66-public-scrutiny-cleanup/STATUS.md`
9. Read `docs/sprint-66-public-scrutiny-cleanup/T<n>-<lane>.md` (your full briefing)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / FIX-LANDED / DONE with the canonical `### [Tn] ...` shape. No version bumps, no CHANGELOG edits, no commits — the orchestrator handles close-out.

---

## Inject protocol

Two-stage submit pattern per `~/.claude/CLAUDE.md` § 3+1+1 orchestration. TermDeck server is on `http://127.0.0.1:3000`. One-shot Node script at `/tmp/inject-sprint-66-prompts.js`: paste pass (`\x1b[200~<brief>\x1b[201~`, no CR) across all 4 sessions with ~250ms gaps → 400ms settle → submit pass (`\r` alone) across all 4. Verify each panel reaches `status: 'thinking'` within 8s; `POST /api/sessions/:id/poke` with `methods: ['cr-flood']` for any panel still idle.

---

## Resolution

**Sprint 66 closed GREEN — 2026-05-17 16:52 ET.** `### [T4-CODEX] FINAL-VERDICT GREEN`; ~70 min wall-clock inject → verdict. Wave: `@jhizzard/termdeck@1.4.0 → 1.5.0` + `@jhizzard/termdeck-stack@1.4.0 → 1.5.0` (audit-trail aligned); `@jhizzard/mnestra` unchanged at 0.4.9. Root `npm test` 391 pass / 0 fail / 0 skipped.

**Shipped — all three lanes DONE, verified by T4-CODEX with file:line evidence:**

- **T1 — Sprint-65 reception gap.** Chip rail renders with a single project (`app.js:742-743`); `meta.role` mutable post-spawn via `PATCH /api/sessions/:id` (route validates at `index.js:1755-1769`; `SessionManager.updateMeta` whitelists + persists at `session.js:632-679`); "mark as orchestrator" Overview-tab toggle (`app.js:441` / `:2216-2244`), re-synced from broadcasts (`app.js:3476-3496`). The brief overstated the client scope — the client was already mutation-ready; only a stale comment needed fixing.
- **T2 — dependency hygiene.** 4 Dependabot PRs resolved in-tree: `express` 4→5 MERGE (1 wildcard route + 2 body guards), `@anthropic-ai/sdk`→0.96.0 MERGE, `uuid` + `open` CLOSE-by-removal. Surfaced + fixed the latent shipped-1.4.0 `require('uuid')` → `ERR_REQUIRE_ESM` bug. `npm test` 391/0, `npm audit` 0.
- **T3 — CI reliability.** `CI` workflow green end-to-end (both `lint-conventions` steps + `docs-lint`); `install-smoke` / `macos` / `systemd-nightly` skip-neutral on absent secrets via a `preflight` gate; README badge → `CI`; `CI-SECRET-REPROVISIONING.md` runbook authored.
- **T4-CODEX** — FINAL-VERDICT GREEN; 2 AUDIT-CONCERNs (over-broad `console.error` exception → T3 narrowed it; a forbidden-literal slip in STATUS → T4 scrubbed it), no AUDIT-RED.

**Deferred / follow-ups** (queued, not Sprint 66 scope): `jhizzard/mnestra` + `jhizzard/rumen` have their own red CI (task #7 — Mnestra: 4 failing Dependabot-PR runs; Rumen: CI red every release push since v0.4.4); Sprint 64's `PreCompact` auto-commit hook was never deployed on the daily-driver (hook file installed mid-close-out; `~/.claude/settings.json` wiring handed to Joshua — the permission classifier hard-blocks an agent self-wiring a hook); the stale `~/.claude/hooks/memory-session-end.js` (May 4, pre-Sprint-62) needs refresh; Brad's "2a opens-invisible" repro; and 5 GitHub-side close-out items parked on Joshua (light branch protection, PR #11 close, Dependabot PR #4/#7/#9/#10 closes).
