# T1 — grok-web provenance flip + bundled-hooks update

## Mission

Memories captured from the Grok **web-chat panel** currently write `source_agent='grok'`,
indistinguishable from the Grok **CLI**. Flip the web-chat panel's provenance to
`'grok-web'` end-to-end: server tag → bundled hooks acceptance → byte-floor exemption →
hook stamps → installed-copy refresh. This was deferred #5 in
`docs/RESTART-PROMPT-2026-06-09-hardening-and-brad-feedback.md` § 2d — gated precisely
because it is release-sensitive and cross-repo. Sprint 74 T1 (engram repo) is your atomic
partner: it adds `grok-web` to mnestra's `source_agents` enum + recall filter.

## Mandatory pre-reads

1. `docs/INSTALLER-PITFALLS.md` — your changes ship in the published tarball. Your DONE
   post must trace each change to the pitfall class it avoids.
2. The Sprint-70-T3 provenance pattern: `packages/server/src/index.js:324-330` and `:396-398`
   (`source_agent: adapter.sourceAgent || adapter.name`) and the antigravity precedent in
   `packages/server/src/agent-adapters/agy.js:43-44`.
3. The antigravity byte-floor exemption precedent:
   `packages/stack-installer/assets/hooks/memory-session-end.js:828-834`.

## Scope (files you own)

- `packages/server/src/` — locate the web-chat-grok panel/adapter definition
  (`grep -rn "web-chat-grok" packages/server/src/`) and flip its provenance tag to
  `sourceAgent: 'grok-web'`, following the agy.js explicit-field pattern.
- `packages/stack-installer/assets/hooks/memory-session-end.js` —
  `ALLOWED_SOURCE_AGENTS` (line ~656): add `'grok-web'`; extend `normalizeSourceAgent` if
  its canonicalization would mangle the hyphenated form; extend the byte-floor exemption
  (~line 828) to `grok-web` sessions if web-chat transcripts share the small-payload shape
  (verify empirically — post a FINDING either way).
- `packages/stack-installer/assets/hooks/memory-pre-compact.js` — check whether it has its
  own agent allowlist/normalization; mirror the change if so.
- Hook version stamps: bump per the convention you find in the hook headers, and verify the
  refresh path (`packages/cli/src/init-mnestra.js::runHookRefresh`) picks the new stamp up.
- Tests: extend the existing hook tests (find via `grep -rl "ALLOWED_SOURCE_AGENTS" tests/ packages/`).

## NOT in scope

- The mnestra enum/migration (Sprint 74 T1 owns it — coordinate via STATUS.md, do not edit engram).
- The installed live copy at `~/.claude/hooks/` (ORCH refreshes post-release).
- Version bumps, CHANGELOG, commits, publishes.

## Acceptance

1. Fresh web-chat-grok session-end writes `source_agent='grok-web'` (test or live-shaped fixture).
2. Hook accepts `grok-web` (not normalized away to `'claude'`), byte-floor decision evidence posted.
3. Stamps bumped; `runHookRefresh` verified.
4. DONE post names the exact Sprint 74 T1 artifacts the release pairing requires.

## Lane discipline

Post shape: `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in
`docs/sprint-73-provenance-and-installer/STATUS.md`. Stay in lane. No commits.
