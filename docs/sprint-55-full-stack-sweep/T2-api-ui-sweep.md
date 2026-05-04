# T2 — API + UI stack sweep (Claude worker)

You are T2 in Sprint 55. Lane focus: **adversarial sweep across every HTTP endpoint of the TermDeck server + every UI interaction of the dashboard.** This surface area was untested in Sprint 53 (which only hit install paths). Sprint 55 closes the gap.

## Boot the panel with: `claude --dangerously-skip-permissions`

Same permissive mode mandate as T1.

## Boot sequence

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 55 API UI stack sweep server endpoints dashboard panels")`
3. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback codename")`
4. `memory_recall(query="3+1+1 hardening rules checkpoint post shape")`
5. Read `~/.claude/CLAUDE.md`
6. Read `./CLAUDE.md`
7. Read `docs/sprint-55-multi-lane-stack sweep/PLANNING.md` — Lane T2 section
8. Read `docs/sprint-55-multi-lane-stack sweep/STATUS.md`
9. **Verify TermDeck server is running:** `curl -s http://127.0.0.1:3000/api/health 2>&1 | head -3`. If not running, attempt `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm start` in a /tmp scratch shell. If still not running, post a FINDING and SKIP UI cells.
10. Map the API surface: `find ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src -name "*.js" -exec grep -l "app\\.\\(get\\|post\\|patch\\|delete\\|put\\)" {} \\;` to enumerate handlers.

## Cells

**API cells (target ~15):** per PLANNING.md Lane T2 API section. Pattern per cell:

```
[Cell A.N — endpoint METHOD /api/path]
Request:    <curl command with body>
Expected:   <status code + body shape>
Observed:   <actual response>
Status:     PASS | FAIL | SKIP
Ledger:     <Class letter or existing class ref>
```

For each POST endpoint, also test malformed JSON: `curl -X POST … -d '{garbage'` — expect 400, not 500 / not crash.

**UI cells (target ~10):** per PLANNING.md Lane T2 UI section. UI cells require a browser. Use playwright via the MCP `mcp__playwright__*` tools (already loaded in this session — see schemas at boot).

If playwright access fails or times out, fall back to manual inspection commands:
- `curl -s http://127.0.0.1:3000/ | head -100` — verify HTML structure
- `curl -s http://127.0.0.1:3000/static/dashboard.js | head -10` — verify static assets
- Document which UI cells couldn't be exercised + why.

Output to `docs/sprint-55-multi-lane-stack sweep/T2-SWEEP-CELLS.md`.

## Lane discipline

- Post shape: `### [T2] …` in shared STATUS.md.
- CHECKPOINT every 30 min.
- READ-ONLY-ONLY (no commits, no destructive ops).
- Codename scrub.

## When you're done

Post `### [T2] DONE 2026-05-04 HH:MM ET — API+UI stack sweep PASS|YELLOW|RED` with full evidence.

Begin.
