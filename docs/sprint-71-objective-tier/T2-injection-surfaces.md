# B-T2 — Injection surfaces + billing fence + Gemini mirror (termdeck)

You are B-T2 in Sprint 71 (Objective Tier), Deck B of a dual-deck sprint. Repo:
`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`. Read PLANNING.md
fully first — §Seam, §Redaction, §Context bind you. You are the only lane in the
termdeck repo this sprint (both decks included) — but the tree carries an ORCH-owned
uncommitted billing patch (`packages/server/src/index.js`, `SECRETS_EXCLUDED_FROM_PTY`)
and deliberate untracked stragglers: build AROUND them, never revert.

## Scope
1. **Session-start injection.** Panel boot/flashback pins the project's tier-0 block
   ABOVE recall context (consume B-T1's `objective_list`/fetch helper; degrade to
   nothing gracefully when the store lacks 038 — this ships before the migration is
   live).
2. **PreCompact re-injection.** Extend the bundled hook asset
   `packages/stack-installer/assets/hooks/memory-pre-compact.js` to fetch + re-inject
   tier-0 at compaction (compaction is where drift happens). INSTALLER-PITFALLS Class N:
   the bundled asset and any vendored/installed copy must change together — read
   `docs/INSTALLER-PITFALLS.md` BEFORE touching this surface (mandatory per repo
   CLAUDE.md) and trace your PR to the failure class it avoids. Fail-soft: hook errors
   must never block compaction.
3. **Vault render.** Exporter emits the tier-0 block atop `Home.md` + each MOC (the human
   sees what the agents get). Fixture-test the render; do NOT run a live vault regen.
4. **Billing fence (formalizes the ORCH patch).** (a) Test asserting
   `ANTHROPIC_API_KEY` ∈ `SECRETS_EXCLUDED_FROM_PTY` — must FAIL if someone removes it.
   (b) `termdeck doctor` probe: WARN when a spawned panel env would inherit
   `ANTHROPIC_API_KEY` (secrets.env carries it AND/OR server process env carries it).
   (c) INSTALLER-PITFALLS ledger entry: panels inheriting provider API keys flips CLI
   billing from subscription to API credits (the 2026-08 overbilling vector) or strands
   boot on the detect-key dialog.
5. **Gemini read-mirror (closes the read loop).** Periodic server job, default OFF
   (`TERMDECK_GEMINI_MIRROR=1` + interval var to enable): export tier-0 + top-N recent
   memories (N default 50) to a Google Sheet via the Sprint-84 SA-JWT util
   (`TERMDECK_SHEETS_SA_KEY_FILE`; see the sheets-harvest implementation for the auth
   pattern — reuse, don't reimplement). §Redaction is release-blocking: privacy-tagged
   rows excluded, redact layer applied per cell, forbidden-string family never present.
   Sheet ID via env/config; document (in the job's header comment + doctor hint) that
   the operator must share the sheet to their Gemini-authed account as reader —
   Gemini-web reliably READS sheets in its authed account; that is the entire delivery
   mechanism.

## Discipline
Post `### [B-T2] ...` per STATUS.md shape; SCHEMA-READY when your injection payload
shape is frozen; DONE when root `npm test` is green. No version bumps, no CHANGELOG, no
commits. Memory MCP hangs >60s → Esc-abort, proceed. Verify store facts via read-only
psql, not MCP recall.

Boot: read `~/.claude/CLAUDE.md`, `./CLAUDE.md` (repo — includes the INSTALLER-PITFALLS
mandate), `docs/INSTALLER-PITFALLS.md`, PLANNING.md, STATUS.md, this brief. Then begin.
