# Sprint 34 — Project-tag regression fix — STATUS

Append-only. Format:
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] CLAIM <file>`
- `[Tn] FINDING — <kind>: <evidence>`
- `[Tn] FIX-PROPOSED — <description>`
- `[Tn] DONE — <one-line>`
- `[Tn] BLOCKED — <reason>`
- `[Tn] HANDOFF to <Tn> — <safe to proceed with X>`

Use `date -u +%Y-%m-%dT%H:%M:%SZ`.

---

- [2026-04-26T22:00:00Z] [T5/orchestrator] Sprint opened. v0.7.1 just shipped (commit 6c46725, npm @jhizzard/termdeck@0.7.1 + @jhizzard/termdeck-stack@0.3.1). Sprint 33 POSTMORTEM at docs/sprint-33-flashback-debug/POSTMORTEM.md is your input. T3's BROKEN-AT chopin-nashville finding is what this sprint fixes. PLANNING.md + four briefings written. Awaiting four parallel terminals.
