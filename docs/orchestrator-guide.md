# Orchestrator Guide

A first-class reference for orchestrating Claude Code with TermDeck. This is the *how to work* doc — not just *how to run terminals*. If you came here because TermDeck looked like a fancier tmux, you're in the right place. The terminals are the substrate; the orchestration patterns below are the product.

The patterns documented here were shaped over months of running AI coding sprints at Anthropic-model scale. Most of them were paid for in lost sleep, broken builds, and "why didn't anyone press Enter on panel 4 at 3 AM" debugging. They're conventions worth knowing before you have to discover them yourself.

This Guide is also rendered in the dashboard right-rail (top-right of the TermDeck UI). Press the `📖 Guide` tab to open it; it will auto-expand the section relevant to whatever you're focused on.

---

## 1. What is the 4+1 pattern?

The 4+1 pattern runs **four parallel Claude Code worker sessions (T1–T4)** plus a **fifth orchestrator session** that coordinates them. Each worker owns a single lane of the sprint. The orchestrator never edits code in worker lanes; it briefs, monitors, audits, and closes.

### Why parallel beats serial

Serial coding sessions hit two ceilings: (a) Claude's context fills up faster than the work shrinks, and (b) the human supervisor becomes the bottleneck because every step waits on review. Splitting work across four context-isolated workers gives you:

- **Cleaner context per lane.** Each worker only loads the files it owns. No bleed.
- **Honest audit trail.** Workers post FINDING / FIX-PROPOSED / DONE in `STATUS.md`; the orchestrator can't conflate "I think I'm done" with "the sprint is correct."
- **Parallel throughput.** Four lanes means four 30-minute jobs finish in 30 minutes, not two hours.
- **Recoverable failure.** A bad lane can be re-run without rolling back the others.

### When to use 4+1 vs. a single session

Use 4+1 when:
- The work splits cleanly into 3–4 file-owned lanes.
- You can write a one-page brief per lane in advance.
- You want a paper trail (`STATUS.md` becomes the sprint's diary).

Skip 4+1 (use a single Claude Code session) when:
- The work is exploratory ("figure out why X is slow").
- One lane gates all the others — parallelism buys you nothing.
- The whole task is under ~30 minutes of work.

> **See also:** `~/.claude/CLAUDE.md` § MANDATORY: 4+1 sprint orchestration

---

## 2. The inject mandate

> **Cardinal rule: never copy-paste boot prompts. Always inject.**

When you launch a 4+1 sprint, the orchestrator pushes each worker's boot prompt into its panel via TermDeck's input API — `POST /api/sessions/:id/input`. The human's job is to open four Claude Code terminals and say "terminals open, inject." The orchestrator does the rest.

Copy-pasting four boot prompts by hand is friction. It's also fragile: a stray newline, a missed paste, an out-of-order panel — and the sprint starts wrong.

### The two-stage submit pattern

This is the part that bit hard enough to become a hard rule. Each worker boot prompt is a multi-line bracketed-paste block. **Do not** append `\r` to the same POST. Use two POSTs:

1. **Paste** — `\x1b[200~<text>\x1b[201~` (no submit byte).
2. **Settle** ~400 ms — long enough for the PTY to flush the paste to Claude Code's input handler.
3. **Submit** — `\r` alone, in its own POST.

Why: when the close marker `\x1b[201~` and the trailing `\r` ride in one PTY write, the OS-level chunk boundary is non-deterministic. Sometimes Claude Code's input parser eats the `\r` as the last paste byte rather than a submit keystroke. Symptom: 3 of 4 panels auto-fire, the 4th sits at a visually populated input box waiting for a human to press Enter. **The cardinal sin is leaving a panel waiting for a human Enter press.** That cost real broken sleep on more than one overnight orchestration.

Single-stage `<text>\x1b[201~\r` injection is **banned**. Two-stage is the only sanctioned form.

### Recovery when a panel stays idle

After all submits land, verify per-panel: `GET /api/sessions/:id/buffer` should show `status: 'thinking'` and a fresh `lastActivity`. If any panel is still `active` (idle) after ~8 s, the submit didn't land. Recover via `POST /api/sessions/:id/poke` with `methods: ['cr-flood']`. Don't page the human; this is exactly what `/poke` exists for.

### cURL examples

Paste stage:

```bash
curl -X POST http://127.0.0.1:3000/api/sessions/$SID/input \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"text": "[200~Hello, T1.\nBoot sequence:\n1. memory_recall(...)\n[201~", "source": "orchestrator"}
EOF
```

Settle ~400 ms, then submit stage:

```bash
curl -X POST http://127.0.0.1:3000/api/sessions/$SID/input \
  -H 'Content-Type: application/json' \
  -d '{"text":"\r","source":"orchestrator"}'
```

Recovery (if a panel is stuck idle):

```bash
curl -X POST http://127.0.0.1:3000/api/sessions/$SID/poke \
  -H 'Content-Type: application/json' \
  -d '{"methods":["cr-flood"]}'
```

> **See also:** `~/.claude/CLAUDE.md` § MANDATORY: 4+1 sprint orchestration; `packages/server/src/index.js` (`/api/sessions/:id/input`, `/api/sessions/:id/poke`).

---

## 3. CLAUDE.md hierarchy

Three layers, read in order at session start. Each layer has a different lifespan and a different audience.

| Layer | File | Contains | Audience |
|---|---|---|---|
| **Global** | `~/.claude/CLAUDE.md` | Cross-project mandates: time check, memory-first, inject mandate, never-copy-paste, project directory map | Every Claude Code session, every project |
| **Project** | `./CLAUDE.md` (in the repo) | Read-order router. Hard rules specific to this project. Pointers to the canonical task docs | Every session in this repo |
| **Session** | The boot prompt itself (or `RESTART-PROMPT-YYYY-MM-DD.md`) | What this specific session must do, the topic to `memory_recall`, the active sprint plan to read | The single session being booted |

### What goes in each layer

**Global rules** are things that apply *everywhere*. "Always check the time before saying 'tonight.'" "Always inject 4+1 boot prompts, never paste." These don't belong in a single repo because you'd duplicate them across every repo and they'd drift.

**Project router** is intentionally short. It says: "Here are this project's hard rules (no TypeScript, vanilla JS client, etc). For deeper context, here's the task-doc table — read the *one* that matches your task." It does **not** restate global rules.

**Session prompt** carries the immediate intent. It tells the new session which `memory_recall` to fire first, which sprint plan to read, which lane it owns. It's disposable; the next session reads a new one.

### Read-order matters

A worker session should always:

1. `memory_recall(project=<this-project>, query=<task topic>)`
2. Read `~/.claude/CLAUDE.md`
3. Read `./CLAUDE.md`
4. Read the one task doc the project router points to.
5. Begin.

Skipping memory or skipping the project router leads to the same failure mode: the session "discovers" something the user already documented two sprints ago and proposes a fix that contradicts a locked decision. Don't do that.

> **See also:** `./CLAUDE.md` (this repo's router); `~/.claude/CLAUDE.md` § MANDATORY: Check Memory First.

---

## 4. Memory-first discipline

Claude Code has a persistent long-term memory system (the Mnestra MCP server, in the TMR stack). It survives sessions. It survives projects. It is the single most valuable input to any session that is not literally the first one.

### Always start with `memory_recall`

Before reading files, before analyzing code, before writing anything: call `memory_recall`. Twice:

1. With a query about the current project + task topic.
2. With a broader query about recent decisions, bugs, or preferences.

The first surfaces lane-specific intel. The second surfaces drift you might otherwise ignore — "oh, we decided last sprint that X is out of scope" is exactly the kind of thing memory catches.

### When to use `memory_remember`

Save to memory when:

- You make a non-obvious architectural decision (lock it).
- You fix a bug whose root cause would surprise the next reader.
- You discover a user preference (workflow, tone, naming).
- You hit context near a soft compaction boundary and want a safety net.

Don't save to memory when:

- The fact lives perfectly well in code or `git log`. (Don't duplicate things `git blame` already answers.)
- The fact is ephemeral ("currently the build is red"). Memory is for things that should outlive the session.

### Memory vs. project files

Memory persists across sessions and projects. Project files persist in the repo. Use:

- **Memory** for cross-session reasoning aids: decisions, preferences, surprising bug fixes.
- **`docs/`** for things you'd want a *new contributor* to read. README, ARCHITECTURE, RELEASE.
- **`CONTRADICTIONS.md`** for the live contradictions ledger — facts that conflict and need resolution.
- **`project_facts.md`** for the *factual snapshot* of the project that doesn't change weekly.

### Cross-project search

Omit the `project` parameter in `memory_recall` to search across all projects. Useful for shared patterns: "how did we handle Supabase migrations" — answer might come from a sibling project.

> **See also:** `~/.claude/CLAUDE.md` § MANDATORY: Check Memory First; `~/.claude/CLAUDE.md` § RAG Memory System.

---

## 5. Enforcement vs. convention

When the orchestrator surfaces a security or correctness gap mid-sprint, the **default response is enforcement** — fix the underlying mechanism so the gap can't recur. Convention-only ("we should remember to do X") is the fallback, not the default.

### Why default-to-enforcement

A convention-only fix asks every future session to re-discover the rule, read the doc, and choose to follow it. That works for stylistic preferences. It does not work for security boundaries, data integrity, or correctness invariants — there, the *first time someone forgets the convention* is the bug.

Enforcement looks like:

- Adding a runtime check that throws on misuse.
- Adding a CI lint that fails the PR.
- Restructuring the API so the wrong call is impossible to type.

### When convention-only is justified

Convention is acceptable when **all three** of these hold:

1. The cost of enforcement is disproportionate to the risk.
2. The rule is genuinely contextual (case-by-case judgment, not a hard invariant).
3. There's a clear paper trail (memory entry, CLAUDE.md note, doc) so future sessions encounter the rule.

If even one fails, prefer enforcement.

> **See also:** memory `feedback_orchestrator_enforcement.md`; `~/.claude/CLAUDE.md` § orchestration discipline.

---

## 6. Sprint discipline inside a lane

You are T*n*. You own *one* lane. Stay in it.

### Hard rules for workers

- **No version bumps.** Don't edit `package.json`'s `version` field. Orchestrator handles it at close.
- **No `CHANGELOG.md` edits.** Same reason.
- **No commits.** Work, save files, sign DONE. The orchestrator commits the sprint as a single audited unit.
- **No `git push`, no `npm publish`.** Same reason — and `RELEASE.md` has separate strict rules.
- **No edits outside your declared file ownership.** If you find a bug in another lane's files, post a FINDING in STATUS.md describing it; the orchestrator routes it.

### STATUS.md — append-only

Each lane has a `## T<n>` section in `docs/sprint-N-<name>/STATUS.md`. Post entries in this format:

```
### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

**Append only.** Never edit prior entries (yours or another lane's). The chronology is the audit trail.

### What "DONE" means

DONE means: lane work is complete to the briefing's acceptance criteria, files are saved, a smoke test (manual or automated) confirms the change works. It does **not** mean "I've reviewed myself and decided I'm done." The orchestrator will independently verify before closing the sprint.

> **See also:** active sprint plan at `docs/sprint-N-<name>/PLANNING.md`; the lane briefing at `docs/sprint-N-<name>/T<n>-<lane>.md`.

---

## 7. Restart-prompt rituals

When a session ends and the next session needs to pick up cleanly, the bridge is a `RESTART-PROMPT-YYYY-MM-DD.md` written before close.

### When to write one

Write a restart prompt when:

- A multi-day initiative paused mid-flight.
- The session is wrapping up but the work isn't done — context window, not work, ran out.
- A sprint just shipped and the next sprint should start cold but informed.

If the session was a one-off Q&A with no shipped artifacts and no follow-up, skip the doc. (But still draft the session-end email per `~/.claude/CLAUDE.md` § Session-End Email — that lives in Gmail, not the repo.)

### What it must contain

A good restart prompt is paste-ready and self-contained. It has:

1. **Live state** — what's deployed, what's published, current branch, current versions.
2. **What shipped this session** — concrete bullets, dated, with commit SHAs.
3. **What's planned next** — queued sprints, their `docs/sprint-N-<name>/` paths, deferred items and why.
4. **Read order for the next session** — explicit list: `memory_recall(...)`, `~/.claude/CLAUDE.md`, `./CLAUDE.md`, the relevant restart doc, the active sprint plan.
5. **Paste-ready prompt block** — the literal text the human will hand to the next Claude session at boot.

Where to put it: top of the repo at `RESTART-PROMPT-YYYY-MM-DD.md`. If multiple per day, suffix with `-<topic>`.

> **See also:** `~/.claude/CLAUDE.md` § MANDATORY: Session-End Email to Self.

---

## 8. Per-project scaffolding files

A well-configured project repo has these files at root or near-root. They give every Claude session a consistent, low-friction onramp.

| File | Purpose |
|---|---|
| `CLAUDE.md` | The project router. Hard rules, read-order, pointers to task docs. Short. |
| `CONTRADICTIONS.md` | Live contradictions ledger. Facts that conflict and aren't yet resolved. New sessions read this to avoid relitigating settled debates. |
| `project_facts.md` | Factual snapshot — what this project *is*, who built it, what's deployed where, what's published where. Updated at major milestones, not weekly. |
| `docs/orchestration/` | Sprint plans, restart prompts, sprint STATUS.md files. Each sprint gets a directory: `docs/sprint-N-<name>/PLANNING.md`, `T<n>-<lane>.md`, `STATUS.md`. |
| `RESTART-PROMPT.md` template | Skeleton for the restart-prompt ritual (§ 7). Filled in at session end with live values. |
| `.claude/settings.json` | Permission defaults — which commands to allow without prompting, hook configurations, etc. |

You don't need to create these by hand. The `termdeck init --project <name>` subcommand scaffolds all of them from canonical templates. The eight files generated, in their final project-relative target paths:

1. `CLAUDE.md` — project router (the one you're writing for).
2. `CONTRADICTIONS.md` — live contradictions ledger.
3. `project_facts.md` — factual snapshot, updated at milestones.
4. `README.md` — public-facing overview (extend after generation).
5. `docs/orchestration/README.md` — how this project runs sprints.
6. `docs/orchestration/RESTART-PROMPT.md.tmpl` — restart-prompt skeleton, copy + fill at session-end.
7. `.claude/settings.json` — permission allow/deny + hook defaults.
8. `.gitignore` — sensible defaults so secrets and per-machine state don't ship.

The `packages/cli/templates/` directory is the source of truth for the templates themselves; the Guide does not duplicate their content. To inspect or customize a template, read it there.

The dashboard's project drawer also surfaces an *orchestration preview* (Sprint 37 lane T3) that shows what `init --project` would generate for a given project, before you commit to the scaffolding.

> **See also:** `packages/cli/templates/` (template source of truth); `packages/cli/src/init-project.js` (the scaffolder); the project drawer's orchestration-preview tab.

---

## 9. Channel inject patterns

The inject mandate (§ 2) is about Claude Code panels. The same principle applies to *messaging humans*: don't stop at "here's a draft, paste into iMessage." Deliver the message into the platform's compose box, ready to send.

### WhatsApp

```bash
URL="wa.me/<E164-without-plus>?text=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "Hello there.")"
open "https://$URL"
```

WhatsApp Desktop intercepts the deep link and pre-fills the message in the conversation. Use `python3` quoting so special characters survive intact.

### iMessage / SMS

Use the `mcp__imessage__send_imessage` MCP tool. `service: "iMessage"` is the default; pass `service: "SMS"` for Android contacts. The tool dispatches via AppleScript through Messages.app — no copy-paste, no compose-box context switch.

### Self

Pass `to: "self"` in `send_imessage` to route to the operator's own number (resolved via the `IMESSAGE_SELF_ADDRESS` env var). Useful for shipping a wrap-up summary, restart prompt, or "remind me about X" note to your own phone.

Contact lookup is the orchestrator's job, not the human's. If you don't know a phone number, search memory (`memory_recall` for `CONTACT <name>`), grep `~/.claude/cache/`, find it. Do not ask "what's their number?" if it has been provided in any prior session.

> **See also:** `~/.claude/CLAUDE.md` § MANDATORY: Never present messages for copy-paste — always inject.

---

## Where to go next

- **Run a sprint right now:** open the dashboard, click the layout button labeled `orch`, launch four Claude Code panels + a fifth orchestrator panel, and tell the orchestrator "terminals open, inject."
- **Scaffold a new project:** `termdeck init --project <name>` — see § 8.
- **Read the canonical sources:** `~/.claude/CLAUDE.md` for the global mandates this Guide is distilled from.
- **Find a specific section in the dashboard:** open the right-rail Guide panel (top-right) and search.

This Guide is reference material — read the section that matches your situation, skip the rest. The next time you orchestrate a sprint, the patterns above should feel like muscle memory, not a doc to consult.
