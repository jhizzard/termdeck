# Sprint 70 · Deck A · T2 — Gemini adapter hardening

**Lane:** T2 (Claude) · **You own:** `packages/server/src/agent-adapters/gemini.js` and the
gemini `doctor` probe (wherever the adapter doctor probes live). Do not touch other adapters.

## Mission

Two things: (1) fix the already-broken `parseTranscript`, and (2) wire + document the
API-key auth path Gemini now requires, with a `doctor` probe so a misconfig is loud.

## Bug 1 — `parseTranscript` assumes one JSON object; Gemini writes JSONL

`packages/server/src/agent-adapters/gemini.js:130 parseTranscript(raw)` does a single
`JSON.parse(raw)` at **line 133** and `return []` on throw. The Gemini CLI session file is
**JSONL** (one JSON object per line), so `JSON.parse` on the whole blob throws and the
adapter silently captures **nothing**. The header comment at line 109 even mislabels it
"Gemini CLI session JSON format (NOT JSONL)" — that premise is wrong; verify against a real
Gemini session file before you trust either claim.

- Fix: parse line-by-line (tolerate blank lines + trailing newline + a partial last line),
  skip unparseable lines rather than aborting the whole transcript.
- Cross-reference the **hook-side** Gemini parser `parseGeminiJson` in
  `~/.claude/hooks/memory-session-end.js` (~line 311–323, registered ~line 449) for the
  message shape (`{ messages: [{ id, timestamp, type: 'user'|'gemini', content }] }`,
  `type:'gemini'`→assistant). Match that shape; it is the de-facto contract. (That hook file
  is T3-adjacent — read it, don't edit it.)
- Add/extend a test with real JSONL multi-line input proving rows are extracted.

## Bug 2 — API-key auth wiring + doctor probe

Gemini CLI is now on **API-key auth** (`~/.gemini/settings.json`
`security.auth.selectedType: "gemini-api-key"`; key in `~/.termdeck/secrets.env`
`GEMINI_API_KEY`). Antigravity stays on OAuth — keep the two segregated.

- Ensure the adapter/doctor surfaces a **clear, actionable** state for: key present & valid,
  key missing, key present but auth mode wrong. A live probe (the prior session validated one
  that returned `AUTHOK`) is the model.
- Document the auth path in the adapter header and/or the doctor output — a future operator
  must not have to reverse-engineer why Gemini stopped working after June 18 2026.

## Discipline

- Post `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED / FIX-LANDED / DONE).
- No version bumps, no CHANGELOG, no commits. DONE = both bugs fixed with a passing test for
  Bug 1 and a working doctor probe for Bug 2, file:line cited.
