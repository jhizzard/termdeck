# Sprint 44 — T1: Grok CLI install + auth wiring

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Install the Grok CLI from `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh`. Verify the binary works against Joshua's existing **SuperGrok Heavy** subscription (no separate API key wiring needed — Heavy-tier carries to the CLI automatically). Confirm the `grok-4.20-multi-agent` model is reachable. Document install + auth + multi-agent invocation in `docs/sprint-44-multi-agent-foundation/T1-grok-install.md` (this file, with FINDING entries appended) AND in the canonical `docs/AGENT-RUNTIMES.md` (T4's deliverable — coordinate at sprint close).

**Important context:** the multi-agent design memorialization is at `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`. Read § "Critical findings — Grok not installed" for what's known about the install path.

## Files
- `~/.grok/` (created by installer; binary at `~/.grok/bin/grok`)
- `~/.termdeck/secrets.env` (only if Heavy-tier auth doesn't auto-carry — verify first; only add `GROK_API_KEY` / `XAI_API_KEY` if needed)
- This file (append FINDING / FIX-PROPOSED / DONE entries)

## Acceptance criteria
1. `grok --help` works (binary on PATH after `exec $SHELL -l` or new terminal).
2. A one-shot `grok --prompt "what is 2+2"` returns a sensible answer.
3. The `grok-4.20-multi-agent` model is reachable — verify by issuing a multi-agent prompt that fans out to ≥ 4 sub-agents (e.g. via the `effort` parameter or a custom sub-agent spec).
4. Document any install gotchas, auth quirks, or sub-agent customization paths in this file's FINDING entries; T4 lane lifts the canonical narrative into `AGENT-RUNTIMES.md`.

## Lane discipline
- Append-only STATUS.md updates with `T1: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T1 owns Grok install + auth verification. Does NOT touch the sync script (T2), the adapter registry (T3), or the AGENT-RUNTIMES.md doc (T4).

## Pre-sprint context

- Joshua has SuperGrok Heavy (multi-hundred-dollar/month subscription).
- The official `grok-4.20-multi-agent` model unlocks 16 sub-agents (4 built-in: general / explore / computer / verify, + up to 12 user-defined customs).
- The Grok CLI also has **native Telegram remote control** — but that path is already covered by the Anthropic-official `telegram@claude-plugins-official` plugin (Sprint 43 T4 ship). T1 doesn't need to wire Grok's Telegram path.
- `~/.grok/user-settings.json` is the user-level config; `.grok/settings.json` is per-project. AGENTS.md (hierarchical, root-to-cwd merge) is the instructional file.
