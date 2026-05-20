# TermDeck Sprint Proposal — 3+1+1 Orchestration Hardening

**Authored 2026-05-19 by the Maestro Sprint 2 orchestrator, for the next TermDeck sprint.**

**Trigger:** Maestro Sprint 2 (Intake Hop: Podium → Maestro) was technically successful (545 pass / 0 fail / 1 xfail; T1+T2+T3 shipped substantial code; T4 caught real defects via independent audit) — but it was an **operational slop show**. The technical success masked roughly five compounding orchestration failures that wasted ~90 minutes of wall-clock time and required manual orchestrator intervention to close out. Every failure is a TermDeck-side fix because the underlying primitives (3+1+1 panels, STATUS.md substrate, two-stage submit, panel status API) are all TermDeck's surface area.

This document inventories the failures, the kitchen-lessons saved to Mnestra, and a proposed TermDeck sprint that comprehensively addresses them.

---

## 1. Documented failure modes (Sprint 2 evidence)

### 1.1 Auditor brief shape — "audit now" reads as "audit on boot"

**Observed:** T4 (Codex auditor) issued `FINAL-VERDICT RED` at 18:18 ET, **four minutes after Phase-0 boot**, with zero worker LANDED posts. The 11 audit tasks in T4's brief read as immediate-action items, so T4 ran them against the unbuilt branch, found everything missing (correct observation, expected state), and declared the sprint failed before workers had typed a character of fix code.

**Recovery cost:** orchestrator had to author an `[ORCH] RULING` rescinding the verdict, then a corrective two-stage inject to T4 to switch it from "verdict mode" to "monitoring mode." ~15 minutes of orchestrator wall-clock + corrupted audit log on STATUS.md.

**Root cause:** the brief shape for an adversarial auditor in a BUILD sprint (vs. an AUDIT sprint of prior committed code, which was Sprint 1's shape) needs an explicit "synchronize-on-LANDED" clause at the top of the task list. The audit cycle is `wait for LANDED → independently reproduce → AUDIT-RED on broken / verified-pass on sound → CHECKPOINT every 15 min while waiting → FINAL-VERDICT only after orchestrator closes`, not `audit-on-boot → verdict → done`.

### 1.2 Worker discipline — "tests pass" ≠ "LANDED posted"

**Observed:** After T4's 18:56 ET amended `FINAL-VERDICT RED` with 3 landed defects, all three workers (T1/T2/T3) engaged on the fixes. T2 posted LANDED 19:45 ET (correct discipline). T1 worked ~8 minutes, finished, hit the Claude Code "Cogitated for 8m 11s" completion banner, went idle **without posting LANDED**. T3 worked ~12 minutes, finished, hit "Churned for 11m 51s", **also went idle without posting LANDED**. STATUS.md stayed silent for 41 minutes while the work was actually done on disk.

**Recovery cost:** orchestrator-side `[ORCH] STATUS` post acting as proxy LANDED + a second corrective inject to T1/T2/T3 with explicit "post your own LANDED now" instructions. The full backend suite (~145s wall-clock) was re-run by the orchestrator as independent verification.

**Root cause:** lane briefs say "post LANDED before commit" but don't make LANDED-posting a load-bearing CONDITION OF DONE. Workers naturally interpret "tests green" as completion. The brief defect is a missing top-of-the-section clause: *the work isn't done until (a) tests green AND (b) `### [Tn] LANDED` posted to STATUS.md AND (c) auditor has reacted.*

### 1.3 Orchestrator sensor — `meta.status` is stale

**Observed:** The orchestrator's polling loop read `GET /api/sessions` and checked `meta.status` + `meta.statusDetail`. For idle Claude Code panels sitting at completion banners, the API persistently reported `status="active", statusDetail="Using tools", lastActivity=<recent>` — meaning the orchestrator concluded the panel was actively working when it was in fact parked-done. Buffer reads (`GET /api/sessions/:id/buffer`) returned empty content for these panels, which the orchestrator misread as transient rendering instead of as a parked-state signal.

**User-side detection** ("you're reading 'Using tools' as a true indicator. It is flawed, it means nothing and doesn't refresh when the terminal goes idle") was the only thing that broke the loop.

**Recovery cost:** ~70 minutes of orchestrator polling cycles built on a stale sensor + a complete methodology rewrite mid-sprint.

**Root cause:** TermDeck's `meta.status` is event-driven (updates on PTY-byte-write events, not on Claude Code's "task complete" event because that's an in-band semantic event, not a PTY event). The fix is either: (a) parse the visible buffer for completion banners (the gray "Cogitated/Churned/Brewed/Cooked for Nm Ns" pattern) and surface "parked-done" as a distinct status, OR (b) integrate with Claude Code's hook system (if available) to receive task-completion events directly.

### 1.4 Boot-prompt boilerplate per sprint

**Observed:** Every 3+1+1 sprint requires the orchestrator to author 4-5 boot-prompt files that are 70-80% identical skeleton (memory_recall calls + read `~/.claude/CLAUDE.md` + read project CLAUDE.md + read PLANNING.md + STATUS.md + T<n>-*.md + post-shape discipline + don't-commit). The variations are sprint name, project, lane brief filename, lane-specific intel, and CLI-type syntax differences (Claude Code's `memory_recall` MCP vs. Codex's surface vs. Gemini's vs. Grok's).

**Recovery cost:** Sprint 1 audit + Sprint 2 each cost ~1-2 hours of orchestrator boilerplate authoring. Cumulatively this is a portfolio-scale waste (Joshua runs 3+1+1 on TermDeck, Maestro, Podium, ClaimGuard, etc.).

**Root cause:** no templating layer; the orchestrator hand-rolls each inject from scratch each time.

### 1.5 No orchestrator wake-up loop by default

**Observed:** The orchestrator (Claude Code) is conversational by default — responds to user messages, then idles until next message. There's no automatic background poll. The first 41-minute silence in Sprint 2 happened because the orchestrator said "I'm parked, watching" while actually just waiting for the next user message; no actual polling was occurring.

**Recovery cost:** the orchestrator eventually used `ScheduleWakeup` to fire itself back into action on a 270s cadence, but only after Josh explicitly asked "why aren't you actively checking all the time."

**Root cause:** orchestrators (any Claude Code session running an orchestration) need a default `/loop`-like behavior set up at sprint kickoff. Currently this requires explicit user invocation or explicit `ScheduleWakeup` calls. TermDeck could surface "this session is orchestrating a sprint" as a metadata flag and a recommended-loop primitive.

---

## 2. Kitchen-lessons saved to Mnestra (cross-link these in the sprint)

Three Sprint-2-derived kitchen-level lessons are already durable. Recall them via `memory_recall(query="3+1+1 orchestration kitchen-lesson Maestro Sprint 2 2026-05-19")` or by the more specific queries below. The TermDeck sprint design should reference them as authoritative.

1. **"Worker considers itself done when its tests pass, not when STATUS.md is updated."** (project=global, source_type=decision, category=workflow.) Includes three orthogonal fixes (brief shape, orchestrator polling, auditor responsibility).

2. **"TermDeck `meta.status` is NOT authoritative for is-this-panel-actually-doing-work."** (project=global, source_type=decision, category=workflow.) Includes the completion-banner patterns and the STATUS.md-driven detection algorithm.

3. **"TermDeck feature request — boot-prompt templates per (CLI-type × role)."** (project=termdeck, source_type=decision, category=workflow.) The first draft of feature 4.1 below; this sprint formalizes it.

A previously-saved related lesson from Sprint 1: **"A parked lane will not auto-wake; orchestrator nudging is load-bearing."** (project=global.) Sprint 2 evidence is a confirmation, not a new lesson.

---

## 3. Existing TermDeck primitives that work correctly

- **Panel spawning** (`POST /api/sessions` or via UI) — works.
- **`GET /api/sessions`** — list of sessions with `meta.{type, project, cwd, createdAt}` — works and is authoritative for inject mapping.
- **`POST /api/sessions/:id/input`** with `{text, source}` — accepts bracketed-paste payloads + raw `\r` — works.
- **Two-stage submit pattern** (paste body wrapped in `\x1b[200~ ... \x1b[201~`, settle 400ms, then `\r` alone) — empirically reliable; documented in `~/.claude/CLAUDE.md`. Sprint 1 audit + Sprint 2 inject + 3x corrective injects all worked first try.
- **`POST /api/sessions/:id/poke {methods: ["cr-flood"]}`** — the documented fallback for a stuck-input panel; not needed in Sprint 2 (two-stage was sufficient).
- **`PreCompact` hook integration** — the Mnestra session-snapshot mechanism survives Claude-Code compaction. Sprint 2 didn't compact any panels, but the safety net is in place.

These do not need rework; the sprint builds on top of them.

---

## 4. Proposed TermDeck features

### 4.1 Boot-prompt template system

Store templates indexed by `(CLI-type × role)`:

| CLI type | Role | Template id |
|---|---|---|
| claude-code | worker | `cc-worker` |
| claude-code | auditor | `cc-auditor` |
| claude-code | orchestrator | `cc-orchestrator` |
| codex | worker | `codex-worker` |
| codex | auditor | `codex-auditor` |
| codex | orchestrator | `codex-orchestrator` |
| gemini | worker | `gemini-worker` |
| gemini | auditor | `gemini-auditor` |
| grok | worker | `grok-worker` |
| grok | auditor | `grok-auditor` |

Each template is a text file with `{{variable}}` substitution. Example `cc-worker`:

```
You are {{lane_tag}} in {{sprint_name}}, running in {{project_name}} at {{project_path}}.

Boot sequence:
1. memory_recall(project="{{project_name}}", query="{{memory_query_lane}}")
2. memory_recall(query="{{memory_query_broad}}")
3. Read ~/.claude/CLAUDE.md and ./CLAUDE.md
4. Read {{sprint_dir}}/PLANNING.md
5. Read {{sprint_dir}}/STATUS.md
6. Read {{sprint_dir}}/{{lane_brief}} (your full briefing)

{{cross_lane_intel}}

Discipline: post `### [{{lane_tag}}] FINDING / PROPOSE / LANDED / DONE 2026-MM-DD HH:MM ET — <gist>` to {{sprint_dir}}/STATUS.md verbosely. The work isn't done until (a) tests green AND (b) `### [{{lane_tag}}] LANDED` posted with file:line + suite result AND (c) auditor has reacted. The TermDeck panel-status API does not refresh when you reach your completion banner — your LANDED post on STATUS.md is the only signal of done-ness reaching the orchestrator.

Run `{{test_command}}` before every LANDED — baseline is {{baseline_suite_result}}; don't regress it.

Don't bump versions, don't touch CHANGELOG, don't commit. The orchestrator handles commit at sprint close.

Then begin.
```

The `cc-auditor` template includes the synchronize-on-LANDED clause at the TOP of the task list, explicit CHECKPOINT cadence, and the tooling-failure fallback.

**Storage:** filesystem-loadable from `~/.termdeck/templates/` so projects can override per-project. Defaults shipped in the TermDeck binary at `share/termdeck/templates/` (or via npm package). Per-template `metadata.yaml` declares required variables and CLI-type compatibility.

**Variable substitution:** simple `{{name}}` syntax. Variables required per template are declared in metadata; the inject API errors if any required variable is missing.

### 4.2 Sprint inject API endpoint

```
POST /api/sprints/inject
{
  "panels": [
    {"tag": "T1", "sessionId": "...", "role": "worker", "lane_brief": "T1-identity-ingest.md"},
    {"tag": "T2", "sessionId": "...", "role": "worker", "lane_brief": "T2-podium-view-maestro.md"},
    {"tag": "T3", "sessionId": "...", "role": "worker", "lane_brief": "T3-preference-aware-scheduling.md"},
    {"tag": "T4", "sessionId": "...", "role": "auditor", "lane_brief": "T4-codex-adversarial.md"}
  ],
  "variables": {
    "sprint_name": "Sprint 2 (Intake Hop)",
    "sprint_dir": "docs/sprint-2-intake-hop",
    "project_name": "maestro",
    "project_path": "~/.gemini/antigravity/scratch/chopin_scheduler",
    "test_command": "cd backend && source venv/bin/activate && python -m pytest -q",
    "baseline_suite_result": "511 pass / 0 fail / 1 xfail / 2 deselected",
    "cross_lane_intel": "...",
    "memory_query_lane": "Sprint 1 audit edition scoping scheduleConstraints intake",
    "memory_query_broad": "recent decisions 3+1+1 orchestration intake field-tolerant scheduling"
  }
}
```

Server:
1. Auto-detect CLI type per session via `meta.type`.
2. Pick template `(cli_type × role)`.
3. Substitute variables.
4. Run two-stage submit (paste-stage all panels with 250ms gap → settle 400ms → submit-stage with 250ms gap).
5. Return per-panel result + initial 5s post-submit `meta.status` snapshot.

This collapses orchestrator inject from "author 4 prompt files + write a Node script + run it" to one HTTP call.

### 4.3 Sprint nudge API endpoint

```
POST /api/sprints/nudge
{
  "panels": [{"tag": "T1", "sessionId": "..."}],
  "kind": "post-landed-reminder" | "status-check" | "tooling-failure-recover" | "custom",
  "context": {
    "open_red": {"file_line": "...", "test_repro": "..."}
  }
}
```

For `post-landed-reminder` and `status-check`, TermDeck ships prebuilt template text. For `custom`, the orchestrator passes its own text.

Mechanism: same two-stage submit. The orchestrator uses this for the "post your LANDED" nudge in Sprint 2's failure mode — instead of authoring a 50-line inject script.

### 4.4 Parked-lane detection

TermDeck exposes a derived signal `meta.parked` computed from:

- `meta.status = "active"` AND `meta.lastActivity > 5 min ago` → check buffer for completion banner.
- Buffer contains regex `(Cogitated|Churned|Brewed|Cooked|Mused|Pondered|Wandered) for \d+m \d+s` in the trailing N lines → set `meta.parked = true`.

Or — cleaner — TermDeck integrates with Claude Code's hook system (if/when there's a `task-complete` hook) to receive the signal directly and set `meta.parked` definitively. Falls back to buffer parsing.

`meta.parked` is a separate field from `meta.status` — clients can choose. The polling orchestrator reads `meta.parked` as the authoritative is-this-panel-actually-doing-work signal.

Optionally: per-session config "auto-nudge after N minutes parked" that fires a default nudge automatically.

### 4.5 Sprint substrate parser

For STATUS.md-driven monitoring, TermDeck offers a parser:

```
GET /api/sprints/status?file=docs/sprint-2-intake-hop/STATUS.md
{
  "lanes": {
    "T1": {
      "last_post": {"verb": "FINDING", "timestamp": "2026-05-19T18:23:00-04:00", "line": 67},
      "open_reds_against_me": [...],
      "landed_since_last_red": false   // ← the key signal
    },
    "T2": {...},
    ...
    "T4-CODEX": {...}
  },
  "open_red_count": 2,
  "last_orchestrator_post": "...",
  "last_final_verdict": {"verb": "RED", "timestamp": "...", "lanes_with_open_defects": ["T1", "T3"]}
}
```

This lets the orchestrator query the substrate as structured data and make decisions: *"T1 has an open RED and no LANDED since, AND T1 is `meta.parked=true` for >5 min → nudge with the kind=post-landed-reminder template."*

### 4.6 Default orchestrator loop primitive

TermDeck offers a default `meta.role = "orchestrator"` flag on a session. When set, the panel:

- Auto-receives a recommended `/loop` invocation on the first response: `/loop 4.5m run the orchestrator polling tick`.
- Gets a default polling-tick template: read STATUS.md via `/api/sprints/status`, detect parked lanes, fire nudges via `/api/sprints/nudge`, report any changes.

This makes "set up active monitoring" a zero-config behavior instead of requiring the orchestrator to manually `ScheduleWakeup`.

---

## 5. Brief-shape directives (cross-project, ship via global CLAUDE.md amendments)

These are NOT TermDeck features — they're documentation amendments that should land in `~/.claude/CLAUDE.md` alongside the TermDeck sprint:

### 5.1 Worker lane briefs

Add at the top of every worker brief's "Discipline" section:

> **Done-when (mandatory):** Your task is NOT complete when your local tests pass. It is complete only when ALL of these are true:
> (a) Tests green (`<test_command>` ≤ baseline).
> (b) `### [T<n>] LANDED 2026-MM-DD HH:MM ET — <gist>` posted to `<sprint_dir>/STATUS.md` with file:line evidence + the exact pytest command + result.
> (c) Auditor (T4) has had a chance to react (do not idle for 10+ minutes after posting LANDED).

### 5.2 Auditor lane briefs

Add at the top of every auditor brief's "Tasks" section:

> **Synchronize on LANDED.** The build sprint produces code over time, not in one shot. Until ≥1 worker posts `LANDED`, your AUDIT-REDs are observations of the pre-build state — NOT failure findings. Do NOT issue FINAL-VERDICT until either: (a) the orchestrator closes the sprint explicitly, or (b) all worker lanes have posted DONE. While waiting, post `CHECKPOINT` every 15 minutes minimum with phase + verified-so-far + pending + most-recent-LANDED-being-verified.

### 5.3 Orchestrator brief (for the orchestrator session itself)

Add a section to the global CLAUDE.md "3+1+1 sprint orchestration" rule:

> **Default polling discipline.** At sprint kickoff, after inject succeeds, the orchestrator MUST set up a recurring polling tick via `ScheduleWakeup` or `/loop`. The tick polls STATUS.md (via `/api/sprints/status` if available, else `wc -l + sed -n '<prev+1>,$p'`) and the per-panel `meta.parked` field (NOT `meta.status` — that field is documented unreliable). Parked-lane detection nudges via `/api/sprints/nudge`. Tick cadence 270s default (stays inside the prompt-cache window). Polling stops on amended FINAL-VERDICT GREEN.

---

## 6. Out of scope (defer)

- Integration with non-TermDeck workflow orchestrators (e.g. GitHub Actions, Linear). The sprint primitives stay TermDeck-internal.
- Multi-orchestrator coordination (one orchestrator session running multiple parallel sprints).
- Template-versioning / template-migration tooling. v1 templates ship in-tree; updates are normal TermDeck releases.
- Web UI for `/api/sprints/*`. CLI / API only for the sprint.

---

## 7. Done-when criteria for the TermDeck sprint

1. Boot-prompt templates exist for at least (claude-code × worker), (claude-code × auditor), (codex × worker), (codex × auditor). Variable substitution works. Default storage in `share/termdeck/templates/` + filesystem override at `~/.termdeck/templates/`.
2. `POST /api/sprints/inject` accepts the documented body shape, picks the right template per session's `meta.type`, runs two-stage submit, returns per-panel result.
3. `POST /api/sprints/nudge` accepts the documented body shape with at least the `post-landed-reminder` and `status-check` kinds shipping prebuilt text.
4. `meta.parked` field added to `/api/sessions` response, derived from buffer-content parsing for the documented completion-banner regex.
5. `GET /api/sprints/status?file=<path>` parses a STATUS.md and returns the structured form documented in §4.5.
6. CLAUDE.md amendments (§5.1, §5.2, §5.3) are drafted as part of this sprint's deliverable but landed by Joshua manually (not by TermDeck workers — global CLAUDE.md is Josh's personal file).
7. A regression Maestro-Sprint-N-replay: re-running Maestro Sprint 2 with the new TermDeck primitives, the orchestrator should never read a stale `meta.status` and never need to author a `[ORCH] STATUS` proxy-LANDED post.
8. Full TermDeck suite green. New tests cover the sprint endpoints.

---

## 8. Suggested sprint structure (3+1+1 — eat your own dog food)

- **T1 (Claude worker)** — boot-prompt template system (§4.1) + storage + variable substitution.
- **T2 (Claude worker)** — sprint inject + nudge endpoints (§4.2, §4.3); reuses T1's template engine.
- **T3 (Claude worker)** — `meta.parked` detection (§4.4) + STATUS.md parser (§4.5).
- **T4 (Codex auditor)** — independent end-to-end test: replay Maestro Sprint 2's inject + nudge cycles with the new endpoints; verify no `meta.status` reads, no manual orchestrator nudges, no parked-lane misses.
- **Orchestrator** — coordinates, drafts the CLAUDE.md amendments, runs the close-out.

Estimated wall-clock: one back-to-back orchestrated sprint, similar in shape to Sprint 1 audit and Maestro Sprint 2 — probably 3-5 hours from inject to close.

---

## 9. Cross-links

- Maestro Sprint 2 STATUS.md: `~/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-2-intake-hop/STATUS.md`
- Maestro PLANNING.md: `~/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-2-intake-hop/PLANNING.md`
- Maestro CLAUDE.md history of orchestration patterns: `~/.gemini/antigravity/scratch/chopin_scheduler/CLAUDE.md`
- Global CLAUDE.md "3+1+1 sprint orchestration" rule: `~/.claude/CLAUDE.md`
- ULTRA-PLAN structure (5-sprint cascade): `~/.gemini/antigravity/scratch/chopin_scheduler/docs/platform-assessment-2026-05-17/ULTRA-PLAN.md`
- Mnestra kitchen-lessons: query `memory_recall(query="3+1+1 orchestration kitchen-lesson")` for the latest set.

---

## 10. Sequencing

This TermDeck sprint should land **before** Maestro Sprint 3 (Phase 5B real-data validation), because Sprint 3 is the highest-stakes 3+1+1 in the ULTRA-PLAN cascade and benefits most from hardened orchestration. Maestro Sprint 2's slop was recoverable because it was a build sprint; Sprint 3 (validation against real Chopin in Bohemia data) is festival-prep critical and shouldn't be the test case for an unhardened orchestration loop.

If Joshua wants to ship Maestro Sprint 3 first regardless, the orchestrator can run it with the same manual discipline that closed out Sprint 2 — but the wall-clock cost will be similar (~90 min of overhead).
