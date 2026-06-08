# Sprint 70 · Deck A · T1 — Antigravity `agy` adapter

**Lane:** T1 (Claude) · **You own:** `packages/server/src/agent-adapters/agy.js` (NEW),
`packages/server/src/agent-adapters/index.js` (registry add), and the **stdout-capture
region** of `packages/server/src/index.js::spawnTerminalSession`. Surgical edits only on the
shared `index.js`; T3 owns its source_agent region — post before you touch it.

## Mission

Make an Antigravity (`agy`) panel a first-class TermDeck agent whose transcript is captured
and written to Mnestra at panel close — the same lifecycle Claude/Codex/Gemini/Grok panels get.

## The one hard constraint

**Antigravity has no readable on-disk session transcript.** The JSONL/protobuf session path
is **dead** — do not build against it. Capture the transcript **in-flight from the PTY
stdout stream** (`unbuffer` / `stdbuf -oL` to defeat block-buffering), tee'd to a transcript
buffer the close-handler can read. This is the novel, highest-risk part of the lane and where
the auditor will push hardest.

## Steps

1. **Read the contract first.** Study the existing adapters as the source of truth for the
   adapter interface — `agent-adapters/gemini.js`, `grok.js`, `codex.js`, and the registry
   `agent-adapters/index.js`. Mirror their export shape exactly (binary name, command-match
   regex, `displayName`, `sessionType`, `parseTranscript`, boot-prompt resolver, `mcp_config`
   path, and the `source_agent` identity the adapter declares).
2. **Author `agy.js`** with the Antigravity specifics:
   - binary `agy` (`~/.local/bin/agy`, v1.0.0); command-match regex for `agy`.
   - `displayName` "Antigravity", `sessionType` as appropriate.
   - **boot-prompt resolver reads `AGENTS.md`** (Antigravity's project-prompt convention),
     not `CLAUDE.md`.
   - `mcp_config` path `~/.gemini/antigravity-cli/mcp_config.json`.
   - **`source_agent` identity = `antigravity`** (canonical). T3 adds `antigravity` (alias
     `agy`) to the write-side allowlist — coordinate the exact string with T3 in STATUS so
     the adapter and the hook agree.
3. **Wire in-flight stdout capture** in `spawnTerminalSession`: when the adapter's capture
   mode is stdout (vs on-disk-file), spawn under `stdbuf -oL`/`unbuffer` and tee the PTY
   output into the per-session transcript buffer that `onPanelClose` already consumes. Reuse
   the existing close→hook path; do **not** fork a second write path.
4. **Register** `agy` in `agent-adapters/index.js`.
5. Prove it: an `agy` panel, on close, produces exactly **one** Mnestra row tagged
   `source_agent='antigravity'` — not zero, not two, not `claude`.

## Hygiene

- No new bundled asset unless you add it to the relevant `package.json` `files` array (it
  must show in `npm pack --dry-run`) — see `docs/INSTALLER-PITFALLS.md` Class H.
- Don't regress Claude/Codex/Gemini/Grok capture: the stdout path must be **opt-in per
  adapter**, never the default.

## Discipline

- Post `### [T1] <VERB> 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED / FIX-LANDED / DONE).
- No version bumps, no CHANGELOG, no commits. Post a DONE with file:line evidence when the
  one-row-tagged-antigravity proof holds.
