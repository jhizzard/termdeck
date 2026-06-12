# T3 — orch/xterm input-accumulation audit + fix (termdeck#12, second half)

## Mission

GitHub issue **termdeck#12** (OPEN) reported two bugs on v1.6.0: (a) focus mode not hiding
non-focused panels — fixed in the v1.6.1 hotfix — and (b) **the input box accumulates
buffer-so-far per keystroke**. (b) is unresolved and was publicly promised an audit
(restart-doc follow-up #10). Reproduce it (or prove it already fixed), fix it with a
regression test, and draft the public issue reply.

## Mandatory pre-reads

1. `gh issue view 12` — the reporter's exact symptom description and version.
2. `memory_recall(project="termdeck", query="input accumulation xterm issue 12 v1.6.1 focus mode hotfix")`.
3. The client input path: `packages/client/public/` (vanilla JS — find the prompt-bar /
   input-box handlers and the `POST /api/sessions/:id/input` call sites).
4. The server input API: `packages/server/src/index.js` input route (incl. the Sprint-63
   body-parser hardening — don't regress it).

## Scope

- **Audit first, fix second.** Phase 1: trace one keystroke end-to-end (DOM event → client
  state → POST body → PTY write) on current main, and post a FINDING with file:line for
  where accumulation can occur (e.g. a listener re-registered per keystroke/per render, a
  send buffer never cleared, an event-handler closure over stale state).
- Phase 2: reproduce against v1.6.0 (the reporter's version — `git stash` not needed; read
  the v1.6.0 tag's relevant file) and against current main. If current main already fixed it,
  the deliverable becomes the EVIDENCE chain (which commit fixed it, proof) + regression test.
- Phase 3: fix (if live) in `packages/client/public/` and/or the server input route +
  regression test (existing test idioms in `packages/server/tests/` / `tests/`).
- Phase 4: draft the public reply for termdeck#12 — post the draft text in STATUS.md for
  ORCH review (peer-developer voice, file:line specifics, honest about timeline). Do NOT
  post to GitHub yourself.

## NOT in scope

- Focus-mode (already fixed, v1.6.1). Multi-keystroke IME handling unless implicated.
- Posting the GitHub reply (ORCH does, after review). No commits.

## Acceptance

1. FINDING with the precise mechanism (or proof of prior fix with commit SHA).
2. Regression test that fails on the buggy behavior and passes after the fix.
3. Draft issue reply in STATUS.md.

## Lane discipline

Post shape: `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in
`docs/sprint-73-provenance-and-installer/STATUS.md`. Stay in lane. No commits.
