# Restart prompt — Sprint 49 orchestrator (paste into a fresh Claude Code session)

You are the orchestrator for TermDeck Sprint 49 — Real mixed-agent dogfood (v1.0.0 inflection gate) + `@jhizzard/termdeck-stack@0.5.1` hook hotfix publish + auto-wire-on-launch wiring.

Sprint 48 closed clean at 2026-05-02 13:18 ET shipping `@jhizzard/termdeck@0.17.0` + `@jhizzard/termdeck-stack@0.5.0`: per-agent MCP auto-wire (Codex/Gemini/Grok adapters via `mcp-autowire.js`'s 3-shape dispatch) + global `termdeck-stack start|stop|status` launcher + PTY env propagation. Wall-clock: 21 min.

Post-Sprint-48 polish committed at `dd5173c` (NOT yet published): hook moved from `hooks.Stop` → `hooks.SessionEnd` (was firing on every turn, not once per `/exit`) + `~/.termdeck/secrets.env` fallback in the bundled hook (was hitting env-var-missing on standalone Claude Code outside TermDeck). Tests 53/53 green. Sprint 49 T4 stamps the changelog and ships as `0.5.1`.

## Boot sequence (do these in order, no skipping)

1. Run `date` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 49 mixed-agent dogfood Codex Gemini Grok auto-wire-on-launch v1.0.0 inflection 0.5.1 hook hotfix SessionEnd")`
3. `memory_recall(query="recent decisions and bugs across projects")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules (time check, session-end email mandate, memory-first, 4+1 inject mandate two-stage submit, never-copy-paste-messages).
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router (no TS, vanilla JS, CommonJS, RELEASE.md before publishing).
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — strict publish protocol (Passkey, NEVER `--otp`, publish before push, stack-installer audit-trail bump).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/PLANNING.md` — Sprint 49 plan stub (lanes sketched, briefs not yet authored — orchestrator authors them at kickoff after substrate probe).
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md` — Sprint 48 close-out + the orchestrator design call on T3's `mcpConfig.merge` escape-hatch (relevant context for T4's auto-wire-on-launch).
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md` — 9-field adapter contract (post-Sprint-48; you don't extend it this sprint, but the auto-wire-on-launch lane consumes it).

## Then begin

### (a) Pre-sprint substrate probe

8 checks (Sprint 48's set + the 0.5.1 publish-readiness probe):

```bash
date '+%Y-%m-%d %H:%M ET'
npm view @jhizzard/termdeck version             # expect 0.17.0
npm view @jhizzard/termdeck-stack version       # expect 0.5.0 (T4 bumps to 0.5.1)
npm view @jhizzard/mnestra version              # expect 0.3.4
curl -s http://127.0.0.1:3000/api/health        # TermDeck server alive?
ls ~/.codex/config.toml ~/.gemini/settings.json ~/.grok/user-settings.json
node -e "const a=require('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters'); for (const [k,v] of Object.entries(a.AGENT_ADAPTERS)) console.log(k, v.mcpConfig === null ? 'NULL (user-managed)' : v.mcpConfig ? 'declared' : 'absent')"
git -C /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck log --oneline -5
node -e "
const fs=require('fs');
const env={};for (const l of fs.readFileSync(require('os').homedir()+'/.termdeck/secrets.env','utf8').split('\n')) {const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m) env[m[1]]=m[2];}
fetch(env.SUPABASE_URL+'/rest/v1/memory_items?source_type=eq.session_summary&select=id', {headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,Prefer:'count=exact'}}).then(r=>r.headers.get('content-range')).then(console.log)
"  # baseline session_summary count (was 4 at Sprint 48 close)
```

### (b) Author the four lane briefs

Sprint 49's lane briefs do NOT yet exist. Orchestrator authors `docs/sprint-49-mixed-agent-dogfood/T{1,2,3,4}-*.md` based on the PLANNING.md sketch + substrate probe findings + which Sprint 46 deferrals to assign each non-Claude lane.

T1 (Codex), T2 (Gemini), T3 (Grok), T4 (Claude — auto-wire-on-launch + 0.5.1 publish). PLANNING.md has the deferral candidate menu by category. Pick proven-shape ones — this is the v1.0.0 sprint, do not gamble on ambitious lanes.

### (c) Author the Sprint 49 PLANNING.md frontmatter

```yaml
---
sprint: 49
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
```

This is the FIRST sprint where lanes 1-3 declare non-Claude agents in frontmatter and the inject script consumes Sprint 47's frontmatter parser + boot-prompt resolver to build per-agent prompts.

### (d) Inject + monitor

Same two-stage submit pattern as Sprint 48. `/tmp/inject-sprint49-prompts.js` consumes the per-lane briefs + per-lane agent assignments. POST stage-1 paste payloads to T1-T4 with 250ms gaps (each agent's `acceptsPaste` field tells you whether bracketed-paste applies — Claude/Codex yes, Gemini/Grok verify), settle 400ms, POST stage-2 `\r` to all four. Verify all 4 show `status: 'thinking'` within 8s. If any stays `active` (idle), fire `/api/sessions/:id/poke` with `methods: ['cr-flood']`.

### (e) Sprint close

If all 4 lanes DONE + at least one non-Claude lane shipped meaningful real work → bump `@jhizzard/termdeck` to `1.0.0` (the v1.0.0 inflection trigger from Sprint 48 PLANNING.md is satisfied) + bump `@jhizzard/termdeck-stack` to `0.5.1` (audit-trail per RELEASE.md + stamps the hook hotfix). Otherwise `0.18.0` + `0.5.1`.

CHANGELOG entry follows the dense Sprint 48 shape. Post-publish verification: query `session_summary` count via the substrate-probe script — expect ≥ 8 (baseline 4 + lane closes 4 = 8 if all four lanes ran through the now-correct SessionEnd hook with secrets.env loaded).

## Pre-sprint context

- Sprint 47.5 hotfix shipped 2026-05-02 12:30 ET: `termdeck@0.16.1` + `termdeck-stack@0.4.12` + `mnestra@0.3.4`. Three layered fixes: stack-installer placeholder env, doctor.js Rumen column drift (Brad's report), mnestra MCP stdio secrets fallback.
- Sprint 48 closed 2026-05-02 13:18 ET shipping per-agent MCP auto-wire + global launcher.
- Post-Sprint-48 polish at `dd5173c`: hook → SessionEnd + secrets.env fallback. NOT YET PUBLISHED — Sprint 49 T4 ships as `0.5.1`.
- Brad messaged on WhatsApp 2026-05-02 ~13:35 ET to update to `@jhizzard/termdeck@latest` for the doctor.js fix.

## Carry-forward TODO list

- [ ] T1/T2/T3 lane briefs (orchestrator authors at kickoff)
- [ ] T4 brief authoring (auto-wire-on-launch + 0.5.1 publish)
- [ ] Verify mixed-agent merger normalizes Codex/Gemini/Grok STATUS posts under real load
- [ ] Run substrate probe + baseline session_summary count
- [ ] Decide v1.0.0 vs v0.18.0 at close
