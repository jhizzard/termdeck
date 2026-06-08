# Sprint 70 · Deck A · T4 — Codex adversarial auditor

**Lane:** T4 (Codex) · You author **no production code**. You are the out-of-distribution
auditor — no shared context with the three Claude worker lanes by design. **Reproduce
independently; default to FAIL.** A lane's self-reported "done + verified" is a *claim*, not a
fact, until you reproduce it against actual code behavior (not a surface grep).

## Boot (your runtime has no memory_recall — read directly)

1. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
2. Read `docs/sprint-70-cli-runtime-migration/PLANNING.md` and `STATUS.md`
3. Read this brief. Then watch STATUS.md and audit each FIX-LANDED **as it lands** (before
   DONE), not after the fact.

## Audit focus (highest-leverage first)

**A1 — T1 stdout-capture is the load-bearing risk.** Antigravity has no readable on-disk
transcript; T1 must capture from PTY stdout in-flight. Independently verify against the
*actual* `spawnTerminalSession` code + the *actual* close path:
1. An `agy` panel on close writes **exactly one** Mnestra row, `source_agent='antigravity'`
   — not zero (capture silently empty — the very failure mode Gemini already had), not two
   (double-write), not `claude` (mis-tag).
2. The stdout path is **opt-in per adapter** — Claude/Codex/Gemini/Grok capture is unchanged.
3. Block-buffering is actually defeated (`stdbuf -oL`/`unbuffer`) — a short agy session still
   yields a non-empty transcript.

**A2 — T2 Gemini JSONL.** Feed `parseTranscript` a real multi-line JSONL session. Confirm rows
are extracted (the old single `JSON.parse` at `gemini.js:133` returned `[]` on every real
file). Confirm the doctor probe distinguishes key-missing vs wrong-auth-mode vs valid — and
doesn't print a false GREEN when `selectedType` isn't `gemini-api-key`.

**A3 — T3 attribution parity + bundled-mirror drift.** The agy/antigravity allowlist change
must be in **both** `~/.claude/hooks/memory-session-end.js` **and** the bundled mirror
`packages/stack-installer/assets/hooks/memory-session-end.js` — diff them; a live-only fix
ships nothing. Confirm `agy → antigravity` normalization, and that the string T1's adapter
declares **equals** the string T3's hook/server accept (the T1↔T3 seam — shared assumptions
hide here). Confirm `grok-models.js` sends no `reasoningEffort` to `grok-build` (it 400s) and
references grok.com-login auth, not `GROK_API_KEY`.

**A4 — Shared-file seam.** `packages/server/src/index.js` is edited by both T1 and T3. Confirm
neither clobbered the other and both regions are coherent.

## Discipline

- Post `### [T4-CODEX] <VERB> 2026-MM-DD HH:MM ET — <gist>` (AUDIT-CONCERN / AUDIT-RED /
  CHECKPOINT / FINAL-VERDICT).
- **CHECKPOINT** at every phase boundary and at least every 15 min: phase+name, what's verified
  with file:line, what's pending, the last FIX-LANDED you were verifying. Your panel may compact
  — STATUS.md is your only durable memory; on compact, self-orient from your latest CHECKPOINT.
- `FINAL-VERDICT GREEN` only when A1–A4 all hold with file:line evidence; else `RED` naming the
  exact failing claim.
