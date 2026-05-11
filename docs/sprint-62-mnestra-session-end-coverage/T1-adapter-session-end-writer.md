# T1 — Adapter session-end Mnestra writer

## Boot sequence

1. `mcp__mnestra__memory_recall(project="termdeck", query="adapter session-end writer hook Sprint 38 Sprint 45")`
2. `mcp__mnestra__memory_recall(query="memory-session-end.js bundled hook PROJECT_MAP")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-62-mnestra-session-end-coverage/PLANNING.md`
6. Read `docs/sprint-62-mnestra-session-end-coverage/STATUS.md`
7. Read `docs/sprint-62-mnestra-session-end-coverage/SOURCE-BRIEF-from-claimguard-sprint-8.0.md` (full — provides empirical context)
8. Read this brief.

Post `### [T1] BOOT 2026-05-08 HH:MM ET — booted, scanning adapter session-close paths` to STATUS.md when done.

## Mission

Wire Codex / Gemini / Grok adapter session-close events to the Mnestra `session_summary` writer. Pre-fix, only Claude Code's `SessionEnd` hook fires; the other three CLIs `/exit` cleanly with their session JSONL durable on disk but no Mnestra row. Sprint 38 hook rewrite addressed Claude only; Sprint 45 added the adapters but never wired the writer.

## Surfaces

- `packages/server/src/adapters/codex.js`, `gemini.js`, `grok.js` — locate the session-close hook point. Two viable patterns:
  - **Inline:** PTY exit handler triggers a writer call directly (similar to how Claude's `SessionEnd` is bridged today).
  - **Filesystem watcher:** one watcher per adapter on `~/.codex/sessions/`, `~/.gemini/...`, `~/.grok/...` that detects "JSONL no longer being appended to + adapter-marked complete" and triggers.
  - Inline is simpler; watcher is more robust to edge cases (panel killed without `/exit`, browser tab closed). Pick inline first; document the watcher path as Sprint 63 work if any case slips through.
- `packages/stack-installer/assets/hooks/memory-session-end.js` — extend OR pair with adapter-specific hooks. The Sprint 38 hook (Claude-only) is the architectural reference; same module-export contract pattern applies (`require.main === module` → CLI mode; imported → exported helpers).
- `packages/server/tests/` — add fixtures for synthetic Codex/Gemini/Grok sessions. Verify exactly one row lands per `/exit`. Verify NO row on JSONL rotation (file replaced mid-session, not session-ended).

## What you call

When a session close is detected, write to Mnestra via the existing webhook bridge or `mnestra-bridge.embedAndWrite` with:
- `source_type: "session_summary"`
- `source_agent: "codex" | "gemini" | "grok"` — set EXPLICITLY per adapter; never inferred or NULL.
- `project`: resolved via the existing PROJECT_MAP (CWD → project name). Reuse the same resolver Claude's hook uses; don't fork.
- `content`: a digest. Options: (a) call `mcp__mnestra__memory_summarize_session` if the MCP is up; (b) fall back to a last-N-lines extract of the JSONL (e.g. last 200 lines) with a header noting the adapter + session ID + timestamp.
- `category`: `session_summary` or whatever the existing Claude path uses for shape consistency.

## Acceptance

1. Synthetic Codex `/exit` produces exactly one `memory_items` row with `source_type=session_summary`, `source_agent='codex'`, `project` correctly resolved.
2. Same for Gemini + Grok.
3. No double-write when the panel already has a stale JSONL on close.
4. No write on JSONL rotation (file replaced, not session-ended).
5. `npm test` in `packages/server` passes.
6. Sprint-level metric (T4 verifies after a few sessions complete post-ship): `session_summary / sessions_processed` rises 27% → >80%.

## Post shape

`### [T1] STATUS-VERB 2026-05-08 HH:MM ET — <gist>` to STATUS.md. Verbs: BOOT, FINDING, FIX-PROPOSED, FIX-LANDED, DONE, BLOCKED.

Read T2/T3 posts in passing — flag any cross-lane consistency concern as FINDING (e.g. T2 renames the project-tag while you're emitting from PROJECT_MAP — coordinate to ensure your `project` field uses the post-rename canonical name where applicable).

## What NOT to touch

- No version bumps (orchestrator owns at close).
- No CHANGELOG narrative edits (you can leave a structured FIX-LANDED note in STATUS).
- No commits.
- Do NOT touch the engram repo (T2/T3 own that).
- Do NOT modify the existing Sprint 38 Claude hook unless absolutely necessary; prefer adding adapter-specific hooks alongside.
- Do NOT change PROJECT_MAP semantics (T2 will handle the claimguard tag canonicalize separately).
