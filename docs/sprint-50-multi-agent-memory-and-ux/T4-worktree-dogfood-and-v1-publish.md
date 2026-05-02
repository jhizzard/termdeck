# Sprint 50 — T4 (Claude): Worktree-isolated dogfood close-out + v1.0.0 publish

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § T4):**

Two related deliverables that close the v1.0.0 cycle:

1. **Worktree-isolated mixed-agent dogfood close-out.** Run a small, easily-reversible Sprint 46 deferral as a 4-lane mixed-agent sub-sprint (T1=codex, T2=gemini, T3=grok, T4=claude or orchestrator). Use `--isolation=worktree` per lane (Sprint 47 introduced this) so a botched lane is `git worktree remove` away from clean. **This is the validation step** — it confirms T1's per-agent hook trigger writes 4 rows, T2's `source_agent` column populates correctly across all 4 agents, and T3's launcher buttons + panel labels + spinner all work for outside-user-equivalent flows.

2. **v1.0.0 publish.** If 1 lands cleanly, orchestrator publishes `@jhizzard/termdeck@1.0.0` + companion `@jhizzard/termdeck-stack@0.6.0` (minor — adapter-driven launcher buttons are new user-visible) + `@jhizzard/mnestra@0.4.0` (already shipped by T2). If anything breaks during the dogfood, roll forward to v0.19.0 instead and queue v1.0.0 for Sprint 51.

## Files

### Worktree dogfood (Deliverable 1)

- NEW `docs/sprint-50.5-dogfood/PLANNING.md` — tight ~50-line plan for the sub-sprint with frontmatter declaring T1=codex, T2=gemini, T3=grok, T4=claude. Pick 4 small Sprint 46 deferrals (e.g., URL state codec edge case, perf at 2000+ nodes commentary-only, source-session links removal note, server metadata gap commentary). Worktree paths under `.worktrees/sprint-50.5-T{1..4}/`.
- NEW `docs/sprint-50.5-dogfood/STATUS.md` — append-only.
- Per-lane briefs (T1-T4) in same directory — small (~30 LOC each).
- Inject script `/tmp/inject-sprint-50.5-dogfood.js` — adapts `/tmp/inject-sprint49-prompts.js` to point at the new sprint dir + the worktree paths.

### v1.0.0 publish prep (Deliverable 2)

- EDIT root `package.json` version `0.18.0` → `1.0.0` (only after dogfood succeeds).
- EDIT root `CHANGELOG.md` `## [1.0.0] - 2026-05-02` block. **This is the v1.0.0 entry** — make it stand-alone, well-written, the kind of thing you'd link to from a blog post. Cover: per-agent MCP auto-wire (Sprint 48), real mixed-agent dogfood (Sprint 49), multi-agent memory plumbing + UX trust + worktree dogfood (Sprint 50). Lead with what changes for users; close with credits and forward-look (Sprint 51 cost panel + Grok 16-sub-agent observability).
- EDIT `packages/stack-installer/package.json` version `0.5.1` → `0.6.0`.
- EDIT root `CHANGELOG.md` `## [0.6.0] - 2026-05-02` block (separate from v1.0.0 — they ship same release wave but have separate scopes).

## Acceptance criteria for the dogfood

1. **All 4 sub-sprint lanes DONE** in worktrees. No conflicts at merge time (worktrees give us this for free).
2. **4 new `session_summary` rows** in `memory_items`, one per lane, with correct `source_agent` values: claude / codex / gemini / grok.
3. **Spinner stays alive** during the dogfood (T3's fix validated under real load).
4. **Panel labels show correct agent names** (T3's fix validated).
5. **Launcher buttons used** to open the 4 panels — orchestrator pre-step is "Joshua opens 4 panels via the new launcher buttons (not via shell + manual binary)."

## Acceptance criteria for v1.0.0 publish

1. `npm view @jhizzard/termdeck version` returns `1.0.0`.
2. `npm view @jhizzard/termdeck-stack version` returns `0.6.0`.
3. `npm view @jhizzard/mnestra version` returns `0.4.0`.
4. CHANGELOG entry is well-written, blog-quality, narrative-arc-from-Sprint-44-to-Sprint-50.
5. Joshua approves the CHANGELOG before publish (orchestrator pauses for a Joshua review beat).
6. After publish, `npm i -g @jhizzard/termdeck@latest && termdeck --version` returns `1.0.0`. Dogfood verification on Joshua's daily-driver machine.

## Coordination

- T4 starts AFTER T1 + T2 + T3 close DONE. The dogfood validates all three so T4 needs them in place.
- If T1 + T2 + T3 close fast, T4 has substantial budget for a quality v1.0.0 CHANGELOG. Treat the v1.0.0 entry as a polished narrative, not a bullet list — this is the entry that lives forever.
- If any of T1/T2/T3 fails, T4 still ships the dogfood (smaller scope) but DOWNGRADES the version bump to 0.19.0 and rolls v1.0.0 to Sprint 51.
- Worktree creation: `git worktree add .worktrees/sprint-50.5-T1 main` per lane. `.gitignore` `.worktrees/` (probably already done).

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 50 worktree dogfood v1.0.0 publish CHANGELOG narrative arc Sprint 44-50 mixed-agent close-out")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (publish protocol)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/STATUS.md
9. Read this brief
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CHANGELOG.md (recent entries to model the v1.0.0 entry style + arc)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/STATUS.md (Sprint 49 close-out — model the Sprint 50.5 STATUS shape)
12. Watch T1+T2+T3 STATUS posts; start your dogfood prep when they hit DONE
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. **DO bump termdeck root version 0.18.0 → 1.0.0** AND **DO author the v1.0.0 CHANGELOG entry** AND **DO bump termdeck-stack 0.5.1 → 0.6.0**. Don't actually publish — orchestrator handles via Joshua's Passkey. Don't commit either — orchestrator handles all close-out.
