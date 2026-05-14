# Sprint 64 — Install-polish convergence + Sprint 63 carve-outs + Investigation 2

**Authored:** 2026-05-14 (post-Sprint-63 wrap).
**Inject:** pending Joshua's "terminals open" signal.
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator (this session).
**Wave target:** `@jhizzard/termdeck@1.3.0` (minor — new install-wizard surface in T1 + adapter-surface changes in T2) + `@jhizzard/termdeck-stack@1.3.0` (audit-trail aligned) + `@jhizzard/mnestra@0.4.10` or `0.5.0` (orchestrator-side companion patch).
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence for all three lanes; install wizard completes on fresh macOS + Ubuntu fixtures end-to-end.

---

## Why this sprint exists

Sprint 64 is **the install-polish convergence keystone before MacBook Air dogfood**, per `docs/CONVERGENCE-PLAN.md`. The original Sprint 63 scope was the install-polish wizard; that was displaced by Wave 2 (Brad's crash-class bug-bundle) which closed Investigation 1 on acceptance grounds. Sprint 64 carries the install-polish work forward, **bundled with the three categories of follow-up surfaced at Sprint 63 close** (per `docs/RESTART-PROMPT-2026-05-11.md` § Sprint 64 candidates):

1. **Install-polish wizard** (T1) — Supabase MCP auto-provision + OS-detection. Final convergence sprint before the MacBook Air clean-install + uninstall acceptance test from CONVERGENCE-PLAN.md runs clean. Phase B virtual install matrix activation depends on this.
2. **Sprint 63 carve-outs** (T2) — four adapter-surface bugs deferred at Sprint 63 close: codex `resolveTranscriptPath` cross-panel contamination (Finding #1), `<5 messages` silent-skip threshold (Finding #3), codex CLI auto-update lifecycle hazard, `spawnTerminalSession` ignoring `adapter.spawn` config.
3. **Investigation 2** (T3) — auto-commit on context compaction-near for all agents. Still-open P0 from `docs/CRITICAL-READ-FIRST-2026-05-07.md`. Long sessions still leak state on compact; the global CLAUDE.md "Before Context Gets Long" rule remains advisory with no enforcement mechanism.

After Sprint 64 ships, the MacBook Air dogfood acceptance test should run clean and operator-action Phase B activation (35-45 min runbook at `docs/sprint-61-uninstall-and-install-harness/PHASE-B-RUNBOOK.md`) brings the virtual install matrix online across macOS + Ubuntu + Docker fedora + Docker debian fixtures.

---

## Lane structure (3+1+1)

| Lane | Owner | Focus | Why this shape |
|------|-------|-------|----------------|
| T1 | Claude | **Install-polish wizard** — Supabase MCP auto-provision + OS-detection | Convergence keystone; biggest lane; touches CLI wizard surface + new MCP-mediated provisioning path |
| T2 | Claude | **Sprint 63 carve-outs** — 4 adapter-surface bugs | All four share the agent-adapter + bundled-hook surface; co-locate for atomic ship |
| T3 | Claude | **Investigation 2** — auto-commit on context compaction-near | Research + design + hook wiring; cross-cutting concern but its own surface (settings.json hooks + memory-summarize routines) |
| T4 | Codex | **Adversarial auditor** — especially load-bearing for T1's MCP auth flow | 3+1+1 mandate; independent reproduction; auth flows + race conditions are exactly where Codex's asymmetric review pays off |
| Orch | Claude | **Mnestra companion patch + version bumps + commits + npm publishes** | Cross-repo (`engram`) + non-lane glue; doesn't belong in a Claude worker lane |

---

## Scope

### T1 — Install-polish wizard (Supabase MCP auto-provision + OS-detection)

**The keystone lane.** Today's install path is documented as 15+ manual steps for new users (Supabase project, 6 SQL migrations, secrets.env, config.yaml, mnestra serve, termdeck — per BACKLOG § B). The Supabase MCP server now allows AI agents to provision projects, apply migrations, manage vault secrets, and verify schemas programmatically. T1 wires that into the `termdeck init` wizard so the new-user path becomes "paste 2 credentials, click 3 buttons."

In scope:

- **Supabase MCP auto-provision path.** New `termdeck init --auto` (or `termdeck init --mcp-supabase`) flag that delegates project creation + migration application + vault secret setup to the Supabase MCP server. Tool calls of interest (verified loaded this session): `mcp__supabase__create_project`, `mcp__supabase__apply_migration`, `mcp__supabase__list_organizations`, `mcp__supabase__get_project_url`, `mcp__supabase__get_publishable_keys`, `mcp__supabase__deploy_edge_function`, `mcp__supabase__get_advisors` (for post-provision lint sweep).
- **OS-detection branches.** Detect macOS / Ubuntu / Docker (fedora vs debian fixtures via `/etc/os-release` parse) at wizard boot. Branch on OS for:
  - Default shell detection (`zsh` on macOS, `bash` on Ubuntu, `sh` on minimal Alpine — Sprint 59 T2's `resolveSpawnShell` precedent at `packages/server/src/index.js` lives here too).
  - Default node-pty rebuild guidance (`xcode-select --install` on macOS, `build-essential` on Ubuntu).
  - Default install path for Mnestra binary + Rumen Edge Function deploy.
  - launchd vs systemd autostart unit generation (autostart unit emission deferred to Path B follow-up if scope creeps; in-Sprint-64 it can be a stub with a TODO marker).
- **Wizard surface unification.** Today `init-mnestra.js` + `init-rumen.js` are separate flows. T1 introduces a top-level `init` orchestrator that runs both in sequence, gates each on the previous's success, and surfaces a single progress bar to the operator. Both pre-existing entries stay callable independently for advanced users.
- **Verification sweep.** After provision + migrations, run `termdeck doctor` (Sprint 35 plus the schema-check probes) and `mcp__supabase__get_advisors` (RLS + function-search-path + lint). Any RED advisor blocks wizard completion with a clear remediation hint. Closes the gap that motivated the 2026-05-06 RLS hygiene rule (memory-scoped rule in `~/.claude/CLAUDE.md` § Supabase RLS + privilege hygiene — every release).
- **`--reset` and `--from-env` parity.** Both existing flags from `init-mnestra` carry forward to the unified wizard. `--reset` drops all bundled artifacts and re-provisions; `--from-env` reads the seed credentials from `~/.termdeck/secrets.env` (bootstrap-style for CI fixtures).

Files of interest:
- `packages/cli/src/init-mnestra.js` (existing wizard; extend or wrap)
- `packages/cli/src/init-rumen.js` (existing wizard; extend or wrap)
- `packages/cli/src/init.js` (NEW — top-level orchestrator)
- `packages/cli/src/os-detect.js` (NEW — OS-detection module)
- `packages/cli/src/mcp-supabase-provision.js` (NEW — MCP-mediated provisioning path)
- `packages/cli/src/doctor.js` (existing; wire post-provision verification sweep)
- `packages/cli/tests/init-flow.test.js` (NEW — fixture-based test of the unified flow)

Out of scope:
- Auto-detecting an existing Supabase project to attach to (covered by `--from-env` for CI; manual paste for operators).
- Vault-dashboard UI (deliberately retired per Sprint 51.5 T3 Class B decision — SQL-Editor deeplinks only).
- Stack-installer auto-discovery of running TermDeck instances (Path B from BACKLOG D.5 multi-port entry; Sprint 67+).
- Autostart launchd / systemd unit generation if scope creeps; stub with TODO marker is acceptable.

### T2 — Sprint 63 carve-outs (4 adapter-surface bugs)

All four are deferred from Sprint 63 close per `docs/sprint-63-wave-2/PLANNING.md` § Sprint 64 candidates + `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`. They share the agent-adapter + bundled-hook surface, so co-locate for atomic ship.

**2.1 — Codex `resolveTranscriptPath` cross-panel contamination (Finding #1).** Codex panel close-out can pick up another codex panel's transcript when both have similar mtime values. Root cause: insufficient gating between spawn-time and most-recent transcript file mtime. Fix shape: add a "fresher-mtime-vs-spawn-time" gate — a transcript whose mtime is older than the spawn time of THIS panel is not its transcript. Files: `packages/server/src/agent-adapters/codex.js:181-194`. Add fence test that simulates two parallel codex spawns + asserts correct transcript binding.

**2.2 — `<5 messages` silent-skip threshold (Finding #3).** Bundled hook at `packages/stack-installer/assets/hooks/memory-session-end.js:576` skips Mnestra writes if the parsed transcript has fewer than 5 messages. This skips genuinely short but high-signal Codex audit sessions ("audited and approved, no concerns" — single Codex turn that's still valuable). Decision needed: relax to N=1 with a `MIN_TRANSCRIPT_BYTES` floor (5 KB threshold at line 795 already filters trivial drips)? Make N configurable via env var? Leave at 5 with documented opt-out? **Recommend at lane scoping:** lower N to 1 (or 2), let `MIN_TRANSCRIPT_BYTES` remain the primary noise filter — that way short-but-content-rich audits get captured but 3-byte noise doesn't. T2 lane authors the decision in their FINDING post; orchestrator adjudicates if T2 wavers.

**2.3 — Codex CLI auto-update lifecycle hazard.** Documented at Sprint 63 close: T2's first codex canary spawn at 13:26 ET hit Codex CLI's update prompt (0.129→0.130), accepted "Update now," ran `npm install -g @openai/codex`, and exited 0 — before the canary inject landed. There's no `--no-update` flag in Codex CLI. Fix shape: pre-spawn version check (probe `codex --version` against a known-good range; if newer or older than expected, log a warning) + a wrapper shim that intercepts the update prompt with a sane default (suppress prompt if non-interactive spawn, defer to operator if interactive). Files: `packages/server/src/agent-adapters/codex.js`. Add fence test that simulates a Codex CLI spawn during auto-update sequence.

**2.4 — `spawnTerminalSession` ignoring `adapter.spawn` config.** At `packages/server/src/index.js:1118-1175`, every adapter is spawned as `zsh -c <command>` regardless of what the adapter's `spawn` declaration says. Likely contributor to codex/gemini/grok canary fast-deaths observed at Sprint 63. Fix shape: read `adapter.spawn` (or a per-adapter override) and use the declared spawn command + arg shape; fall back to `zsh -c` only when no declaration exists. Files: `packages/server/src/index.js:1118-1175`, `packages/server/src/agent-adapters/*.js` (add `spawn: { command, args }` field per adapter). Add fence test that verifies each adapter's declared spawn shape is honored.

Files of interest:
- `packages/server/src/agent-adapters/codex.js` (carve-outs 2.1, 2.3)
- `packages/server/src/agent-adapters/claude.js`, `gemini.js`, `grok.js` (carve-out 2.4 — add `spawn` declaration)
- `packages/stack-installer/assets/hooks/memory-session-end.js:576, 795` (carve-out 2.2)
- `packages/server/src/index.js:1118-1175` (carve-out 2.4)
- `packages/server/tests/agent-adapters.test.js` (extend with fences for each carve-out)

Out of scope:
- The 5 KB `MIN_TRANSCRIPT_BYTES` threshold at hook line 795 — that's a separate config + a separate decision; keep it as-is unless 2.2's reasoning concludes it must move in lockstep.
- Source-agent-attribution rework — Sprint 50 T1's whitelist already covers the canonical 4 agents + orchestrator.

### T3 — Investigation 2 (auto-commit on context compaction-near)

The still-open P0 from `docs/CRITICAL-READ-FIRST-2026-05-07.md`. Every agent — Claude, Codex, Gemini, Grok — MUST commit memories to Mnestra automatically when nearing context compaction. The global CLAUDE.md "Before Context Gets Long" rule is advisory; long sessions still leak state on compact.

In scope:

**3.1 — Compaction-near signal for Claude.** Research Claude Code 2.x harness for `PreCompact` hook (per `settings.json` hooks block). Verify with `claude --help` + WebFetch on the official docs if needed. If the hook exists, wire it to a `memory_summarize_session` + `memory_remember` sweep. If it doesn't, fall back to a token-count proxy: at every Nth tool call OR every M minutes of wall-clock, spend a turn writing a compact session-state memory. Document the chosen path; bias toward the harness hook because it's deterministic.

**3.2 — Sweep-to-Mnestra routine.** Design what gets captured when the signal fires:
- Most recent N decisions (memory_remember calls already made this session)
- Open task list / TaskList state if available
- Current sprint context (if a sprint is active in the cwd)
- Pending findings (any text Joshua surfaced in the conversation that hasn't been captured)
- Categorize: source_type=`fact`/`decision`/`code_context`; category=`workflow`/`debugging`/`architecture`

**3.3 — Codify in CLAUDE.md (both global + project).** Promote from advisory to enforcement:
- `~/.claude/CLAUDE.md` § Before Context Gets Long — replace the "as a safety net" framing with a deterministic rule + the harness hook reference.
- TermDeck's `CLAUDE.md` — mirror the rule + document the TermDeck-specific shape (TermDeck-side periodic capture for non-Claude panels).

**3.4 — TermDeck-side periodic capture for non-Claude panels.** Codex / Gemini / Grok don't natively know about Mnestra and have no PreCompact-equivalent hook. Build a server-side timer per active non-Claude panel that drains the rolling buffer to Mnestra every N minutes (suggest 10 min). Complement of Sprint 62 + Sprint 63's close-out capture: those handle clean `/exit`; this handles compaction-mid-session. Files: `packages/server/src/session.js` (per-panel timer registration), `packages/server/src/index.js` (timer cleanup on panel close), `packages/server/src/agent-adapters/*.js` (per-adapter buffer-extraction shape).

**3.5 — Acceptance test.** A long synthetic session that crosses a compaction boundary loses zero substantive findings — verified by recalling pre-compaction content via `memory_recall` after compaction. T3 designs the test fixture (may use a small token-count-proxy trigger to avoid actually waiting for compaction in a test env).

Files of interest:
- `~/.claude/CLAUDE.md` (global rule promotion — out-of-repo edit, orchestrator commits to global)
- `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (TermDeck mirror)
- `~/.claude/hooks/memory-pre-compact.js` (NEW — harness hook, out-of-repo) OR `packages/stack-installer/assets/hooks/memory-pre-compact.js` (bundled version)
- `packages/server/src/session.js` (per-panel periodic capture timer)
- `packages/server/src/agent-adapters/*.js` (per-adapter buffer-extraction)
- `packages/server/tests/periodic-capture.test.js` (NEW)

Out of scope:
- Standalone-shell capture (Codex / Gemini / Grok run outside TermDeck) — deferred from Sprint 62 per its PLANNING § Out of scope. Sprint 65+ candidate.
- A new `mnestra doctor` probe for "did the periodic capture fire?" — that's an active-health-dashboard item (BACKLOG § D.5 "Active health dashboard"), Sprint 66+.

### T4-CODEX — Adversarial auditor

Especially load-bearing for **T1's MCP auth flow** (does the wizard ever expose credentials in logs / temp files / process-arg lists? does the OS-detection branch break on edge cases like macOS Sequoia + Apple Silicon + zsh-with-strict-mode?) and **T3's compaction-near signal** (does the harness hook actually fire BEFORE compaction, or AT compaction-time which is too late? — Codex's own training on Claude Code internals can detect this).

In scope:
- Independent reproduction of T1's wizard end-to-end on a fixture (use the Sprint 61 fresh-install harness if it's still wired; otherwise design a fixture).
- Review T2's 4 carve-outs against the agent-adapter test suite. For each, confirm the fence test fails before the fix lands and passes after.
- Review T3's compaction signal claim. If T3 says "PreCompact hook fires reliably," T4 reproduces independently. If T3 falls back to token-count proxy, T4 reasons about: what happens if the proxy fires AT the compaction boundary instead of before? What happens if the sweep itself takes a turn (does that push us past the boundary)?
- CHECKPOINT discipline mandatory: every 15 min AND every phase boundary, per `~/.claude/CLAUDE.md` § Three hardening rules.
- Post-shape uniformity: `### [T4-CODEX] STATUS-VERB 2026-05-14 HH:MM ET — <gist>` on every post.

Out of scope: rubber-stamping. Per the canonical pattern, your training cut + lack of shared session context is the asymmetry. Sprint 51.5 went all-Claude and missed 4 bugs Codex caught in 14 minutes at 51.6. Don't let that happen here.

### Orchestrator-side (this session, not a lane)

Carries the cross-repo work + non-lane glue:

- **Mnestra companion patch (`engram` repo).** Brad's §3 #2 + #4 + #6 from 2026-05-11: pre-listen singleton probe (probe 37778 with `net.connect`; if healthy, exit success with clear log; if not, bind). Log rotation cap on `~/.termdeck/mnestra.log`. Attach-to-existing on autostart (MCP boot path tests 37778 first, only spawns on connection failure). Pidfile in `~/.mnestra/`. Target: `@jhizzard/mnestra@0.4.10` (or `0.5.0` if Joshua decides minor-bump at scoping).
- **Version bumps + CHANGELOG.** termdeck → 1.3.0 + termdeck-stack → 1.3.0 + mnestra → 0.4.10/0.5.0. Audit-trail aligned.
- **`gitleaks` pre-publish sweep.** Pre-commit hook fires automatically; verify the forbidden-literal set (defined in `~/.gitleaks.toml` + global `~/.claude/CLAUDE.md`) is absent from the staged diff. Add allowlist entries only for genuine false positives.
- **`npm publish` (Passkey, Joshua) + git push (orchestrator).** Per the split-publish-workflow rule: Joshua handles `npm publish` interactively; orchestrator handles `git commit` + `git push origin main`. Never attempt `npm publish` from orchestrator bash.
- **CRITICAL-READ-FIRST-2026-05-07.md update.** Once T3 ships, add a `## Resolution — Investigation 2 — 2026-05-14` section similar to Investigation 1's. Don't delete it — the next future session may want to read why we treated this as P0.
- **CONVERGENCE-PLAN.md update.** Mark the install-polish keystone as shipped; surface the MacBook Air dogfood acceptance test as the next gate.
- **RESTART-PROMPT-2026-05-14-post-sprint-64.md.** Standard post-sprint wrap doc.

---

## Hardening rules (mandatory per global CLAUDE.md + project)

1. **Post-shape uniformity:** every lane uses `### [Tn] STATUS-VERB 2026-05-14 HH:MM ET — <gist>` (or `### [T4-CODEX] ...` for the auditor). `### ` prefix REQUIRED on every lane. This is the rule that bit Sprint 51.7 — bare `[T1]` made T3's idle-poll regex miss the post entirely.
2. **Auditor CHECKPOINT discipline:** T4-CODEX posts `### [T4-CODEX] CHECKPOINT 2026-05-14 HH:MM ET` every 15 min AND every phase boundary. Survives Codex compaction.
3. **Idle-poll regex hardening:** orchestrator-side polling uses `^(### )?\[T<n>\] DONE\b` — tolerant to absence of `### ` prefix as belt-and-suspenders.
4. **No forbidden literals externally:** the reference Mnestra project ID + internal project name MUST NOT appear in any sprint artifact, CHANGELOG, STATUS post, or cross-repo doc. Use "the reference Mnestra project" / "the daily-driver project" / elide entirely. `gitleaks` pre-commit will block any commit with a hit.
5. **No "pen-test" framing:** use "full-stack sweep" / "end-to-end functional sweep" / "adversarial sweep" in any external-facing artifact (STATUS posts, CHANGELOG, Brad-facing summary). "Pen-test" is a metaphor only.
6. **No version bumps / CHANGELOG edits / commits from lanes:** orchestrator handles those at sprint close. Lanes ship code + tests + post `DONE` to STATUS.md.
7. **Supabase RLS hygiene (global rule).** Every new function shipped in T1's wizard must satisfy the 5 gates: no `WITH CHECK (true)` policies on PUBLIC; `REVOKE EXECUTE … FROM PUBLIC` on every function; `SET search_path = public, pg_catalog` on every function; no raw anon-key paths to writeable tables; RLS enabled on every `public` table. Run the standing checklist before any wizard ships a migration.

---

## Acceptance criteria

For sprint close (orchestrator scope):
- **T1:** install wizard completes on fresh macOS + Ubuntu fixtures end-to-end; OS-detection branches verified; Supabase MCP auto-provision creates project + applies migrations + writes `~/.termdeck/secrets.env` + verifies via `mcp__supabase__get_advisors` post-provision lint sweep. New `termdeck init` orchestrator runs `init-mnestra` + `init-rumen` in sequence and surfaces a single progress indicator.
- **T2:** 4 carve-outs landed with fence tests. Codex `resolveTranscriptPath` no longer cross-contaminates (verified by parallel-codex-spawn fence). `<5 messages` threshold decision documented in STATUS.md by T2's FINDING + adjudicated by ORCH. Codex auto-update wrapper shim or pre-spawn version check ships. `spawnTerminalSession` honors `adapter.spawn` declarations per agent.
- **T3:** Compaction-near signal wired (harness hook if Claude Code 2.x exposes one; token-count proxy if not). Sweep-to-Mnestra routine ships with categorization. Global + project CLAUDE.md updated from advisory to enforcement. TermDeck-side periodic capture loop ships for non-Claude panels. Acceptance test verifies a synthetic session crossing a compaction boundary loses zero substantive findings.
- **T4-CODEX:** FINAL-VERDICT GREEN with file:line evidence for all three lanes. Independent reproduction of T1's wizard. Adversarial review of T3's compaction signal (especially "does the hook fire BEFORE compaction").

For ship:
- `@jhizzard/termdeck@1.3.0` published (Passkey by Joshua).
- `@jhizzard/termdeck-stack@1.3.0` published.
- `@jhizzard/mnestra@0.4.10` (or `0.5.0`) published.
- Commits pushed to `origin/main`; `git tag v1.3.0`.
- `docs/CRITICAL-READ-FIRST-2026-05-07.md` gains `## Resolution — Investigation 2 — 2026-05-14` section.
- `docs/CONVERGENCE-PLAN.md` marks install-polish keystone as shipped + surfaces MacBook Air dogfood test as next gate.
- This file gains a `## Resolution` section dated at close.
- `docs/RESTART-PROMPT-2026-05-14-post-sprint-64.md` authored.

---

## Boot sequence (each lane reads this top-to-bottom)

Every Tn lane briefing file repeats this sequence inline. Path: `docs/sprint-64-install-polish-and-carveouts/T<n>-<lane>.md`.

1. `memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `memory_recall(query="recent decisions and bugs 2026-05-11 through 2026-05-14")`
3. Read `~/.claude/CLAUDE.md` (global rules — especially 3+1+1 hardening + RLS hygiene + no-forbidden-literals + gitleaks discipline)
4. Read `./CLAUDE.md` (TermDeck project read-order; P0 banner points at Investigation 2)
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — Investigation 1 closed (Sprint 62 + Sprint 63); Investigation 2 still-open, this sprint's T3 lane closes it
6. Read `docs/RESTART-PROMPT-2026-05-11.md` — Sprint 63 close-out + Sprint 64 candidates context
7. Read `docs/BACKLOG.md` § P0 (any active blockers) + § D.5 (Sprint 64+ candidate list)
8. Read `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` (this file)
9. Read `docs/sprint-64-install-polish-and-carveouts/STATUS.md` — orchestrator scaffold + cross-lane visibility
10. Read `docs/sprint-64-install-polish-and-carveouts/T<n>-<lane>.md` — your full briefing

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md with the canonical `### [Tn] ...` shape. Do NOT bump versions, edit CHANGELOG, or commit — orchestrator handles those at sprint close.

---

## Inject protocol

Per `~/.claude/CLAUDE.md` § 3+1+1 sprint orchestration:

1. After Joshua signals "terminals open, inject," `GET /api/sessions` to fetch the four fresh session IDs, sorted by `meta.createdAt` to map them to T1/T2/T3/T4 in creation order.
2. Build a one-shot Node script at `/tmp/inject-sprint-64-prompts.js` that reads the four briefing files and POSTs each via the **two-stage submit pattern**: paste body (`\x1b[200~<text>\x1b[201~`) across all four sessions with ~250ms gap, settle 400ms, then submit `\r` alone across all four sessions with ~250ms gap. Single-stage `<text>\x1b[201~\r` injection is BANNED.
3. Run the script. Each POST should return `200 {"ok":true,"bytes":<N>,"replyCount":<M>}`.
4. After ~8s, `GET /api/sessions` and `GET /api/sessions/:id/buffer` for each panel. Confirm all four show `status: 'thinking'` with non-stale `lastActivity`. If any panel shows `status: 'active'` (idle, waiting), POST `/api/sessions/:id/poke` with `methods: ['cr-flood']` immediately to recover. Do not page Joshua; this is exactly what `/poke` exists for.

---

## Resolution — 2026-05-14

**Sprint 64 closed at 16:47 ET FINAL-VERDICT GREEN.** ~42 min wall-clock from inject (16:05 ET) to verdict.

### Wave shipped

- `@jhizzard/termdeck@1.2.0 → 1.3.0` (Passkey, web auth — Joshua).
- `@jhizzard/termdeck-stack@1.2.0 → 1.3.0` (audit-trail aligned).
- `@jhizzard/mnestra` unchanged at `0.4.9`. Companion patch (log rotation + pre-listen singleton probe + pidfile from Brad's 2026-05-11 §3 #2/#4/#6) **deferred**. Multi-port verification 2026-05-14 15:28 ET confirmed Mnestra attach-to-existing already works in v0.4.9 (Brad's §3 #4 closed without a companion patch); remaining items can ship in a separate Mnestra-only wave when convenient.

### Lane outcomes

- **T1** (install-polish wizard, ~37 min lane wall-clock): DONE 16:42 ET. 80+ new fence tests across `os-detect.test.js`, `mcp-supabase-provision.test.js`, `init-flow.test.js`, `spawn-env-exclusion.test.js`, redaction fences. 3 kitchen-level memories WRAPPED 18:02 ET (dual-layer credential redaction; test canary entropy vs gitleaks; management-token blast-radius).
- **T2** (4 Sprint 63 carve-outs, ~25 min lane wall-clock): DONE 16:38 ET. ~24 new tests. Carve-outs 2.1 (codex resolveTranscriptPath spawn-time gate, 0ms birthtime epsilon), 2.2 (`MIN_TRANSCRIPT_MESSAGES` env-configurable threshold default 1), 2.3 (codex auto-update persisted-last-seen-version probe), 2.4 (`adapter.spawn` field honored by `spawnTerminalSession`). 3 kitchen-level memories WRAPPED 18:01 ET (Birthtime > mtime for cross-process file attribution; Shell-Wrap Strips Interactive TTY for Agent CLIs; Don't Dilute Deterministic Signals to Save a Fixture).
- **T3** (Investigation 2 closure, ~30 min lane wall-clock): DONE 16:36 ET. 10 new tests (`pre-compact-hook.test.js` + `periodic-capture.test.js`). Bundled `memory-pre-compact.js` + installer wiring + uninstall + refresh + server-side `onPanelPeriodicCapture`. Acceptance doc at `INVESTIGATION-2-ACCEPTANCE.md`.
- **T4-CODEX** (adversarial auditor): FINAL-VERDICT GREEN 16:47 ET. Caught 10+ AUDIT-CONCERNs (multiple load-bearing) plus 2 AUDIT-REDs (PAT broadcast pre-FIX-LANDED — most-load-bearing catch of the sprint; gitleaks canary entropy). Used live probes (`curl POST /api/sessions`, `node --test <specific files>`, `gitleaks detect`) not just diff reading. 3 kitchen-level memories WRAPPED 18:00 ET (Live Probe Audit; Two-Layer Secret Defense; Name Lifecycle Signals Precisely).

### Adversarial Codex catches (load-bearing this sprint)

1. **PAT broadcast (AUDIT-RED 16:26 ET)** — T1's new `--auto` path was about to persist the Supabase PAT (org-wide management credential) into `~/.termdeck/secrets.env`, which the server loads at startup and merges into every spawned PTY env. After `termdeck init --auto`, every Claude/Codex/Gemini/Grok/shell panel would have inherited the PAT via `process.env.SUPABASE_ACCESS_TOKEN`. CVE-class regression caught pre-merge. Fix: PAT non-persistence + per-key PTY env exclusion list + dual-layer redaction (source + caller).
2. **gitleaks canary entropy (AUDIT-RED 16:42 ET)** — T1's fence tests for the PAT/JWT redaction used canary strings that matched real-secret regex shape. gitleaks pre-commit hook flagged them as actual leaks (18 findings; 3 pre-existing unrelated). Fix: runtime-built / low-entropy fixtures that match the redaction regex without entropy red-flags.
3. **Periodic-capture timer registration timing bug** (AUDIT-CONCERN 16:25 ET → 16:31 live-probe escalation) — T3's `onPanelPeriodicCapture` registered the timer from `session.meta.type` BEFORE the adapter type resolved. Direct-spawn (`POST /api/sessions {command:"codex"}` with no `type` field) sessions saw `meta.type="shell"`, `isNonClaudeAdapter=false`, timer never registered. T4's live probe (`hasPeriodic:false` in the response) caught what the static fence tests missed. Fix: promote `session.meta.type = directSpawnAdapter.sessionType` at spawn time.
4. **codex `resolveTranscriptPath` 1000ms slack bug** (AUDIT-CONCERN 16:21 ET) — T2's initial 2.1 fix used `gateMs = spawnTimestampMs - 1000` slack, so rollouts born 999ms before Panel-B's spawn passed the gate. T2 tightened to strict 0ms epsilon for birthtime-capable files.
5. **Pre-emption coordination drift** — T1's 16:17 FINDING posted before reading the 16:14 ORCH SCOPE, creating divergence on test colocation + redaction placement. T4's 16:14 CHECKPOINT locked in the rigor path; ORCH 16:18 SCOPE reaffirmed; T1 aligned on FIX-LANDED-2 round.

### Cross-sprint pattern observations

- **3+1+1 with Codex auditor continues to pay off.** Same pattern as Sprint 51.6 (4 catches), Sprint 61 (9 catches), Sprint 63 (4 catches). Sprint 64: 10+ catches including 2 AUDIT-REDs. ~25% of sprint capacity went to audit; net positive vs the alternative (silent ship of PAT broadcast → next-week hotfix → reputation hit).
- **Live-probe audits dominate static-diff audits.** T4 ran actual `node --test`, `curl POST /api/sessions`, `gitleaks detect` invocations rather than just reading diffs. Several catches (periodic-capture not registering on direct-spawn; gitleaks canaries; codex resolveTranscriptPath fence-test failure) were only visible to live tooling.
- **Sprint speed correlates with auditor caliber, not lane caliber.** ~42 min wall-clock is the fastest 3+1+1 close to date (Sprint 63: ~80 min; Sprint 61: ~52 min; Sprint 51.6: ~53 min). Codex's catches per minute drove the cadence — workers shipped, auditor flagged, workers revised, auditor verified. The serialized round-trip is the limiting factor; faster catches = faster sprints.

### Orchestrator-side close-out

- `~/.claude/CLAUDE.md` § Before Context Gets Long promoted from advisory to enforcement; new § Kitchen vs recipes directive added (kitchen-level memories prefer over recipe-level, per Joshua 2026-05-14).
- `docs/CRITICAL-READ-FIRST-2026-05-07.md` § Resolution — Investigation 2 — 2026-05-14 closes the P0.
- `docs/BACKLOG.md` § D.5 entry added for TermDeck dashboard text-break / copy-paste rendering issue (Joshua 2026-05-14).
- `docs/RESTART-PROMPT-2026-05-14-post-sprint-64.md` authored.
- Mnestra companion patch (Brad §3 #2/#4/#6 — log rotation + singleton probe + pidfile) deferred to a separate Mnestra-only wave.
- Brad WhatsApp ship summary fired at sprint close.

### What's next

Sprint 65 = "Dashboard reliability + orch-panel awareness wave" (scoped at `docs/sprint-65-dashboard-reliability/PLANNING.md`) is queued — Brad's 2026-05-13 chips + ORCH pin spec + 2026-05-12 items 2+3 + optional Path A 10/12-panel layouts fold-in. Single 3+1+1 sprint, full-day wall-clock estimate.

After Sprint 65 ships, the MacBook Air dogfood acceptance test from `docs/CONVERGENCE-PLAN.md` runs clean. Then operator-action Phase B activation (35-45 min runbook at `docs/sprint-61-uninstall-and-install-harness/PHASE-B-RUNBOOK.md`) brings the virtual install matrix online across macOS + Ubuntu + Docker fedora + Docker debian fixtures.
