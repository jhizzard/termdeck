# A-T3 — Structural staleness + key-resolution hardening (engram TS)

You are A-T3 in Sprint 70 (Graph-Boosted Recall), Deck A of a dual-deck sprint. Repo:
`~/Documents/Graciella/engram`. Read PLANNING.md fully first — §Seam and §Context bind you.

## Own exclusively
- A staleness module (new file, e.g. `src/staleness.ts`) + its tests.
- The KEY-RESOLUTION LINES ONLY of `src/extract_write.ts`, `src/summarize.ts`,
  `src/consolidate.ts` (see item 3 — do not restructure anything else in those files;
  A-T2 owns the recall files, A-T1 owns migrations).

## Scope
1. **Read-side recency (newest-anchor downranking).** Within a same-cluster sibling set
   (near-dup cluster or supersession chain), the newest-dated anchor ranks first and
   older siblings are downranked — structural, not prompt-advisory. Hook into the rank
   pipeline at the seam A-T2 exposes (coordinate via STATUS posts; keep your logic in
   your module, exported as a pure function A-T2 calls). Known failure class this kills:
   the Jul-31 recall-staleness incident (status queries surfacing superseded rows above
   their successors).
2. **Mechanical supersession proposals.** From consolidation near-dup clusters, PROPOSE
   `supersedes` links (proposal rows or flags — the judged-promotion machinery decides;
   NEVER auto-apply a supersession). Tier-0/objective rows are exempt (seam §3 — they
   never decay, never get superseded mechanically).
3. **`resolveAnthropicKey()` (billing-fix engram half).** New tiny helper:
   `process.env.ANTHROPIC_API_KEY` first, else parse `~/.termdeck/secrets.env` (copy the
   established reader pattern from `src/db-endpoint.ts` — quoted values, `${...}`
   placeholders skipped, absent file → '' ). Adopt in the three consumer files. Rationale
   (§Context 2): TermDeck panels are being made key-free for billing safety; extraction
   must survive a key-free process env. A commented-out line in secrets.env
   (`# DISABLED-... : ANTHROPIC_API_KEY=`) must NOT resolve — only a live uncommented
   line or real env var. Test both branches with a fixture file.

## Discipline
Post `### [A-T3] ...` per STATUS.md shape; DONE when tests pass. No version bumps, no
CHANGELOG, no commits. Memory MCP hangs >60s → Esc-abort, proceed. Verify store facts via
read-only psql (strip `?pgbouncer=true`), not MCP recall.

Boot: read `~/.claude/CLAUDE.md`, engram `CLAUDE.md` (if present), PLANNING.md, STATUS.md,
this brief. Then begin.
