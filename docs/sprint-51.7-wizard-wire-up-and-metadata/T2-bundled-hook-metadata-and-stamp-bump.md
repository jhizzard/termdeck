# T2 — Bundled hook metadata completeness + version stamp bump

You are T2 in Sprint 51.7 (wizard-wire-up-and-metadata, v1.0.3 mini).

## Boot sequence (do these in order, no skipping)

1. `memory_recall(project="termdeck", query="Sprint 51.6 v1.0.2 bundled hook memory_sessions postMemorySession started_at duration_minutes facts_extracted")`
2. `memory_recall(query="rag-system writer process-session.ts transcript JSONL parser metadata fields")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/PLANNING.md`
6. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md`
7. Read this brief end-to-end.
8. Read `packages/stack-installer/assets/hooks/memory-session-end.js` end-to-end (740 LOC; this is the file you're modifying).
9. Read `docs/INSTALLER-PITFALLS.md` ledger entry #15 (line 159), especially the v1.0.3 follow-up note at line 173 about the metadata-completeness gap.

## Pre-sprint intel

Sprint 51.6's v1 bundled hook intentionally shipped the "minimum viable row" for `memory_sessions` — it writes `session_id`, `project`, `ended_at`, `messages_count`, `summary_len`, `path_len`, but leaves `started_at = NULL`, `duration_minutes = NULL`, `facts_extracted = 0`. Codex's Phase B post (sprint-51.6 STATUS.md line 1024) called this out: "Metadata caveat: started_at and duration_minutes are NULL because the v1 hook intentionally omits those fields. The installed hook source says v1.0.2 ships the minimum viable row and leaves per-message timestamp parsing for a future sprint."

That future sprint is now. The legacy rag-system writer (`~/Documents/Graciella/rag-system/src/scripts/process-session.ts`, the spawner Joshua's pre-2026-05-02 hook delegated to) populated all three fields by parsing the transcript JSONL passed on stdin. We need the bundled hook to do the same in pure Node (no rag-system dependency — Class E hidden-dependency rule).

The transcript JSONL shape Claude Code passes to the hook (verified via existing hook logic):
- One JSON object per line, each line is a message record
- Each message has at minimum a `timestamp` (ISO 8601 UTC) and a `role` (`user` / `assistant` / `tool_use` / `tool_result` / etc.)
- `tool_use` records carry a `name` field (e.g., `memory_remember`, `memory_recall`, `Read`, `Bash`)
- Some messages carry `content` arrays with text + tool blocks

You also need to bump the bundled hook's version stamp from `v1` to `v2`. The marker is at line 54 (and a reference at line 46). The version stamp drives `refreshBundledHookIfNewer()`'s `installed >= bundled` short-circuit at `init-mnestra.js:550` — bumping to v2 guarantees that a user with a v1 installed hook hits the refresh branch on next `init --mnestra`. T1 is independently bisecting why the wire-up no-ops, but the stamp bump is load-bearing insurance regardless of T1's root cause.

## Lane scope

1. **Add transcript-parsing helpers to the bundled hook.** Inside `packages/stack-installer/assets/hooks/memory-session-end.js`, alongside the existing helpers, add:

   ```js
   function parseTranscriptMetadata(transcriptJsonl) {
     const lines = (transcriptJsonl || '').split('\n').filter(Boolean);
     let earliestTs = null;
     let latestTs = null;
     let factsExtracted = 0;
     for (const line of lines) {
       let msg;
       try { msg = JSON.parse(line); } catch (_) { continue; }
       const ts = msg.timestamp || (msg.message && msg.message.timestamp);
       if (ts) {
         const t = Date.parse(ts);
         if (!Number.isNaN(t)) {
           if (earliestTs === null || t < earliestTs) earliestTs = t;
           if (latestTs === null || t > latestTs) latestTs = t;
         }
       }
       // Conservative facts_extracted heuristic: count distinct memory_remember tool_use blocks.
       // Avoid string-match on "Remember:" — that over-counts quoted text.
       const blocks = (msg.message && Array.isArray(msg.message.content)) ? msg.message.content : [];
       for (const b of blocks) {
         if (b && b.type === 'tool_use' && (b.name === 'memory_remember' || b.name === 'mcp__mnestra__memory_remember')) {
           factsExtracted += 1;
         }
       }
     }
     const startedAt = earliestTs ? new Date(earliestTs).toISOString() : null;
     const endedAt = latestTs ? new Date(latestTs).toISOString() : null;
     const durationMinutes = (earliestTs && latestTs) ? Math.max(0, Math.round((latestTs - earliestTs) / 60000)) : null;
     return { startedAt, endedAt, durationMinutes, factsExtracted };
   }
   ```

   (Sketch — adapt to the existing module style. Match the existing JSDoc / comment density.)

2. **Wire the helper into `postMemorySession()`.** The existing function constructs the payload with hardcoded NULLs/0s — replace with the parsed values. Keep `ended_at` derivation that's already there as a fallback when transcript parsing yields no timestamps.

3. **Bump the bundled hook version stamp.** At `packages/stack-installer/assets/hooks/memory-session-end.js:54`, change `v1` → `v2`. Update the corresponding comment at line 46 if it references `v1` literally. Grep the entire repo for `stack-installer-hook v1` and update test fixtures + docs that hardcode the version (likely `tests/project-taxonomy.test.js`, `tests/init-mnestra-hook-refresh.test.js`, and anything in `packages/stack-installer/tests/`).

4. **Add unit tests** at `packages/stack-installer/tests/hook-metadata-parser.test.js`:
   - Empty transcript → `{startedAt: null, endedAt: null, durationMinutes: null, factsExtracted: 0}`.
   - Single message → `startedAt === endedAt`, `durationMinutes === 0`.
   - Multi-message 30-min span → `durationMinutes === 30`.
   - Malformed line in middle of valid lines → skip the malformed, count the rest.
   - Three `memory_remember` tool_use blocks → `factsExtracted === 3`.
   - One `memory_remember` block + one `Bash` block → `factsExtracted === 1`.
   - Use a small fixture file at `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` (you can pull a real one from `~/.claude/projects/` and trim to 5–10 lines, scrubbing any sensitive content).

5. **Run the targeted test set** to confirm no regressions:
   ```bash
   node --test packages/stack-installer/tests/hook-metadata-parser.test.js
   node --test packages/stack-installer/tests/stack-installer-hook-merge.test.js
   node --test packages/cli/tests/init-mnestra-hook-refresh.test.js
   node --test tests/project-taxonomy.test.js
   ```

6. **Document the metadata semantics inline** — a short comment block above `parseTranscriptMetadata()` explaining why the conservative `memory_remember`-count heuristic is preferred over a `Remember:` string match (avoids quoted-text false positives).

## Lane discipline

- No version bumps in `package.json` files (T3 owns those).
- No CHANGELOG edits.
- No git commits.
- All findings → `STATUS.md` as `[T2] FINDING` / `[T2] FIX-PROPOSED` / `[T2] FIX-LANDED` posts.
- Stay in lane: do NOT touch `packages/cli/src/init-mnestra.js` (that's T1). Do NOT touch `package.json` versions, CHANGELOG, or commit.
- If your stamp bump breaks tests T1 is also touching, post a `[T2] CROSS-LANE` note in STATUS.md and coordinate via T4-CODEX adjudication.

## When you're done

Post `[T2] DONE` to STATUS.md with: parser implementation summary (1 paragraph), files changed (file:line bullets), version stamp bump confirmation (`grep -n stack-installer-hook` output before/after), test counts (pass/fail before vs after), fixture path, and a short fixture-redaction note ("scrubbed user-content; only structure preserved").

Begin.
