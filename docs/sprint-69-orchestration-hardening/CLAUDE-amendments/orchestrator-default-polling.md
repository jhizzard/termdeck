# Amendment for `~/.claude/CLAUDE.md` — orchestrator default polling discipline

**Section to add to the global 3+1+1 sprint orchestration rule, after the auditor synchronize-on-LANDED section.**

---

## MANDATORY: Orchestrator default polling discipline (3+1+1)

At sprint kickoff — **immediately after the inject succeeds** (all panels confirmed receiving the boot prompt via the two-stage submit pattern) — the orchestrator MUST set up a recurring polling tick. The orchestrator is conversational by default and will idle indefinitely without a wake-up loop; this is the documented failure mode that cost Maestro Sprint 2 ~41 minutes of false silence.

**Mechanism:** `ScheduleWakeup` (in-session, dynamic mode) OR the `/loop` skill. Tick cadence:

- **270s default** during workers-in-flight phase (stays inside the prompt-cache window; cheap per tick).
- **60-90s during close-out lap** (one worker DONE pending; tighter polling matches the faster expected pace).
- **NEVER 300s exactly** — worst-of-both: pays the cache miss without amortizing it. Drop to 270s (stay in cache) or commit to 1200s+ (one cache miss buys a much longer wait).
- **Stop polling on FINAL-VERDICT GREEN** (orchestrator or auditor close).

**Tick signals — ranked by reliability:**

1. **STATUS.md whole-file scan** (most reliable). Grep for `^### \[(T[1-4](-[A-Z]+)?|ORCH)\] (FINDING|PROPOSE|LANDED|DONE|AUDIT-RED|AUDIT-CONCERN|CHECKPOINT|FINAL-VERDICT|STATUS|RULING)` across the WHOLE file (NOT tail-only — workers post inside their own `## T<n>` sections, which sit before the orchestrator's appended posts; tail polling misses them). Compare per-lane LANDED/DONE/AUDIT-* timestamps against the prior tick's snapshot. New posts = signal.

2. **TermDeck `meta.parked` field** (Sprint 69 primitive). Derived from buffer-content parsing for completion-banner regex. Reliable for parked-done detection on Claude Code panels (Codex/Gemini banners may differ — see Sprint 69 T3's regex coverage). Use to detect a worker who finished but didn't post `LANDED` yet — nudge via `POST /api/sprints/nudge` `kind=post-landed-reminder`.

3. **TermDeck `meta.status` field — DO NOT USE for polling decisions.** Documented stale: persists at `status=active, statusDetail="Using tools"` long after a Claude Code panel reaches its completion banner (Sprint 2 + Sprint 69 evidence). Useful only for confirming the initial inject landed; after that, ignore.

4. **Panel buffer endpoint** (`GET /api/sessions/:sid/buffer`) — useful for parked-banner detection when `meta.parked` isn't available. Don't rely on it for active-work detection; many panels return empty buffer mid-render.

**Parked-lane nudge cycle:**

1. Detect parked-without-LANDED (via `meta.parked=true` OR buffer-content + lastActivity > 10 min, against a lane with an open requirement).
2. Construct a nudge text. For Sprint 69+: `POST /api/sprints/nudge` with the right `kind`. For pre-Sprint-69: hand-roll a two-stage-submit script.
3. Two-stage submit: paste-stage with bracketed-paste markers, settle 400 ms, submit-stage with `\r` alone. Same primitive as inject.
4. Wait one tick; if the nudged lane still hasn't engaged, fall back to `codex-rescue` subagent or [ORCH] STATUS proxy-post documenting the disk state.

**Close-out trigger:** all worker lanes post DONE (or orchestrator explicitly closes via `### [ORCH] STATUS — close-out begins`). Then:

1. Run the project's full test suite from the sprint branch.
2. Spawn independent auditor (`codex-rescue` subagent or other fallback model) — required when sprint auditor failed or was waived.
3. Author kitchen-level memories (orchestrator-centralized per the global rule; do NOT delegate to workers).
4. Author any CLAUDE.md amendments the sprint produced.
5. Surface to Josh: codex-rescue verdict, suite result, file list, branch-rename if needed, amendment files. Await commit OK.

**TermDeck Sprint 69 introduced** the `GET /api/sprints/status?file=<path>` parser endpoint — orchestrators using TermDeck 1.6.0+ can replace the bash grep + post-tracking with a structured JSON query (returns per-lane `last_post`, `open_reds_against_me`, `landed_since_last_red`). Use it when available.
