# Changelog — `@jhizzard/termdeck-stack`

All notable changes to the meta-installer are tracked here. The
underlying packages (`@jhizzard/termdeck`, `@jhizzard/mnestra`,
`@jhizzard/rumen`) ship on their own cadences and have their own
changelogs — see the root `CHANGELOG.md` for `@jhizzard/termdeck`.

## [0.3.2] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.7.2`,
  the patch release that closes the second of two converging bugs
  diagnosed in Sprint 33's *"Flashbacks are vaporware"* investigation.
  v0.7.1 fixed the analyzer regex; v0.7.2 repairs the mis-tagged
  corpus and pins TermDeck-side resolver behavior against future
  drift. Sprint 34's 4+1 audit (~15 minutes wall-clock) reset the
  framing: **the chopin-nashville source is not in TermDeck.** The
  resolver in `packages/server/src/rag.js` is correct (longest-prefix
  wins with explicit `path.sep` boundary; verified against the live
  15-project `~/.termdeck/config.yaml`); every TermDeck-side writer
  routes through `_projectFor`; Sprint 21 T2's fix landed and is
  intact. The 1,165 mis-tagged `memory_items` rows came from
  `~/.claude/hooks/memory-session-end.js:17` — Josh's user-owned
  global Claude Code harness hook, outside any package — which
  pattern-matches `/ChopinNashville|ChopinInBohemia/i` first-match-wins
  on cwd with no `termdeck` entry above it. Rumen `extract.ts:62`
  (`(ARRAY_AGG(m.project))[1]`) then propagates the bad tag every
  15 minutes via synthesis writeback.
- **What ships in v0.7.2 (within-repo).** TermDeck-side writer-side
  observability: `[rag] write project=<tag> source=<...>` and
  `[mnestra-bridge] query project=<tag> source=<...> mode=<...>`
  log lines on every event/query (~30 LOC across `rag.js` and
  `mnestra-bridge/index.js`). NEW `tests/project-tag-resolution.test.js`
  with 12 cases pinning the resolver contract — leaf wins over
  ancestor, explicit `meta.project` beats cwd, `path.sep` boundary
  guards against false-prefix matches, the regression pin
  (`.../ChopinNashville/SideHustles/TermDeck/termdeck` resolves to
  `termdeck`). One-time corpus repair shipped as
  `scripts/migrate-chopin-nashville-tag.sql` (~210 LOC,
  three-block dry-run / UPDATE / REVERT layout, conservative
  multi-branch heuristic, reversible via a `metadata.rebrand_v0_7_2_from`
  stash). Live-corpus regression catches in
  `tests/project-tag-invariant.test.js` (6 tests) and a project-bound
  extension to `tests/flashback-e2e.test.js` (now 3 tests).
- **What v0.7.2 deliberately does NOT fix.** The harness hook
  is Josh-owned and out of any package; v0.7.2 documents the
  one-paste fix in the root `CHANGELOG.md` and POSTMORTEM. A
  prospective `@jhizzard/rumen@0.4.4` would harden the
  `(ARRAY_AGG)[1]` synthesis tag inheritance, but fixing the
  hook first heals Rumen on next tick.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`. Mnestra (0.2.2) and Rumen (0.4.3)
  unchanged through this bump.
- Live-store backfill execution: deferred to orchestrator + Josh
  decision after Block 1 sample inspection. Script ships in the
  TermDeck package; runs via
  `psql "$DATABASE_URL" -f scripts/migrate-chopin-nashville-tag.sql`.

## [0.3.1] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.7.1`,
  the patch release that closes one of two converging bugs that made
  Flashback go silent for the most common Unix shell errors. Sprint 33
  (4+1 forensic orchestration, ~24 minutes wall-clock) traced the
  silence to a regex coverage gap in `PATTERNS.error` — the session.js
  comment claimed Unix tool errors were covered, the code never
  enforced it. Pure "documentation is not verification" miss. v0.7.1
  ships the analyzer regex fix + 17 regression fixtures + e2e
  instrumentation. The second root cause (a `chopin-nashville`
  project-tag regression hiding TermDeck memories from the bridge's
  project filter) is diagnosed in `docs/sprint-33-flashback-debug/POSTMORTEM.md`
  and ships in v0.7.2 (Sprint 34) because it requires UPDATE
  statements against the live Supabase store + writer-side source
  review. See the root `CHANGELOG.md` v0.7.1 entry for the full
  diagnosis.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`. Mnestra (0.2.2) and Rumen (0.4.3)
  unchanged through this bump.

## [0.3.0] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.7.0`,
  the runtime-correctness companion to the v0.6.9 install-time
  audit/verify framework. v0.7.0 ships three runtime-side fixes:
  (1) theme persistence — `session.meta.theme` becomes a render-time
  getter that resolves against the live config instead of a SQLite
  snapshot, so editing `~/.termdeck/config.yaml` actually changes
  existing terminals' themes; (2) auth cookie persists 30 days
  (HttpOnly, SameSite=Lax, conditional Secure) so users don't re-type
  the token at every browser session; (3) new `GET /api/health/full`
  endpoint that answers "is this install actually healthy right now?"
  by reusing the v0.6.9 preconditions helpers at runtime — Postgres,
  pg_cron, pg_net, Vault, cron.job activity, SQLite, Mnestra webhook,
  Rumen pool. Cached 30s. See the root `CHANGELOG.md` v0.7.0 entry
  for the full check list and test counts.

### Why a minor bump (not patch)
- v0.7.0 is a minor on the underlying TermDeck package — it adds two
  new feature surfaces (`/api/health/full` and the cookie max-age
  semantics) and changes a load-bearing internal contract (theme
  resolution moves from snapshot to live). The meta-installer's
  audit-trail bump matches that minor cadence so the published
  versions read as a coordinated set: TermDeck 0.7.0 ↔
  termdeck-stack 0.3.0, mirroring the 0.6.x ↔ 0.2.x correspondence.
- Strict reading of `docs/SEMVER-POLICY.md` would treat a docs-only
  audit-trail bump as patch. We're stretching to minor here on
  purpose, same way 0.2.0 was — to keep the published version
  surface legible alongside the underlying TermDeck minor.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack`
  always pulls `@jhizzard/termdeck@latest`, so existing installs
  pick up v0.7.0 automatically. Mnestra (0.2.2) and Rumen (0.4.3)
  unchanged through this bump.
- This closes the v0.6.x → v0.7.0 narrative cleanly: v0.6.x =
  install-time correctness, v0.7.0 = runtime correctness. The same
  audit/verify principle locked into both.

## [0.2.8] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.9`,
  the deliberate close to the v0.6.x incident saga. v0.6.9 introduces
  `auditPreconditions()` and `verifyOutcomes()` — a front-loaded check
  before any state-changing operation, plus a closing check that
  confirms what was just done actually took. Closes the failure class
  that produced four of the eight v0.6.x patches: a documented manual
  step that wasn't verified in code. The wizard now refuses to proceed
  on missing extensions, missing access tokens, missing Vault secrets,
  or any other unmet external precondition. See the root
  `CHANGELOG.md` v0.6.9 entry for the full list of checks and the
  10 regression fixtures.

### Notes
- Fifth and final audit-trail bump in the v0.6.5–v0.6.9 arc. Eight
  underlying patches in 48 hours, three meta-installer audit-trail
  bumps tracking them. The principle that emerged and is now locked
  into the codebase: *"Documentation is not verification."*
- v0.7.0 is the next minor release, planned to extend the audit/verify
  pattern from install-time into runtime via `/api/health/full` plus
  fixes for theme persistence and auth-cookie UX. Not bundled into
  v0.6.9 to keep the narrative clean: v0.6.x = install-time correctness,
  v0.7.x = runtime correctness.

## [0.2.7] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.8`.
  v0.6.8 fixes a meta-installer-induced bug: the meta-installer
  installs `@jhizzard/mnestra` globally as a peer, and TermDeck's
  migration loader was preferring that peer over its own bundled
  migrations. When a user upgraded TermDeck without also upgrading
  the sibling Mnestra package, a stale Mnestra silently shadowed
  newer bundled migrations. v0.6.5's source_session_id fix was
  invisible to anyone with stale Mnestra-in-global-node_modules.
  v0.6.8 flips the precedence — bundled first, peer node_modules as
  a fallback only when bundled is missing. See the root
  `CHANGELOG.md` v0.6.8 entry and the new
  `tests/migration-loader-precedence.test.js` for the four
  regression cases that pin this guarantee.

### Notes
- Fourth audit-trail bump in the v0.6.5–v0.6.8 arc. No installer
  behavior change. The longer-term consideration: a future
  meta-installer release should consider whether to keep installing
  `@jhizzard/mnestra` as a global peer at all, given that TermDeck
  now treats its bundled migrations as canonical. Tracked as a
  follow-up; not blocking this audit-trail bump.

## [0.2.6] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.7`,
  which closes the loop on a long-standing flaw in the meta-installer
  itself. The stack-installer writes
  `SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE'` as a literal placeholder
  string when wiring the Supabase MCP server entry into
  `~/.claude/mcp.json` — the user is expected to manually replace it
  after install. v0.6.4 told users to `export SUPABASE_ACCESS_TOKEN=...`
  for `supabase link`, but that export never propagated into the JSON.
  v0.6.7 of `@jhizzard/termdeck` now backfills the token automatically
  during `termdeck init --rumen` once `supabase link` confirms the token
  is real. See the root `CHANGELOG.md` v0.6.7 entry for the full helper
  contract and the 10 regression fixtures.

### Notes
- This is the third audit-trail bump in the v0.6.5–v0.6.7 arc. No
  installer behavior change — `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`. Future improvement: stop writing
  the literal placeholder in this installer and instead skip the env
  block when no real token is available, prompting the user to set
  `SUPABASE_ACCESS_TOKEN` before running `init --rumen`. Tracked as a
  follow-up; not blocking this audit-trail bump.

## [0.2.5] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.6`.
  v0.6.6 auto-appends `?pgbouncer=true&connection_limit=1` on Supabase
  transaction-pooler URLs (port 6543 on `*.pooler.supabase.com`),
  closing the secondary warning Brad's Rumen logs showed alongside
  the v0.6.5 schema error. Direct connections and session-mode pooler
  URLs are unchanged. Detection lives in `setup/supabase-url.js`
  (`isTransactionPoolerUrl`, `normalizeDatabaseUrl`) and is wired into
  both `init-mnestra` (write time) and `init-rumen` (Edge Function
  secret-set time, for partial-upgrade installs). 15 regression
  fixtures pin the detection rules.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`. Mnestra and Rumen versions are
  unchanged through this bump (0.2.2 and 0.4.3 respectively).

## [0.2.4] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.5` and
  `@jhizzard/mnestra@0.2.2`, both shipped 2026-04-26 to fix a schema
  drift between the published Mnestra migrations and Rumen's runtime
  contract. The `memory_items.source_session_id` column existed in the
  pre-rebrand `rag-system` schema but was dropped from the published
  Mnestra migrations during the Engram → Mnestra rename. Rumen v0.4.x
  still required it, so every fresh `termdeck init --mnestra` →
  `termdeck init --rumen` install path failed Rumen's first cron tick
  with `column m.source_session_id does not exist`. Both packages now
  ship migration `007_add_source_session_id.sql` (idempotent, TEXT,
  partial index). See the root `CHANGELOG.md` v0.6.5 entry and
  `@jhizzard/mnestra` v0.2.2 entry for full context.

### Notes
- This is the first release where two underlying packages bumped
  together as a coordinated set. The meta-installer behavior is
  unchanged — `npx @jhizzard/termdeck-stack` always pulls each layer's
  `@latest`, so a fresh run picks up both fixes automatically. Anyone
  on a partially-installed v0.6.4 stack should run
  `termdeck init --mnestra --yes` after upgrading; the new migration
  applies idempotently without re-prompting for credentials.

## [0.2.3] — 2026-04-26

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.4`,
  which surfaced after v0.6.3 unblocked `init --mnestra` for Brad's
  MobaXterm SSH install — the next step (`init --rumen`) failed with
  the Supabase CLI's raw *"Access token not provided"* error. v0.6.4
  detects that signature and prints a path-aware hint pointing at
  the Supabase PAT dashboard plus the exact `export` command, since
  `supabase login` (the CLI's other suggestion) requires a browser
  and doesn't work over SSH. v0.6.4 also adds `termdeck init --mnestra
  --from-env` as a defensive non-interactive bypass for any terminal
  that fights with our raw-mode secret prompt. See the root
  `CHANGELOG.md` for the full v0.6.4 entry.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`, so existing 0.2.x installs pick
  up v0.6.4 automatically. Brad confirmed the cache trap on 0.6.0
  the hard way; users who hit similar staleness should always run
  `npm cache clean --force && npm i -g @jhizzard/termdeck@latest`
  (or just re-run `npx @jhizzard/termdeck-stack`).

## [0.2.2] — 2026-04-25

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.3`,
  which shipped after a fourth report from the same tester whose
  pre-v0.6.1 install was already half-set-up. v0.6.3 reorders
  `termdeck init --mnestra` to persist `~/.termdeck/secrets.env`
  immediately after collecting inputs (before any pg work), so a
  failed Postgres connect no longer throws away the typed-in
  `DATABASE_URL`. It also adds `--yes` (reuse saved secrets, skip
  prompts) and `--reset` (ignore saved secrets, re-prompt). See the
  root `CHANGELOG.md` for the full v0.6.3 entry.

### Notes
- No installer behavior change. `npx @jhizzard/termdeck-stack` always
  pulls `@jhizzard/termdeck@latest`, so existing 0.2.x installs pick
  up the v0.6.3 wizard fix automatically. This bump keeps the audit
  trail tight — the CHANGELOG for 0.2.1 was written before the
  fourth tester report came in.

## [0.2.1] — 2026-04-25

### Documentation
- Audit-trail update: validated against `@jhizzard/termdeck@0.6.2`,
  which shipped ~8 minutes after stack-installer 0.2.0 went live.
  v0.6.2 removed the `Proceed with setup for project X?` confirm gate
  in `termdeck init --mnestra` after a third report from a tester
  whose terminal kept resolving the confirm as a soft-cancel even
  after v0.6.1's askSecret hardening. See the root `CHANGELOG.md`
  for the full v0.6.2 entry.

### Notes
- No installer behavior change: stack-installer 0.2.0 already pulled
  `@jhizzard/termdeck@latest`, so a fresh `npx @jhizzard/termdeck-stack`
  on 0.2.0 picked up the v0.6.2 wizard fix automatically. This bump
  is purely to keep the per-package audit trail tight — the CHANGELOG
  for 0.2.0 was written when `latest` was still 0.6.1 and had no way
  to mention the hotfix that landed minutes later.

## [0.2.0] — 2026-04-25

### Documentation
- New **Known limitations** section: Tier 3 (Rumen) still requires a
  manual `termdeck init --rumen` after the meta-installer finishes.
  Auto-running this step is queued as Sprint 31 T2.
- New **Version vs. the rest of the stack** section: explains that
  this package's version tracks the meta-installer surface, not the
  underlying packages, and that the installer always pulls each
  layer's `latest` dist-tag at install time.

### Why this is a minor bump (not patch)
Codex's 2026-04-25 audit flagged that `0.1.0` looked like the least-
mature published surface next to `termdeck 0.6.1 / mnestra 0.2.1 /
rumen 0.4.3`. The README was also silent on (a) why this package's
version is decoupled from the underlying layers and (b) the manual
`termdeck init --rumen` step that Tier 3 users still need. The bump
signals "actively maintained, validated against the v0.6.x stack."

The strict reading of `docs/SEMVER-POLICY.md` would treat a docs-only
refresh as patch-level. We're stretching to minor here on purpose —
this is the "we know it's been sitting at 0.1.0 too long, here's the
intentional refresh" release. Future docs-only updates will revert
to patch.

### Notes
- Installer code in `src/index.js` is byte-for-byte identical to
  v0.1.0. The published 0.1.0 already wires Tiers 1–4 against the
  current stack — no behavior change in this release.

## [0.1.0] — 2026-04-25

### Initial release
- One-command meta-installer: `npx @jhizzard/termdeck-stack`.
- Four-layer overview, detection of already-installed packages,
  tier prompt (default 4), `npm install -g` for missing layers,
  merges Mnestra and Supabase MCP entries into `~/.claude/mcp.json`
  without clobbering existing servers.
- Modes: interactive (default), `--tier N`, `--dry-run`, `--yes`.
- Zero runtime deps beyond Node built-ins.
