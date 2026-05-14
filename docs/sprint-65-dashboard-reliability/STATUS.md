# Sprint 65 — STATUS

**Sprint:** Dashboard reliability + orch-panel awareness wave
**Pattern:** 3+1+1 (T1/T2/T3 Claude + T4 Codex auditor + Orchestrator)
**Authored:** 2026-05-14 (queued behind Sprint 64)
**Inject:** pending Sprint 64 close + Joshua's "terminals open" signal
**Wave target:** `@jhizzard/termdeck@1.4.0` + `@jhizzard/termdeck-stack@1.4.0`

---

## Post shape (mandatory)

`### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`

`### ` prefix REQUIRED on every lane. T4 uses `### [T4-CODEX] ...`.

Verbs: BOOTED / FINDING / FIX-PROPOSED / FIX-LANDED / DONE / (T4) CHECKPOINT / AUDIT-OK / AUDIT-CONCERN / AUDIT-RED / FINAL-VERDICT GREEN/YELLOW/RED / (ORCH) SCOPE / INJECT / SHIP.

---

## Orchestrator — Sprint context

- **Sprint 64** ships (or queued) — see `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` § Resolution for status.
- **Sources for this sprint's scope:**
  - `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 entry (3 items) + 2026-05-13 v2 spec entry (chips + ORCH pin) + 2026-05-14 8-panel/multi-port entry (Path A fold-in candidate).
  - Existing P0 in BACKLOG § P0 — per-adapter idle/parked detection (Sprint 59-surfaced, bundled here per T2 sub-task 2.5).
- **Approach A decided** for orch identification (explicit `meta.role` flag) — see BACKLOG D.5 entry for full reasoning.
- **Path A fold-in (T1 sub-task 1.4)** — orchestrator adjudicates at inject based on T1's bandwidth estimate.

---

## Lane assignments

| Lane | Owner | Focus | Brief |
|------|-------|-------|-------|
| T1 | Claude | Client: chips + ORCH pin + tile auto-removal (+ optional Path A layouts) | `T1-client-chips-and-orch-pin.md` |
| T2 | Claude | Server: meta.role + exited filter + 410 Gone + panel_exited WS + idle/parked | `T2-server-meta-role-and-lifecycle.md` |
| T3 | Claude | Verification + Brad's 2a repro + 18-panel acceptance matrix | `T3-verification-and-repro.md` |
| T4 | Codex | Adversarial auditor — race conditions + schema + localStorage | `T4-codex-auditor.md` |

---

## Lane posts

_(lanes append here once injected)_

---

## Cross-lane dependencies

- **T2 → T1:** T1 expects `meta.role` in per-session meta + `panel_exited` WS frame shape. T2 must define both before T1's FIX-LANDED is meaningful.
- **T1 + T2 → T3:** T3's acceptance matrix exercises both lanes together. T3 starts test scaffolding early but can't run end-to-end until both T1 + T2 FIX-LANDED.
- **T2 → T3 (idle/parked):** T2's `idlePattern` declarations land in agent-adapter files; T3's acceptance for idle detection asserts the resulting status flip.
- **Sprint 64 → Sprint 65:** if Sprint 64 ships first, the `adapter.spawn` field is already on each adapter file. Sprint 65 T2 extends with `idlePattern` on the same files. Coordinate via FINDING if Sprint 64 hasn't shipped at inject.
- **T4 → all:** auditor reviews each FIX-LANDED before sprint close. FINAL-VERDICT gates SHIP.

---

## Brad outreach (orchestrator-side)

Two WhatsApp asks during this sprint:

1. **At sprint inject:** request Brad's "opens invisible" repro steps (T3 sub-task 3.1). Suggested message: *"Heading into Sprint 65 (chips + ORCH pin + dead-panel cleanup). For 2a (panels opening invisible from your 2026-05-12 list) — got repro steps? T3 lane has 4 hypothesis branches but Brad's actual repro path beats them all."*
2. **At sprint close:** ship summary with chips + ORCH visual + 18-panel-2-project repro proof.

Use the AppleScript-driven WhatsApp send pattern from global CLAUDE.md § Never present messages for copy-paste — always inject.

---

## Sprint close-out checklist (orchestrator)

- [ ] All four lanes posted `DONE` / `FINAL-VERDICT GREEN`.
- [ ] `npm test` root green.
- [ ] `ACCEPTANCE-CHECKLIST.md` exists; key matrix items pass.
- [ ] Brad's 2a repro adjudicated (fixed-in-sprint OR deferred with BACKLOG entry).
- [ ] `gitleaks` pre-commit clean.
- [ ] Version bumps: termdeck → 1.4.0, termdeck-stack → 1.4.0.
- [ ] CHANGELOG entries authored for both packages.
- [ ] Joshua publishes `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` (Passkey, `--auth-type=web`).
- [ ] Orchestrator `git commit` + `git push origin main`.
- [ ] `git tag v1.4.0` + push.
- [ ] `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 + 2026-05-13 entries marked CLOSED; 8-panel/multi-port entry kept (Path B still pending).
- [ ] `PLANNING.md` gains `## Resolution` section.
- [ ] `docs/RESTART-PROMPT-2026-MM-DD-post-sprint-65.md` authored.
- [ ] Brad WhatsApp ship summary.
- [ ] Session-end email drafted.
