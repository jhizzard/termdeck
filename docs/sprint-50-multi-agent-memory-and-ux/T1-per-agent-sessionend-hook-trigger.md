# Sprint 50 — T1 (Claude): Per-agent SessionEnd hook trigger + Grok SQLite extraction

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes; full design in [docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md](../MULTI-AGENT-MEMORY-ARCHITECTURE.md) § Deliverable 1):**

NEW server-side `onPanelClose(session)` in `packages/server/src/index.js` that fires the bundled hook with the correct adapter-specific payload when a non-Claude panel closes. EXTEND the agent-adapter contract with `resolveTranscriptPath(session)` (10th field). Codex / Gemini / Grok adapters implement their transcript-path resolution. Grok needs SQLite extraction from `~/.grok/grok.db` (Sprint 45 carry-over).

## Critical pre-lane substrate probe

**Before writing code: verify Codex transcript actually exists in a chat-shape JSONL.** Sprint 49 close-out (2026-05-02 14:58 ET) discovered `~/.codex/history.jsonl` is a flat command-history shape, NOT chat. Manual hook fire returned `session-too-short: 0 messages (parser=codex)` against a real Codex sprint-lane session.

```bash
find ~/.codex -name '*.jsonl' -o -name '*.json' 2>/dev/null
```

Possibilities to investigate:
1. `~/.codex/sessions/<uuid>.jsonl` exists (chat transcripts go here, history.jsonl is just command CLI history) — adapter points there.
2. Codex's chat transcript is in `logs_2.sqlite` (the 19MB SQLite seen in Sprint 49 ls) — adapter extracts via SQL.
3. Codex doesn't persist chat transcripts at all today — adapter returns null, lane documents the gap.

Run the probe FIRST. Document findings in your FINDING post. Adjust `resolveTranscriptPath` for Codex accordingly.

## Files

- EDIT `packages/server/src/index.js` — NEW exports `onPanelClose(session)` + `readTermdeckSecretsForPty()` (latter already exists post-Sprint-48). Wire `onPanelClose` into the existing PTY-exit handler.
- EDIT `packages/server/src/agent-adapters/{claude,codex,gemini,grok}.js` — add `resolveTranscriptPath(session)` field returning `string | null`.
- EDIT `docs/AGENT-RUNTIMES.md` § 5 — adapter contract bumped 9 → 10 fields.
- NEW `tests/per-agent-hook-trigger.test.js` (~120 LOC, ~8 tests).
- IF Grok SQLite extraction in scope: EDIT `packages/stack-installer/assets/hooks/memory-session-end.js` to add a Grok parser. Use a dynamic `require()` of `better-sqlite3` so the dep is optional — gracefully no-op if not installed.

## API contract

```js
// onPanelClose: server-side panel-exit handler.
// Fail-soft: any error logs and exits cleanly. Never blocks panel teardown.
async function onPanelClose(session) {
  const adapter = AGENT_ADAPTERS[session.meta.type] || AGENT_ADAPTERS['claude-code'];
  // Don't double-fire for Claude (its own hook already runs).
  if (adapter.sessionType === 'claude-code') return;
  const transcriptPath = await adapter.resolveTranscriptPath(session);
  if (!transcriptPath) return;
  const hookPath = path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js');
  if (!fs.existsSync(hookPath)) return;
  const payload = {
    transcript_path: transcriptPath,
    cwd: session.meta.cwd,
    session_id: session.id,
    sessionType: adapter.sessionType,
    source_agent: adapter.name,  // T2 consumes this
  };
  const child = spawn('node', [hookPath], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  child.unref();  // detach
}
```

Adapter contract addition:

```js
{
  // ... existing 9 fields ...
  resolveTranscriptPath: async (session) => string | null,
}
```

## Acceptance criteria

1. Closing a Codex panel writes one `session_summary` row with `source_agent='codex'` (assumes T2's column lands first OR T2 lands in parallel; T1 just passes the field).
2. Same for Gemini, Grok.
3. Claude's existing hook still fires; no double-write per session (verified by `select count(*) ... where session_id = $X` returns 1).
4. Empty / missing transcript → no-op cleanly (no row, no error, no panel-close blocked).
5. Server doesn't block panel close on hook script's exit (fire-and-forget).
6. **All 4 lanes' Sprint 50 close-out panels** write rows correctly (T4 dogfood validates this end-to-end).
7. Grok SQLite extraction: a real Grok panel close writes a row with summary text from the actual conversation (not just system messages).

## Coordination

- **T1 produces `source_agent` in the hook payload; T2 consumes it via the new column.** If T2 hasn't merged yet, hook script silently writes to a column-not-yet-existing — Supabase will reject. Coordinate with T2 (likely T1 ships first since the column needs to exist before any insert; OR T2 ships migration first then T1 ships hook population).
- T3 + T4 are independent of T1.
- **Don't break the existing single-Claude-hook flow.** Today the bundled hook works for Claude Code via `~/.claude/settings.json` SessionEnd registration. T1 layers ADDITIONAL firing for non-Claude panels via the server-side `onPanelClose`. Claude's existing path stays untouched.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 50 per-agent SessionEnd hook trigger onPanelClose resolveTranscriptPath Codex Gemini Grok SQLite multi-agent memory")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md (your design source-of-truth)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-50-multi-agent-memory-and-ux/STATUS.md
9. Read this brief
10. **Run substrate probe FIRST**: find ~/.codex -name '*.jsonl' -o -name '*.json'; ls ~/.gemini/tmp/; sqlite3 ~/.grok/grok.db ".tables" 2>/dev/null
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/index.js (registry shape)
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (the hook you fire)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
