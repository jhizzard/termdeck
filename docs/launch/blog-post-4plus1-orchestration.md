# I watched my memory system debug its own rename at 2am

![Flashback meta moment](../screenshots/flashback-meta-moment.png)

It was about 2am on April 15, 2026. I was mid-sprint, mid-rename — the second rename in thirty minutes, actually — when one of the four Claude Code panels I had running inside TermDeck tripped into an error state. A toast faded in at the corner of the panel. The header read:

> **FLASHBACK — ENGRAM · POSSIBLE MATCH**

The header was wrong. I had stopped calling the memory package Engram about forty minutes earlier, after the npm search came back red. The client hadn't caught up yet. But the body of the toast was correct, and it was surfacing a memory I had written to Supabase earlier in the same session:

> TermDeck Sprint 3 T4 DOUBLE name dispute (2026-04-14 through 2026-04-15): Both "Engram" and "Mnemos" came back 🔴 RED. Engram has 138 npm packages, Gentleman-Programming/engram at 2.5k stars. Mnemos has TWO literal name collisions with MCP memory servers...

One of my four parallel terminals had written that memory a few hours earlier during name-dispute research. Another one had errored out. The output analyzer flagged the error. The proactive-recall feature queried Supabase. Supabase returned T4's own research note. The tool I was building surfaced a memory about the crisis I was currently executing, from the production store it syncs to, in the session we were building the feature in.

I took the screenshot and went to bed at 3:30am. This post is about what was running on the machine when that happened.

## The 4+1 pattern

"Orchestration" in the LLM world usually means one agent spawning subagents, or a planner-executor loop, or a dependency graph of tool calls managed by a framework. That is not what I mean here.

I mean this: four Claude Code terminals running inside TermDeck, each with an exclusive file-ownership scope, coordinating only through an append-only `docs/STATUS.md` file — plus one main Claude Code instance running outside TermDeck, in a separate host terminal, which I call the orchestrator. Four workers, one orchestrator. 4+1.

The four workers are scoped by path. T1 owns `packages/client/public/`. T2 owns `packages/server/src/` and `packages/cli/src/`. T3 owns `docs-site/` and related Vercel wiring. T4 owns `docs/launch/` and research notes. No two of them can touch the same file. If T3 needs something T2 owns, T3 posts `T3 → T2: need <thing>` in `STATUS.md` and waits. The glyph protocol is `⏳ ✅ ❌ 🔒 🔓 ❓ 🛑`. The rules are on a single page in `docs/demo/parallelize-template.md`.

The orchestrator — me, plus one Claude Code session outside the multiplexer — does everything the workers cannot. Irreversible steps: git tags, npm publishes, repo renames on GitHub. Cross-terminal decisions: when two workers post conflicting assumptions, the orchestrator resolves it and writes the resolution back into `STATUS.md`. Tie-breaking. Running migrations when a worker posts a `🛑` blocker.

The split between the four workers and the one orchestrator is not aesthetic. It exists because irreversible operations are exactly the ones you do not want four agents racing on. Parallelism is for the disjoint stuff. Serialization is for the things you cannot undo.

## The sprint

Sprint 3 was supposed to ship the Flashback launch assets. The four-terminal split:

- **T1** — live ops on my actual machine: verify Engram/Mnestra Tier 2 end-to-end, deploy Rumen as a Supabase Edge Function, capture the launch GIF.
- **T2** — `termdeck init --engram` and `termdeck init --rumen` setup wizards in the server and CLI packages.
- **T3** — deploy the Astro Starlight docs site to Vercel at https://termdeck-docs.vercel.app and wire the in-app help button to it.
- **T4** — launch copy, name-dispute research, project cards on joshuaizzard.com.

I launched the four TermDeck panels in 2x2 layout, pasted the starting prompts, and went to work on the orchestrator side. The orchestrator queue for this sprint turned out to be heavier than expected, because the name kept collapsing under me.

The first name was Engram. T4 posted the name-dispute research about ninety minutes into the sprint: 138 packages on npm, a 2.5k-star GitHub repo using the name, several adjacent memory-tooling products. Red. I pivoted the orchestrator to Mnemos, ran a four-repo mechanical rename pass with a Python one-shot that touched 71 files in a single commit, published `@jhizzard/mnemos` 0.2.1, deprecated `@jhizzard/engram`, and updated the git tags.

Twenty minutes later T4 posted again: Mnemos had two literal name collisions with existing MCP memory servers. Red. I pivoted to Ingram. Another four-repo rename pass. Another publish. Another deprecation. Then I ran the name check on Ingram and found an existing package in the same space. Red. Fourth attempt: Mnestra. Both `@jhizzard/mnestra` and unscoped `mnestra` returned E404 on npm. Clean. I ran the rename pass a third time and published again.

Final count for the ~2-hour window: four renames across four repos, three npm publishes, three deprecations, three sets of git tags. 71+ files touched in a single Python one-shot on the largest of the three rename passes. The four workers kept shipping their own scoped tasks the entire time, because their file-ownership scopes did not overlap with the renames the orchestrator was pushing through.

## The recursive bit

That is the setup for the screenshot at the top of this post. Somewhere in the middle of the Mnemos → Mnestra pivot, one of the worker panels hit an error. The output analyzer flagged it. Flashback queried Supabase. Supabase returned T4's own research note about Engram and Mnemos both being red.

The toast header still said `ENGRAM — POSSIBLE MATCH` because the client-side rename constant hadn't propagated yet. The body of the toast was correct. The tool used itself to document its own naming crisis in real time, using memories written by one of its own worker terminals, surfaced by a feature it was shipping in the same session.

I am trying to be honest about how weird this was. Flashback is a pattern-matched error hook with a pgvector query behind it — there is no intelligence in the surfacing decision, just cosine similarity and recency decay. It is a very simple feature. But the loop closed: memory layer, proactive recall, error analyzer, the product being built, the product in use, the crisis being logged, the crisis being surfaced. All of them pointed at the same object, which happened to be the rename I was executing at 2am.

## Why this pattern matters

I don't think the 4+1 split is clever. It is the obvious shape of parallel work once you accept two constraints: agents can't read each other's minds, and disjoint file scopes are the only coordination surface that doesn't require either a merge strategy or a lock server.

What I do think is that this pattern — or something close to it — will be the default for anyone building seriously with Claude Code in 2026. Multi-agent workflows keep failing on coordination overhead. The 4+1 pattern eliminates almost all of it by pushing the coordination into the planning document upfront and the file-ownership exclusivity at runtime. Review happens at the end, once, by a human reading scoped diffs.

The other thing worth saying out loud: the tool using itself is not a gimmick. It is the test. A memory system that cannot surface its own development crisis is probably not going to surface yours either. Mine did, even when the client was still calling itself the wrong name.

Install:

```
npx @jhizzard/termdeck
```

GitHub: https://github.com/jhizzard/termdeck
