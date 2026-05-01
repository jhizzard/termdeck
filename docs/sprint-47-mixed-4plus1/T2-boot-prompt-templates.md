# Sprint 47 — T2: Per-agent boot-prompt templates + resolver

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

NEW directory `docs/multi-agent-substrate/boot-prompts/` with four templates (one per agent: Claude, Codex, Gemini, Grok). NEW `packages/server/src/boot-prompt-resolver.js` reads template by agent name + interpolates placeholders. The infrastructure that lets the inject script (Sprint 47 T3) emit agent-correct boot prompts.

## Files

- NEW `docs/multi-agent-substrate/boot-prompts/boot-prompt-claude.md`
- NEW `docs/multi-agent-substrate/boot-prompts/boot-prompt-codex.md`
- NEW `docs/multi-agent-substrate/boot-prompts/boot-prompt-gemini.md`
- NEW `docs/multi-agent-substrate/boot-prompts/boot-prompt-grok.md`
- NEW `packages/server/src/boot-prompt-resolver.js` (~60 LOC)
- NEW `tests/boot-prompt-resolver.test.js` (~80 LOC, ~12 tests)

## Per-agent template differences

Each template is agent-specific in three ways:

1. **Instructional file reference.** Claude reads `CLAUDE.md`; Codex + Grok read `AGENTS.md`; Gemini reads `GEMINI.md`. The agent's first reading step in the boot sequence cites the right file.
2. **Memory-tool framing.** Claude + Grok have native MCP integration with Mnestra (`memory_recall`, `memory_remember`). Codex + Gemini may not — investigate at lane time and either (a) include the MCP tool calls (if their CLIs support MCP) or (b) replace with a `cat`/`grep` pattern over `~/.mnestra/cache/` if they don't. Document the verdict in each template.
3. **Boot step count.** Claude has 6-step boot; other agents may have 5 or 7 depending on what their CLIs accept idiomatically.

## Template format

Each template uses Mustache-style placeholders interpolated by the resolver:

```markdown
You are {{lane.tag}} in TermDeck Sprint {{sprint.n}} ({{sprint.name}}). [...]

Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="{{lane.project}}", query="{{lane.topic}}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md  (or AGENTS.md / GEMINI.md per agent)
5. Read {{sprint.docPath}}/PLANNING.md
6. Read {{sprint.docPath}}/STATUS.md
7. Read {{sprint.docPath}}/{{lane.briefing}}

Then begin.
```

Placeholders: `{{lane.tag}}` / `{{sprint.n}}` / `{{sprint.name}}` / `{{sprint.docPath}}` / `{{lane.briefing}}` / `{{lane.topic}}` / `{{lane.project}}`. The resolver fills them; missing-variable errors are diagnostic.

## Resolver API

```js
// packages/server/src/boot-prompt-resolver.js
function resolveBootPrompt(agentName, vars) {
  // agentName ∈ {claude, codex, gemini, grok}
  // vars: { lane: {tag, briefing, topic, project}, sprint: {n, name, docPath} }
  // Reads docs/multi-agent-substrate/boot-prompts/boot-prompt-${agentName}.md,
  // interpolates placeholders, returns the final paste-ready string.
  // Throws on unknown agent or missing placeholder variable.
}

module.exports = { resolveBootPrompt };
```

## Acceptance criteria

1. **All four template files present** with the right instructional-file reference + memory-tool framing per agent. Each template body is ~30-50 lines (similar to today's hardcoded boot prompts in `inject-sprint45.js` / `inject-sprint46.js`).
2. **Resolver picks the right template per agent name.** `resolveBootPrompt('codex', vars)` reads `boot-prompt-codex.md`, NOT `boot-prompt-claude.md`.
3. **All placeholders interpolate.** Test fixture with full `vars` produces a string with no `{{...}}` literals remaining.
4. **Missing variables throw with a clear error.** `resolveBootPrompt('claude', {sprint: {n: 47, name: 'foo', docPath: 'bar'}})` (no `lane` key) throws `Missing variable: lane.tag`.
5. **Unknown agent throws.** `resolveBootPrompt('gpt5', vars)` throws with the four valid options listed.
6. **No template-engine dependency.** Hand-rolled `{{var.path}}` interpolation (~10 LOC). Project is no-build vanilla JS; Mustache/Handlebars is overkill.

## Coordination

- T2 doesn't depend on T1 (frontmatter parser); the resolver consumes raw `vars` objects, not parsed frontmatter directly. Sprint 48 inject scripts will glue T1 (parse PLANNING.md frontmatter) + T2 (resolve boot prompt for each lane).
- T2 doesn't depend on T3; T3's inject extension calls T2's resolver. Lane authors verify their template against the agent's actual TUI by manual paste-test before declaring DONE.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 44 boot prompt template Sprint 45 inject script lane brief boot sequence Mnestra MCP memory_recall AGENTS.md GEMINI.md per-agent")
3. memory_recall(query="recent decisions and bugs")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/scripts/inject-sprint46.js (today's hardcoded boot prompt — extract structure into the four templates)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md (per-agent instructional file convention)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
