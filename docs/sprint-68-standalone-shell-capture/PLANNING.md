# Sprint 68 — Standalone-shell memory capture: native CLI session-end hooks

**Authored:** 2026-05-19 by the orchestrator session (`af97e403`), **staged for a later kick-off.** Joshua is closing terminals to pick up other projects; this sprint boots fresh when he returns to TermDeck.
**Inject:** 4 panels to be opened on `http://127.0.0.1:3000` — T1/T2/T3 Claude + T4 Codex. The orchestrator injects via the TermDeck input API on Joshua's go (never copy-paste).
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator.
**Runs:** **after Sprint 67** (field-deployment integrity). Sprint 67 fixes the *existing* hook deployment (`runHookRefresh`, PreCompact actually firing); Sprint 68 adds *new* hooks onto that verified foundation. Per Joshua's 2026-05-19 slotting decision, the 2026-05-17 forward plan's dashboard sprint shifts to **Sprint 69** and the memory-tech sprint to **Sprint 70**.
**Wave target:** `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` **1.5.0 → 1.6.0** (minor — a new installer capability + new bundled-hook behavior is a feature, not a patch). `@jhizzard/mnestra` unchanged — no schema change; the bundled hooks reuse the existing `memory_items.source_agent` write path (Sprint 50). Orchestrator confirms at close-out.
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence; a standalone (non-TermDeck) Codex/Gemini/Grok shell writes a correctly-labeled `session_summary` row to Mnestra on session end; the *same* agent run as a TermDeck panel writes exactly one row (no double-capture); `npm test` green; every installer change traces to the INSTALLER-PITFALLS class it avoids.

---

## Why this sprint exists

On 2026-05-19 a question raised inside a ClaimGuard sprint — *"Codex, Gemini, and Grok aren't Claude Code — they have no session-end memory hook"* — prompted an audit. Two findings:

1. **The non-Claude CLIs have caught up to Claude Code's hook model.** Verified against current official docs + installed versions on the daily-driver:
   - **Gemini CLI** (installed 0.42.0) — native `SessionEnd` hook (`reason`: `exit|clear|logout|prompt_input_exit|other`) **and** a separate `PreCompress` compaction hook. Configured in `~/.gemini/settings.json`; hooks default-on since v0.26.0.
   - **Grok CLI** / `grok-dev` — current repo docs list `SessionEnd` + `Stop` + `PreCompact`/`PostCompact` in `~/.grok/user-settings.json`. **Caveat:** the installed `grok-dev` is 1.1.5, which likely predates the hook system — T1 verifies the minimum hooked version.
   - **Codex CLI** (installed 0.131.0) — `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop` via `~/.codex/hooks.json`. **Still no `SessionEnd` and no compaction hook** — `Stop` is turn-complete-scoped, not session-scoped.

   The long-standing "wrap the CLI because it has no hook surface" assumption (baked in since Sprint 45/50; restated in `CLAUDE.md` and `docs/CRITICAL-READ-FIRST-2026-05-07.md`) is now partly stale. All three CLIs use the Claude-Code-shaped stdin-JSON hook contract (`session_id`, `transcript_path`, `cwd`, `hook_event_name`).

2. **TermDeck panels are already covered.** `onPanelClose` (`packages/server/src/index.js:265`) fires on `term.onExit` and captures non-Claude `/exit` content to Mnestra with the correct `source_agent` (Sprints 62/63/64). That path is proven and **is not changed by this sprint.**

The genuine residual gap: **standalone Codex/Gemini/Grok shells run *outside* TermDeck capture nothing** — no server, no `onPanelClose`. This is an explicitly-tracked horizon item (`RESTART-PROMPT-2026-05-17-ci-followup.md` §5: *"standalone-shell capture … still uncovered"*). Now that the CLIs expose native hook surfaces, it is closeable: install a native session-end (+ compaction) hook into each CLI's own config so standalone shells capture to Mnestra the same way TermDeck panels and Claude Code already do.

---

## Design decisions (load-bearing — every lane depends on these)

**D1 — Native hook = standalone-only; self-disables inside TermDeck.** A panel that has a native CLI hook *and* runs inside TermDeck would double-write (the native hook **and** `onPanelClose`). The native hook therefore no-ops when it detects a TermDeck-spawned PTY. Mechanism:

- T1 adds `TERMDECK_PANEL_SESSION=<session.id>` to the PTY child env in `spawnTerminalSession` (verify first — TermDeck may set no such marker today).
- The installed native-CLI-hook command sets `TERMDECK_NATIVE_CLI_HOOK=<agent>` (value ∈ `codex|gemini|grok`; doubles as the `source_agent`).
- The bundled hook script no-ops **iff `TERMDECK_NATIVE_CLI_HOOK` is set AND `TERMDECK_PANEL_SESSION` is set** — i.e. "I am a non-Claude native CLI hook running inside TermDeck; `onPanelClose` owns this session."
- Regression-safe for the two existing invocation paths: Claude Code's own `SessionEnd` hook command carries *neither* var (never no-ops — Claude-in-TermDeck still captures via its own hook, which `onPanelClose` deliberately skips); `onPanelClose` spawns the hook from the *server* process, which has *neither* var (never no-ops). **`onPanelClose` is not modified.**

**D2 — Codex is degraded-mode, documented as such.** Codex has no `SessionEnd` and no compaction hook. Codex's standalone capture rides a **throttled `Stop` hook** (`Stop` = turn-complete): it captures after each turn — so the last turn before the user quits lands — with a transcript-byte-growth throttle (the `onPanelPeriodicCapture` 1 KB-delta idea). It will not catch a `/exit` that follows no final turn. This is a Codex platform limitation, stated plainly in the docs T3 writes — not papered over.

**D3 — Version-gated, fail-loud-not-silent.** Gemini ≥0.26.0 (✓ 0.42.0). Codex `hooks.json` (✓ 0.131.0). Grok — T1 verifies the minimum `grok-dev` version that supports hooks; if the installed version lacks them, the installer **gates Grok out with an explicit upgrade message** rather than writing a `hooks` block the CLI silently ignores (INSTALLER-PITFALLS Class I — silent no-op).

---

## Lane structure (3+1+1)

| Lane | Owner | Focus |
|------|-------|-------|
| T1 | Claude | **Hook scripts + dedup** — `TERMDECK_NATIVE_CLI_HOOK` source-agent labeling + the D1 no-op guard in `memory-session-end.js` / `memory-pre-compact.js`; add the `TERMDECK_PANEL_SESSION` PTY marker; resolve each CLI's native-hook `transcript_path` (**Grok is the risk**) |
| T2 | Claude | **Installer wiring** — `installCodexHook` / `installGeminiHook` / `installGrokHook`: idempotent JSON-merge into the three CLI config files; version gates; `runHookRefresh` + uninstall paths |
| T3 | Claude | **Tests + docs** — fence tests (merge idempotency, dedup, source-agent fallback, version-gate, malformed-abort); correct the stale "no hook surface" docs; INSTALLER-PITFALLS trace + new-class evaluation |
| T4 | Codex | **Adversarial auditor** — independently reproduce standalone capture + the no-double-write invariant; audit the JSON-merge for clobber risk; CHECKPOINT discipline |
| Orch | Claude | version/CHANGELOG/commit/publish hand-off/push/tag; kitchen-memory harvest from STATUS.md; `CRITICAL-READ-FIRST` + `BACKLOG` updates; close-out |

**T4 is the Codex panel** — the orchestrator maps the Codex session to T4 at inject regardless of grid position.

---

## Scope summary (full detail in each lane brief)

### T1 — Hook scripts + dedup (`T1-hook-scripts-and-dedup.md`)

Make the two bundled hook scripts (`packages/stack-installer/assets/hooks/memory-session-end.js`, `memory-pre-compact.js`) usable as native CLI hooks: (a) `source_agent` resolution order — stdin payload → `TERMDECK_NATIVE_CLI_HOOK` env → existing inference — validated against `ALLOWED_SOURCE_AGENTS`; (b) the D1 no-op guard; (c) confirm/add the `TERMDECK_PANEL_SESSION` PTY-child marker in `spawnTerminalSession`. Then verify each CLI's *native-hook* stdin `transcript_path` resolves to something the existing parsers read. Gemini/Codex pass a real path. **Grok is the risk** — `grok-dev` stores sessions in `~/.grok/grok.db` (SQLite); if its native hook gives no usable file path, the script must extract from `grok.db` by `session_id` (the grok adapter already has this logic to borrow).

### T2 — Installer wiring (`T2-installer-wiring.md`)

New installer functions in `packages/stack-installer/src/index.js`, mirroring the proven `installPreCompactHook` / `_mergePreCompactHookEntry` pattern: detect each CLI + version, then idempotent JSON-merge a `hooks` block into the CLI's config — Codex `Stop` → `~/.codex/hooks.json`; Gemini `SessionEnd` + `PreCompress` → `~/.gemini/settings.json`; Grok `SessionEnd` + `PreCompact` → `~/.grok/user-settings.json`. Each hook command sets `TERMDECK_NATIVE_CLI_HOOK=<agent>`. Backup-before-write, abort-on-malformed, dry-run support, version gates (D3). Extend `runHookRefresh` (`packages/cli/src/init-mnestra.js`) and the uninstall splice (`packages/stack-installer/src/uninstall.js`). **Depends on Sprint 67's `runHookRefresh` fix** — build on the repaired path, do not re-fix it.

### T3 — Tests + docs (`T3-tests-and-docs.md`)

Fence tests: per-CLI JSON-merge idempotency, the D1 dedup guard (both standalone and in-TermDeck env states), source-agent fallback, version-gate, malformed-config abort, user's-own-hooks-preserved. Correct the now-stale "CLIs have no hook surface / no PreCompact equivalent" claims in `~/.claude/CLAUDE.md`, project `CLAUDE.md`, and `docs/CRITICAL-READ-FIRST-2026-05-07.md`. Add the three CLI-config invariants tables (mirror INSTALLER-PITFALLS § "Settings.json invariants"). Trace every installer change to its INSTALLER-PITFALLS class; evaluate whether writing into third-party CLI config warrants a **new failure class** and, if so, append it. Move the §5 horizon item in `BACKLOG.md` to in-progress.

### T4 — Codex auditor (`T4-codex-auditor.md`)

Independent adversarial review: actually install the hooks, run a standalone Codex/Gemini/Grok shell, confirm a labeled row lands; run the same agent as a TermDeck panel, confirm exactly one row (D1 holds). Audit the JSON-merge against every settings.json invariant (clobber, malformed-abort, idempotency, user-hook preservation). CHECKPOINT discipline — post `### [T4-CODEX] CHECKPOINT` at every phase boundary and ≥ every 15 min.

---

## INSTALLER-PITFALLS trace (mandatory — `docs/INSTALLER-PITFALLS.md`)

Every PR in the installer surface must trace to the classes it avoids. This sprint's installer work (T2) touches three third-party CLI config files — a new sub-surface. Classes in scope:

- **Class A (idempotent re-runs)** — the JSON-merge detects an already-present entry and skips; running the installer twice reports "nothing to do." Mirror `_mergePreCompactHookEntry`.
- **Class B (path mismatch)** — write to the path each CLI actually *reads*: `~/.codex/hooks.json`, `~/.gemini/settings.json` `hooks`, `~/.grok/user-settings.json` `hooks`. Re-verify per release; CLI config schemas are young and may drift.
- **Class E (hidden dependency)** — the bundled hooks must import no dev-private path (clean since Sprint 38; T3 re-greps `assets/`).
- **Class I (silent no-op)** — a hook installed but never firing (wrong event name, version too old). D3's loud version-gate + a `termdeck doctor` probe (or a documented verification procedure) make it detectable.
- **Class N (lockstep drift)** — the native hooks, the `TERMDECK_PANEL_SESSION` marker, and `onPanelClose` form one dedup contract; all move together, and the e2e test drives **both** standalone and in-TermDeck starting states.
- **New class (candidate)** — "third-party host-config drift": writing into a config file owned by a tool that is neither ours nor Claude Code, whose schema/version we do not control. T3 decides whether INSTALLER-PITFALLS needs this as a formal class.

Pre-ship checklist items most at risk: #2 (idempotent re-runs), #3 (`npm pack` includes any new asset), #5 (path parity), #13 (lockstep local-FS components).

---

## Hardening rules (mandatory — global `CLAUDE.md` + project)

1. **Post-shape uniformity** — every lane posts `### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` to STATUS.md; the `### ` prefix is REQUIRED; T4 posts `### [T4-CODEX] ...`.
2. **Auditor CHECKPOINT discipline** — T4 posts `### [T4-CODEX] CHECKPOINT ...` at every phase boundary and ≥ every 15 min: phase, what's verified with file:line evidence, what's pending, last FIX-LANDED reference.
3. **Idle-poll regex hardening** — any lane polling another uses the tolerant `^(### )?\[T<n>\] DONE\b`.
4. **No forbidden literals** — no internal Supabase project name / ref anywhere in `docs/sprint-68-*`, code, or commit messages. The gitleaks pre-commit hook enforces this.
5. **No "pen-test" framing** — "adversarial sweep" / "end-to-end functional sweep".
6. **No version bumps / CHANGELOG edits / commits from lanes** — the orchestrator does those at close-out.
7. **Supabase RLS hygiene** — this sprint is JS + installer config; no SQL expected. If a migration appears, the five hygiene gates apply.

---

## Acceptance criteria

**For sprint close (T4-CODEX FINAL-VERDICT GREEN, file:line evidence per lane):**

- **T1:** `memory-session-end.js` + `memory-pre-compact.js` resolve `source_agent` from `TERMDECK_NATIVE_CLI_HOOK` and no-op correctly under D1 (verified against all three invocation paths: native-CLI-standalone, native-CLI-in-TermDeck, `onPanelClose`, Claude's own SessionEnd hook); `TERMDECK_PANEL_SESSION` is set on PTY children; each CLI's native-hook `transcript_path` resolves (Grok's `grok.db` path proven or extraction added).
- **T2:** `installCodexHook` / `installGeminiHook` / `installGrokHook` idempotently merge into the three config files, back up first, abort on malformed JSON, preserve the user's own hook entries, and gate on version (D3); `runHookRefresh` + uninstall cover the new entries.
- **T3:** fence tests green for merge/dedup/fallback/version-gate/malformed-abort; stale-doc claims corrected; INSTALLER-PITFALLS trace complete.
- **T4-CODEX:** FINAL-VERDICT GREEN — standalone capture reproduced for each CLI, the no-double-write invariant confirmed in-TermDeck.

**For ship (orchestrator scope):**

- `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` bumped to 1.6.0, CHANGELOG entry, published (Passkey by Joshua), committed, pushed, tagged — per `docs/RELEASE.md`.
- This file gains a `## Resolution` section.
- `RESTART-PROMPT-<close-date>-post-sprint-68.md` authored; `BACKLOG.md` §5 horizon item closed.

---

## Out of scope

- Modifying the CLIs' own source code — third-party; the surface is each CLI's hook *config*, not its program.
- Changing `onPanelClose` or any TermDeck-panel capture path — proven; the only server-side change is adding the `TERMDECK_PANEL_SESSION` env marker.
- A true on-`/exit` capture for Codex — Codex has no `SessionEnd`; the throttled `Stop` hook is the accepted degraded mode (D2).
- Standalone-shell capture for any CLI other than Codex/Gemini/Grok.
- Sprint 67's work — fixing `runHookRefresh` / verifying the PreCompact hook fires on the daily-driver belongs to Sprint 67; Sprint 68 builds on its result.

---

## Risks / open questions

- **Grok is the highest-risk element.** Installed `grok-dev` 1.1.5 may predate the hook system, and Grok sessions live in `~/.grok/grok.db` (SQLite), not a transcript file. T1 de-risks this *first*; if Grok cannot be supported on a reasonable version, the installer gates it out (D3) and Grok standalone capture is documented as a follow-up — Codex/Gemini still ship.
- **Dedup correctness (D1) is the load-bearing invariant.** A wrong guard either double-writes or silently drops Claude-in-TermDeck captures. T4 must hammer all four invocation paths.
- **CLI hook contracts are young.** Gemini/Grok hook schemas may shift between releases — T2 pins behavior to the verified doc versions and T3's tests assert the contract.

---

## Boot sequence (each lane reads this top-to-bottom)

1. `mcp__mnestra__memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `mcp__mnestra__memory_recall(query="Sprint 68 standalone-shell capture native CLI hooks")`
3. `mcp__mnestra__memory_recall(query="recent TermDeck decisions and bugs")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/RESTART-PROMPT-2026-05-19-sprint-68-staged.md` (the staging doc — finding + context)
7. Read `docs/INSTALLER-PITFALLS.md` (mandatory — installer-surface work)
8. Read `docs/sprint-68-standalone-shell-capture/PLANNING.md` (this file)
9. Read `docs/sprint-68-standalone-shell-capture/STATUS.md`
10. Read `docs/sprint-68-standalone-shell-capture/T<n>-<lane>.md` (your full briefing)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / FIX-LANDED / DONE with the canonical `### [Tn] ...` shape. No version bumps, no CHANGELOG edits, no commits — the orchestrator handles close-out.

---

## Inject protocol

Two-stage submit pattern per `~/.claude/CLAUDE.md` § 3+1+1 orchestration. TermDeck server on `http://127.0.0.1:3000`. One-shot Node script at `/tmp/inject-sprint-68-prompts.js`: paste pass (`\x1b[200~<brief>\x1b[201~`, no CR) across all 4 sessions with ~250 ms gaps → 400 ms settle → submit pass (`\r` alone) across all 4. Verify each panel reaches `status: 'thinking'` within 8 s; `POST /api/sessions/:id/poke` with `methods: ['cr-flood']` for any panel still idle.

---

## Resolution

_(Filled at sprint close.)_
