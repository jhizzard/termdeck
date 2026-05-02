# Restart prompt — Sprint 51 orchestrator (paste into a fresh Claude Code session)

You are the orchestrator for TermDeck Sprint 51 — Cost-monitoring panel + UX polish quartet. **First post-v1.0.0 sprint.**

v1.0.0 shipped 2026-05-02 15:48 ET via the Sprint 50 release wave: `@jhizzard/termdeck@1.0.0` + `@jhizzard/termdeck-stack@0.6.0` + `@jhizzard/mnestra@0.4.0`. All trigger criteria met (per-agent MCP auto-wire + real mixed-agent dogfood + multi-agent memory plumbing + UX trust trio + worktree-isolated dogfood validation). Sprint 51 is post-v1.0.0 polish-and-feature territory.

## Boot sequence (do these in order, no skipping)

1. Run `date` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 51 cost monitoring panel costBand source_agent click stability launcher buttons Gemini timestamp drift Grok sub-agent observability")`
3. `memory_recall(query="recent decisions and bugs across projects")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules (time check, session-end email mandate, memory-first, 4+1 inject mandate two-stage submit, never-copy-paste-messages).
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router (no TS, vanilla JS, CommonJS, RELEASE.md before publishing).
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — strict publish protocol (Passkey, NEVER `--otp`, publish before push, stack-installer audit-trail bump).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51-cost-panel-and-polish/PLANNING.md` — Sprint 51 plan stub (lanes sketched, briefs not yet authored).
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/STATUS.md` — Sprint 50 close-out + the v1.0.0 release narrative (CHANGELOG entry).
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md` — current 11-field adapter contract (post-Sprint-50; Sprint 51 T3 adds `approvalModel` for the 12th).
10. Read the project memory `~/.claude/projects/.../memory/project_cost_monitoring_panel.md` — T1 lane's vision-level scoping.

## Then begin

### (a) Pre-sprint substrate probe

10 checks (Sprint 50's set + the post-v1.0.0 user-impact probe):

```bash
date '+%Y-%m-%d %H:%M ET'
npm view @jhizzard/termdeck version             # expect 1.0.0
npm view @jhizzard/termdeck-stack version       # expect 0.6.0
npm view @jhizzard/mnestra version              # expect 0.4.0
npm view @jhizzard/rumen version                # expect 0.4.4
curl -s http://127.0.0.1:3000/api/health        # TermDeck server alive?
curl -s http://127.0.0.1:3000/api/agents        # confirm Sprint 50 T3's /api/agents route still works
gh issue list --repo jhizzard/termdeck --limit 10  # check for v1.0.0 user-filed bugs
git -C /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck log --oneline -5
node -e "
const fs=require('fs');
const env={};for (const l of fs.readFileSync(require('os').homedir()+'/.termdeck/secrets.env','utf8').split('\n')) {const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m) env[m[1]]=m[2];}
fetch(env.SUPABASE_URL+'/rest/v1/memory_items?source_agent=not.is.null&select=source_agent', {headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,Prefer:'count=exact'}}).then(r=>r.headers.get('content-range')).then(console.log)
"  # confirm source_agent plumbing landing rows post-v1.0.0
head -50 ~/.codex/sessions/2026/*/*/rollout-*.jsonl 2>/dev/null | grep -i 'usage\|tokens' | head  # T1 token-count substrate
```

If any P0 user issue surfaces in step 7, **Sprint 51 pivots** — author a `docs/sprint-51.5-v1-hotfix/` and ship `@jhizzard/termdeck@1.0.1` first, THEN resume Sprint 51 cost-panel work as Sprint 52.

### (b) Author the four lane briefs

Sprint 51's lane briefs do NOT yet exist. Orchestrator authors `docs/sprint-51-cost-panel-and-polish/T{1,2,3,4}-*.md` based on the PLANNING.md sketch + substrate probe findings.

T1 is the biggest (~120 LOC server + ~150 LOC client + ~80 LOC tests + 4 adapter pricing fields) — author it first so the orchestrator-to-Joshua hand-off can confirm scope before injecting.

T4 (Grok sub-agent observability) is a stretch. If substrate probe shows Grok's `task` tool isn't actually emitting the documented patterns reliably, T4 swaps to a Sprint 46 deferral instead and orchestrator notes the swap.

### (c) Sprint 51 PLANNING.md frontmatter

```yaml
---
sprint: 51
lanes:
  - tag: T1
    agent: claude
    project: termdeck
  - tag: T2
    agent: claude
    project: termdeck
  - tag: T3
    agent: claude
    project: termdeck
  - tag: T4
    agent: claude
    project: termdeck
---
```

All-Claude per Sprint 50 close pattern (mixed-agent dogfood is now Sprint 50.5; subsequent dogfoods happen as their own self-contained sub-sprints, not as the main 4+1 lane assignment).

### (d) Inject + monitor

Same two-stage submit pattern as Sprint 50. `/tmp/inject-sprint51-prompts.js` extends `/tmp/inject-sprint50-prompts.js`. Verify all 4 show `status: 'thinking'` within 8s. If any stays `active`, fire `/api/sessions/:id/poke` with `methods: ['cr-flood']`.

### (e) Sprint close

If all 4 lanes DONE → bump `@jhizzard/termdeck` to `1.1.0` + bump `@jhizzard/termdeck-stack` to `0.6.1` (audit trail; OR `0.7.0` if T1's pricing-field plumbing requires the wizard to surface costBand info during install).

CHANGELOG entry follows the v1.0.0 narrative shape (less ceremonial since this is a polish/feature minor, but still substantive). Post-publish verification: query `select source_agent, count(*) from memory_items group by 1` → should show all 5 source agents (claude, codex, gemini, grok, orchestrator) with non-trivial counts post-Sprint-51 if T1's cost panel exercised the recall path.

## Pre-sprint context (carry-forward)

- v1.0.0 release wave 2026-05-02 15:48 ET. Wall-clock to v1.0.0: 7 sprints across multiple days (44 → 50). Today alone: 4 sprints + 1 hotfix + 1 manual rescue = ~110 min total wall-clock for v1.0.0.
- Sprint 49 surfaced Gemini-specific concerns: approval-heavy lifecycle, timestamp drift (stamps 21-44 min into the future), scope creep. T3 of Sprint 51 documents these in adapter metadata.
- Sprint 50 close: Joshua flagged the launcher click-stability bug. T2 fixes it.
- Sprint 51 may pivot to v1.0.1 hotfix if real users file P0s. Watch the issue tracker.

## Carry-forward TODO list

- [ ] T1/T2/T3/T4 lane briefs (orchestrator authors at kickoff)
- [ ] v1.0.0 user-bug intake (orchestrator probes the issue tracker)
- [ ] Decide v1.1.0 vs v1.0.1 at sprint close based on lane outcomes
- [ ] `docs/INSTALL-FOR-COLLABORATORS.md` refresh (Sprint 48 → 51 carry-over)
- [ ] Verify v1.0.0 ran clean on Joshua's daily-driver machine (`npm i -g @jhizzard/termdeck@latest && termdeck --version`) before Sprint 51 kickoff
