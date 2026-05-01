# Sprint 47 — T4: Cross-agent STATUS.md merger

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

NEW `packages/server/src/status-merger.js` (~50 LOC). Each agent (Claude / Codex / Gemini / Grok) posts FINDING / FIX-PROPOSED / DONE differently — Claude has the convention nailed, the others may use emojis, bullet points, or free-form prose. The merger takes a raw STATUS-line in any of the four shapes and emits the canonical `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>` format.

Sprint 47 ships this as infrastructure. Sprint 48 (or wherever mixed-agent dogfood happens) actually runs the merger over real cross-agent STATUS posts.

## Files

- NEW `packages/server/src/status-merger.js` (~50 LOC, single export `mergeStatusLine(rawLine, opts)`)
- NEW `tests/status-merger.test.js` (~80 LOC, ~12 tests)

## API

```js
// packages/server/src/status-merger.js
function mergeStatusLine(rawLine, opts = {}) {
  // opts.laneTag: optional override (e.g. 'T2') if the raw line doesn't include it
  // Returns: '- Tn: <STAGE> — <summary> — <timestamp>' (the canonical bullet)
  // OR null if the line doesn't look like a STATUS post (e.g. it's a section header)
}

module.exports = { mergeStatusLine };
```

## Detected variants

The merger handles four common shapes drawn from real Sprint 45 / 46 STATUS posts (Claude) plus expected shapes from the other agents' idioms:

1. **Canonical Claude shape** (already-correct): `Tn: FINDING — text — timestamp` → returned unchanged with leading `- ` if missing.

2. **Emoji-prefixed (Codex pattern observed in audit-mode)**: `🔍 Found: text` → maps to `FINDING`. `✅ Fixed: text` → maps to `DONE`. `🛠 Proposed: text` → maps to `FIX-PROPOSED`. The lane-tag and timestamp are appended from `opts.laneTag` + `new Date().toISOString()`.

3. **Bullet-pointed (Gemini idiom)**: `- found that <text>` / `- proposing fix: <text>` / `- done: <text>` → mapped to the right stage with a one-line summary extracted.

4. **Free-form prose (Grok idiom — observed in Grok TUI output)**: `I noticed <X>` / `I'll fix this by <Y>` / `Done: <Z>` → mapped via keyword detection. Falls through to canonical pass-through if no keywords match.

For each variant, normalize to:

```
- Tn: <STAGE> — <summary up to ~120 chars> — <ISO timestamp + ET annotation>
```

## Acceptance criteria

1. **Pass-through unchanged.** A canonical Claude line in → same line out (with leading `- ` added if missing). 4 tests.
2. **Codex emoji variant.** All three emojis (🔍 / ✅ / 🛠) map to the right stage. Timestamp gets appended. 3 tests.
3. **Gemini bullet variant.** "found that" / "proposing fix" / "done:" keyword detection. 3 tests.
4. **Grok free-form variant.** "I noticed" / "I'll fix" / "Done:" keyword detection. Falls through cleanly when no keyword matches (returns null). 4 tests.
5. **Edge cases.** Empty line → null. Section header (`### T1 — ...`) → null. Garbage input → null without throwing.
6. **Deterministic timestamp injection.** When `opts.now` is supplied (test seam), the merger uses that instead of `new Date()`. Snapshot tests pin the exact output.

## Coordination

- T4 is fully independent of T1/T2/T3 — different module, different concerns. No cross-coordination needed.
- T4 ships infrastructure only. Real test happens in Sprint 48's mixed-agent dogfood when the merger runs over actual non-Claude STATUS posts. If the four-variant detection misses an idiom that Codex/Gemini/Grok actually use, Sprint 48 will surface it; T4's tests use synthesized fixtures based on Sprint 45-46 observations + reasonable extrapolation.
- The Sprint 46 lane STATUS posts (`docs/sprint-46-dashboard-audit/STATUS.md`) are the canonical Claude-shape fixtures. Lift two or three real lines into the test as snapshot fixtures.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 46 STATUS.md FINDING FIX-PROPOSED DONE format Claude Codex Gemini Grok adapter status post normalization")
3. memory_recall(query="recent decisions and bugs")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md (your canonical Claude-shape fixtures — lift 2-3 real lines into the test)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
