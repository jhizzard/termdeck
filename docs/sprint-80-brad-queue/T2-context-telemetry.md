# T2 — Context telemetry + enforcement lane (FR-5 + FR-6)

You are T2 in Sprint 80 (Brad Queue). You own context-size telemetry and threshold enforcement, server + client. Boot sequence:

1. `memory_recall(project="termdeck", query="context blowup rotation token gauge PreCompact periodic capture")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-80-brad-queue/PLANNING.md` + `STATUS.md`
5. Read this brief, then RE-VERIFY anchors (briefs are hypotheses; post drift as FINDING)

**Field context:** on 2026-06-26 four of Brad's five orchs silently ran to 356K–999K context and crashed the host. Claude-side self-monitoring provably fails at high context. These two features are the TermDeck-layer answer; Brad's interim systemd watchdog is the reference behavior spec.

## FR-5 — per-panel context counter

- **Source of truth:** newest `*.jsonl` under `~/.claude/projects/<encoded-cwd>/` for the session's cwd; last assistant turn's `usage` block; context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The server already resolves transcript paths for the periodic-capture timer (Sprint 64 T3, `packages/server/src/index.js` — find `onPanelPeriodicCapture` + its path helper and REUSE it; do not roll a second encoded-cwd resolver).
- **Trigger:** fs.watch on the JSONL (debounced), not polling. Update `session.meta.contextK`, broadcast over the existing WS meta-update path, render in the panel header (`packages/client/public/app.js`) as `89K ctx` → `⚠ 340K` → `⛔ 410K` with configurable WARN/OVER thresholds (config.yaml keys + sane defaults 350/400).
- **External-writer parity (Brad's ask):** add `'contextK'` to `SessionManager.PATCHABLE_META_FIELDS` (`packages/server/src/session.js:658`). Precedence: server-computed value wins whenever the JSONL is readable; PATCH value is fallback for non-Claude panels with no JSONL. Document this in ARCHITECTURE.md.
- Non-Claude panels (Codex/Gemini/Grok) have no Claude JSONL — degrade to PATCH-only, no header noise when unknown.

## FR-6 — `maxContextK` enforcement

- Config: global default + per-session override (`maxContextK`, plus `contextAction: notify|inject|kill`, `contextInjectText`, `respawnOnKill: bool`).
- **Locked (PLANNING §3.3): default action is `notify`** (UI alert + optional webhook POST). `inject` = two-stage paste+CR of the configured force-rotate message via the production `pty-submit.js` path. `kill` = terminate + optional respawn — NEVER default, and never fire while the panel is mid-tool-use: design a grace pass (e.g. re-check after N seconds, max M deferrals, then act) — T4 audits this guard specifically.
- Check runs on the same JSONL-write event as FR-5 — no new polling loop.
- One firing per breach episode (hysteresis — don't re-inject every turn above threshold; reset when context drops below WARN, i.e. after rotation).

## Tests

`packages/server/tests/` (inside the npm glob): synthetic JSONL fixture with usage blocks → contextK computed correctly; threshold crossing fires action exactly once; kill-guard defers while mid-tool-use; PATCH fallback + precedence; malformed/truncated JSONL tail → no crash, stale value retained. Client render can be asserted via the existing escapehtml/client test pattern if present — verify what exists first.

## Lane discipline

Post `### [T2] VERB 2026-MM-DD HH:MM ET — gist` (exact shape, `### ` prefix). `session.js` is shared with T1's FR-4 work — HANDOFF-REQUEST before touching input-buffer fields. No version bumps, no CHANGELOG, no commits. DONE post includes test counts + a manual-verify note (real panel, real JSONL growth).
