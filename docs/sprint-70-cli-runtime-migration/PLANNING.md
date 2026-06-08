# Sprint 70 — CLI-runtime migration (Deck A) · 3+1+1

**One-liner:** make **Antigravity `agy`** and **Grok Build** work as first-class TermDeck
panel agents/auditors, harden the **Gemini** adapter, and extend **source_agent**
write-side attribution so `agy` panels are tagged correctly — so the 4-CLI 360 auditor
fleet (Claude · Codex · Antigravity · Grok Build) is whole again.

**Deck:** A (:3000). Companion **Deck B** (:3001) ships Brad's Mnestra `privacy_tags`
PR in the **engram** repo — *different repo, zero file overlap with this deck.*

---

## Why now — the CLI reality (VERIFIED 2026-06-05/07; do not trust training/web over this)

Two of the four auditor CLIs churned under us at once:

1. **Gemini CLI** OAuth/subscription serving **ENDS June 18 2026**. The binary survives
   only via a **paid (billing-enabled) API key** — already done, `~/.gemini/settings.json`
   `security.auth.selectedType: "gemini-api-key"`, validated live (`AUTHOK`). The
   replacement IDE-CLI is **Antigravity `agy` v1.0.0** (`~/.local/bin/agy`), which stays on
   OAuth → **auth segregation is live** (agy=OAuth, gemini=API-key).
2. **Grok** is now **Grok Build 0.2.33** (auto-updated from 0.1.216), authed via
   **grok.com login** (NOT the `GROK_API_KEY` in `~/.termdeck/secrets.env`, which is a
   separate api.x.ai key). `grok models` exposes **only** `grok-build` (default/coding —
   **rejects `reasoningEffort` → HTTP 400**) and `grok-composer-2.5-fast`. **No grok-4.x.**
   A "reasoning-Grok auditor" is therefore **not achievable** via Grok Build → Codex stays
   the deep-reasoning auditor; Grok Build is wired as-is.
3. **Codex** remains the deep-reasoning auditor (this deck's T4).

Credentials are **settled for working purposes** (rotation deferred to project-end): all
secrets in `~/.termdeck/secrets.env` (mode 600). You do **not** need to touch credentials.

## Goal / definition of done

- **T1** Antigravity `agy` adapter exists, registered, and an `agy` panel captures a real
  transcript via **in-flight stdout capture** (the JSONL/protobuf session path is dead).
- **T2** Gemini adapter `parseTranscript` no longer breaks on JSONL; API-key auth is wired +
  documented + has a `doctor` probe.
- **T3** `grok-models.js` describes the **Grok-Build** namespace (not grok-4.x); `agy`/
  `antigravity` is a recognized **write-side** `source_agent` (hook allowlist + bundled
  mirror + server normalization) so agy-panel memories aren't mis-tagged `claude`.
- **T4** Codex `FINAL-VERDICT GREEN` only with file:line evidence on T1–T3.

---

## Lane map + file ownership (collision-avoidance is load-bearing)

| Lane | Owns (edit only these) | Mission |
|---|---|---|
| **T1** (Claude) | `packages/server/src/agent-adapters/agy.js` (NEW) · `agent-adapters/index.js` (registry add) · the **stdout-capture region** of `packages/server/src/index.js::spawnTerminalSession` | Antigravity adapter + in-flight stdout transcript capture |
| **T2** (Claude) | `packages/server/src/agent-adapters/gemini.js` · gemini `doctor` probe wherever doctor probes live | Fix `parseTranscript` (JSONL, not one `JSON.parse`) + API-key auth wiring/doc |
| **T3** (Claude) | `packages/server/src/agent-adapters/grok-models.js` · `~/.claude/hooks/memory-session-end.js` **AND** its bundled mirror `packages/stack-installer/assets/hooks/memory-session-end.js` · the **source_agent-normalization region** of `packages/server/src/index.js` | Grok-Build model namespace rewrite + agy/antigravity write-side attribution |
| **T4** (Codex) | nothing — auditor | Adversarial independent reproduction of T1–T3 |

**Shared file = `packages/server/src/index.js`** (T1's spawn/capture region vs T3's
source_agent-normalization region). Use **surgical `Edit`s, never a rewrite**, and post in
STATUS before touching it so the other lane sees you. The auditor watches this seam.

**This deck does NOT touch the engram repo.** The read-side `source_agents` recall-filter
enum widening (adding `antigravity`) is a **documented follow-up**, not in scope — write-side
tagging is what matters now and nobody filters recalls by `antigravity` yet.

---

## Boot sequence (every lane ran this from its inject; re-run any step you skipped)

1. `memory_recall(project="termdeck", query=<your lane topic>)`
2. `memory_recall(query=<broader topic>)`  *(Codex T4: memory_recall is not wired in your
   runtime — skip 1–2 and read the docs directly.)*
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read this `PLANNING.md`
5. Read `STATUS.md`
6. Read your `T<n>-*.md` brief

Then begin.

## Lane discipline (MANDATORY — all lanes, identical shape)

- **Post shape — every lane, every post:** `### [T<n>] <VERB> 2026-MM-DD HH:MM ET — <gist>`
  - T1/T2/T3 VERB ∈ `FINDING` / `FIX-PROPOSED` / `FIX-LANDED` / `DONE`
  - T4 VERB ∈ `AUDIT-CONCERN` / `AUDIT-RED` / `CHECKPOINT` / `FINAL-VERDICT`
  - The `### ` prefix is **required**. Example:
    `### [T1] FIX-LANDED 2026-06-07 19:05 ET — agy adapter registered; stdout-tee capturing`
- **Auditor checkpoint discipline (T4):** post `### [T4-CODEX] CHECKPOINT` at every phase
  boundary **and at least every 15 min** — phase+name, what's verified with file:line, what's
  pending, the last FIX-LANDED you were verifying. Your panel may compact mid-sprint; STATUS.md
  is your only durable memory — on compact, self-orient from your most recent CHECKPOINT.
- **Idle-poll regex** (if any lane waits on another): tolerant `^(### )?\[T<n>\] DONE\b`.
- **No version bumps, no CHANGELOG edits, no commits, no `git push`, no `npm publish`.** The
  orchestrator runs the entire close-out. If you'd write a CHANGELOG line, put it in STATUS instead.

## Deferred / not this deck

- Widen engram `memory_recall` `source_agents` enum to include `antigravity` (read-side) —
  follow-up after write-side tagging is verified producing antigravity rows.
- Sprint 67 → v1.6.2 close-out + this deck's eventual release wave are **orchestrator** jobs
  (read `docs/RELEASE.md` first; Josh runs the Passkey `npm publish`). `grok-models.js` stays
  out of any unrelated commit — this sprint owns it.
