# Sprint 44 — T4: `docs/AGENT-RUNTIMES.md` (canonical reference)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Write the canonical reference doc for the multi-agent capability. Audience: future-Joshua after a 3-month gap; Brad and other testers; the Unagi SWE lead; future contributors. Covers: which agents are supported, where their auth keys go, how the AGENTS.md / GEMINI.md sync mechanism works, the adapter contract spec, how to add a new agent, and the TheHarness alignment note.

## Files
- NEW `docs/AGENT-RUNTIMES.md`

## Required sections

1. **Overview** — what the multi-agent capability gives you (capacity safety valve + audit-quality lever); when to reach for it; the 4-agent landscape (Claude / Codex / Gemini / Grok); the cost-band model.

2. **Supported agents (Sprint 44 state)** — table mapping agent name → CLI binary → instructional file → Sprint when shipped:

   | Agent | CLI | Instructional file | Sprint shipped | Cost band |
   |---|---|---|---|---|
   | Claude Code | `claude` | `CLAUDE.md` | Pre-existing | subscription / pay-per-token (depends on plan) |
   | Codex CLI | `codex` | `AGENTS.md` | Sprint 45 | pay-per-token |
   | Gemini CLI | `gemini` | `GEMINI.md` | Sprint 45 | pay-per-token |
   | Grok CLI | `grok` | `AGENTS.md` | Sprint 45 (T1 install Sprint 44) | subscription (SuperGrok Heavy) |

3. **Where auth keys go** — explicit table:
   - Claude Code: handled via `claude login` (subscription) or `ANTHROPIC_API_KEY` env (pay-per-token)
   - Codex CLI: `OPENAI_API_KEY` (or codex's own auth flow)
   - Gemini CLI: `GEMINI_API_KEY`
   - Grok CLI: SuperGrok Heavy carries automatically (no separate key); fallback `GROK_API_KEY` / `XAI_API_KEY` in `~/.termdeck/secrets.env`

4. **How AGENTS.md / GEMINI.md sync works** — `npm run sync:agents` reads `CLAUDE.md` (canonical) and emits both mirrors. Generated files are committed (visible on GitHub). Re-running is idempotent. The sync script lives at `scripts/sync-agent-instructions.js`.

5. **The adapter contract** — the 7-field shape from memorialization § 4:
   ```
   matches, spawn, patterns, statusFor, parseTranscript, bootPromptTemplate, costBand
   ```
   For each field: what it does, what type it is, an example from `claude.js`.

6. **How to add a new agent** — worked example walking through what Sprint 45 T1 will do for Codex:
   - Read the new agent's CLI documentation
   - Find its prompt regex / status patterns / transcript format
   - Write `packages/server/src/agent-adapters/codex.js` implementing the 7-field contract
   - Add to `index.js` export
   - Add snapshot tests in `tests/agent-adapter-codex.test.js`
   - Update CHANGELOG

7. **TheHarness alignment** — the same adapter contract is portable to TheHarness's browser-based world. `spawn` becomes "open Playwright tab with this URL" instead of "spawn PTY"; everything else carries over. This is the bridge that makes Sprint 47+ "TheHarness as a TermDeck lane agent" feasible without forking abstractions.

8. **Sprint sequencing** — what's in Sprint 44 (this), what's in Sprint 45 (Codex/Gemini/Grok adapter implementations + launcher refactor), what's in Sprint 46 (mixed-agent 4+1 with per-lane assignments), what's in Sprint 47+ (TheHarness handoff).

9. **Cross-references** — pointers to:
   - The memorialization doc: `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`
   - The compact plan file: `~/.claude/plans/that-should-do-it-flickering-rain.md`
   - The Sprint 44 / 45 / 46 PLANNING.md files

## Acceptance criteria

1. The doc reads cleanly to a 3-month-future-Joshua / Brad / Unagi-SWE audience without requiring them to read the memorialization doc first.
2. Every section listed above is present.
3. The "How to add a new agent" worked example is concrete enough that Sprint 45 T1 can follow it as a recipe.
4. Cross-references to the memorialization + plan file + Sprint 45/46 plans land correctly.
5. Style matches existing TermDeck docs (concise prose, code blocks, tables where dense).

## Lane discipline
- Append-only STATUS.md updates with `T4: FINDING / FIX-PROPOSED / DONE`.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T4 owns the doc. Does NOT touch Grok install (T1), the sync script (T2), or the adapter registry code (T3).
- Coordinate with T1's FINDING entries for any Grok-specific install gotchas worth lifting into the doc.

## Pre-sprint context

This doc replaces the implicit "scattered across CLAUDE.md, memorialization, plan file, and lane briefs" knowledge with one canonical reference. After T4 ships, future contributors land on this doc and don't need to read the planning archaeology.
