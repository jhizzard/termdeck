# Sprint 47 — T1: Frontmatter parser + lane.agent validation

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

NEW `packages/server/src/sprint-frontmatter.js`. Parse YAML-style `---`-delimited frontmatter from a PLANNING.md or per-lane brief. Validate `lane.agent ∈ {claude, codex, gemini, grok}` against the adapter registry at `packages/server/src/agent-adapters/index.js`. Expose `getLaneAgent(briefPath, laneTag)` that returns the adapter ref (or `'claude'` default if the field is absent).

## Files

- NEW `packages/server/src/sprint-frontmatter.js` (~80 LOC, two exports: `parseFrontmatter(filePath)` and `getLaneAgent(briefPath, laneTag)`)
- NEW `tests/sprint-frontmatter.test.js` (~120 LOC, ~15 tests)
- READS but doesn't modify: `packages/server/src/agent-adapters/index.js` (registry, for the agent-name enum)

## Frontmatter format

The convention this lane establishes (Sprint 48+ PLANNING.md files use it):

```markdown
---
sprint: 48
lanes:
  - tag: T1
    agent: codex
    project: termdeck
  - tag: T2
    agent: gemini
    project: termdeck
  - tag: T3
    agent: grok
    project: termdeck
  - tag: T4
    agent: claude
    project: termdeck
---

# Sprint 48 — ...
```

Today's Sprint 45 / 46 / 47 PLANNING.md files have NO frontmatter — the parser must treat their absence as "all lanes default to `claude`."

## Parser API

```js
// packages/server/src/sprint-frontmatter.js
function parseFrontmatter(filePath) {
  // Returns { sprint?, lanes: [{tag, agent, project, ...}] } or {} if no frontmatter block.
  // Throws on malformed YAML or invalid `agent` value.
}

function getLaneAgent(briefPath, laneTag) {
  // Resolves agent for a specific lane. Returns the adapter MODULE (not just the name string).
  // Defaults to claude adapter if frontmatter absent or `agent` field missing on this lane.
  // Throws on `agent` ∉ {claude, codex, gemini, grok}.
}

module.exports = { parseFrontmatter, getLaneAgent };
```

## Acceptance criteria

1. **Snapshot test against today's Sprint 45 PLANNING.md** (no frontmatter) → `parseFrontmatter()` returns `{}`. `getLaneAgent('/path/to/sprint-45-.../PLANNING.md', 'T1')` returns the Claude adapter.
2. **Snapshot test against a synthetic Sprint 48 PLANNING.md** with mixed agents (T1=codex, T2=gemini, T3=grok, T4=claude) → `parseFrontmatter()` returns the populated lanes array. `getLaneAgent(...)` returns the right adapter per lane.
3. **Invalid agent throws.** Frontmatter declares `agent: gpt5` → `parseFrontmatter()` throws with a message naming the valid options.
4. **Missing-field defaults to claude.** Frontmatter present but a lane omits `agent` → `getLaneAgent()` returns Claude adapter.
5. **Malformed YAML throws.** Frontmatter has unclosed quotes or bad indentation → throws with line number.
6. **No third-party YAML dependency.** Use a tiny hand-rolled YAML-subset parser (just enough to handle the convention above — sequences of mappings with string scalars). The project is no-build vanilla JS; adding `js-yaml` is overkill for this scope.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 47 frontmatter parser lane agent validation YAML mixed 4+1 sprint-47-mixed-4plus1")
3. memory_recall(query="recent decisions and bugs")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/index.js (the registry — your validation source-of-truth)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md` with timestamps. Don't bump versions, don't touch CHANGELOG, don't commit.
