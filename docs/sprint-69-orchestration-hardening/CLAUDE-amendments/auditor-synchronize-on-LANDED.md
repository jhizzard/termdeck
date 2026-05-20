# Amendment for `~/.claude/CLAUDE.md` — auditor lane synchronize-on-LANDED

**Section to add to the global 3+1+1 sprint orchestration rule, after the worker done-when discipline section.**

---

## MANDATORY: Auditor lane synchronize-on-LANDED (3+1+1)

In a **BUILD sprint** (the workers are writing new code, not reviewing already-committed code), the auditor (T4 — typically Codex, Gemini, or a fallback subagent) MUST synchronize on worker LANDED posts. The audit cycle is:

1. **Boot phase** — read the sprint contract (`PLANNING.md`, `STATUS.md`, your lane brief). Set up your independent test harness from scratch — do NOT reuse worker fixtures. **Do NOT run audit assertions against the pre-build branch state.** Post `### [T4-<CLI>] CHECKPOINT YYYY-MM-DD HH:MM ET — Phase 0 / Boot complete`.

2. **Wait phase** — poll `STATUS.md` (or `GET /api/sprints/status` if the sprint has access to TermDeck Sprint 69+ primitives) for worker LANDED posts. While waiting, post a `### [T4-<CLI>] CHECKPOINT` at every phase boundary AND **at least every 15 minutes**. STATUS.md is the only substrate that survives panel compaction; your in-context audit state does not.

3. **Audit-on-LANDED** — once a worker posts LANDED, INDEPENDENTLY REPRODUCE their claim. Run their tests, write your own adversarial variants, grep their source for the failure modes in your brief. Post `### [T4-<CLI>] AUDIT-RED` only on a LANDED defect with file:line evidence. Post `### [T4-<CLI>] AUDIT-CONCERN` for forward-looking risks (design concerns, not failing tests).

4. **FINAL-VERDICT** — only after **either** (a) the orchestrator closes the sprint explicitly via `### [ORCH] STATUS — close-out`, **OR** (b) all worker lanes have posted DONE. **Do NOT issue FINAL-VERDICT against an unbuilt branch.** Maestro Sprint 2 (2026-05-18) had the Codex auditor issue `FINAL-VERDICT RED` 4 minutes after Phase-0 boot, against unbuilt code; the orchestrator had to RESCIND the verdict via [ORCH] RULING. The build sprint produces code over time, not in one shot.

5. **Tooling-failure fallback** — if your shell/file-read tooling dies mid-audit (Sprint 1 + Sprint 2 + Sprint 69 evidence: Codex `exec_command` returning `code -1` on every call; Grok CLI bracketed-paste incompatibility), post `### [T4-<CLI>] TOOLING-FAILURE CHECKPOINT` + your AUDIT-REDs in full + `### [T4-<CLI>] FINAL-VERDICT — RED-BY-INABILITY`. The orchestrator spawns a fallback verifier (typically `codex-rescue` subagent). Honesty over false-green.

**Cross-CLI compatibility:** Codex, Gemini, and Claude Code all honor bracketed-paste injection. **Grok does NOT** (Sprint 69 finding, 2026-05-20). When picking an auditor lineup for a 3+1+1 sprint, Grok is structurally unusable as a TermDeck-injected lane until either Grok CLI ships paste support OR the TermDeck inject endpoint adds a Grok-specific transport.
