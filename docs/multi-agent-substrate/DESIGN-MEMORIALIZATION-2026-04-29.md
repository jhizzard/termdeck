# Multi-Agent Substrate Design — Full Session Memorialization

**Date:** 2026-04-29
**Session range:** ~11:30 ET (Sprint 42 sign-off email sent) → ~11:55 ET (this memorialization)
**Context:** Sprint 42 was closed and validated end-to-end (cron live, 365 cron-inferred edges, all four packages published). After the session-end email was sent to `admin@nashvillechopin.org`, Joshua opened a major new design line: how to bring **Codex / Gemini / Grok** into TermDeck as first-class lane agents, alongside or instead of Claude. This document captures the entire research-and-design process so the next several sprints can reference it without re-doing the work.

> "[I want to] design methodologies based on the underlying folder and instruction structures of Gemini and Codex that would allow them to either work WITH Claude in TermDeck or to run entire projects in TermDeck based on prompts adapted to their workflows (they don't have CLAUDE.md but could be order to follow similar structures). And lastly, I am trying to figure out how to setup a Grok CLI imitation that it suggested... so that we could leverage its native 16-agent working style — and use it in TermDeck. Remember we are also working on a project called TheHarness which may incorporate all of this... I am also developing with you a Claude ecosystem to execute my whole BHHT business."  — Joshua, 2026-04-29 ~11:30 ET

## 1. The trigger — why this design line emerged when it did

Three converging pressures forced multi-agent to the front of the queue:

1. **Capacity ceiling.** During Sprint 42 close-out (yesterday evening), Joshua tapped out his Claude Max 20x plan despite disciplined token economy. Multi-vendor isn't a luxury; it's a capacity safety valve.
2. **Audit quality.** Codex and Gemini already work as audit tools (the `codex@openai-codex` Claude Code plugin gives delegate-to-Codex). But that's Claude-driving-Codex. The next step is **independent agents on parallel lanes** — Codex auditing Claude's T1 output without Claude's framing pollution.
3. **Convergence with TheHarness.** TheHarness (`/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/`) is a parallel browser-based multi-LLM orchestrator (Phase 0 / pre-architecture, blocked on BHHT). Whatever convention work TermDeck does for terminal-side multi-agent should port directly to TheHarness's browser-side world.

## 2. Phase 1 exploration — three parallel agent dispatches + one web fetch

### Agent 1: TermDeck's existing agent-spawn abstraction analysis

**Verdict:** PTY spawn is already agent-agnostic. Five hardcoded touchpoints above the spawn layer need adaptation. ~400-500 LOC of refactor.

The five touchpoints traced:

| # | File:line | Currently | Needs to become |
|---|---|---|---|
| 1 | `packages/client/public/app.js:2422-2487` | Hardcoded regex branches: `/^claude/`, `/^cc/`, `/^gemini/`, Python servers | Adapter-driven prefix matching against `AGENT_ADAPTERS` registry |
| 2 | `packages/server/src/index.js:767-820` (`spawnTerminalSession`) | Generic shell spawn; injects `TERMDECK_SESSION_ID`, `TERMDECK_PROJECT` | **No change required** — already agent-agnostic |
| 3 | `packages/server/src/session.js:243-256` (`_detectType`) | Hardcoded patterns in `PATTERNS` per agent | Data-driven from registry |
| 4 | `packages/server/src/session.js:258-312` (`_updateStatus`) | `switch(meta.type)` with hardcoded status strings ("Claude is reasoning", "Gemini is generating") | Per-adapter `statusFor(state)` function |
| 5 | `packages/stack-installer/assets/hooks/memory-session-end.js:83-116` | Reads Claude's `{ message: { role, content } }` JSONL transcript | Adapter-pluggable parsers (Claude JSONL / Codex format / Gemini format / Grok format) |

The PTY spawn agnosticism is the win — that's the foundation that makes multi-agent feasible without rewriting the runtime.

Status detection (agent type 3) is partial: `PATTERNS.gemini` already exists at `session.js:71-118`. Adding `PATTERNS.codex`, `PATTERNS.grok` is straightforward but should ideally land as data inside an adapter, not as more hardcoded keys.

### Agent 2: Existing multi-agent traces across Joshua's machine

**Verdict:** Codex partial, Gemini partial, Grok absent, TheHarness mapped, BHHT context recovered.

#### Codex — partially integrated (delegate-from-Claude only)

- **Plugin:** `codex@openai-codex` enabled in `~/.claude/settings.json`
- **Marketplace config:** Points to `openai/codex-plugin-cc` GitHub repo
- **Plugin data:** `~/.claude/plugins/data/codex-openai-codex/`
- **Binary on PATH:** `/usr/local/bin/codex`
- **Env var injected into TermDeck PTYs:** `CODEX_COMPANION_SESSION_ID`
- **Available agent types provided by the plugin:** `codex:setup`, `codex:rescue`, `codex:codex-result-handling`, `codex:gpt-5-4-prompting`, `codex:codex-cli-runtime`

What this gives today: Claude can delegate to Codex via Claude Code's Agent tool when given the `codex:rescue` subagent type. **What's missing:** Codex running as its own panel, without Claude as the wrapper.

#### Gemini — partially recognized (status detection only)

- `packages/server/src/session.js` has `PATTERNS.gemini` with prompt regex `/^gemini>\s/m` for status detection
- `packages/client/public/app.js:2470-2471` has hardcoded `gemini` launcher branch
- Binary on PATH at `/usr/local/bin/gemini`
- Memory hook still assumes Claude JSONL — Gemini sessions are NOT writing to Mnestra correctly today

#### Grok — not installed

- `which grok` → not found
- Joshua has the install URL: `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh`
- Per the install-script research: drops binary at `~/.grok/bin/grok` on darwin-arm64; minimal installer; no auth-flow encoded in install.sh (auth is runtime)

#### TheHarness — separate multi-LLM orchestrator (browser-based)

- **Location:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/`
- **What it does:** Local orchestration layer that automates multiple LLM chat interfaces (Claude / ChatGPT / Gemini / Grok) using **Playwright browser automation instead of API tokens**. Pastes prompts into paid chat subscriptions, extracts responses, routes tasks based on model capability, maintains cross-model persistent memory via Mnestra/Rumen, handles approvals for irreversible actions.
- **Core thesis:** "Rent reasoning at flat-rate chat prices, own the orchestration and the memory, approve every irreversible action, and never pay for a token twice."
- **Status:** Pre-architecture (Phase 0 competitive research before Phase 1 PoC). Blocked on BHHT completion.
- **Key files:** `VISION.md` (architecture), `WHY.md` (rationale + ~$40K/month credit burn context + the OpenClaw cautionary tale: 138 CVEs, RCE vulnerability CVE-2026-32922, 135K instances cut off by Anthropic Feb 2026, founder departed to OpenAI), `docs/COMPETITIVE-LANDSCAPE.md`
- **Relationship to TermDeck:** Shares Mnestra (memory) + Rumen (learning loop). Different transport (browser vs PTY), different audience, different value proposition. Synergy: coding insights from TermDeck inform business decisions via shared Mnestra.

#### BHHT — Brook Hiddink High Ticket

- **Location:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/HighTicket/`
- **Acronym:** Brook Hiddink High Ticket (acronym recovered from `BHHT_Project_Prompt.md`)
- **Objective:** Fully automated high-ticket / mid-ticket dropshipping pipeline before summer 2026 (hard deadline: Chopin in Bohemia July 14-19)
- **Phase 1 ~80% complete:** HT Video Extractor pipeline downloads Kajabi/Wistia videos, processes via **Gemini 2.5 Flash** for audio+visual extraction, stores JSON in Supabase (`ht_video_extractions` table). 18/23 Module 2 videos extracted; 5 failing JSON parse (Gemini unterminated strings issue).
- **Phases 2-5:** Niche selection engine → supplier outreach → Shopify store build → Google Shopping ads
- **Key technical detail:** Uses Gemini API (NOT Claude) for video extraction at scale. **Proves the multi-vendor pattern works in production already** — TermDeck's multi-agent substrate just brings it into the orchestration layer.

#### OpenClaw — the cautionary tale, NOT OpenCode

- TheHarness `WHY.md` documents OpenClaw (NOT OpenCode) as the warning case
- 138 CVEs; RCE vulnerability CVE-2026-32922; 135K instances cut off by Anthropic Feb 2026; founder departed to OpenAI
- TheHarness explicitly rejects this approach: *"Every architectural choice in The Harness must be tested against the question: would OpenClaw have done this? If the answer is yes, reconsider."*
- No "OpenCode" references found anywhere — likely conflated with OpenClaw or with Cursor/Cline alternatives in casual conversation

### Agent 3 (web fetch): Grok CLI install.sh + AGENTS.md / GEMINI.md conventions

#### Grok CLI install.sh (initial read, later corrected)

- Drops binary at `~/.grok/bin/grok` on darwin-arm64
- Minimal installer; SHA-256 verification + PATH setup
- No 16-agent reference in the installer (this was the basis for my initial — incorrect — "folklore" claim)
- Metadata in `~/.grok/install.json`
- No environment variables or auth flow in install.sh (auth happens at runtime)

#### Cross-CLI instruction file conventions (authoritative findings)

| Agent | Instructional file | Hierarchical loading | Source |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | Yes (project + user `~/.claude/CLAUDE.md`) | Joshua's existing global at `~/.claude/CLAUDE.md` |
| Codex CLI | `AGENTS.md` | Yes (per the OpenAI Codex repo's own structure) | `github.com/openai/codex` |
| Grok CLI | `AGENTS.md` | **Yes — explicitly "merged from git root down to cwd"** | `github.com/superagent-ai/grok-cli` README |
| Gemini CLI | `GEMINI.md` | Documented as "context file"; hierarchical not explicitly confirmed | `github.com/google-gemini/gemini-cli` |

**The convergence finding:** Codex AND Grok share `AGENTS.md`. Joshua's source-of-truth strategy reduces from 4-way (one file per agent) to **3-way** (`CLAUDE.md` + `AGENTS.md` shared by Codex/Grok + `GEMINI.md`). Sync script generates the latter two from the canonical CLAUDE.md.

## 3. The plan-mode design — three-sprint trilogy

### Sprint 44 (Foundation): Grok install + AGENTS.md sync mechanism + adapter registry skeleton

- **T1** Grok CLI install + auth wiring + `docs/AGENT-RUNTIMES.md`
- **T2** `scripts/sync-agent-instructions.js` — reads `CLAUDE.md` (canonical), emits `AGENTS.md` + `GEMINI.md` mirrors with agent-specific lead-ins. Each generated file has `<!-- AUTO-GENERATED ... Do not edit directly. -->` banner. `npm run sync:agents` script + invoke from `prepare-release.sh`.
- **T3** `packages/server/src/agent-adapters/index.js` registry skeleton + `claude.js` adapter. Lift existing PATTERNS + status logic into the Claude adapter with NO behavior change. Snapshot tests pin legacy behavior.
- **T4** `docs/AGENT-RUNTIMES.md` documentation
- **Target version:** `termdeck@0.12.0` + `termdeck-stack@0.4.7`

### Sprint 45 (Adapters): Codex, Gemini, Grok adapter implementations

- **T1** Codex adapter (status patterns, transcript parser, boot prompt)
- **T2** Gemini adapter (migrate hardcoded branches into adapter)
- **T3** Grok adapter (with sub-agent awareness up to 16)
- **T4** Refactor: launcher UI + analyzer use the registry. Remove hardcoded branches in `app.js` and `_updateStatus` switch.
- **Target version:** `termdeck@0.13.0`

### Sprint 46 (Mixed 4+1): Per-lane agent assignments + per-agent boot prompts

- **T1** Lane assignment in PLANNING.md frontmatter: `agent: claude | codex | gemini | grok`
- **T2** Per-agent boot prompt templates (`boot-prompt-{agent}.md`)
- **T3** Inject script extension reading per-lane `agent` field
- **T4** Cross-agent STATUS.md merger
- **Target version:** `termdeck@0.14.0` — Joshua decides at this point whether 1.0.0 is appropriate (multi-agent + cron + observability is "production-ready for outside users" territory)

## 4. The adapter contract (the key abstraction)

```js
{
  matches: (cmd) => boolean,           // does this cmd string indicate this adapter?
  spawn: { binary, defaultArgs, env }, // PTY spawn config
  patterns: { prompt, thinking, editing, tool, error }, // for analyzer
  statusFor: (state) => { status, statusDetail }, // status badge
  parseTranscript: (raw) => Memory[],  // for the session-end hook
  bootPromptTemplate: (lane, sprint) => string, // inject prompt
  costBand: 'free' | 'pay-per-token' | 'subscription', // for Sprint 46 cost annotations
}
```

This contract is **portable to TheHarness** when its Phase 1 starts. TheHarness's `spawn` is "open browser tab with this URL" instead of "spawn PTY"; everything else carries over.

## 5. Course corrections during plan-mode review

### Correction 1: Sprint scope confirmed

Joshua confirmed the **3-sprint trilogy as drafted** (Sprint 44 / 45 / 46). Each ships independently usable; ~3 days wall-clock total at the recent 9-12 minute sprint cadence.

### Correction 2: Grok scope — initially wrong, then corrected

**My initial claim during planning:** the "16-agent working style" was folklore — Grok CLI's actual architecture is 4 default sub-agents (general / explore / computer / verify) + user-defined customs.

**Joshua's correction (post-plan, with direct citation from a Grok session):**
- He has **SuperGrok Heavy** (multi-hundred-dollar/month subscription)
- The official `grok-4.20-multi-agent` model is configurable to **16 agents** via effort/params
- Sub-agents are enabled by default in this CLI when used with the multi-agent model
- His existing Heavy-tier API key carries to the CLI — no separate billing config to wire
- Persistent knowledge of him via global user profile + per-project files (Grok's AGENTS.md analog is first-class)
- **The CLI also supports native Telegram remote control** — confirmed via Grok's own response to Joshua

**Reconciled framing:** the 4 built-in sub-agents I found are the DEFAULT set. The 16-agent ceiling is real on `grok-4.20-multi-agent` with up to 12 user-defined customs (4 + 12 = 16). My "folklore" framing was premature; the underlying capability exists.

### Correction 3: Sprint 43 T4 (Telegram MCP) ↔ Sprint 44/45 Grok overlap

Because grok-cli has native Telegram remote control, Sprint 43 T4 has two paths now:

- **Path A (Sprint 43-clean):** thin generic Telegram MCP that doesn't depend on Grok being installed. Ships in Sprint 43 as planned.
- **Path B (Sprint 44-dependent):** leverage grok-cli's built-in Telegram bridge. Possibly cheaper/cleaner than a separate MCP. Reorders the trilogy: Sprint 44 must ship before Sprint 43 T4.

Lane brief picks one at Sprint 43 inject time. Joshua deferred this tactical decision.

## 6. Critical files identified for the trilogy

| Path | Purpose | Sprint |
|---|---|---|
| `packages/server/src/agent-adapters/` (NEW directory) | Adapter registry home | 44 |
| `packages/server/src/agent-adapters/index.js` (NEW) | Registry export, skeleton | 44 |
| `packages/server/src/agent-adapters/claude.js` (NEW) | Claude adapter (lifts existing logic) | 44 |
| `packages/server/src/agent-adapters/codex.js` (NEW) | Codex adapter | 45 |
| `packages/server/src/agent-adapters/gemini.js` (NEW) | Gemini adapter | 45 |
| `packages/server/src/agent-adapters/grok.js` (NEW) | Grok adapter (16-agent + Telegram) | 45 |
| `packages/server/src/session.js` (REFACTOR) | `_detectType` + `_updateStatus` consume registry | 44 (Claude only) → 45 (full refactor in T4) |
| `packages/client/public/app.js:2422-2487` (REFACTOR) | Launcher refactor | 45 T4 |
| `packages/stack-installer/assets/hooks/memory-session-end.js` (REFACTOR) | Adapter-pluggable transcript parser | 45 |
| `scripts/sync-agent-instructions.js` (NEW) | Generates AGENTS.md / GEMINI.md from CLAUDE.md | 44 T2 |
| `docs/AGENT-RUNTIMES.md` (NEW) | The reference doc for the convention | 44 T4 |
| `docs/SPRINT-FORMAT.md` (NEW) | Per-lane agent assignment schema | 46 T1 |
| `~/.claude/CLAUDE.md` | Canonical source for sync | 44 T2 |
| `~/.termdeck/secrets.env` | `GROK_API_KEY` / `XAI_API_KEY` | 44 T1 |
| `~/.grok/user-settings.json` | Custom sub-agent definitions (post-install) | 45 T3 |

## 7. Reuse — existing patterns to lean on

- **Two-stage submit pattern.** `~/.claude/CLAUDE.md` § "MANDATORY: 4+1 sprint orchestration". PTY-level guarantee, agnostic to what's reading on the other end. Reuse verbatim across all four agents.
- **Existing `PATTERNS` map** at `packages/server/src/session.js:28-118`. Sprint 44 T3 lifts these wholesale into the Claude adapter with snapshot-test parity.
- **`flashback-diag` ring buffer** (Sprint 39). Each agent adapter can append; flashback fires regardless of which agent surfaced the error pattern.
- **PROJECT_MAP / PROJECT-TAXONOMY.md** (Sprint 41). Project tagging is agent-agnostic — works the same for Claude / Codex / Gemini / Grok sessions.
- **Sprint 42 T3's `applyTemplating` helper** at `packages/server/src/setup/migration-templating.js`. Pattern is reusable for any agent-instruction templating that needs project-ref or other variable substitution.

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Codex/Gemini/Grok have their own token budgets — running 4 concurrently could blow up multi-vendor cost | Adapter exposes a `costBand` field. Sprint 46 lane assignment shows estimated cost in PLANNING.md. SuperGrok Heavy is a `subscription` band (no per-token cost). |
| Grok CLI quality may not match Claude Opus | Lane assignment per-lane explicit. Joshua chooses; doesn't get assigned automatically. |
| Memory hook transcript-format shift breaks the Claude path | Snapshot tests at Sprint 44 T3 pin behavior. Adapter-pluggable parser falls back to Claude-format if adapter not declared. |
| `AGENTS.md` shared by Codex AND Grok could diverge | Sync script generates one; if divergence emerges, downgrade to per-agent `.codex/AGENTS.md` vs `.grok/AGENTS.md`. Clean fallback. |
| `npm run sync:agents` not run before commit → AGENTS.md drift | Pre-commit hook or commit both source + mirrors. Sprint 44 T2 picks one. |
| Sprint 43 T4 ↔ Sprint 44/45 Grok overlap (Telegram) | Document both paths in T4 lane brief; pick at inject time. |

## 9. Tactical decisions deferred to Sprint kickoff (NOT plan-blocking)

- **Where do `AGENTS.md` / `GEMINI.md` mirrors live in source control?** Generated-and-gitignored vs. generated-and-committed. Recommendation: committed — external visibility wins for Brad and other testers landing on GitHub first.
- **Cost modeling exposure in PLANNING.md.** Defer until Joshua has felt the bill once.
- **xAI API key for Grok.** RESOLVED — SuperGrok Heavy carries the key.
- **TheHarness ordering.** Stays post-BHHT per current TheHarness `WHY.md`.
- **BHHT integration touchpoints.** Sprint 44/45/46 do NOT wire BHHT's Gemini-2.5-Flash extraction pipeline into TermDeck's panel system. Convention work is the prerequisite for any future merge if desirable.

## 10. What this enables for the broader Joshua ecosystem

### Immediate (post-trilogy)

- **Capacity safety valve.** Tap-out on Claude Max 20x → reroute to Gemini / Codex / Grok via a lane brief edit. No infrastructure change required mid-sprint.
- **Audit-quality lever.** A T2 lane brief can specify `agent: codex` to audit T1's Claude output without Claude's framing pollution.
- **Cost arbitrage.** SuperGrok Heavy is a flat-rate subscription. Routing exploratory / scaffolding lanes to Grok offloads from Claude's metered tier.

### Medium-term (post-Sprint 46)

- **TheHarness convergence.** The same adapter contract powers TheHarness's Phase 1 (browser-based). Spawn becomes "open Playwright tab" instead of "spawn PTY"; everything else carries over.
- **BHHT-into-TermDeck merge.** BHHT's Gemini-2.5-Flash video extraction can become a TermDeck-orchestrated lane if Joshua wants visibility/observability into the extraction pipeline. Optional.
- **"TermDeck for outside users" milestone.** Multi-agent + cron + observability + dashboards reaches v1.0.0-worthy completeness.

### Long-term (Sprint 47+)

- **TheHarness as a TermDeck lane agent.** PLANNING.md lane brief: `agent: harness/claude-pro` runs the lane through TheHarness's Claude.ai browser session instead of `claude` CLI. Cost: free-relative-to-API since it uses Joshua's chat subscription. This is the **BHHT-economy unlock** — Joshua's $1,500/month subscription budget gets orchestrated.
- **Cross-Mnestra federation.** Multi-instance memory federation (out per Sprint 38). Becomes interesting when multiple agents on multiple machines share a single Mnestra.
- **Graph-aware recall in Flashback.** Sprint 38's `memory_recall_graph` RPC consumed by the flashback path. Cross-project surfacing becomes automatic at error-state threshold.

## 11. Recommended sprint sequencing — when to fire

| Sprint | When | Trigger | Notes |
|---|---|---|---|
| 43 | Post-other-projects push | Joshua signals return to TermDeck | Already inject-ready at `docs/sprint-43-graph-controls-and-cross-project-surfacing/`. Decide T4 path (generic Telegram MCP vs. defer for grok-cli native) at inject time. |
| 44 | Post-Sprint-43 close, OR can interleave | Joshua signals desire for multi-agent capacity | Foundation only. Ship lands `termdeck@0.12.0`. |
| 45 | Post-Sprint-44 close | Sprint 44's adapter registry is in place | Codex / Gemini / Grok adapters. Lands `termdeck@0.13.0`. |
| 46 | Post-Sprint-45 close | All three adapters validated | Mixed 4+1. Lands `termdeck@0.14.0` (or `1.0.0` if Joshua deems ready). |
| 47+ | Post-BHHT, post-Sprint-46 | TheHarness Phase 1 begins | TheHarness as a TermDeck lane agent + cross-Mnestra federation candidates. |

## 12. Open questions that will surface during implementation

These are NOT plan-blocking; they're flagged so the next session-Claude doesn't rediscover them:

- Does Codex have a documented transcript file format? Sprint 45 T1 needs to investigate `~/.codex/sessions/*.jsonl` (suspected) or the codex-companion plugin's own state files.
- What's the Gemini CLI session-log format? Sprint 45 T2 needs to read `gemini --help` and any user-config docs.
- Does grok-cli's native Telegram bridge expose chat-ID allowlisting, or does the wrapper need to add it? Sprint 43 T4 (or 44 T1) decides.
- When `grok-4.20-multi-agent` is invoked with 16 sub-agents, does the parent CLI surface per-sub-agent status to stdout, or only aggregate "thinking"? Affects Sprint 45 T3 status-pattern design.
- AGENTS.md hierarchical loading: how do Codex and Grok handle conflicts between root and cwd files? Sprint 44 T2 needs this for the sync script's lead-in design.

## 13. Pointer to live artifacts

- **Plan file** (compact, decision-focused): `/Users/joshuaizzard/.claude/plans/that-should-do-it-flickering-rain.md`
- **This document** (full memorialization): `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`
- **Memory entry**: searchable via `memory_recall(project="termdeck", query="multi-agent adapter Codex Gemini Grok SuperGrok Heavy 16 sub-agents")` — written 2026-04-29 ~11:30 ET
- **Sprint 43 plan** (cross-references this work in T4): `docs/sprint-43-graph-controls-and-cross-project-surfacing/PLANNING.md`
- **Sprint 42 close-out** (the substrate this builds on): `docs/sprint-42-tmr-substrate-hardening/STATUS.md`
- **TheHarness vision** (parallel track): `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/VISION.md` + `WHY.md`
- **BHHT project prompt** (downstream beneficiary): `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/HighTicket/BHHT_Project_Prompt.md`

## 14. Process notes — what worked in the design session

For the next time Joshua opens a major design line:

1. **Three parallel Explore agents** (TermDeck abstraction analysis + multi-agent traces + external CLI conventions) covered the search space in one batched turn. Worth repeating.
2. **Web fetches against authoritative repos** (`github.com/openai/codex`, `github.com/google-gemini/gemini-cli`, `github.com/superagent-ai/grok-cli`) were faster than reading their docs sites — the README + repo file structure tells you the convention without needing a docs-site crawl.
3. **AskUserQuestion with 2-3 fork-in-the-road options** kept the plan-mode review tight without trapping Joshua in a 10-question quiz. The two questions asked (Grok scope + Sprint scope) were the only material forks.
4. **The "I had a different X in mind" option** in AskUserQuestion is a low-cost way to catch when my exploration missed something — it surfaced the SuperGrok Heavy correction without bouncing the plan back to Phase 1.
5. **Plan-mode-review-then-correct** (Joshua's SuperGrok Heavy message landing AFTER plan approval) was handled cleanly by editing the plan file directly. The write-tool-only restriction during plan mode lifts on ExitPlanMode, so post-correction edits are easy.

## 15. What this document is NOT

- Not a sprint plan — for that, see `docs/sprint-44-*` (when authored), `docs/sprint-45-*`, `docs/sprint-46-*`. This is the design rationale they'll point back to.
- Not a tutorial for adding a new agent — for that, the Sprint 44 T4 deliverable `docs/AGENT-RUNTIMES.md` will be the canonical reference.
- Not authoritative on any single CLI's exact behavior — those CLIs evolve; verify at sprint inject time.

## 16. Closing note from the designing-Claude

The Sprint 42 close-out validated the cron path end-to-end (368 cron-inferred edges, 45 cross-project, on petvetbid). That validation is the substrate this trilogy builds on: without graph-inference cron alive, multi-agent gives you 4× the capacity but nothing extra surfaces from it. With cron alive, every multi-agent session contributes memories that cross-link automatically, and Sprint 43's flashback persistence (T2) gives the audit trail to confirm that surfacing is happening. The trilogy is the next-tier capacity-and-quality unlock; Sprint 43's flashback persistence is the observability layer that makes the unlock visible.

The order matters: **Sprint 43 ships the dashboard first** so Sprint 44/45/46's multi-agent work has somewhere visible to land. Without Sprint 43's flashback dashboard, multi-agent is unobservable — agents reasoning in panels with no record of what they surfaced.

Joshua: when you return from your other-project push, the inject-ready order is **43 → 44 → 45 → 46**. Each one lands cleanly on top of the previous. None blocks on the others except Sprint 45 (needs 44's registry) and Sprint 46 (needs 45's adapters). Sprint 43 is independent of 44/45/46 — could ship first, last, or in parallel if Joshua wanted to inject two sprints simultaneously (which he hasn't done before but is technically supported by TermDeck's session model).

Memorialized 2026-04-29 11:55 ET. — Claude Opus 4.7 (1M context)
