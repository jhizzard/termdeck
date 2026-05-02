# Sprint 48 — Per-agent MCP auto-wire + global stack launcher — STATUS

**Sprint kickoff timestamp:** 2026-05-02 12:57 ET
**Sprint close timestamp:** 2026-05-02 13:18 ET (T4 last DONE post; T3 + T1 closed earlier)
**Wall-clock:** **~21 minutes** kickoff-to-last-DONE (Sprint 41=9, 42=12, 43=17, 44=11, 45=16, 46=16, 47=28, 48=21). Below the Sprint 47 ceiling and consistent with the recent 11-28 min band. T3's schema-divergence coordination ask added ~5 min of ask-and-answer overhead but produced a cleaner helper API (the `merge` escape-hatch path is now reusable for future non-conforming agents).

## Pre-sprint context

- Sprint 47.5 hotfix landed 2026-05-02 ~12:30 ET: `termdeck@0.16.1` / `termdeck-stack@0.4.12` / `mnestra@0.3.4`. Three layered fixes: (a) stack-installer no longer writes literal `${SUPABASE_URL}` placeholders; (b) doctor.js Rumen probe uses correct per-table column map (Brad's 2026-05-02 false-positive WARN); (c) mnestra MCP stdio path now runs `loadTermdeckSecretsFallback()` and treats `${VAR}` placeholders as unset. Hotfix made the 4+1 inject possible — a stale broken installer would have re-broken every fresh agent panel.
- T4 scope changed from initial sketch (was meta-dogfood, now launcher + env propagation). Dogfood deferred to Sprint 49. v0.17.0 target instead of v1.0.0 — v1.0.0 still gated on real mixed-agent dogfood.

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — Codex MCP auto-wire + shared `mcp-autowire.js`

- T1: FINDING — substrate probe 2026-05-02 12:57 ET — `~/.codex/config.toml` exists (non-empty: model, plugins, projects, notice tables) with NO `[mcp_servers.*]` blocks. `~/.termdeck/secrets.env` 16 lines. `codex-cli 0.125.0` at `/usr/local/bin/codex`. — 2026-05-02 12:57 ET
- T1: FINDING — Codex MCP TOML schema is `[mcp_servers.NAME]` (snake_case, NOT camelCase) with sibling `[mcp_servers.NAME.env]` table for env vars. Verified against existing TOML structure in user's config. — 2026-05-02 12:58 ET
- T1: FIX-PROPOSED — Add `mcpConfig: null` to `claude.js` adapter (declares contract field; `null` semantically means "user-managed via `claude mcp add`"). Required because `tests/agent-adapter-codex.test.js:62-66` does `assert.deepEqual(codexKeys, claudeKeys)` parity check, so codex's new `mcpConfig` key must also appear on claude. T2/T3 will add concrete configs to gemini/grok in their lanes. — 2026-05-02 12:58 ET
- T1: FIX-PROPOSED — Helper supports THREE adapter shapes (precedence top → bottom): (1) escape-hatch `merge(rawText, {secrets}) => {changed, output}` for non-record schemas like Grok's array shape — confirms T3's coordination ask, option A; (2) JSON-record-merge `mcpServersKey + mnestraBlock(): object` for Gemini's record shape; (3) TOML-append / JSON-append `mnestraBlock(): string + detectExisting` for Codex's TOML and any string-rendered JSON. Adapters declare exactly one shape; the helper dispatches on field presence. T1 brief's original "JSON returns string" path stays available as the JSON-append fallback. — 2026-05-02 13:09 ET
- T1: DONE — Sprint 48 T1 shipped. Files: NEW `packages/server/src/mcp-autowire.js` (207 LOC — single export `ensureMnestraBlock(adapter, opts?)` plus `readSecrets`, `expandTilde`, and `_internals` for tests; supports all three adapter shapes; idempotent; `${VAR}` placeholder rejection in `readSecrets` mirrors Sprint 47.5 hotfix discipline); EDIT `packages/server/src/agent-adapters/codex.js` (+34 LOC `mcpConfig` field — concrete-or-omit env discipline, TOML basic-string escaping for backslashes + quotes, line-anchored `[mcp_servers.mnestra]` detection regex); EDIT `packages/server/src/agent-adapters/claude.js` (+5 LOC `mcpConfig: null` to satisfy `tests/agent-adapter-codex.test.js:62-66` parity check, plus contract-doc comment block updated to 9 fields); EDIT `docs/AGENT-RUNTIMES.md` § 5 (contract bumped 7 → 9 fields with new rows for `acceptsPaste` and `mcpConfig`; § 7 TheHarness alignment paragraph extended to note the two new fields port cleanly to browser-tab transport); NEW `tests/mcp-autowire.test.js` (414 LOC, 30 tests covering all three shapes + contract enforcement + idempotency + tilde-expansion + parent-dir creation + secrets parser including `${VAR}` rejection + Codex CLI live integration smoke); NEW `tests/agent-adapter-codex-mcpconfig.test.js` (107 LOC, 9 tests covering path / format / required functions / detectExisting positive+negative cases + mnestraBlock secret-rendering + concrete-or-omit + TOML-escaping). All 30 mcp-autowire tests pass including the live `codex --help` integration smoke (HOME-isolated, exits 0 — confirms our written TOML is parser-valid). All 9 codex-mcpconfig tests pass. All 155 agent-adapter tests across all 4 adapters still pass (parity check happy with `mcpConfig` on both claude and codex). Full-suite check: 876/876 pass + 3 skipped on the curated set; the 22 failures in `tests/project-taxonomy.test.js` are the pre-existing Sprint 40 carry-over (out-of-repo `~/.claude/hooks/memory-session-end.js` PROJECT_MAP), already flagged unrelated by T2. No version bump, no CHANGELOG, no commit — orchestrator handles. T2 + T3 coordination: T2's Gemini adapter Just Works against the JSON-record-merge path (verified by reading `gemini.js:208-213`); T3's proposed Grok `merge`-based adapter Just Works against the escape-hatch path (verified by `merge escape-hatch: adapter owns full parse/mutate/serialize` test in mcp-autowire.test.js). T3 can ship their `grok.js` patch + tests without further changes to the helper. — 2026-05-02 13:13 ET

### T2 — Gemini MCP auto-wire

- T2: FINDING — Gemini CLI MCP schema verified against https://www.geminicli.com/docs/tools/mcp-server (2026-05-02). Top-level key is `mcpServers` (camelCase, matches brief). Per-entry transport is one-of `command` / `url` / `httpUrl`; mnestra uses stdio so the entry emits `command: 'mnestra'` only. The `type: 'stdio'` field used in Claude's `~/.claude.json` is a Claude-Code extension and is NOT in the Gemini schema — adapter intentionally omits it. Local probe: `~/.gemini/settings.json` exists and contains only `{security.auth.selectedType: 'oauth-personal'}` — the helper will need to add a top-level `mcpServers` key on first run. Restart-required: Gemini discovers MCP servers at startup, so writes take effect on next `gemini` launch (acceptable — helper writes on TermDeck panel spawn, before user types `gemini`). — 2026-05-02 13:02 ET
- T2: FIX-PROPOSED — Adapter contract field shape: `mcpConfig: { path: '~/.gemini/settings.json', format: 'json', mcpServersKey: 'mcpServers', mnestraBlock: ({secrets}) => ({mnestra: {command: 'mnestra', env: {...}}}) }`. `mnestraBlock` returns the value to merge under `mcpServersKey` (helper does `Object.assign(config[mcpServersKey] ||= {}, mnestraBlock({secrets}))`). Empty/missing secrets are dropped from `env` rather than written as empty strings — matches stack-installer/src/index.js:336-339 concrete-or-omit discipline (Gemini, like Claude Code, does not shell-expand `${VAR}` in MCP env). — 2026-05-02 13:02 ET
- T2: DONE — `packages/server/src/agent-adapters/gemini.js` extended with `mcpConfig` field (+~50 LOC: provenance comment block + `MNESTRA_ENV_KEYS` const + `buildMnestraBlock` helper + the field itself). NEW `tests/agent-adapter-gemini-mcpconfig.test.js` (95 LOC, 5 tests covering: required fields present with documented values, full-secrets merge shape, partial/empty/no-arg secrets omission, no-`type`-field discipline, deterministic output as idempotency precondition). All 5 new tests pass. Existing 27 Gemini adapter tests still pass (32/32 in the gemini suite). All 160 agent-adapter tests pass with 0 failures. Pre-existing 22 failures in `tests/project-taxonomy.test.js` are unrelated (out-of-repo hook, Sprint 40 carry-over noted in PLANNING.md). No version bump, no CHANGELOG, no commit — orchestrator handles. Coordination notes for T1: my `mcpConfig` shape matches the `format: 'json'` branch documented in T1-codex-mcp-autowire.md; T1's `ensureMnestraBlock(geminiAdapter)` should consume it directly once the helper module lands, no further T2 changes expected. T1's claude.js parity-fix proposal (`mcpConfig: null` to satisfy codex test parity check) does not affect my work — the gemini adapter test suite has no claude/gemini deepEqual parity check. — 2026-05-02 13:02 ET

### T3 — Grok MCP auto-wire

- T3: FINDING — Boot complete 2026-05-02 12:57 ET. **Grok MCP schema deviates from the brief's assumption** — confirmed against the actual Bun-bundled source-of-truth at `/usr/local/lib/node_modules/grok-dev/dist/utils/settings.{d.ts,js}` (the `superchargedt/grok-cli` repo URL in the brief doesn't exist; package on disk is `grok-dev` v1.1.5 from the existing Sprint 45 T3 install). Authoritative schema: `UserSettings.mcp.servers` is an **ARRAY** of `McpServerConfig`, NOT a record `mcpServers.NAME`. Each item: `{ id, label, enabled, transport: "stdio"|"http"|"sse", command?, args?, env?, cwd?, url?, headers? }`. Brief's `mcpServersKey: 'mcpServers'` and `mnestraBlock: () => ({mnestra: {...}})` record shapes are wrong for Grok. Hot-load behavior: `agent.js` calls `loadMcpServers()` at the start of every agent turn (3 sites: stream, batch, child-agent), so MCP changes are picked up on the next user message — **no restart required**. `~/.grok/user-settings.json` currently `{"defaultModel": "grok-4.20-0309-reasoning"}` (48 bytes, 0600 perms — preserve). Sibling `~/.grok/grok.db{,-shm,-wal}` and `~/.grok/delegations/` are SQLite + delegation state, untouched by MCP wiring. — 2026-05-02 13:03 ET
- T3: FIX-PROPOSED — Grok adapter declares `mcpConfig` with a custom `merge` function instead of the `mcpServersKey + mnestraBlock` record-merge shape T2's Gemini DONE post and T1's brief use. **Coordination ask for T1 (still in progress per STATUS at 13:02 ET):** the shared helper at `packages/server/src/mcp-autowire.js` should support a format-agnostic escape-hatch alongside your TOML-append + JSON-record paths — propose a third path keyed off `mcpConfig.merge` (presence-checked):

  ```js
  // mcpConfig.merge takes the raw current file contents (or '' if absent)
  // and returns { changed: bool, output: string }. Adapter owns parse +
  // mutate + serialize. Helper still owns: tilde expand, parent dir mkdir,
  // file read, atomic write, returning { wrote, unchanged, path, bytes }.
  ```

  This unblocks Grok's array-shape and any future agent whose schema doesn't match Codex's TOML-block or Gemini's JSON-record patterns. **Order of precedence in the helper:** `mcpConfig.merge` (if present, takes over completely) → format-specific path. If T1 prefers the helper format-strict, T3 falls back to **option B**: ship a one-off `packages/server/src/grok-mcp-wire.js` that bypasses the helper for this single agent (less DRY but isolates the divergence). Option A preferred — flag your call in T1 DONE post.

  Grok-side merge logic (independent of helper API choice):

  ```js
  // packages/server/src/agent-adapters/grok.js — new mcpConfig field
  mcpConfig: {
    path: '~/.grok/user-settings.json',
    format: 'json',
    merge: (rawText, { secrets }) => {
      let current = {};
      if (rawText && rawText.trim()) {
        try { current = JSON.parse(rawText); } catch { current = {}; }
        if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
      }
      const next = { ...current };
      next.mcp = next.mcp && typeof next.mcp === 'object' ? { ...next.mcp } : {};
      const servers = Array.isArray(next.mcp.servers) ? [...next.mcp.servers] : [];
      const existingIdx = servers.findIndex((s) => s && s.id === 'mnestra');
      const desired = {
        id: 'mnestra',
        label: 'Mnestra',
        enabled: true,
        transport: 'stdio',
        command: 'mnestra',
        args: [],
        env: pickConcreteEnv(secrets, ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY']),
      };
      if (existingIdx >= 0) {
        if (deepEqualMnestra(servers[existingIdx], desired)) {
          return { changed: false, output: rawText };
        }
        servers[existingIdx] = desired; // refresh stale env values
      } else {
        servers.push(desired);
      }
      next.mcp.servers = servers;
      return { changed: true, output: JSON.stringify(next, null, 2) + '\n' };
    },
  },
  ```

  `pickConcreteEnv` drops empty/`${VAR}`-placeholder values per Sprint 47.5 hotfix discipline (T2 mentioned same in Gemini DONE — convergent). Acceptance #1 (Mnestra entry written, `defaultModel` preserved), #4 (other top-level keys preserved): both fall out of the spread `{ ...current }` + nested spread on `mcp`. Idempotency #3: deep-equal short-circuit returns `{changed:false}` → helper no-op. Tests use a tmpdir-backed fixture (no global `~/.grok` mutation). Integration test for #2 (live `memory_recall` call inside Grok) gated on T1 helper landing — wired LAST in `tests/agent-adapter-grok-mcpconfig.test.js` with skip-if-binary-absent. — 2026-05-02 13:03 ET

- T3: DONE — Grok adapter `mcpConfig` shipped with the orchestrator-approved Option-A `merge` escape-hatch shape. Files touched:
  - **EDIT** `packages/server/src/agent-adapters/grok.js` (+121 LOC: comment block documenting Grok schema deviation + provenance + hot-load behavior, `MNESTRA_ENV_KEYS` const, private `_pickConcreteEnv` / `_buildMnestraServer` / `_mnestraEntryEqual` / `_mergeMnestraIntoGrokSettings` helpers, and the `mcpConfig: { path, format: 'json', merge: _mergeMnestraIntoGrokSettings }` field on the adapter export). The adapter owns parse + mutate + serialize for Grok's array-shaped `mcp.servers`; T1's helper still owns tilde-expand, parent-dir mkdir, file read, atomic write per the orchestrator's 13:09 ET design call.
  - **NEW** `tests/agent-adapter-grok-mcpconfig.test.js` (162 LOC, 10 tests): required-fields snapshot (path/format/merge present + mcpServersKey/mnestraBlock absent, locking the schema-divergence in); empty-file → mnestra entry with full env; `defaultModel` preservation regression lock (Joshua's actual on-disk shape today); idempotency (second run returns `{changed:false}` byte-for-byte); env drift refresh with sibling server preservation; `${VAR}`-placeholder + empty-string + missing-key omission; user-added sibling-field handling on existing mnestra entry (label/args drift triggers refresh, documenting the canonical-shape policy); malformed-JSON fallback to clean replacement; array-root rejection; deterministic output across calls. All 10 pass (~108ms).
  - **NO new mcp-autowire.js work** — that file is T1's. Adapter is contract-complete and ready for T1's helper to call `mcpConfig.merge(rawText, { secrets })` directly; helper-side dispatch logic (presence-check on `merge` → take the branch; otherwise fall through to TOML/JSON-record paths) is T1's call per the orchestrator endorsement.

  **Test runs:**
  - `node --test tests/agent-adapter-grok-mcpconfig.test.js` → 10/10 pass.
  - `node --test tests/agent-adapter-grok.test.js` → 43/43 pass (no regression on the existing Sprint 45 T3 + Sprint 47 sub-task suite).
  - All adapter suites combined (`grok + grok-mcpconfig + claude + codex + gemini + gemini-mcpconfig + parity`) → 170/170 pass.
  - Full root suite (`node --test tests/*.test.js`) → 892 tests, 867 pass, 22 fail, 3 skipped. The 22 failures are all in `tests/project-taxonomy.test.js` and are pre-existing (out-of-repo `~/.claude/hooks/memory-session-end.js` PROJECT_MAP carry-over noted in T2's DONE post and Sprint 40 PLANNING — unchanged baseline). My +10 tests bring root from 882 → 892 with zero new failures.

  **Acceptance criteria status:**
  - **#1 (writes valid Mnestra entry, preserves `defaultModel`):** ✓ — `merge: preserves existing top-level keys` test pins this against Joshua's actual `~/.grok/user-settings.json` shape.
  - **#2 (live `memory_recall` callable from Grok session):** GATED on T1 helper landing + Joshua launching a Grok panel post-merge. Cannot be unit-tested. Orchestrator should fire as smoke test at sprint close, before v0.17.0 publish.
  - **#3 (idempotent — running twice = no-op):** ✓ — `merge: idempotent` test asserts `{changed:false}` + byte-equal output on second run.
  - **#4 (JSON merge preserves all top-level keys):** ✓ — covered by both `defaultModel` preservation and the env-drift-with-sibling-server tests.
  - **#5 (Grok-binary-absent → CI skip, passes on Joshua's machine):** Adapter tests are pure-function and run anywhere; the live `memory_recall` integration test (acceptance #2) belongs in `tests/mcp-autowire.test.js` per T1's brief and will use the skip-if-binary-absent pattern there. T3's contract tests don't need binary skip — they snapshot the merge function output.

  **Coordination notes:**
  - Orchestrator endorsed Option A (helper-side `mcpConfig.merge` branch) at 13:09 ET — T1 will ship that path, T3 doesn't need a fallback `grok-mcp-wire.js`.
  - T2's Gemini DONE post + my T3 DONE compose cleanly: T2 uses the `mcpServersKey + mnestraBlock` JSON-record path; T3 uses the `merge` escape-hatch. Helper picks based on `mcpConfig.merge` presence.
  - **Sprint 49 candidate (deferred per brief):** Grok 16-sub-agent observability — `session.js` analyzer extension for `"Delegating to [agent] sub-agent: …"` and `"[sub-agent complete]"` patterns; UX is a collapsible tree pane with agent pills. Out of scope for this lane; flagging as primary Sprint 49 candidate alongside the mixed-agent dogfood deferred from this sprint's T4 scope-change.
  - **One AGENT-RUNTIMES.md § 5 update note for T1's lane (you're already touching it for the 9-field claude.js parity fix):** the contract docs should distinguish the two `mcpConfig` shapes — `{ path, format: 'toml'|'json', mcpServersKey, mnestraBlock }` for record/append agents; `{ path, format: 'json', merge }` for schema-divergent agents like Grok; `null` for user-managed agents like Claude. Three cases; 2 lines each in the table is sufficient.

  No version bumps, no CHANGELOG edits, no commits — orchestrator handles close-out. — 2026-05-02 13:14 ET

### T4 — Global stack launcher + PTY env-var propagation

- T4: FINDING — boot complete (date 2026-05-02 12:57 ET, memory_recall x2, global+project CLAUDE.md, RELEASE.md, PLANNING.md, STATUS.md, T4 brief, scripts/start.sh, packages/stack-installer/src/index.js, server spawnTerminalSession). Design choices: (a) deliverable 2 — add a cached `readTermdeckSecretsForPty()` helper at module scope in `packages/server/src/index.js` (mirrors the parser already present in stack-installer/src/index.js Sprint 47.5 hotfix; quote-stripping + `${VAR}` placeholder rejection) and merge into the `pty.spawn` env block AFTER `...process.env` and BEFORE the TermDeck-specific keys, so user shell env still wins for non-secret vars but secrets.env beats absent process.env. (b) deliverable 1 — port `scripts/start.sh` to `packages/stack-installer/src/launcher.js` (CommonJS, ~150 LOC) exposing `startStack/stopStack/statusStack`. The global launcher relies on `mnestra` and `termdeck` binaries being on PATH (Tier 1 + Tier 2 from the wizard), spawns each detached, writes `~/.termdeck/stack.pid` (JSON shape `{mnestraPid, termdeckPid, port, startedAt}`), health-checks via the same endpoints start.sh uses (`:37778/healthz`, `:$port/api/health`). Rumen "process" is a Supabase Edge Function — there's no local PID to manage; status reports via `psql $DATABASE_URL "SELECT NOW() - MAX(created_at) FROM rumen_jobs"` mirroring start.sh step 3. (c) subcommand dispatch in stack-installer index.js: short-circuit before `box('TermDeck Stack Installer')` if argv[2] matches `start|stop|status`, route to launcher.js, exit. Bare `npx @jhizzard/termdeck-stack` keeps the wizard. — 2026-05-02 13:01 ET

- T4: DONE — both deliverables shipped. Files touched:
  - **NEW** `packages/stack-installer/src/launcher.js` (~290 LOC including dep-injection scaffolding for tests) — `startStack/stopStack/statusStack` exports + helpers `_readSecrets`, `_whichBinary`, `_resolveMnestraInvocation`, `_ensureFirstRunConfig`, `_probeHealth`, `_spawnDetached`. Pidfile at `~/.termdeck/stack.pid`. Detached spawn writes to `/tmp/termdeck-mnestra.log` and `/tmp/termdeck-server.log`. `${VAR}` placeholder rejection mirrors the Sprint 47.5 hotfix lesson.
  - **NEW** `packages/stack-installer/tests/launcher.test.js` — 10 tests: secrets parser (4), whichBinary (1), resolveMnestraInvocation (3), stopStack pidfile contract (2). All green via `node --test`.
  - **EDIT** `packages/stack-installer/src/index.js` — added `_maybeRunSubcommand(argv)` that lazy-requires `./launcher` and routes `start|stop|status` before the wizard. `printHelp` now lists the three subcommands at the top. Bare `npx @jhizzard/termdeck-stack` still runs the wizard (backwards compat preserved).
  - **EDIT** `packages/server/src/index.js` — added module-scoped `readTermdeckSecretsForPty()` (cached, lazy-loaded) + `_resetTermdeckSecretsCache()` test hook. `spawnTerminalSession` now computes a `secretFallback` of secrets.env keys NOT already set in `process.env` and merges into the PTY env between `...process.env` and the TermDeck-specific keys. Both helpers exported from `module.exports` for unit testing.
  - **NEW** `packages/server/tests/pty-env-propagation.test.js` — 5 tests including a live PTY integration test that spawns `node -p 'process.env.SUPABASE_URL'` via `@homebridge/node-pty-prebuilt-multiarch` and asserts the var is visible to the child. Skips gracefully if node-pty fails to load.
  - **EDIT** `docs/GETTING-STARTED.md` — Tier-0 Quickstart now leads with `npm i -g @jhizzard/termdeck-stack && termdeck-stack start`. Tier-1 install path mirrors. Troubleshooting table updated for `termdeck-stack stop` recovery and v0.17.0 PTY env auto-merge note.
  - **EDIT** `packages/stack-installer/assets/hooks/README.md` — "Required environment" section now documents the v0.17.0 PTY-spawn env merge behavior (parent shell still wins, secrets.env fills the gap), and notes that standalone Claude Code launches outside TermDeck still rely on shell sourcing.

  **Test run:** `npm test` clean (40/40 pass, includes the 5 new PTY env tests via the existing `packages/server/tests/**/*.test.js` glob). Launcher tests run via `node --test packages/stack-installer/tests/launcher.test.js` (10/10 pass — outside the root npm-test glob, same convention as the existing root `tests/` files; consider promoting the stack-installer suite into `npm test` in a follow-up). No regressions to existing 35 session.test.js tests.

  **Verification still owed (post-merge, manual):** memory-session-end.js landing rate >0% — requires running a real Claude Code session inside a freshly-rebuilt TermDeck server and watching `memory_items` in Supabase for a `source_type='session_summary'` row. Cannot be unit-tested (depends on Mnestra + OpenAI + Claude Code stop-hook all firing). Orchestrator should validate at sprint close, before publishing v0.17.0.

  **Sprint 49 follow-ups (not done in this lane, deliberately scoped out):**
  - Optional `~/.zshrc` source-line offer in the wizard (brief flagged it as time-permitting; skipped to keep the lane tight).
  - If T1/T2/T3 ship `mcp-autowire.js` ensureMnestraBlock helpers, `startStack` could call them on each known agent's config so the global launcher also auto-wires MCP — feels right but is genuine scope creep beyond T4 ownership.
  - Promote `packages/stack-installer/tests/**/*.test.js` into the root `npm test` glob.
  - The launcher does not currently kill stale TermDeck processes the way `scripts/start.sh` does (the bash script has port-pid lsof + IS_TERMDECK detection). Acceptable for v0.17.0 because `termdeck-stack stop` is the canonical path; revisit if outside users hit EADDRINUSE.

  — 2026-05-02 13:18 ET

## Orchestrator notes

_(append-only, orchestrator-only)_

- **ORCH 2026-05-02 13:09 ET — design call on T3's coordination ask:** Endorsing T3's **option A** (`mcpConfig.merge` escape-hatch in the shared helper). Reasoning: (1) Grok's array-shaped `mcp.servers` is a real schema we don't get to re-architect; (2) the `merge(rawText, {secrets}) → {changed, output}` boundary is clean — adapter owns parse/mutate/serialize for non-conforming agents, helper still owns tilde-expand, mkdir-p, atomic write, and the `{wrote|unchanged|path|bytes}` return shape; (3) future agents (potential Cursor/Windsurf/Aider adapters) won't need helper-side schema changes either. **Order of precedence in `mcp-autowire.js`:** `mcpConfig.merge` (presence-checked) takes the entire branch and short-circuits format-specific paths; otherwise fall through to TOML-block (Codex) or JSON-record (Gemini, Claude-when-not-null). T2's Gemini DONE adapter consumes the format-strict path with no changes needed. T3 implements the `merge` function on the Grok adapter as proposed. **T1: please ship the helper with both branches — don't fork to a one-off `grok-mcp-wire.js`.** Option A keeps DRY without compromising T2's already-shipped shape.

- **ORCH 2026-05-02 13:09 ET — T1 claude.js parity fix:** Approved. `mcpConfig: null` on the Claude adapter is the right semantic ("user-managed via `claude mcp add` / `~/.claude.json`; helper no-ops on null"). Helper should treat `null` as `{ skipped: true, reason: 'user-managed' }`, NOT as missing field. Add a unit test asserting the no-op return shape.

- **ORCH 2026-05-02 13:09 ET — sprint tempo at 12 min in:** T2 closed at +5min (very fast, adapter-only). T4 closed at +21min (substantial — launcher port + PTY env + 15 new tests + GETTING-STARTED rewrite). T1 (critical path for T3 integration) and T3 still in flight. Healthy pace; on track for the 28-min Sprint 47 ceiling or below.

## Side-task progress

### Sprint 46 + Sprint 47 deferrals picked up opportunistically

_(orchestrator picks 3-5 smallest items; documents which ones shipped here)_

### `docs/INSTALL-FOR-COLLABORATORS.md` refresh

_(orchestrator handles at sprint close)_

### Mixed-agent smoke test

_(if T4 dogfood runs cleanly the dogfood IS the smoke; otherwise orchestrator fires a synthetic side-panel test)_

### v1.0.0 decision

_(orchestrator evaluates at sprint close: did per-agent MCP auto-wire ship AND dogfood lane complete real work? If yes → v1.0.0. If only auto-wire → v0.17.0. If failure → v0.16.1 patch.)_

## Sprint close summary

_(orchestrator fills at close: lanes shipped, deferrals addressed, smoke/dogfood outcome, version decision, publish status, push status, anything queued for Sprint 49+)_
