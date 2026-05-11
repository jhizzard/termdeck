# Sprint 63 Wave 2 — /exit Capture Verification (T2)

**Lane:** T2 — Empirical /exit capture proof (PRIORITY)
**Date:** 2026-05-11 (US Eastern)
**Scope:** close Investigation 1 of `docs/CRITICAL-READ-FIRST-2026-05-07.md` on **acceptance grounds** — real adapter panels, real `/exit` events, real Mnestra rows in both schemas.
**Final status:** **2 of 4 adapters PASS end-to-end** (claude + codex retry). **Finding #2 (gemini extension filter) shipped inline this sprint** per ORCH SCOPE 13:51 ET. **Findings #1 + #3 carved to Sprint 64** as documented below.

> Sprint 62 closed Investigation 1 on code/test grounds (the Sprint 50 wire-up at `packages/server/src/index.js:192-241` + Sprint 62 fence tests in `packages/server/tests/adapter-session-end-writer.test.js` proved the close-path executes the bundled hook for non-Claude adapters). This document closes it on **acceptance grounds**. The wire-up is necessary but not sufficient — three downstream surfaces silently swallow content even when the wire-up fires; one is fixed inline this sprint, two are tractable Sprint 64 work.

---

## 1. Method (verbatim)

For each of `claude-code | codex | gemini | grok`:

1. `POST /api/sessions { command, type, cwd, project, label, reason }` — spawns the inner CLI in a PTY managed by TermDeck server (`spawnTerminalSession` at `packages/server/src/index.js:1118` wraps the command as `zsh -c <command>`).
2. Wait 15 s (first run) / 20 s (codex retry) for the CLI to boot.
3. Inject 3 substantive prompts via the two-stage paste+submit pattern (`\x1b[200~<text>\x1b[201~` → 400 ms settle → `\r`). Each prompt **embeds the per-adapter canary phrase**, so the canary appears in the user-message portion of the transcript even if the agent does not echo it.
4. Poll `/api/sessions/:id/buffer` for response. First run: 1.5 s interval status poll, 90 s timeout. Codex retry: fixed 60 s wait then liveness check.
5. After 3 prompts/responses: inject `/exit\r` for graceful CLI shutdown. Poll up to 20 s for `status === 'exited'`.
6. `DELETE /api/sessions/:id` as cleanup (SIGHUPs PTY if `/exit` was ignored; harmless 404 if already gone).
7. Wait 18 s (first run) / 25 s (codex retry) for `term.onExit → onPanelClose → spawn(hook) → Supabase POST` chain to land.

Then via psql (`DATABASE_URL` from `~/.termdeck/secrets.env`, query-string params stripped because Supabase pooler URL includes `?pgbouncer=true` which libpq rejects), probe the dual schema.

### Source-of-truth file:line references

- `packages/server/src/index.js:210-241` — `onPanelClose(session)` definition. Skips claude-code (`:216`); resolves transcript path (`:219`); spawns bundled hook (`:234`); passes `source_agent` from adapter (`:231`).
- `packages/server/src/index.js:1158-1192` — `term.onExit(({exitCode, signal}) => { ... onPanelClose(session) ... })`. The `onPanelClose` call is at `:1181`.
- `packages/server/src/index.js:1372-1383` — `DELETE /api/sessions/:id` route. Calls `session.pty.kill()` (`:1378`) which raises SIGHUP, which triggers `term.onExit`.
- `packages/server/src/agent-adapters/{claude,codex,gemini,grok}.js` — each adapter exposes `resolveTranscriptPath` (10th adapter field, Sprint 50 T1).
- `packages/stack-installer/assets/hooks/memory-session-end.js:644` — writes one row to `memory_items` with `source_type='session_summary'` and `source_agent` normalized via the `ALLOWED_SOURCE_AGENTS` whitelist (`:631-633`).
- `packages/stack-installer/assets/hooks/memory-session-end.js:718` — writes one companion row to `memory_sessions` with `on_conflict=session_id` (Sprint 51.6 T3). Payload at `:726-743` does NOT include `source_agent` — that column does not exist on `memory_sessions`.
- `packages/stack-installer/assets/hooks/memory-session-end.js:576` — **silent-skip surface**: `if (messages.length < 5) skip`.
- `packages/stack-installer/assets/hooks/memory-session-end.js:140,795` — silent-skip surface: `MIN_TRANSCRIPT_BYTES = 5000` and `if (stat.size < MIN_TRANSCRIPT_BYTES) skip`.

---

## 2. Canary phrases

| Adapter        | Canary phrase                                              |
|:---------------|:-----------------------------------------------------------|
| claude-code    | `sprint-63-acceptance-canary-claude-2026-05-11-e1ad`       |
| codex          | `sprint-63-acceptance-canary-codex-2026-05-11-9b60`        |
| gemini         | `sprint-63-acceptance-canary-gemini-2026-05-11-156e`       |
| grok           | `sprint-63-acceptance-canary-grok-2026-05-11-15b5`         |

Published to STATUS.md at 13:20 ET for T4-CODEX independent verification.

---

## 3. psql probe results (dual-schema, scrubbed)

Output is **scrubbed** of the reference Mnestra project ID and internal project name per the global hygiene rule (`<ref-redacted>` and `<project-redacted>`).

### Schema A — `memory_items` (canary AND source_type='session_summary')

```
source_agent|source_type|project|bytes|source_session_id|created_at_utc|content_head
codex|session_summary|termdeck|2422|6c833582-4e8c-4a5d-98c7-e3370727470e|2026-05-11 18:01:03 UTC|Session with 7 messages. [user] # AGENTS.md instructions for /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck …
claude|session_summary|termdeck|2532|329e3ef5-f5d2-4bb4-a096-7a8c45858143|2026-05-11 17:25:34 UTC|Session with 9 messages. [user] Please echo this exact phrase verbatim on its own line: sprint-63-acceptance-canary-claude-2026-05-11-e1ad …
(2 rows)
```

**Per-source_agent canary-matched row count:**

```
source_agent|rows
claude|1
codex|1
(2 rows)
```

**Codex canary position in content** (codex's prompt 1 was preceded by codex's own AGENTS.md preamble, so the canary appears at offset 498):

```
canary_window
…echo this exact phrase verbatim on its own line: sprint-63-acceptance-canary-codex-2026-05-11-9b60
Then write one paragraph (~150 words) about how PostgreSQL MVCC works. This is an automated acceptance test for the TermDeck /exit hook…
(1 row)
```

### Schema B — `memory_sessions` (canary in summary)

```
session_id|project|bytes|messages_count|duration_minutes|started_at_utc|ended_at_utc|created_at_utc|summary_head
6c833582-4e8c-4a5d-98c7-e3370727470e|termdeck|2422|7|2|2026-05-11 17:57:56 UTC|2026-05-11 18:00:08 UTC|2026-05-11 18:01:04 UTC|Session with 7 messages. [user] # AGENTS.md instructions for /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck …
329e3ef5-f5d2-4bb4-a096-7a8c45858143|termdeck|2532|9|5|2026-05-11 17:20:48 UTC|2026-05-11 17:25:30 UTC|2026-05-11 17:25:34 UTC|Session with 9 messages. [user] Please echo this exact phrase verbatim on its own line: sprint-63-acceptance-canary-claude-2026-05-11-e1ad …
(2 rows)
```

### Hook log (`~/.claude/hooks/memory-hook.log`) — test window

```
[2026-05-11T17:25:34.884Z] ingested: project="termdeck" session=329e3ef5-... bytes=2532 messages=9  sessionType=auto  sourceAgent=claude startedAt=2026-05-11T17:20:48.714Z durationMin=5  factsExtracted=0 memory_items=ok memory_sessions=ok
[2026-05-11T17:26:29.113Z] ingested: project="termdeck" session=bada8478-... bytes=2602 messages=10 sessionType=codex sourceAgent=codex  startedAt=2026-05-11T17:12:32.179Z durationMin=14 factsExtracted=0 memory_items=ok memory_sessions=ok   ← first-run misattribution (see Finding #1)
[2026-05-11T18:01:04.217Z] ingested: project="termdeck" session=6c833582-... bytes=2422 messages=7  sessionType=codex sourceAgent=codex  startedAt=2026-05-11T17:57:56.697Z durationMin=2  factsExtracted=0 memory_items=ok memory_sessions=ok   ← codex retry — PASS
```

Three ingestions in window. Two represent canary-bearing rows (claude + codex retry); one is the stale-rollout misattribution that prompted Finding #1's reframing. Gemini and grok produced **no** hook log entries — `onPanelClose` was reached but `resolveTranscriptPath` returned null for gemini (Finding #2, fixed inline) and the hook silent-skipped grok at the `<5 messages` threshold (Finding #3, Sprint 64).

---

## 4. Acceptance gate

| Adapter        | Schema A row | source_agent          | Schema B row | Result                                                                                                          |
|:---------------|:-------------|:----------------------|:-------------|:----------------------------------------------------------------------------------------------------------------|
| claude-code    | ✓ 1 row      | claude (correct)      | ✓ 1 row      | **PASS** — canary phrase present, dual-schema written via Claude Code's own SessionEnd hook (TermDeck onPanelClose intentionally skips claude-code per `index.js:216`). |
| codex (retry)  | ✓ 1 row      | codex (correct)       | ✓ 1 row      | **PASS** — canary at offset 498 in content (preceded by codex's own AGENTS.md preamble). Retry was required to clear codex 0.129→0.130 update-picker — see Finding #1. |
| gemini         | ✗ 0 rows     | —                     | ✗ 0 rows     | **FAIL (adapter fix LANDED this sprint, parser-side handling deferred)** — Finding #2.                          |
| grok           | ✗ 0 rows     | —                     | ✗ 0 rows     | **FAIL (Sprint 64 carve-out)** — Finding #3.                                                                    |

**Result: 2/4 PASS on canary content.** Finding #2 adapter-level fix lands inline (filter accepts `.jsonl`); the JSONL-aware parser layer is Sprint 64 work. Finding #3 deferred to Sprint 64 as instructed (ORCH SCOPE 13:51 ET).

---

## 5. Findings

### Finding #1 — codex CLI update-picker self-exit (initial misattribution origin)

**Cause (per ORCH FINDING 2026-05-11 13:46 ET):** the first codex canary panel (session `bada8478`) spawned codex 0.129.0 with a pending update to 0.130.0. Codex's interactive update picker fired ("1. Update now / 2. Skip / 3. Skip until next version"); `npm install -g @openai/codex` ran successfully, codex emitted "Please restart Codex." and **exited 0** before any canary content was injected. My driver's prompt 2 POST then 404'd on "Session is exited".

**Downstream consequence:** `term.onExit → onPanelClose` fired with the canary panel's `session.id=bada8478` but the panel had never produced its own rollout file. The codex adapter's `resolveTranscriptPath` (`packages/server/src/agent-adapters/codex.js:158-196`) sorted candidate rollout files by mtime descending and returned the first cwd-matching file — which was an unrelated active codex panel's rollout (`rollout-2026-05-11T13-12-30-...jsonl`, mtime 13:34). The hook wrote a `memory_items` row tagged with my canary's `source_session_id` but containing summary text from the OTHER panel. The row exists in Mnestra and is visible in the hook log at 17:26:29.

**Retry result (post-update):** codex 0.130.0 boots cleanly, skips the update picker, accepts paste, processes 3 prompts. New session id `6c833582-...` lands BOTH schemas with the canary at content offset 498. The capture pathway works correctly when codex stays alive.

**Status: NOT a TermDeck bug, NOT a T2 bug** (per ORCH). Filed as Sprint 64 candidate under **Investigation 2 territory — codex CLI lifecycle hardening**:
- Codex's auto-update path has no `--skip-update` flag in `codex --help`. A panel that hits the picker silently exits with no canary content even when the user/automation was about to inject substantive input.
- The same window exists for *any* future codex auto-update event. Recommendation for Sprint 64: TermDeck-side detection (parse the update prompt and inject "Skip until next version" automatically when running headless), OR codex-side `--no-auto-update` flag advocacy upstream, OR adapter-level disambiguation in `resolveTranscriptPath` so stale-rollout misattribution can't happen on the next occurrence.

### Finding #2 — gemini `resolveTranscriptPath` extension filter rejects `.jsonl` — **SHIPPED THIS SPRINT**

**File:line (pre-fix):** `packages/server/src/agent-adapters/gemini.js:86`

```js
if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
```

**Substrate evidence:** my canary gemini panel produced transcript file `~/.gemini/tmp/termdeck/chats/session-2026-05-11T17-27-dce3289b.jsonl` (9 KB, 6 canary occurrences). The adapter filter requires `.json`; this file ends in `.jsonl`. Scan at `:97-98` found zero candidates and returned `null`, so `onPanelClose` exited at `index.js:220` — no hook spawn, no row.

Adapter doc-comment at `:53` originally said: `~/.gemini/tmp/<basename(cwd)>/chats/session-<ISO-ts>-<short-id>.json` — gemini CLI must have switched its persistence format to JSONL between 2026-05-02 (older `.json` files in dir) and 2026-05-08 (newer `.jsonl` files in dir). Adapter not updated.

**Impact:** every gemini session opened in TermDeck since gemini's format switch produced **zero** Mnestra rows on close. Silent data loss for ~9 days.

**Fix shipped this sprint** (ORCH SCOPE 13:51 ET):

```diff
-      if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
+      if (!name.startsWith('session-')) continue;
+      if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
```

Also updated the adapter doc-comment to note both formats are accepted now and the JSONL-parser-side handling is a Sprint 64 candidate.

**Fence test:** `packages/server/tests/gemini-resolve-transcript-extension.test.js` — 6 tests:
1. `.jsonl` positive (Finding #2 fix)
2. `.json` regression guard
3. mtime preference (newer `.jsonl` wins over older `.json`)
4. createdAt filter (stale files skipped)
5. `session-` prefix gate (non-prefixed files ignored)
6. fallback-walk (basename dir empty → walk other proj dirs)

All 6 PASS. Full `npm test` after fix: **119 pass / 0 fail / 0 skip** (T1 baseline 112 → T3 fail-fix → +6 new = 119).

**Sprint 64 carve-out from this finding:** the bundled hook's `parseGeminiJson` at `packages/stack-installer/assets/hooks/memory-session-end.js:297-327` does `JSON.parse(raw)` over the whole file and expects an outer object with `.messages`. JSONL is N independent JSON objects, one per line. After this sprint's fix, the adapter FINDS the `.jsonl` file, the hook spawns, but `parseGeminiJson` returns `[]` → `messages.length < 5` silent-skip at line 576 still applies → still no row for `.jsonl` gemini sessions. **The fix shifts the failure mode from "adapter ignores all gemini sessions" to "hook can't parse JSONL deltas"** — visible/diagnosable, not silently buried. Full end-to-end recovery requires the parser update; smallest viable patch is a try-as-JSON-then-fall-back-to-JSONL variant of `parseGeminiJson`, mirrored in both `gemini.js` (adapter, for type-driven dispatch upstream) and `memory-session-end.js` (inlined parser).

### Finding #3 — `<5 messages` silent-skip — **SPRINT 64 CARVE-OUT** (per ORCH)

**File:line:** `packages/stack-installer/assets/hooks/memory-session-end.js:576`

```js
if (messages.length < 5) {
  debug(`session-too-short: ${messages.length} messages (parser=${resolvedType}), skipping`);
  return null;
}
```

**Substrate evidence:** grok canary panel produced grok.db session `df609d2109f3` with 4 messages (2 user + 2 assistant; total 6 713 bytes — well over the 5 KB transcript-size threshold). Each message contains the canary phrase. Hook silent-skipped.

This is the SAME silent-skip surface flagged in `docs/CRITICAL-READ-FIRST-2026-05-07.md` Resolution-Sprint-62 as a Sprint 63 candidate. T2's brief lines 86-92 also list it as a known surface. **Deferred to Sprint 64 per ORCH SCOPE 13:51 ET** — needs deeper redesign (the threshold exists to drop pre-/post-restart no-op transcripts; better discriminator would be byte-count of `text` content rather than entry count, or distinguishing real-content turns from system-prompt/tool-result deltas).

The grok-specific contributor: grok responded slowly to my first prompt (`thinking` state didn't return to `active` within 90 s of inject); driver's 90s-per-prompt timeout moved on, so prompt 1's user message and any partial response weren't recorded by grok before prompt 2 arrived; only prompts 2 + 3 + 2 responses were captured. Faster grok responses OR a `<3 messages` threshold would have cleared this.

---

## 6. Side-channel observations (orchestrator visibility)

- **`packages/server/src/index.js:1349`** has a literal forbidden-word in a code comment — public artifact, ORCH confirmed scrubbing at sprint close (gitleaks scan in progress).
- **T2 brief at `docs/sprint-63-wave-2/T2-exit-capture-proof.md:71-83`** targets non-existent `mnestra_session_summary`. Adopted T4-CODEX correction at 13:13 ET; the actual companion table is `memory_sessions`. PLANNING.md headline at line 5 also says "memory_items + mnestra_*" — should be tightened. Brief-text fix-up for orchestrator at sprint close.
- **`spawnTerminalSession` (`packages/server/src/index.js:1118-1175`) ignores `adapter.spawn` config** — wraps as `zsh -c <command>` regardless of `codex.js:273` `spawn: {binary, defaultArgs, env}` declaration. Filed as **Sprint 64 candidate** per ORCH SCOPE 13:51 ET. Probable contributor to codex's fast-death window during the update-picker event (codex spawned without proper interactive-TTY context may have skipped the picker dialog and gone straight to update + exit).
- **My driver's 1.5 s `status` poll missed every adapter's `thinking` transitions** for claude/codex/gemini (only grok's pattern surfaced consistently). The work happened (replyCount climbed, transcripts grew), but `seen=[{"t":N,"s":"active"}]` recorded only `active` throughout the 90 s wait. The driver carried on regardless. Not a lane scope but a flag for any future automation-via-API: use the buffer endpoint's `inputBufferLength` and `lastActivity` deltas instead of, or alongside, `status`.

---

## 7. What this means for Investigation 1

`docs/CRITICAL-READ-FIRST-2026-05-07.md` Investigation 1 was closed on code/test grounds by Sprint 62. My acceptance test confirms:

- The TermDeck-side wire-up at `packages/server/src/index.js:192-241` IS correct and fires for non-claude adapters (codex retry proves this end-to-end).
- Claude Code's separate SessionEnd hook IS firing correctly (claude canary proves this end-to-end).
- BUT — the wire-up is **necessary, not sufficient**. Three downstream surfaces silently swallowed content during my acceptance test:
  - Finding #1 (codex CLI update-picker) — environmental, not a code bug. Sprint 64 hardening candidate.
  - Finding #2 (gemini extension filter) — code bug. **Fixed inline this sprint.** Full JSONL end-to-end is Sprint 64.
  - Finding #3 (`<5 messages` threshold) — design choice that has real silent-skip blast radius. Sprint 64 redesign.

**The 27% Mnestra coverage metric expected to recover after Sprint 62 (`docs/CRITICAL-READ-FIRST-2026-05-07.md` lines 202-205):** claude coverage IS healthy; codex coverage WILL recover once update-picker hazard cleared (per ORCH, this incident did clear the immediate exposure — codex now on 0.130.0); gemini coverage will start surfacing visible parser failures rather than silent skips (Finding #2 fix); grok coverage and ANY short-conversation coverage across ALL adapters won't recover until the `<5 messages` threshold redesign ships (Finding #3, Sprint 64).

---

## 8. Reproducibility

```bash
# 1. Pre-flight:
curl -s http://127.0.0.1:37778/healthz   # Mnestra
curl -s http://127.0.0.1:3000/api/sessions   # TermDeck

# 2. Generate canaries (fresh suffix per run):
python3 -c "import secrets; [print(a, 'sprint-63-acceptance-canary-' + a + '-2026-05-11-' + secrets.token_hex(2)) for a in ['claude','codex','gemini','grok']]"

# 3. Drive panels (fresh session IDs each run; isolates from existing sprint panels):
node /tmp/sprint63-t2-drive-canary.js
# or for codex-only retry:
node /tmp/sprint63-t2-retry-codex.js

# 4. Probe dual-schema (scrubs forbidden literals automatically; strips `?pgbouncer=true`):
/tmp/sprint63-t2-probe-mnestra.sh

# 5. Run the new fence (validates Finding #2 fix in isolation):
node --test packages/server/tests/gemini-resolve-transcript-extension.test.js
```

Driver sources: `/tmp/sprint63-t2-drive-canary.js`, `/tmp/sprint63-t2-retry-codex.js`. Probe source: `/tmp/sprint63-t2-probe-mnestra.sh`. Driver logs: `/tmp/sprint63-t2-canary.log`, `/tmp/sprint63-t2-codex-retry.log`. Results: `/tmp/sprint63-t2-results.json`, `/tmp/sprint63-t2-codex-retry-results.json`. Probe outputs: `/tmp/sprint63-t2-psql-output.txt`, `/tmp/sprint63-t2-psql-output-retry.txt`.

---

_Authored 2026-05-11 13:42 ET; updated 14:02 ET to reflect ORCH 13:46 codex-lifecycle finding, ORCH 13:51 SCOPE decision to land Finding #2 inline + defer #1/#3, codex retry PASS at 18:01:04 UTC, and 6-test fence shipping in `packages/server/tests/`. T4-CODEX is requested to independently reproduce against the same canary phrases (published in STATUS.md at 13:20 ET) and confirm the 2/4 acceptance result + the Finding #2 fix at `packages/server/src/agent-adapters/gemini.js:86-91`._
