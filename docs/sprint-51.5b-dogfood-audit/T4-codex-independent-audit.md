# T4 — Codex independent audit (Brad-shape reproduction + adversarial verification)

You are T4 (Codex auditor) in Sprint 51.5b (v1.0.3 dogfood audit, 3+1+1, audit-only).

**As of 2026-05-04 ~11:00 ET, Codex CLI HAS Mnestra MCP wired** (`codex mcp add mnestra` ran this morning per `~/.claude/projects/.../memory/reference_mcp_wiring.md`). You can call `memory_recall` directly. STATUS.md remains the canonical durable substrate.

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.7 v1.0.3 wire-up runHookRefresh init-mnestra match_memories migration drift")` (verify MCP works; if recall fails, fallback to file-only substrate)
2. `memory_recall(query="Sprint 51.6 Sprint 51.7 Codex audit Class M Class A migration replay drift")`
3. Read `~/.claude/CLAUDE.md` (especially § "Three hardening rules learned from Sprints 51.6 + 51.7" — checkpoint discipline applies to YOU)
4. Read `./CLAUDE.md`
5. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
6. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
7. Read this brief end-to-end.
8. Read `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` (your prior audit work — durable record of what v1.0.3 fixes vs leaves on the table).

## MANDATORY: Compaction-checkpoint discipline

Per CLAUDE.md hardening rule 1 (added 2026-05-04 after Codex compacted mid-Sprint-51.6 AND mid-Sprint-51.7): **post a `### [T4-CODEX] CHECKPOINT 2026-05-04 HH:MM ET` to STATUS.md at every phase boundary AND at least every 15 minutes of active work.**

Each CHECKPOINT post includes:
- (a) Phase number + name (e.g., "Phase 1 — Brad-shape fixture provisioning")
- (b) What's verified so far (file:line evidence)
- (c) What's pending
- (d) Most recent worker FIX-LANDED reference you were about to verify

Why: STATUS.md is your only durable substrate. On compaction, the orchestrator re-injects pointing at your most recent CHECKPOINT. Self-orientation post-compact: read your own most recent CHECKPOINT, continue from where pending becomes verified.

## Pre-sprint intel

Sprint 51.6 + 51.7 closed Class M + the wizard wire-up bug. v1.0.3 ships:
- `runHookRefresh()` decoupled from DB phase, runs at `init-mnestra.js:716` BEFORE migrations
- New CLI-binary integration test at `tests/init-mnestra-cli-refresh.test.js` pinning the wire-up
- Bundled hook v2 with transcript-derived metadata population (`started_at` / `duration_minutes` / `facts_extracted`)
- Parser counts ALL three tool names: `memory_remember`, `mcp__mnestra__memory_remember`, `mcp__memory__memory_remember`

But **a Class A migration-replay drift remains** (`packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-96` declares `match_memories` with column ordering `(id, content, source_type, category, project, metadata, similarity)` while petvetbid's existing function returns a different signature). Sprint 51.7 fixed Class M — DB failure no longer strands hook upgrade — but the underlying migration drift is still there for any user re-running `init --mnestra` on an existing v0.6.x-era install. T4 should verify this gap manifests as a visible-but-non-blocking failure (the user sees migration error; refresh still landed; re-run succeeds after manual fix).

T4's job: **independently reproduce T1/T2/T3 findings using a Brad-shape fixture** (NOT petvetbid). Catch any over-claim before the orchestrator sends Brad the WhatsApp.

## Phase 1 — Brad-shape fixture provisioning

Create a fixture that resembles Brad's jizzard-brain shape:
- Fresh tmp HOME with NO `~/.claude.json` (so no MCP wiring)
- A stale 508-LOC pre-Sprint-50 hook at `<tmpHOME>/.claude/hooks/memory-session-end.js` (use the bundled hook from a v0.10.0 git checkout OR craft a stale fixture that has TermDeck-managed markers but no v1/v2 stamp)
- A long-lived Supabase project (use T3's throwaway `termdeck-dogfood-2026-05-04` after T3 finishes Phase E, OR provision your own)

Post `### [T4-CODEX] CHECKPOINT — Phase 1 fixture ready` when complete.

## Phase 2 — Independent reproduction of T1's claims

Run the canonical user path against your Brad-shape fixture:

```bash
HOME=$T4_FIXTURE_HOME DATABASE_URL=$BRAD_SHAPE_DB termdeck init --mnestra 2>&1 | tee /tmp/t4-codex-init-mnestra.log
echo "exit=$?"
```

Independently verify (do NOT trust T1's stdout):
- `→ Refreshing... ✓ refreshed v? → v2 (backup: ...)` appears BEFORE `→ Connecting to Supabase...` (architectural ordering invariant T1's test #1 pins)
- Hook file at `$T4_FIXTURE_HOME/.claude/hooks/memory-session-end.js` is now v2 byte-identical to bundled
- Backup file written with timestamp
- Even if `applyMigrations()` throws on mig-001 return-type drift, refresh ALREADY landed (the whole point of T1's fix)

Cross-check: if the migration-001 drift fires AND the wizard returns exit 5 BUT the hook still updated, that's T1's promise kept. Document the visible failure mode the user sees (`Migration failed: 001_mnestra_tables.sql`) and confirm the user's ingestion is recovered despite the visible error.

Post `### [T4-CODEX] AUDIT — T1 reproduction <PASS|FAIL>` with file:line evidence.

Post `### [T4-CODEX] CHECKPOINT — Phase 2 complete`.

## Phase 3 — Audit T2's metadata claims

After T2 posts DONE, independently verify the parser claims using YOUR fixture:

- Trigger a `/exit` against the Brad-shape fixture (or use a synthetic transcript from `~/.claude/projects/`)
- Query the resulting `memory_sessions` row
- Verify `started_at IS NOT NULL`, `duration_minutes > 0`, `facts_extracted >= 0`
- Cross-check `facts_extracted` against manual count of all three tool_use names in the transcript
- Edge case: a transcript with ONLY `mcp__memory__memory_remember` (legacy prefix) — verify count is correct (this is the Codex 11:09 ET catch from Sprint 51.7)
- Edge case: empty transcript — verify NULL/NULL/0
- Edge case: malformed JSONL line — verify graceful skip

Post `### [T4-CODEX] AUDIT — T2 parser claims <PASS|FAIL>` with file:line evidence (e.g., specific transcript path + manual count + DB row count comparison).

Post `### [T4-CODEX] CHECKPOINT — Phase 3 complete`.

## Phase 4 — Audit T3's fresh-project + Brad outreach claims

After T3 posts DONE with their Brad WhatsApp draft:

- Verify T3's `init --mnestra` on tmp HOME actually wrote a `v2` hook (status = `installed`, not `refreshed`) — independently re-run the test from T3's stdout sample
- Verify the GRAPH_LLM_CLASSIFY Y-path landed both secrets (independently query `supabase secrets list`)
- Verify the Vault deeplink is correctly URL-encoded — paste it into a clean browser window, confirm SQL Editor opens with vault.create_secret(...) pre-filled (NOT truncated, NOT broken on `&` characters)
- **Audit T3's WhatsApp draft for accuracy.** Does it claim things dogfood actually verified? Does it over-promise (e.g., claim metadata works when fixture shows otherwise)? Does it accurately represent the migration-001 caveat (or omit it appropriately for Brad's read)?

If T3's draft is accurate: post `### [T4-CODEX] AUDIT — T3 + Brad draft PASS, orchestrator green to send`.
If T3 over-claims: post `### [T4-CODEX] AUDIT — T3 over-claim on <X>, REOPEN T3 for redraft`.

Post `### [T4-CODEX] CHECKPOINT — Phase 4 complete`.

## Phase 5 — Final disposition

If all phases PASS: `### [T4-CODEX] DONE — VERIFIED 2026-05-04 HH:MM ET — sprint clean, orchestrator green to send Brad`.

If any phase FAILS: `### [T4-CODEX] DONE — REOPEN T<n> 2026-05-04 HH:MM ET` with concrete fix recommendation. Orchestrator triggers Sprint 51.8 hotfix.

## Lane discipline + post shape

- You do NOT write production code. You write probes, you write STATUS.md posts.
- You do NOT bump versions, edit CHANGELOG, commit, or send Brad anything.
- **Post shape:** every STATUS.md post starts with `### [T4-CODEX] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED (uniform shape across all lanes per CLAUDE.md hardening rule 2).
- **CHECKPOINT discipline (rule 1):** every 15 min OR at every phase boundary. Non-negotiable.
- Verbose STATUS.md posts. Quote stdout/stderr verbatim. Cite file:line on every claim.

## When you're done

Post `### [T4-CODEX] DONE — VERIFIED` (sprint clean) or `### [T4-CODEX] DONE — REOPEN T<n>` (specific lane has unresolved gap, with concrete recommendation).

Begin.
