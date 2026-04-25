# Sprint 26 — Memory Quality Pass

Append-only coordination log.

## Mission

The memory layer that powers Flashback and Rumen has accumulated quality debt that is now visible in production. Flashback is silent again (post-Sprint-21 fix). Rumen's full kickstart on 2026-04-19 generated 31/166 placeholder fallbacks (19% JSON-parse failure rate). Confidence scores from Haiku synthesis are not normalized so cross-project ranking is meaningless. The output analyzer's error regex still false-positives on completed Claude Code panels. None of these are individually catastrophic; together they're why Flashback feels unreliable. This sprint fixes all four in parallel — disjoint files across two repos (TermDeck + Rumen), 4 workers + 1 orchestrator.

## Two repos, one sprint

T1 and T4 work in the **TermDeck repo** (`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/`).

T2 and T3 work in the **Rumen repo** (`~/Documents/Graciella/rumen/`).

Each worker `cd`s to the right repo at the top of its session. The orchestrator commits each repo separately and pushes both. Rumen v0.4.2 ships at the end of the sprint with T2+T3's improvements (npm publish from the orchestrator, not workers).

## Terminals

| ID | Spec | Repo | Primary file ownership |
|----|------|------|------------------------|
| T1 | T1-flashback-regression.md | TermDeck | `packages/server/src/mnestra-bridge/index.js`, `packages/server/src/rag.js`, `tests/flashback-e2e.test.js` |
| T2 | T2-rumen-json-hardening.md | Rumen | `src/synthesize.ts`, `tests/synthesize.test.ts` |
| T3 | T3-rumen-confidence-norm.md | Rumen | `src/confidence.ts` (new), `src/relate.ts`, `tests/relate.test.ts` |
| T4 | T4-analyzer-false-positives.md | TermDeck | `packages/server/src/session.js` (PATTERNS.error only) |

## File ownership table

Every file any spec touches, mapped to exactly one owner.

| File | Repo | Owner |
|------|------|-------|
| `packages/server/src/mnestra-bridge/index.js` | TermDeck | T1 |
| `packages/server/src/rag.js` | TermDeck | T1 |
| `tests/flashback-e2e.test.js` | TermDeck | T1 |
| `src/synthesize.ts` | Rumen | T2 |
| `tests/synthesize.test.ts` | Rumen | T2 |
| `src/confidence.ts` (new) | Rumen | T3 |
| `src/relate.ts` | Rumen | T3 |
| `tests/relate.test.ts` | Rumen | T3 |
| `packages/server/src/session.js` | TermDeck | T4 |
| Sprint STATUS.md | TermDeck | append-only, all |

T2 and T3 both touch the Rumen repo but disjoint files. If a refactor tempts a worker to cross into another file in the same repo, append `[Tn] BLOCKED scope-creep` and stop — the orchestrator will resolve.

## Acceptance criteria

- [ ] T1 — Flashback fires end-to-end on the repro recipe (`cat /no/such/file` triggers a `[flashback]` log within 30s, with a hit OR an explicit "no matches" line — silent both ways is failure).
- [ ] T2 — Rumen's Haiku JSON parse failure rate drops below 5% on a re-run against the same fixture corpus that produced 19% on 2026-04-19. Test added that asserts the new behavior on three malformed-JSON fixtures.
- [ ] T3 — `confidence.ts` exports a pure `normalize(rawScore, contextSize)` function with unit tests covering: zero score, score above 1.0 (clamp), small context (low confidence ceiling), large context (full range). Integrated into `relate.ts` so all new insights land with normalized scores.
- [ ] T4 — `PATTERNS.error` no longer triggers on a Claude Code session that exits cleanly after touching the word "error" in normal output. Test added to `tests/` (TermDeck) covering at least three real-world false-positive corpora.
- [ ] All four `[Tn] DONE` in STATUS.md.

## Dependencies

None. All four workers start immediately on injection.

## Verification (orchestrator)

After all four DONE:

1. **TermDeck:** `node --check packages/server/src/{mnestra-bridge/index.js,rag.js,session.js}` and `node --test tests/flashback-e2e.test.js`
2. **Rumen:** `cd ~/Documents/Graciella/rumen && npm test`
3. **Flashback live test:** Start TermDeck stack, open a shell panel, run `cat /no/such/file`, watch server stdout for `[flashback]`.
4. Two commits (one per repo), push both.
5. Bump Rumen to v0.4.2, `npm publish --access public` from the Rumen repo.
6. CHANGELOG entries in both repos.

## Rules

1. Append only to STATUS.md.
2. Never edit another terminal's files (across both repos).
3. Flag blockers with `[Tn] BLOCKED <reason>`.
4. Sign off with `[Tn] DONE`.
5. Workers never `git commit`, `git push`, or `npm publish` — orchestrator only.

---
(append below)
