# T1 — Google Sheets intake ramp + harvester

**You are T1 in Sprint 84 (Write-Side Completion).** Your lane is arc step 4.2: the Google-Sheets-to-Mnestra intake ramp — the path that lets Josh (and Gemini-web, and any phone quick-capture shortcut) drop a row in a sheet and have it arrive in `memory_inbox` as a proposal.

## Scope

1. **Harvester module** (~200 LOC target, not a cap): reads a designated Google Sheet tab via **service-account** auth (googleapis npm or raw REST with a JWT — your call, ground-truth what's lightest; zero-build-step, CommonJS, vanilla JS — the termdeck hard rules apply if you land it in the termdeck repo).
2. **Forward path:** each unforwarded row becomes an inbox proposal through the SAME insert path `packages/mcp-bridge/src/tools/propose.js` uses (ground-truth it first — client RPC vs raw insert; reuse, don't fork). Fields: text (required), project (default per sheet config), source_agent `gemini-web` unless the row carries a source column (canonical vocabulary only).
3. **Append-only, mark-forwarded-never-delete:** the harvester writes a `forwarded_at` timestamp back to the row's forwarded column. It NEVER deletes or reorders rows. Idempotency: a row with `forwarded_at` set is skipped forever; a crash between insert and mark must not double-propose on rerun (dedup on a deterministic row fingerprint — sheet id + row index + content hash — carried in the proposal metadata).
4. **Sheet schema + activation README:** document the expected tab layout (suggested: `ts | source | project | text | forwarded_at`) and the operator activation steps (mint service account, share sheet with its email, set env vars). If a required secret is missing from `~/.termdeck/secrets.env`, ship code+tests complete with the env-var contract documented and post FINDING — do NOT block the lane on Josh minting credentials mid-sprint.
5. **Cadence:** propose your polling cadence to T3 via a STATUS post (T3 owns all cron additions). A local timer (supervisor-style) is also acceptable — state your choice and why.

## Boot sequence

1. `memory_recall(project="termdeck", query="Sheets intake ramp memory_propose inbox")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-84-write-side-completion/PLANNING.md` then `STATUS.md`
4. This brief. Then ground-truth `packages/mcp-bridge/src/tools/propose.js`, `src/policy.js`, `src/clients/mnestra.js` before writing a line.

## Acceptance bar

- Unit tests for: fingerprint dedup, forwarded-row skip, crash-between-insert-and-mark rerun safety, source_agent mapping, malformed-row quarantine (bad rows are marked with an error note in the sheet, never silently dropped, never fatal to the batch).
- One end-to-end proof against a REAL sheet (create a throwaway under the service account if credentials exist; otherwise a faked transport layer with the real request shapes asserted) showing row → `memory_inbox` pending → `forwarded_at` stamped.
- No new RPC/column without a `SCHEMA-READY` post first (PLANNING contract 1).

## Lane discipline

Stay in lane: nothing in rumen, nothing in T3's cron/purge surface, no bridge policy edits (T2 owns policy.js this sprint — if you need a policy change, post FINDING and let ORCH route it). Post `### [T1] VERB 2026-MM-DD HH:MM ET — <gist>` to STATUS.md for FINDING / FIX-PROPOSED / FIX-LANDED / SCHEMA-READY / BLOCKED / DONE. No version bumps, no CHANGELOG, no commits.
