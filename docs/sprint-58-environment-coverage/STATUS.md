# Sprint 58 — STATUS

**Sprint:** Environment Coverage Catch-Net (pure infrastructure, zero feature work)
**Pattern:** 3+1+1 (T1/T2/T3 Claude workers + T4 Codex auditor + orchestrator)
**Date:** Plan authored 2026-05-05 ~15:30 ET; injection time TBD
**Target ship:** No npm publish. Deliverable is `.github/workflows/` + `docker/` + `scripts/` + `docs/INSTALL-FIXTURES.md` checked in. Future releases gated on the new CI passing.

## Lane post shape — MANDATORY uniform across all lanes

```
### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <one-line gist>
<body>
```

Status verbs: `BOOT`, `FINDING`, `FIX-PROPOSED`, `FIX-LANDED`, `DONE`, `BLOCKED`, `BLOCKED-ON-T<n>`, `BLOCKED-ON-ORCH`, `CHECKPOINT` (T4 only — every phase boundary AND every 15 min). Plus T4-specific: `FIXTURE-VERIFIED`, `FIXTURE-GAP`, `COVERAGE-GAP`, `DEFERRAL-OK`, `DEFERRAL-PARTIAL-CLOSE`.

T4 prefix: `### [T4-CODEX]`. Worker prefix: `### [T1]`, `### [T2]`, `### [T3]` — bare `[T<n>]` without `### ` is BANNED (Sprint 51.7 idle-poll regex bug).

## Lane scope summary

| Lane | Scope | Files |
|---|---|---|
| **T1 GHACTIONS+DOCKER** | Pieces 1 + 2: install-into-clean-Ubuntu workflow + Multi-OS Docker matrix (Ubuntu, Fedora, Alpine, Debian) | `.github/workflows/install-smoke.yml`, `docker/Dockerfile.{ubuntu,fedora,alpine,debian}`, `README.md` (badge) |
| **T2 SYSTEMD+DOCTOR** | Pieces 3 + 5: Hetzner nightly systemd VM smoke + Brad #4 version-gated doctor probes | `.github/workflows/systemd-nightly.yml`, `scripts/hetzner-systemd-smoke.sh`, doctor RPC probe + `tests/doctor-rpc-version-gate.test.js` |
| **T3 SUPABASE+DOCS** | Pieces 4 + 6: shared test Supabase project setup + canonical secret names + reset script + INSTALL-FIXTURES.md | `scripts/test-supabase-reset.sh`, `docs/INSTALL-FIXTURES.md` (orchestrator-coordinated: project creation + secret addition) |
| **T4-CODEX AUDITOR** | Independent verification of the catch-net's coverage; coverage matrix per Brad finding; adversarial probe for gaps | (read-only across all the above + cross-system: psql on test project, Hetzner API, GitHub Actions logs) |

## Pre-sprint substrate (verified at sprint open)

```
@jhizzard/termdeck             1.0.12 (Sprint 57 close)
@jhizzard/termdeck-stack       0.6.12
@jhizzard/mnestra              0.4.3
@jhizzard/rumen                0.5.3

origin/main commit             574c2eb (Sprint 57 ship — pushed 2026-05-05 ~15:15 ET)

Test Supabase project          (TBD — orchestrator-coordinated Task 3.1)
GitHub Actions secrets         (TBD — orchestrator adds after T3 documents canonical names)
Hetzner Cloud account          (TBD — orchestrator-pre-provisioned outside the sprint)
```

## Lane discipline (universal)

1. **No feature work.** If a lane finds itself touching `packages/server/src/`, `packages/cli/src/` (except for piece #5's doctor probe), or `packages/client/`, it has scope-crept. Stop, post `### [T<n>] SCOPE-CHECK ...` and check with orchestrator before continuing. T2 Task 2.3 (doctor version-gate) is the ONE allowed code-shipping task in this sprint.
2. **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Orchestrator handles close.
3. **Stay in lane.** Cross-lane reads OK. Cross-lane writes BANNED.
4. **Append-only STATUS.md.**
5. **Sprint 58 fixtures REPORT bugs, they don't FIX bugs.** A fixture that turns RED on Brad #5 is the deliverable; making it GREEN is Sprint 59's job. If you find yourself wanting to fix install.sh's bashisms or hardcoded zsh, post `### [T<n>] FINDING ...` describing the bug and stop. Sprint 59 ships against this catch-net.

## Cross-references

- Sprint 57 ship: commit `574c2eb`, `@jhizzard/termdeck@1.0.12`, `@jhizzard/termdeck-stack@0.6.12`
- Sprint 57 PLANNING + STATUS: `docs/sprint-57-cleanup-and-deferrals/`
- Brad's 9-finding field report (received during Sprint 57 close): `CHANGELOG.md` § [1.0.12] Notes
- Sprint 59 stub: `docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md`
- Global rules: `~/.claude/CLAUDE.md` § MANDATORY: Sprint role architecture
- Project rules: `./CLAUDE.md`
- Release procedure (no publish for Sprint 58): `docs/RELEASE.md`

---

## Lane posts (append below — newest at bottom)

<!-- T1, T2, T3 use bare ### [T<n>] prefix. T4-CODEX uses ### [T4-CODEX]. -->
<!-- Example canonical post:  ### [T1] FINDING 2026-05-05 HH:MM ET — install.sh line 47 uses [[ ]] which fails on Alpine ash; flag for Sprint 59 fix -->

