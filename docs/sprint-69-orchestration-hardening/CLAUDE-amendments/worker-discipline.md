# Amendment for `~/.claude/CLAUDE.md` — worker lane done-when discipline

**Section to add to the global 3+1+1 sprint orchestration rule, after the existing "MANDATORY: Sprint role architecture — Orchestrator + Workers + Auditor (3+1+1)" section.**

---

## MANDATORY: Worker lane done-when discipline (3+1+1)

In a 3+1+1 sprint, a worker lane's task is **NOT complete when local tests pass**. It is complete only when ALL of these are true:

**(a)** Tests green — `<lane's test command>` ≤ baseline established at boot.

**(b)** `### [T<n>] LANDED YYYY-MM-DD HH:MM ET — <gist>` posted to the sprint's `STATUS.md` with **file:line evidence** + the exact test command + result. The post is the substrate-side signal; orchestrator and auditor cannot observe done-ness any other way (TermDeck `meta.status` does NOT refresh when a CLI panel reaches its completion banner — Sprint 2 + Sprint 69 evidence).

**(c)** Auditor has had a **10-minute window** to react after your LANDED. If no auditor exists for the sprint, OR the auditor is unresponsive past the window, post a FINDING noting the silence and then post `### [T<n>] DONE` based on (a) + (b) alone. The orchestrator handles audit at close-out via a fallback (e.g. `codex-rescue` subagent). Do NOT wait indefinitely on a deadweight auditor.

Why (c) is bounded: Sprint 69 caught the unbounded form of (c) deadlocking T2 (Codex worker) when T4 (Grok auditor) was structurally unusable (Grok CLI bracketed-paste incompatibility). T2 sat at LANDED-but-not-DONE for 14+ minutes posting FINDING-routed-to-T4 with no possibility of a reaction. The orchestrator broke the deadlock with an [ORCH] RULING; this amendment makes the bound canonical.

**Substrate is load-bearing.** The Claude Code completion banner ("Cogitated/Churned/Brewed/Cooked/Mused/Pondered/Wandered/Crafted for Nm Ns" in gray text) appears AFTER your tests pass; from outside, the panel looks "active using tools" indefinitely. STATUS.md is the only channel the orchestrator and auditor have to observe your progress. Post verbosely.

**The new TermDeck `meta.parked` field** (Sprint 69 T3) closes part of this gap — orchestrators can now detect parked-done panels via buffer-content parsing. But the worker post is still primary. `meta.parked` is the orchestrator's nudge trigger, not the worker's free pass to skip posting.
