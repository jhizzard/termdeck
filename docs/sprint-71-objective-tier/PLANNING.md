# Sprint 71 — Objective Tier (Deck B, :3002)

**Dispatch 2026-08-05 evening. Dual-deck sprint: this deck (B) runs concurrently with
Deck A = Sprint 70 Graph-Boosted Recall on :3001
(`docs/sprint-70-graph-boosted-recall/`). ONE orchestrator shepherds both. Numbering
note: the June-era `sprint-71-mcp-bridge` dir is an UNRELATED historical sprint; this
slug is the canonical Sprint 71 per `docs/RESTART-PROMPT-2026-08-02-EVENING-POST-S69.md`.**

## Mission

Hierarchical memory with ENFORCED top-level objectives so the system cannot drift.
**Tier 0 = OBJECTIVES** (per-project, ~5-15 rows: what this project is for, what must
never happen, current strategic position) with four enforcement properties: (1) ALWAYS
INJECTED at session start + RE-INJECTED at PreCompact (compaction is where drift
happens; the hook already fires there); (2) pinned ABOVE recall results — retrieval can
never bury them; (3) mutable ONLY via explicit ratification (`supersedes` chain,
operator-gated like doctrine ratify) — never decay, never judge-rejected; (4) rendered
atop the vault's `Home.md` + each MOC so the human sees the same tier-0 the agents get.
Tier 1 = doctrine/kitchen (graph-chain recalled, Deck A's business). Tier 2 = evidence.
The synthesis: **"CLAUDE.md for every agent, generated from the store"** — Claude Code's
layered enforcement (CLAUDE.md / hooks / skills / plan-mode) moved server-side so
codex/grok/agy shells AND web surfaces get identical tier-0.

Also carried this sprint (Josh directives 2026-08-05): **(a) billing-safety
formalization** — panels must never inherit `ANTHROPIC_API_KEY` (ORCH already live-patched
the tree; B-T2 formalizes with tests + doctor probe); **(b) Gemini-web read-mirror** —
gemini.google.com has NO connector path; the ONLY reliable surface it reads is a Google
Sheet inside its authed account. Export tier-0 + recent memories to a mirror sheet →
closes the last read-surface gap in the fabric (write side already captured via the
Sprint-84 sheet harvest; this completes the loop).

**Repos: engram (B-T1) + termdeck (B-T2) + rumen (B-T3).** Paths:
`~/Documents/Graciella/engram` · `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` ·
`~/Documents/Graciella/rumen`.

## Lanes

- **B-T1 — Tier-0 schema + tools (engram).** Owns `migrations/038_objective_tier.sql`
  EXCLUSIVELY (Deck A owns 037 — never renumber) + a new `src/objectives.ts` (+tests).
  Schema: objectives storage (project, text, rank, status, ratified_by/at,
  supersedes chain), distinct marker so recall/consolidation/decay EXCLUDE tier-0
  (objectives are injected, not retrieved — seam §3; post the exact marker spec as
  SCHEMA-READY early, Deck A's walk depends on it). MCP tools: `objective_list` (read),
  `objective_ratify` (the ONLY mutation path; operator-gated). Pinning fetch: the helper
  Deck A's envelope stub will call (seam §1). RLS + function hygiene release-blocking.
- **B-T2 — Injection surfaces + billing fence + Gemini mirror (termdeck).**
  (1) Session-start injection: panel boot/flashback pins tier-0 above recall context.
  (2) PreCompact re-injection: extend the bundled `memory-pre-compact.js` asset (+ its
  parity-fenced installed copy path — INSTALLER-PITFALLS Class N: change both or
  neither) to fetch + re-inject tier-0. (3) Vault render: tier-0 block atop `Home.md` +
  each MOC in the exporter. (4) Billing fence: test asserting `ANTHROPIC_API_KEY` ∈
  `SECRETS_EXCLUDED_FROM_PTY` (the ORCH patch already in the tree at
  `packages/server/src/index.js`) + doctor probe warning when a panel env would inherit
  the key + INSTALLER-PITFALLS ledger entry. (5) Gemini read-mirror: periodic server job
  (default OFF, `TERMDECK_GEMINI_MIRROR`) exporting tier-0 + top-N recent memories to a
  Google Sheet via the Sprint-84 SA-JWT util (`TERMDECK_SHEETS_SA_KEY_FILE`); redaction
  MANDATORY (see §Redaction).
- **B-T3 — Anti-drift jobs (rumen).** Owns rumen `src/` additions + `migrations/009+`.
  (1) Contradiction scan: new decisions vs tier-0 → FLAG row (never silently absorb; the
  operator sees flags). (2) Objective-coverage report: sustained project activity with
  zero tier-0 linkage = drift signal. (3) Objective-staleness review flags (age/last-
  ratified). All ship DARK (flags/crons default OFF).
- **B-T4 — Codex auditor.** Adversarial. CHECKPOINT discipline mandatory. Priority
  targets: ratification gating (hunt ANY unratified mutation path), 038 RLS hygiene,
  PreCompact bundled-vs-installed parity, Gemini mirror REDACTION (nothing
  privacy-tagged, no forbidden internal strings, redact.js applied), billing fence test
  actually failing when the key is removed from the exclusion set.

## §Seam — cross-deck contract (FROZEN; identical text in both PLANNINGs)

1. **Recall envelope reserves a `tier0` pinned block.** A-T2's envelope shape:
   `{ tier0: [...], results: [...] }` (or the equivalent in the existing response
   format): `tier0` always FIRST, never interleaved, never downranked by A-T3 staleness,
   never absorbed into hubs/communities. This sprint Deck A emits `tier0: []` — Deck B's
   engram half (B-T1) provides the real fetch. If integration lands cleanly in-window,
   B-T1 may wire its fetch into A-T2's stub AFTER both post SCHEMA-READY; otherwise the
   stub ships empty and wiring is a fast-follow.
2. **Engram migration numbers: 037 = Deck A, 038 = Deck B.** Pre-assigned; never
   renumber; neither deck edits the other's migration file.
3. **Objectives are injected, not retrieved.** The 037 walk EXCLUDES tier-0/objective
   rows — B-T1 posts the exact marker (column/flag) as `SCHEMA-READY` in THIS deck's
   STATUS.md so A-T1 can write the exclusion predicate. Post it EARLY.
4. **Cross-deck reads allowed; writes fenced to your own deck's files.** Deck A STATUS:
   `docs/sprint-70-graph-boosted-recall/STATUS.md`. Deck B STATUS:
   `docs/sprint-71-objective-tier/STATUS.md`.

## §Redaction (Gemini mirror — release-blocking)

The mirror sheet leaves the machine into Google's cloud and is readable by anyone the
sheet is shared with. Before any row is written: (1) privacy-tagged rows EXCLUDED
entirely; (2) content passes the established redaction layer (vendored
`redact.js` pattern — reuse, don't reimplement); (3) the internal-Supabase-project-name
forbidden-string family must never appear (same list the gitleaks config enforces);
(4) sheet sharing: the operator's Gemini account as reader — document the share step for
the operator, do not attempt to share programmatically beyond the SA's capability.

## Context every lane must know

1. **MCP recall hangs under multi-panel load.** Verify store state via READ-ONLY psql
   (`DATABASE_URL` in `~/.termdeck/secrets.env`, strip `?pgbouncer=true`). Any memory MCP
   call hanging >60s at boot: Esc-abort and proceed — your brief carries the context.
2. **The billing patch in the termdeck tree is ORCH-owned and uncommitted** — B-T2
   formalizes around it; nobody reverts it; nobody commits.
3. Claude Code parity map (design north star): CLAUDE.md global→project = tier 0; hooks
   (harness-executed) = enforcement; skills = tier-1 procedures; plan mode = intent
   ratification. The Objective Tier is that layering server-side for ALL surfaces.
4. No version bumps, no CHANGELOG edits, no commits, no publishes — ORCH at close.
5. Post-shape (uniform, mandatory): `### [B-T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
   Verbs as in Deck A. Tolerant idle-poll regex form: `^(### )?\[B-T<n>\] DONE\b`.

## Acceptance

- 038 authored (not live-applied; ORCH applies at close): objectives storage +
  ratification-only mutation enforced AT THE SQL LAYER (no UPDATE grant path that skips
  ratify), RLS hygiene clean.
- `objective_list`/`objective_ratify` MCP tools registered + tested; ratify
  operator-gated.
- Panel boot + PreCompact both inject tier-0 (test-proven with fixtures); vault exporter
  renders tier-0 atop Home.md + MOCs (fixture export).
- Billing fence test red if `ANTHROPIC_API_KEY` removed from exclusion set; doctor probe
  present.
- Gemini mirror: dark by default; when ON in a fixture run, produces a redaction-clean
  sheet payload (unit-level; live sheet write optional if SA key present).
- Rumen jobs authored dark + tested; contradiction FLAG path proven on a fixture.
- Root `npm test` green in all three repos; B-T4 FINAL-VERDICT GREEN.

## Resolution (ORCH close, 2026-08-05)

FINAL-VERDICT GREEN / RATIFY 20:53 ET (B-T4), ~79 min inject-to-verdict incl. one ORCH contract ruling (no amendment: retire folded into ratify as supersede-with-nothing + GATE 6 single-door privilege scan; cap race serialized on per-project advisory xact lock, container-counterfactual-proven). Shipped: engram 038 + objective_list/objective_ratify + tier0FetcherForRecall(); termdeck tier-0 injection (3 surfaces + PreCompact v4 + vault render), billing fence (both vectors + doctor probe), Gemini read-mirror (dark, redaction-gated); rumen 009/010 + objective-guard (dark, 270-test suite). Forbidden-string leak in this STATUS scrubbed at source (twice, benign race). Wave: mnestra 0.13.0 / rumen 0.12.0 / termdeck 1.20.0 / stack 1.18.0. Live-apply operator-gated. Follow-ons in BACKLOG §A.
