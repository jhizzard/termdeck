# Sprint 70 · Deck A · T3 — Grok-Build namespace + agy/antigravity attribution

**Lane:** T3 (Claude) · **You own:** `packages/server/src/agent-adapters/grok-models.js`,
`~/.claude/hooks/memory-session-end.js` **and** its bundled mirror
`packages/stack-installer/assets/hooks/memory-session-end.js`, and the
**source_agent-normalization region** of `packages/server/src/index.js`. Surgical edits only
on the shared `index.js` (T1 owns its stdout-capture region) — post in STATUS before touching it.

## Mission A — rewrite `grok-models.js` to the Grok-Build namespace

The installed `grok` is **Grok Build 0.2.33** (auto-updated from 0.1.216). `grok models`
exposes **only**:
- `grok-build` — default, coding model. **Rejects `reasoningEffort` → HTTP 400.**
- `grok-composer-2.5-fast`

There is **no grok-4.x** and **no reasoning-effort knob**. The current `grok-models.js` was
reverted to a stale baseline and this sprint owns it — rewrite it to describe exactly these
two models, drop any grok-4.x / reasoning-effort assumptions, and make any code that sends
`reasoningEffort` to `grok-build` either omit it or guard it (a 400 is a hard failure).
Auth is via **grok.com login**, NOT `GROK_API_KEY` (that's a separate api.x.ai key) — note
this in the file header so nobody re-wires it to the wrong credential.

Keep `grok-models.js` self-contained; the orchestrator keeps it out of any unrelated commit.

## Mission B — agy/antigravity is a recognized write-side `source_agent`

So that Antigravity (`agy`) panels write memories tagged correctly instead of being
normalized to `claude`:

- `~/.claude/hooks/memory-session-end.js` — the allowlist array (~line 645:
  `'claude','codex','gemini','grok','orchestrator'`) and `normalizeSourceAgent()` (~line 672).
  Add **`antigravity`** as a first-class value and normalize the alias **`agy` → `antigravity`**.
- **Mirror the identical change** into the bundled hook
  `packages/stack-installer/assets/hooks/memory-session-end.js`. Live-vs-bundled hook drift is
  a known failure class (flagged in the Sprint 66 Resolution) — the two must stay byte-identical
  on this allowlist. If the bundled path differs, find it (`grep -rl normalizeSourceAgent
  packages/`) and fix both.
- `packages/server/src/index.js` source_agent-normalization region — make sure the server-side
  `onPanelClose` path passes `antigravity` through for `agy` panels (coordinate the exact
  string with **T1**, who declares it on the adapter; they must match).

`source_agent` is a **free-text column with no DB CHECK** (engram `migrations/015_source_agent.sql`)
— so this is purely an app-side allowlist change. **No engram migration. Do not touch the
engram repo.** Widening the read-side `memory_recall` `source_agents` filter enum to include
`antigravity` is a documented follow-up, not this lane.

## Discipline

- Post `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED / FIX-LANDED / DONE).
- No version bumps, no CHANGELOG, no commits. DONE = grok-models reflects Grok-Build reality
  **and** both hook copies + the server path accept `antigravity` (with `agy` alias), file:line cited.
