# B-T1 — Tier-0 schema + tools (engram)

You are B-T1 in Sprint 71 (Objective Tier), Deck B of a dual-deck sprint. Repo:
`~/Documents/Graciella/engram`. Read PLANNING.md fully first — §Seam and §Context bind you.

## Own exclusively
- `migrations/038_objective_tier.sql` (pre-assigned; Deck A owns 037 — never renumber,
  never edit theirs).
- New `src/objectives.ts` + tests + the MCP tool registrations for
  `objective_list` / `objective_ratify` (follow the registration pattern of existing
  tools in `src/index.ts` — touch only your tool entries there).

## Scope
1. **Storage.** Design choice is yours (new table vs marked rows in `memory_items`), but
   the four enforcement properties must hold at the SQL layer: per-project set (~5-15),
   rank, status, `supersedes` chain, `ratified_by`/`ratified_at`. Mutation ONLY through a
   ratify function — no UPDATE grant that bypasses it. Objectives never decay, are never
   judge-rejected, never consolidated: EXCLUDE them from every existing pipeline
   (consolidation, decay, near-dup, judge) via the marker predicate.
2. **The marker (seam §3) — POST IT EARLY.** The instant you freeze the marker
   (column/flag + exclusion predicate), post
   `### [B-T1] SCHEMA-READY ... — marker spec: <exact columns/predicate>` in THIS deck's
   STATUS.md. Deck A's walk exclusion (A-T1) is waiting on it. This is your first
   deliverable, ideally within the first 30 minutes.
3. **MCP tools.** `objective_list(project)` — ordered, tiny, cheap; `objective_ratify` —
   the only mutation path, operator-gated (mirror the doctrine-ratify gating precedent),
   `supersedes` semantics on replace.
4. **Pinning fetch.** Export the helper that returns the tier-0 block for a project in
   the shape Deck A's envelope reserves (`tier0: [...]`, seam §1). After BOTH your
   SCHEMA-READY and `[A-T2] SCHEMA-READY` (their envelope) exist in the two STATUS files,
   you MAY wire the fetch into their stub — coordinate via STATUS posts; if timing is
   tight, ship the helper + tests and leave wiring as fast-follow.
5. **Hygiene (release-blocking).** `SET search_path = public, pg_catalog`; REVOKE
   EXECUTE FROM PUBLIC then targeted GRANT on every function; RLS enabled on any new
   table; `ADD ... NOT VALID` + `VALIDATE` for constraints; idempotent re-run per house
   style (read 034/036 headers).

## Discipline
Post `### [B-T1] ...` per STATUS.md shape. AUTHOR ONLY — ORCH applies 038 live at close.
Dry-run DDL inside `BEGIN; ... ROLLBACK;` via read-only psql creds (strip
`?pgbouncer=true`). No version bumps, no CHANGELOG, no commits. Memory MCP hangs >60s →
Esc-abort, proceed on the brief.

Boot: read `~/.claude/CLAUDE.md`, engram `CLAUDE.md` (if present), PLANNING.md, STATUS.md,
this brief. Then begin with the marker spec.
