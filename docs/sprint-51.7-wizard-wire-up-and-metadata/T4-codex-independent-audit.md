# T4 — Codex independent audit (3+1+1 auditor)

You are T4 (Codex auditor) in Sprint 51.7 (wizard-wire-up-and-metadata, v1.0.3 mini).

**Important constraint:** Codex CLI in this setup does NOT have Mnestra MCP wired (confirmed Sprint 51.6, 20:54 ET). You cannot call `memory_recall` / `memory_remember`. Your durable substrate is `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md`. Post verbose `[T4-CODEX]` entries with file:line evidence so the orchestrator (and future-you post-compaction) can pattern-match.

## Boot sequence (do these in order, no skipping)

1. Read `~/.claude/CLAUDE.md` (especially § "MANDATORY: Sprint role architecture — Orchestrator + Workers + Auditor (3+1+1, not 4+1)" — that's the doctrine you're enacting).
2. Read `./CLAUDE.md` (project router).
3. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/PLANNING.md`.
4. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` (lane state + your prior posts if you've compacted).
5. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/T1-wizard-wire-up-bisect.md`.
6. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/T2-bundled-hook-metadata-and-stamp-bump.md`.
7. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/T3-ship-v1-0-3.md`.
8. Read `docs/sprint-51.6-memory-sessions-hook-fix/STATUS.md` lines 690–1060 (your own prior Phase B audit work — durable record of the failure mode this sprint exists to fix).
9. Read `docs/INSTALLER-PITFALLS.md` ledger entry #15 (line 159) and the v1.0.3 follow-up note at line 173.

## Pre-sprint intel

Sprint 51.6 was the first sprint to use the canonical 3+1+1 pattern. You (Codex T4) caught 4 real bugs in T3's WIP that all-Claude lanes had shipped past:
- `memory_sessions` POST without `?on_conflict=session_id` (idempotency bug)
- `package.json.files` missed `packages/stack-installer/assets/**` (packaging gap; bundled hook would never reach users)
- `refreshBundledHookIfNewer()` overwriting genuinely-custom user hooks (overwrite-safety gap)
- Auto-refresh wire-up FAILED Phase B verification → `DONE — REOPEN T3` → v1.0.3 follow-up = THIS SPRINT

Your job in 51.7 is the same shape: independently reproduce, audit before FIX-LANDED rather than rubber-stamp after, surface gaps the Claude lanes' shared assumptions blind them to. Adversarial mindset.

## Lane scope

You audit in three phases:

### Phase 1 — Independent reproduction of the wire-up failure (T1's target)

Don't trust T1's bisect verbatim. Set up your OWN sandbox: tmp HOME, stale-shaped hook fixture, run the actual `termdeck` binary against it. Confirm the failure mode T1 describes matches what you see. If T1 names hypothesis X as the root cause, run an experiment that would distinguish X from Y and Z. Post `[T4-CODEX] AUDIT — T1 root cause confirmed/contradicted` with your evidence.

Specifically check:
- Is the `step()` / `ok()` ANSI rewriting eating the refresh status output, making it INVISIBLE in stdout but the refresh actually fired?
- Is `runMnestraAudit()` (line 668) silently catching errors and exiting 0 before line 670, masking a real failure?
- Does `__dirname` resolve correctly when the binary is npx-cached, pnpm-installed, OR yarn-installed (not just `npm install -g`)?
- Does Brad's actual installed hook on jizzard-brain pre-Phase-B match the marker policy in `looksTermdeckManaged()`?

### Phase 2 — Audit T2's transcript parser + stamp bump

- Throw edge-case fixtures at T2's parser:
  - Empty transcript
  - Single-line transcript
  - Transcript with all-malformed lines
  - Transcript where messages have nested `message.content` arrays vs flat `content` arrays vs no content
  - Transcript with `tool_use` blocks under both names (`memory_remember` direct vs `mcp__mnestra__memory_remember` namespaced — verify T2 counts both)
  - Transcript with `tool_use` from tools T2 should NOT count (`Bash`, `Read`, etc.)
  - 10MB transcript (memory pressure)
- Verify the stamp bump v1 → v2 propagates everywhere: grep the entire repo for `stack-installer-hook v1` and confirm only intentional historical references remain (e.g., in CHANGELOG entries about v1.0.2).
- Verify T2 didn't break any test that hardcoded `v1`. If T2 missed updating a fixture, post `[T4-CODEX] AUDIT — T2 missed: ...` BEFORE T2 posts FIX-LANDED if possible.

### Phase 3 — Pre-publish + post-publish verification (after T3 STAGED-FOR-PUBLISH)

Pre-publish:
- `npm pack --dry-run --json` from root + stack-installer; verify the bundled hook + init-mnestra.js + new tests are all present in the right tarballs.
- Verify CHANGELOG entry shape matches v1.0.2's pattern.
- Run the full test matrix yourself; don't trust T3's pass/fail counts.
- Run T1's new CLI integration test against the staged binary (e.g., `node packages/cli/src/index.js init --mnestra ...` against a tmp HOME).

Post-publish (orchestrator triggers this phase by posting `[ORCH] PUBLISHED v1.0.3` in STATUS.md):
- `npm install -g @jhizzard/termdeck@1.0.3`
- Verify version: `node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"` → `1.0.3`
- Verify bundled hook v2: `grep -n "@termdeck/stack-installer-hook" /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js` → `v2`
- Run `termdeck init --mnestra` (Joshua's daily-driver against petvetbid)
- Verify the installed hook landed at v2 byte-identical to the bundled v2: `diff ~/.claude/hooks/memory-session-end.js /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js` → empty diff
- Verify backup file was written: `ls ~/.claude/hooks/memory-session-end.js.bak.*` → at least one new entry with today's timestamp
- Trigger a fresh `/exit`. Wait 60s.
- `psql "$DATABASE_URL" -c "select * from memory_sessions where ended_at >= now() - interval '5 minutes' order by ended_at desc limit 1"` → confirm row exists with `started_at IS NOT NULL`, `duration_minutes IS NOT NULL`, `facts_extracted >= 0`.
- `psql "$DATABASE_URL" -c "select source_agent, source_type from memory_items where created_at >= now() - interval '5 minutes' and source_type='session_summary'"` → `source_agent='claude'` for the latest row.
- **Rumen catch-up probe.** Joshua noted `rumen_insights` count has been flat for "a few days" (downstream of the same `memory_sessions` ingestion gap). After triggering a fresh `/exit` and waiting one Rumen-tick cycle (~15 min), check: `psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"` — count should grow, `max(created_at)` should be inside the last 30 min. If Rumen is still flat after 30 min despite a fresh `memory_sessions` row, post `[T4-CODEX] FINDING — Rumen not catching up` with `rumen_jobs` recent-error inspection (`select * from rumen_jobs order by created_at desc limit 5`). This may surface a separate Sprint 52+ item but should not block v1.0.3 sign-off.

If all probes pass: post `[T4-CODEX] DONE — VERIFIED 2026-05-04 HH:MM ET` with a full evidence dump (psql results, diff outputs, version checks).

If any probe fails: post `[T4-CODEX] DONE — REOPEN T<n>` with file:line evidence and a concrete next-action recommendation.

## Lane discipline

- You do NOT write production code. You write tests, you write probes, you write STATUS.md posts.
- You do NOT bump versions, edit CHANGELOG, or commit.
- Your value comes from independent reproduction — do not duplicate T1's instrumentation; build your own.
- Verbose STATUS.md posts. The orchestrator and future-you depend on them as durable substrate. Include file:line evidence on every claim. Quote stdout/stderr verbatim where possible.
- If you compact mid-sprint: re-orient by reading STATUS.md (your own prior posts), then this brief, then continue from where you left off. Sprint 51.6 had a successful compact-mid-sprint recovery via this pattern.

## When you're done

Post `[T4-CODEX] DONE — VERIFIED` (sprint clean) or `[T4-CODEX] DONE — REOPEN T<n>` (specific lane has unresolved gap, with concrete fix recommendation).

Begin.
