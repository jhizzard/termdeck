# T2 — Sprint 63 carve-outs (4 adapter-surface bugs)

You are T2 in Sprint 64. Your lane closes the four deferred items from Sprint 63's `EXIT-CAPTURE-VERIFICATION.md` carve-out section. All four share the agent-adapter + bundled-hook surface, so they ship as one coherent FIX-PROPOSED block.

## Boot sequence

1. `memory_recall(project="termdeck", query="codex resolveTranscriptPath cross-panel contamination MIN_TRANSCRIPT_BYTES <5 messages silent skip adapter.spawn zsh -c")`
2. `memory_recall(query="recent decisions and bugs 2026-05-11 through 2026-05-14")`
3. Read `~/.claude/CLAUDE.md` (global rules)
4. Read `./CLAUDE.md` (TermDeck project read-order)
5. Read `docs/sprint-63-wave-2/PLANNING.md` § Sprint 64 candidates + § Resolution
6. Read `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md` IN FULL — your four items are explicitly documented there
7. Read `docs/sprint-64-install-polish-and-carveouts/PLANNING.md`
8. Read `docs/sprint-64-install-polish-and-carveouts/STATUS.md`
9. Read this file in full

Then begin.

## Scope

Four sub-tasks. Ship as a single FIX-PROPOSED block once all four cohere with fence tests.

### 2.1 — Codex `resolveTranscriptPath` cross-panel contamination

**Source:** Sprint 63 Finding #1, documented in `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`.

**Symptom:** A Codex panel's close-out can pick up a DIFFERENT Codex panel's transcript when both have similar mtime values on their respective rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

**Root cause hypothesis (verify in code first):** `resolveTranscriptPath` at `packages/server/src/agent-adapters/codex.js:181-194` picks the most-recent file in the codex sessions dir by mtime, without gating on whether the file's mtime is fresher than THIS panel's spawn time. Parallel Codex panels can interleave their transcripts.

**Fix shape:**
- Read the file at `packages/server/src/agent-adapters/codex.js:181-194` to confirm the hypothesis.
- Add a `spawnTimestampMs` field to the panel's session meta at spawn time (Date.now() at the moment of `pty.spawn` in `spawnTerminalSession`).
- In `resolveTranscriptPath`, filter the candidate rollout files: skip any whose `mtimeMs < session.meta.spawnTimestampMs`. A transcript that existed BEFORE this panel spawned cannot be this panel's transcript.
- If multiple files pass the gate, pick the most-recent as before (existing logic stays).

**Fence test:** `packages/server/tests/agent-adapters.test.js` — spawn two Codex sessions with overlapping mtime windows (use a fake-fs + sinon-style clock or jest-fake-timers if available; if not, use a real-fs fixture with synthetic mtime via `fs.utimesSync`). Assert each panel resolves to its own transcript.

### 2.2 — `<5 messages` silent-skip threshold

**Source:** Sprint 63 Finding #3, documented in `docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`.

**Symptom:** The bundled hook at `packages/stack-installer/assets/hooks/memory-session-end.js:576` skips Mnestra writes if the parsed transcript has fewer than 5 messages. This skips genuinely short but high-signal sessions — most commonly Codex audit posts ("audited and approved, no concerns") that are 1-2 turns but content-rich.

**Decision needed.** Three candidate paths; pick one and document the choice in your FINDING post:

- **(A) Lower N to 1** (or 2). Let `MIN_TRANSCRIPT_BYTES = 5 KB` (line 795) remain the primary noise filter. Short-but-content-rich audits get captured; 3-byte noise still filtered. **Recommended by orchestrator at scoping.** Side effect: corpus grows faster; weigh against Mnestra throughput.
- **(B) Make N configurable** via env var (e.g., `TERMDECK_MIN_MESSAGES`, default 5). Operator override per-install. More surface area; more docs to maintain.
- **(C) Leave at 5 + document the opt-out path.** Status quo. Documented opt-out: operators set `MIN_TRANSCRIPT_BYTES = 0` to bypass the byte gate AND override the message gate.

Post your FINDING with the recommendation + reasoning. Idle-poll for `### [ORCH] SCOPE` adjudication if you waver.

**Fence test:** add a test fixture transcript with N=1 message that's >5 KB; assert the hook produces a Mnestra write under path A; passes under path B with default config + skipped under path B with override; passes under path C with the documented opt-out.

### 2.3 — Codex CLI auto-update lifecycle hazard

**Source:** Sprint 63 close-out narrative (PLANNING § Sprint-arc highlights → "codex auto-update edge case").

**Symptom:** T2's first canary spawn at Sprint 63 13:26 ET hit Codex CLI's update prompt (0.129→0.130), accepted "Update now," ran `npm install -g @openai/codex`, and exited 0 — BEFORE the canary inject landed. Codex CLI has no `--no-update` flag.

**Fix shape (choose at lane scoping; post FINDING with the choice):**

- **(A) Pre-spawn version check.** Before spawning a Codex panel, run `codex --version` (~50ms cost). If the version differs from a known-good range (last 7 days of major.minor releases, or pinned to a `CODEX_PINNED_VERSION` env var), log a WARN and surface the auto-update risk to the operator via the dashboard's preflight badge. Doesn't prevent auto-update; just makes it visible.

- **(B) Wrapper shim** at `packages/server/src/agent-adapters/codex-wrapper.sh` that intercepts the update prompt: when stdin is non-interactive (no TTY), reject the update prompt with "n\n"; when stdin is interactive, defer to the operator. Spawn the wrapper instead of `codex` directly.

- **(A+B combined).** Both. Pre-spawn version check for visibility; wrapper shim for prevention. More moving parts but covers the case where the operator-spawned Codex panel WAS interactive and a future revision changes the update-prompt semantics.

**Recommended at scoping:** (A) for v1.3.0 ship + (B) as an opt-in via `--codex-wrapper` flag once the wrapper's behavior is tested. (A) is safe to ship blind; (B) needs more care.

**Fence test:** mock `codex --version` returning a stale version; assert the WARN fires. For (B), simulate a non-interactive spawn that hits the update prompt; assert the wrapper responds "n\n" and the underlying codex spawns the actual REPL.

### 2.4 — `spawnTerminalSession` ignoring `adapter.spawn` config

**Source:** Sprint 63 Sprint 64 candidates list (PLANNING § Sprint 64 candidates).

**Symptom:** At `packages/server/src/index.js:1118-1175`, every adapter is spawned as `zsh -c <command>` (or the resolved shell from Sprint 59 T2's `resolveSpawnShell`) regardless of what the adapter's declaration says. Likely contributor to codex/gemini/grok canary fast-deaths observed at Sprint 63 13:26 ET (T2 first canary).

**Fix shape:**

- Add a `spawn` field to each agent-adapter declaration in `packages/server/src/agent-adapters/{claude,codex,gemini,grok}.js`. Shape: `spawn: { command: 'codex', args: ['repl'], env: { ... }, shellWrap: false }` where `shellWrap: false` means "spawn the command directly via `pty.spawn(command, args, ...)` without a shell wrapper."
- In `spawnTerminalSession` (`packages/server/src/index.js:1118-1175`), read `adapter.spawn`. If declared:
  - `shellWrap: false` → `pty.spawn(spawn.command, spawn.args, { ..., env: {...env, ...spawn.env} })`.
  - `shellWrap: true` (or absent) → existing `zsh -c <command>` shape stays.
- Fall back to `zsh -c` only when the adapter has no `spawn` declaration AND the command isn't a plain shell name (existing `PLAIN_SHELLS` regex stays).
- The existing Sprint 59 T2 `resolveSpawnShell` chain stays as a final fallback.

**Cross-cutting concern:** carve-out 2.3's wrapper shim (option B) would land at `adapter.spawn` for the Codex adapter, so authoring order is: 2.4 first (the `spawn` field + handler), then 2.3 (if option B chosen, declare it via `adapter.spawn` on Codex).

**Fence test:** for each adapter, spawn a panel + verify the spawned command + args match the adapter's declaration. Mock `pty.spawn` to capture the actual call arguments.

## Files of interest

- `packages/server/src/agent-adapters/codex.js:181-194` (carve-out 2.1) + add `spawn` field (2.4)
- `packages/server/src/agent-adapters/claude.js`, `gemini.js`, `grok.js` (carve-out 2.4 — add `spawn` declaration)
- `packages/stack-installer/assets/hooks/memory-session-end.js:576, 795` (carve-out 2.2)
- `packages/server/src/index.js:1118-1175` (carve-out 2.4 — `spawnTerminalSession` adapter.spawn handler)
- `packages/server/src/agent-adapters/codex-wrapper.sh` (NEW — carve-out 2.3 option B if chosen)
- `packages/server/tests/agent-adapters.test.js` (extend with fences for each carve-out)
- `packages/stack-installer/assets/hooks/tests/memory-session-end.test.js` (or equivalent location; carve-out 2.2 fence)

## Acceptance criteria

For this lane to close (post `### [T2] DONE`):

- `npm test` root green (regression-clean; expect 8-12 new fence tests across the four sub-tasks).
- Each carve-out has at least one fence test that fails before the fix and passes after — establish this by intentionally reverting your fix and re-running the test before reverting the revert.
- 2.2's decision documented in STATUS.md via your FINDING post + orchestrator's SCOPE adjudication.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

## Post discipline

`### [T2] STATUS-VERB 2026-05-14 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING (as needed) → FIX-PROPOSED → FIX-LANDED → DONE. Use `### ` prefix on every post. No bare `[T2]` posts.

For 2.2 and 2.3, post a FINDING with your recommendation BEFORE proposing the fix. The orchestrator may want to adjudicate the choice across both carve-outs.
