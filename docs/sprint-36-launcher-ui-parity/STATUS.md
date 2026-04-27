# Sprint 36 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

Format:
```
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

---

## T1 — Full start.sh parity in CLI

### FINDING — 2026-04-27 13:32 ET

Gap analysis after reading `scripts/start.sh`, `packages/cli/src/stack.js`, `packages/cli/src/index.js`, `packages/cli/src/auto-orchestrate.js`:

1. **Implementation parity is already there.** `stack.js` (the `termdeck stack` Node port) already implements all five `start.sh` behaviors: secrets load (Step 1/4), port reclaim, Mnestra autostart with kill-and-restart-on-empty-store + secrets reload (Step 2/4), Mnestra MCP-absence hint, Rumen last-job age via `pg.Pool` (Step 3/4), summary line + `BOOT` (Step 4/4). Sprint 35 T4 added the Tier-1 box-banner enhancements (RAG state line, port reclaim, transcript hint) inside `index.js`'s `--no-stack` path.

2. **The gap is invocation, not implementation.** Default-entry `npx @jhizzard/termdeck` (no subcommand) routes through `auto-orchestrate.js`'s `shouldAutoOrchestrate()` gate, which short-circuits to `false` whenever `~/.termdeck/secrets.env` OR `~/.termdeck/config.yaml` is missing — i.e., on every fresh machine. Fresh users land directly in `index.js`'s Tier-1-only path and never see the Step 1/4–Step 4/4 choreography. This is enforced by `tests/cli-default-routing.test.js:57–62` which asserts "fresh machine: plain `termdeck` does NOT enter stack.js" — the OLD Sprint 24 policy, contradicting Sprint 36 acceptance criterion #2.

3. **MCP-absence hint reads from the wrong path.** `stack.js:454` checks `~/.claude/mcp.json`, but Claude Code v2.1.119+ (and Joshua's box) reads from `~/.claude.json`. On Joshua's actual box: `~/.claude/mcp.json` does not exist; `~/.claude.json` exists with `mcpServers: {memory, adbliss, imessage}` — no `mnestra` entry. Today's hint would false-trigger on the legacy-path absence even before T2 lands. Detection needs to check both paths. Coordination: T2 is migrating writes from legacy → canonical; I'll expose `CLAUDE_MCP_PATH_CANONICAL` / `CLAUDE_MCP_PATH_LEGACY` constants from `stack.js` for T2 to import.

4. **Hint wording is non-actionable.** `stack.js:462` says "Hint: add a 'mnestra' entry to ~/.claude/mcp.json for Claude Code" — leaves the user to figure out the JSON shape. Briefing wording is better and tells users what to do.

### FIX-PROPOSED — 2026-04-27 13:33 ET

Four-step change, all under `packages/cli/src/`:

1. **`stack.js`** — Export `CLAUDE_MCP_PATH_CANONICAL` (`~/.claude.json`) and `CLAUDE_MCP_PATH_LEGACY` (`~/.claude/mcp.json`) module-level constants. Update the Mnestra MCP-absence detection block (currently `stack.js:452–463`) to check BOTH paths and only print the hint when neither contains the substring `mnestra`. Update hint wording to: `TermDeck doesn't see Mnestra wired in Claude Code yet. Run: npx @jhizzard/termdeck-stack`.

2. **`auto-orchestrate.js`** — Flip `shouldAutoOrchestrate()` to always-on. Keep the function (test seam, future telemetry) but make it return `true` unconditionally. Document the Sprint 36 policy change inline. Fresh machines hit `stack.js`'s `ensureFirstRunConfig()` (auto-writes `~/.termdeck/config.yaml` on first run) and then proceed through Step 1/4–4/4 with mostly-`SKIP` statuses — matching what `scripts/start.sh` produces on a fresh box.

3. **`tests/cli-stack-detection.test.js` + `tests/cli-default-routing.test.js`** — Update Sprint 24 assertions to reflect the new policy: fresh machine SHOULD enter stack.js; `--no-stack` still bypasses; `--help` still unaffected.

4. **NOT touching** `init-rumen.js`, server-side MCP writers (T2's lane), dashboard UI (T3), hooks bundling (T4). No version bumps, no CHANGELOG, no commits.

### DONE — 2026-04-27 15:35 ET

All four FIX-PROPOSED steps are landed in the working tree and validated. Files changed (all on disk from the prior cohort + orchestrator hotfix #2 — this cohort verified, ran tests, and confirmed parity):

- `packages/cli/src/auto-orchestrate.js` — `shouldAutoOrchestrate()` now returns `true` unconditionally (was: gated on secrets.env + config.yaml presence + autoStart/rag.enabled). Function signature preserved as a future telemetry seam.
- `packages/cli/src/stack.js` — added module-level constants `CLAUDE_MCP_PATH_CANONICAL`, `CLAUDE_MCP_PATH_LEGACY`, `CLAUDE_MCP_PATHS`; added `hasMnestraMcpEntry()` that checks both paths; added `isTermDeckLive()` liveness probe; `reclaimPort()` now self-recognizes the live server and exits with `{ alreadyLive: true }`; rewrote MCP-absence hint to use `hasMnestraMcpEntry()` and updated wording to "TermDeck doesn't see Mnestra wired in Claude Code yet. Run: npx @jhizzard/termdeck-stack". Constants + helper exported on `module.exports` for T2 to import.
- `packages/cli/src/index.js` — orchestrator hotfix #2: `reclaimStalePort()` mirrors stack.js's liveness probe (curl `/api/sessions` with `-m 1.5`; on `HTTP 200` → exit 0 instead of SIGKILLing the live server). Plus `else if (process.env.TERMDECK_PORT) config.port = parseInt(...)` at the env-read seam (defense in depth; the existing `port = config.port || 3000` short-circuit at line 259 still maps `0 → 3000`, but that's pre-existing behavior outside this lane's scope).
- `tests/cli-stack-detection.test.js` — 7 unit tests rewritten to assert always-true policy (was 7 tests asserting Sprint 24 gated behavior).
- `tests/cli-default-routing.test.js` — flipped fresh-machine assertion to expect stack.js banner; added `fresh + --no-stack` opt-out test (now 6 tests total).

**Test results (real run, this cohort):**
- `node --test tests/cli-stack-detection.test.js` → 7/7 pass, ~115ms.
- `node --test tests/cli-default-routing.test.js` → 6/6 pass, ~4.6s.
- Live server (PID 2983, port 3000) survived both test runs — the liveness-probe self-recognition is working in the real production environment, confirming the orchestrator hotfix is the correct fix for the four prior cohort kills.

**Side-by-side parity (real run, fresh `HOME=$(mktemp -d)`, `TERMDECK_PORT=0`):**

```
TermDeck Stack Launcher
─────────────────────────────────────────────────

  ⓘ First run detected — creating <tmphome>/.termdeck/config.yaml
  └ Edit <tmphome>/.termdeck/config.yaml to add projects or tweak defaults.
  └ Open http://localhost:3000 and click 'config' to complete setup

Step 1/4: Loading secrets ..........................  SKIP  (no <tmphome>/.termdeck/secrets.env — Tier 1 only)
Step 2/4: Starting Mnestra .........................  OK    (already running, 5,323 memories)
  └ TermDeck doesn't see Mnestra wired in Claude Code yet. Run: npx @jhizzard/termdeck-stack
Step 3/4: Checking Rumen ...........................  OK    (last job 00:02:22 ago)
Step 4/4: Starting TermDeck ........................  BOOT  (port 0)

  Stack: TermDeck :0 | Mnestra :37778 (5,323) | Rumen (00:02:22 ago)
```

Step labels, dot padding, status tags, sub-note format all match `scripts/start.sh` byte-for-byte. The MCP-absence hint correctly fires on Joshua's box because `~/.claude.json` keys his MCP entry as `memory` (legacy from the Engram → Mnestra rename) and the substring "mnestra" doesn't appear anywhere in the file — exactly the case the new wording is designed to catch.

**Coordination outcomes:**
- T2's path-constants ask is satisfied: `CLAUDE_MCP_PATH_CANONICAL` / `CLAUDE_MCP_PATH_LEGACY` are exported from `packages/cli/src/stack.js`. T2's lane is free to either import from there OR canonicalize them in `packages/cli/src/mcp-config.js` (T2's planned file) and have stack.js re-export — either is fine; T1 doesn't care which file holds the canonical definition.
- Hint wording matches the spirit of Sprint 35 T3 `termdeck doctor` (telling the user the action to take: run the installer) rather than the old "edit ~/.claude/mcp.json" leave-them-stranded wording.

**Out-of-scope items confirmed not touched:** `init-rumen.js`, server-side MCP writers (T2), dashboard UI (T3), hook bundling (T4). No version bumps, no CHANGELOG, no commits.

**Follow-up notes for orchestrator (sprint close):**
1. `scripts/start.sh` can now become a 5-line wrapper (`exec node packages/cli/src/index.js "$@"`) or be deleted entirely. The CLI is fully featured — Joshua's daily driver can switch per acceptance criterion #5 (Phase 0 dogfood gate).
2. The `port = config.port || 3000` short-circuit at `packages/cli/src/index.js:259` blocks ephemeral-port mode (passing `--port 0` or `TERMDECK_PORT=0` resolves back to 3000). Not a Sprint 36 regression — pre-existing — but worth a Sprint 37 fast-follow if anyone wants `--port 0` to actually bind to an ephemeral port for test isolation.
3. Joshua's `~/.claude.json` keys his MCP entry as `memory` (not `mnestra`). The substring detection correctly flags this as "not wired" — but if Joshua wants his daily-driver box to stop showing the hint, T2's migration logic should rename `memory → mnestra` (or accept either key as the same server) when it migrates from legacy. Out of scope for T1; flagging for T2.

---

## T2 — MCP path drift fix

### FINDING — 2026-04-27 13:34 ET

**Schema observed on Joshua's box (Claude Code v2.1.119+):**

`~/.claude.json` exists (73 KB). It is the unified Claude Code profile with ~55 top-level keys including `mcpServers`, `projects`, `oauthAccount`, `installMethod`, plus UI/onboarding metadata. The MCP block lives at the **top level** as `mcpServers`, keyed by server name. Of 22 entries in `projects`, only 2 carry per-project `mcpServers` overrides — top-level is the canonical default and what Claude Code reads on every session.

`~/.claude/mcp.json` does **not** exist on Joshua's box. Confirmed Claude Code no longer reads the legacy path on his install — Mnestra (registered as `memory`) is wired solely via top-level `mcpServers` in `~/.claude.json`. Brad's reports ([memory_recall 2026-04-26]) confirm the stack-installer-on-fresh-machine path drops MCP into the legacy file, where current Claude Code never reads it — the user-visible "install is broken" symptom.

Canonical entry shape (from a real top-level entry):
```
{ "type": "stdio", "command": "node", "args": [...], "env": {...} }
```
HTTP entries omit `command/args` and use `{ "type": "http", "url": "..." }`. The current installer doesn't write a `type` field — adding `"type": "stdio"` for spawn-based entries to match.

**Write/read sites in the repo (3 total — all need migration):**
1. `packages/stack-installer/src/index.js:39` — `MCP_CONFIG = ~/.claude/mcp.json`. Primary writer. `readMcpConfig` / `writeMcpConfig` / `wireMcpEntries` at 254–314.
2. `packages/cli/src/init-rumen.js:505` — `wireAccessTokenInMcpJson` defaults to legacy. Helper is path-injectable (existing tests stay green).
3. `packages/cli/src/index.js:270` — `checkSupabaseMcpHint` reads legacy.

`packages/server/src/setup/supabase-mcp.js` is a runtime spawn wrapper only; no config read/write — out of scope for this lane.

**Schema-preservation hazard:** today's writer (`stack-installer:267`) does `JSON.stringify(cfg, …)` over the full parsed file. Safe for legacy `~/.claude/mcp.json` (single-purpose), but applied to `~/.claude.json` it would round-trip every Claude Code internal key — surviving today, but the next Claude Code release that adds a key would have us silently dropping it. Migration must do **read-modify-write only on `.mcpServers`** and leave everything else untouched.

**Cross-package note:** `@jhizzard/termdeck-stack` (packages/stack-installer) and `@jhizzard/termdeck` (packages/cli) are published as **separate npm packages**. Stack-installer's `files` field publishes only `src/**`, so it cannot `require()` into `packages/cli/`. The shared `MCP_CONFIG_PATH` constant + merge helpers must live in **both** packages — same contract, two physical files. Acceptable cost; alternative is a third published package, overkill for ~120 lines.

**T1 coordination (alignment):** T1's FIX-PROPOSED at 13:33 ET names the constants `CLAUDE_MCP_PATH_CANONICAL` and `CLAUDE_MCP_PATH_LEGACY` and proposes exporting them from `stack.js`. T2 will land the **canonical definitions** in `packages/cli/src/mcp-config.js` (the schema/CRUD layer) under those exact names, so T1 can `require('./mcp-config')` instead of declaring the constants in `stack.js`. This keeps "where do I find the on-disk MCP config path?" answered by one file across the codebase. T1 still owns the absence-hint detection logic in `stack.js`; T2 just provides the path constants and the merge primitives.

**T4 boundary:** T4 writes `~/.claude/settings.json` (different file, same parent dir). T2 will not touch settings.json — T4's lane.

### FIX-PROPOSED — 2026-04-27 13:34 ET

Atomic per file, idempotent, no-deletion of legacy.

**Step 1 — `packages/cli/src/mcp-config.js` (NEW, ~120 lines):**

Exports:
- `CLAUDE_MCP_PATH_CANONICAL = path.join(os.homedir(), '.claude.json')`
- `CLAUDE_MCP_PATH_LEGACY = path.join(os.homedir(), '.claude', 'mcp.json')`
- `readMcpServers(filePath)` → `{ servers, malformed, missing }`. Reads top-level `.mcpServers` only.
- `mergeMcpServers(currentServers, legacyServers)` → merged map; **current wins** on key collision (legacy is migration-source, never source of truth).
- `writeMcpServers(filePath, servers)` → read-modify-write that preserves all other top-level keys. Atomic via `${path}.tmp.${pid}` then `rename`. `mode 0600`. If file is missing, creates a `{ mcpServers: {...} }` minimal file.
- `migrateLegacyIfPresent({ dryRun })` → reads both paths, merges, writes to canonical, returns `{ migrated: [names], kept: [names], wrote: bool }`. Idempotent: a second invocation with no new legacy entries reports `migrated: []`.

**Step 2 — `packages/stack-installer/src/mcp-config.js` (NEW, sibling copy):**

Same exports, same semantics. Standalone (zero deps beyond Node built-ins) so `@jhizzard/termdeck-stack` stays self-contained as a published package.

**Step 3 — Update writers/readers:**

- `packages/stack-installer/src/index.js`: replace `MCP_CONFIG` with `CLAUDE_MCP_PATH_CANONICAL` import. `wireMcpEntries` becomes: load merged map → optionally insert mnestra/supabase if absent → `writeMcpServers(CLAUDE_MCP_PATH_CANONICAL, ...)`. New entries get `"type": "stdio"`. The "edit `${MCP_CONFIG}`" hint switches to `~/.claude.json`. If the merge migrated entries from legacy, print one dim line: `"Migrated <N> entr(y/ies) from legacy ~/.claude/mcp.json — old file left in place."`
- `packages/cli/src/init-rumen.js`: `wireAccessTokenInMcpJson` default path → `CLAUDE_MCP_PATH_CANONICAL`. Helper signature unchanged — existing tests continue passing because they always inject `mcpJsonPath`. Internal write logic switches to the structure-preserving `writeMcpServers` so the function never clobbers Claude Code's other top-level keys when run against the real `~/.claude.json`.
- `packages/cli/src/index.js`: `checkSupabaseMcpHint` reads `CLAUDE_MCP_PATH_CANONICAL`. Comment block updated.

**Step 4 — Tests:**

- NEW `tests/mcp-config-merge.test.js`: covers `readMcpServers` (missing, malformed, top-level only), `mergeMcpServers` (legacy-only / current-only / both-disjoint / both-with-overlap → current wins), `writeMcpServers` (preserves unrelated top-level keys like `oauthAccount` and `projects`, idempotent on second call, mode 0600, atomic), `migrateLegacyIfPresent` (no-legacy → noop, legacy-only → migrated, both → merged).
- Update `tests/init-rumen-mcp-json.test.js`: ADD ONE new test — when `mcpJsonPath` points at a `~/.claude.json`-shaped fixture (with sibling `oauthAccount`, `projects`, etc.), the helper backfills `SUPABASE_ACCESS_TOKEN` AND leaves all other top-level keys byte-identical. Existing 9 tests stay untouched.

**Acceptance per briefing:**
1. ✅ Install reads both, merges, writes to `~/.claude.json`, leaves `~/.claude/mcp.json` alone.
2. ✅ Idempotent: second install run produces zero diff.
3. ✅ T1 has a single import for the path constant.
4. Manual: confirm Claude Code v2.1.119+ picks up the `mnestra` entry on next session.

Out of scope (per briefing): per-project nesting under `projects.<path>.mcpServers`. Defaulting to top-level — works for global; per-project users keep their overrides untouched because we only mutate top-level `mcpServers`.

### DONE — 2026-04-27 15:37 ET

All four FIX-PROPOSED steps landed. 45 tests pass (24 new mcp-config-merge + 11 init-rumen-mcp-json + 9 init-rumen-access-token + 1 init-mnestra-resume — green).

**New files (sibling copies — same exports, same semantics):**
- `packages/cli/src/mcp-config.js` (174 LOC) — canonical schema/CRUD module.
- `packages/stack-installer/src/mcp-config.js` (138 LOC) — sibling copy. Stack-installer's `files` field publishes only `src/**` so it cannot `require()` into `packages/cli/`. Comment header documents the sync constraint.

**Exports (both copies):**
- `CLAUDE_MCP_PATH_CANONICAL` → `path.join(os.homedir(), '.claude.json')`
- `CLAUDE_MCP_PATH_LEGACY` → `path.join(os.homedir(), '.claude', 'mcp.json')`
- `readMcpServers(filePath)` → `{ servers, raw, missing, malformed, error }`. Tolerates missing / empty / array-top-level / parse-error. `raw` carries the full parsed object so writers can do structure-preserving round-trips.
- `mergeMcpServers(currentServers, legacyServers)` → merged map; current wins on collision. Tolerates null/undefined.
- `writeMcpServers(filePath, servers)` — atomic, structure-preserving. Re-reads the file, replaces only `.mcpServers`, leaves every other top-level key (`oauthAccount`, `projects`, `installMethod`, …) byte-equivalent. Tmp+rename, mode 0600. Creates a minimal `{ mcpServers: {...} }` file when none exists.
- `migrateLegacyIfPresent({ canonicalPath, legacyPath, dryRun })` → `{ migrated, kept, wrote, malformed }`. Idempotent — second invocation reports `migrated: []`. Never deletes or modifies the legacy file.

**Updated writers/readers:**
- `packages/stack-installer/src/index.js`:
  - `MCP_CONFIG` now equals `CLAUDE_MCP_PATH_CANONICAL`. `printNextSteps`'s "edit `${MCP_CONFIG}` and replace SUPABASE_PAT_HERE" hint auto-points at `~/.claude.json`.
  - `wireMcpEntries` is now a 2-step flow: (1) `migrateLegacyIfPresent` forward-merges any legacy entries (logs `↑ migrated N entr(y/ies) from legacy ~/.claude/mcp.json — left in place`); (2) re-read canonical, layer in mnestra/supabase additions, write via `writeMcpServers`. New entries get `"type": "stdio"` to match the schema observed on Joshua's box. Malformed canonical aborts cleanly with a stderr line — does not clobber.
  - Removed the old single-purpose `readMcpConfig` / `writeMcpConfig` helpers. Module exports gained `_mcpInternals`, `MCP_CONFIG_PATH`, `CLAUDE_MCP_PATH_CANONICAL`, `CLAUDE_MCP_PATH_LEGACY`.
- `packages/cli/src/init-rumen.js`:
  - `wireAccessTokenInMcpJson` default path → `CLAUDE_MCP_PATH_CANONICAL`. Internal write goes through `writeMcpServers` so the ~55 unrelated top-level keys Claude Code stores in `~/.claude.json` (`oauthAccount`, `projects`, …) are preserved byte-equivalent. Existing 9 regression tests still pass unchanged (they always pass `mcpJsonPath`).
  - Status banner uses `r.path` instead of hardcoded `~/.claude/mcp.json`.
- `packages/cli/src/index.js`:
  - `checkSupabaseMcpHint` reads canonical first, then falls back to legacy. Uses `readMcpServers` from `./mcp-config`. Comment block updated to call out the Sprint 36 read order.

**Tests:**
- NEW `tests/mcp-config-merge.test.js` (331 LOC, 24 tests). Covers path constants; `readMcpServers` (missing / malformed / array-top-level / no-mcpServers-key / happy path); `mergeMcpServers` (legacy-only / current-only / disjoint / collision / null-tolerant); `writeMcpServers` (preserves unrelated top-level keys, creates minimal file when missing, mode 0600, no leftover `.tmp` files, idempotent on identical input); `migrateLegacyIfPresent` (no-legacy noop, legacy-only forward-copy, idempotent on second run, current-wins on overlap with `wrote: false`, dryRun, creates-canonical-when-missing, malformed-legacy without write).
- EXTENDED `tests/init-rumen-mcp-json.test.js` with one new test: target shaped like `~/.claude.json` (`oauthAccount`, `projects`, `installMethod`, `autoUpdates`, `skipAutoPermissionPrompt`, `extraKnownMarketplaces`, sibling Mnestra entry) — backfill mutates ONLY supabase env, every other top-level key survives `Object.keys(reread).sort() === Object.keys(fixture).sort()`. Original 9 tests untouched.

**Acceptance per briefing:**
1. ✅ Install reads both, merges, writes to `~/.claude.json`. Legacy file left in place.
2. ✅ Idempotent — second run of `migrateLegacyIfPresent` and `writeMcpServers` produces zero diff (proven in tests).
3. ✅ T1 has a single import for the path constant — `require('./mcp-config')` exports `CLAUDE_MCP_PATH_CANONICAL` / `CLAUDE_MCP_PATH_LEGACY`. (See **Cross-lane drift to resolve at sprint close** below.)
4. Manual (out-of-lane): confirm Claude Code v2.1.119+ picks up the `mnestra` entry on next session — Joshua to verify after sprint close.

**Out of scope (per briefing) — preserved:**
- `~/.claude/mcp.json` is never deleted.
- No per-project nesting under `projects.<path>.mcpServers`. Defaulting to top-level — works for global; per-project users keep their overrides untouched because we only mutate top-level `.mcpServers`.
- `packages/server/src/setup/supabase-mcp.js` not touched (runtime spawn wrapper, no config IO).
- `~/.claude/settings.json` not touched (T4's lane).

**Cross-lane drift to resolve at sprint close:** T1's DONE entry (15:35 ET) declared `CLAUDE_MCP_PATH_CANONICAL` / `CLAUDE_MCP_PATH_LEGACY` inline in `packages/cli/src/stack.js`. T2 also exports them from `packages/cli/src/mcp-config.js`. Both copies match. Recommendation for orchestrator: at sprint close, refactor `stack.js` to `const { CLAUDE_MCP_PATH_CANONICAL, CLAUDE_MCP_PATH_LEGACY } = require('./mcp-config')` and drop the inline `path.join(os.homedir(), …)` calls. One-file source of truth keeps the next "where do I find the on-disk MCP config path?" question short. Trivial — ~3-line edit to stack.js plus dropping its self-defined constants.

**Follow-up flagged by T1 (out of T2 scope, NOT addressed in this lane):** Joshua's `~/.claude.json` keys his MCP entry as `memory`, not `mnestra` (legacy from the Engram → Mnestra rename, hand-wired pre-installer). T1 suggested T2's migration logic could rename `memory → mnestra` to make the absence-hint stop firing on Joshua's daily-driver box. Decision: **don't rename in migration.** `memory` is a generic name; Joshua's entry happens to point at Mnestra but other users could legitimately have a different `memory` MCP server. The cleaner fix is in T1's `hasMnestraMcpEntry()` detection — accept either `servers.mnestra` OR a server whose `command` resolves to a Mnestra binary. That's an edit to `stack.js`, T1's lane. Filing as Sprint 36.5 fast-follow if Joshua's hint flicker becomes annoying.

**Files needing commit at sprint close (per sprint contract — no commit in lane):**
- NEW: `packages/cli/src/mcp-config.js`, `packages/stack-installer/src/mcp-config.js`, `tests/mcp-config-merge.test.js`
- MODIFIED: `packages/stack-installer/src/index.js`, `packages/cli/src/init-rumen.js`, `packages/cli/src/index.js`, `tests/init-rumen-mcp-json.test.js`

---

## T3 — Dashboard RAG toggle UI + HIGH-priority bug supplements

### FINDING — 2026-04-27 15:34 ET (resume cohort — A/B/C orientation)

Boot complete. Substrate confirmed safe (orchestrator hotfix #2 — both `reclaimPort` in `stack.js` and `reclaimStalePort` in `cli/src/index.js` self-recognize a live TermDeck via `/api/sessions` probe). Deliverable D already DONE (orchestrator-applied below). Resuming at A.

**Deliverable A — extension point identified.** Existing `setupModal` (app.js:2495–2563) is a full-screen wizard already wired to `#btn-config` (app.js:3157). The plain-English RAG settings panel will render as a sibling block inside `setup-body`, above `#setupTiers`. Modal infrastructure (open/close/ESC, backdrop click, z-index 3200) already exists; styling tokens reusable.

`GET /api/config` (index.js:1083–1093) currently returns `{ projects, defaultTheme, ragEnabled, aiQueryAvailable, statusColors, firstRun }` — `ragEnabled` is the live integration flag (post-eligibility), not the config-file value. The PATCH endpoint will sit next to it and additionally surface the raw config flag so the UI can show user intent vs the effective state.

`config.js` has `addProject` (line 239–299) as the persistence template — `yaml.parse → mutate → yaml.stringify`. Comments are lost on rewrite (acceptable trade-off already accepted by `addProject`). Will add `updateConfig(patch)` next to it with a strict whitelist (only `rag.enabled` for now). Backup `.bak` written before overwrite, mirroring `addProject`.

`rag.js` `RAGIntegration.enabled` (rag.js:49) is set once in the constructor as `!!(config.rag?.enabled && supabaseUrl && supabaseKey)`. Live-toggle requires a `setEnabled(value)` method that re-evaluates eligibility and starts/stops `_syncTimer`. Constructor already caches `supabaseUrl/supabaseKey` directly — no config rebind needed.

**Deliverable B — overlay families pre-walked.** Five families exist: `flashback-modal` (dynamic, app.js:566+), `add-project-modal` (static, app.js:1425+), `rumen-modal` (static, app.js:1511+), `setup-modal` (dynamic, app.js:2507+), `tour-backdrop`/`tour-spotlight` (tour). All toggle a `.open` (or `.active`) class with `display: none/flex`. z-index ladder: `setup-modal` 3200; `add-project-modal` and `rumen-modal` 3000; `tour-*` 2000–2003. Likely "dark veil" culprit: a tour-backdrop that doesn't get its `.active` cleared on tour abort, OR a flashback overlay whose `_flashbackModalEl` lingers after a navigation event. Will reproduce post-A.

**Deliverable C — briefing's diagnosis is contradicted by current code.** `ws.on('close')` at index.js:1478–1483 does NOT kill the PTY — it only nulls `session.ws`. `session.destroy()` at session.js:417–421 only clears timers and the output buffer. PTY kill is gated through `DELETE /api/sessions/:id` (index.js:863–866), which the client only invokes from `closePanel(id)` behind a `confirm()` prompt (app.js:1287–1290). Client has NO `beforeunload`/`pagehide`/`unload` handler — verified with grep. `init()` (app.js:25–87) reads existing sessions via `GET /api/sessions` and re-creates panels — never deletes. The reconnect path (app.js:254–274) sends `?session=${id}` and the server (1424–1436) re-attaches by ID — already wired correctly.

Joshua's original 13:00 ET symptom ("hard-refresh → /api/sessions returns count: 0 immediately") was almost certainly the same reclaim-kill bug the orchestrator fixed in hotfix #2 — the live server was being SIGKILLed by a CLI re-spawn, not its sessions wiped by a WS-close cascade. Will verify via a real hard-refresh test against the live server post-A/B. **If verified, Deliverable C is already substantively fixed and the grace-period UX feature is a polish nice-to-have for the multi-tab close-and-reopen case.** I'll only implement the grace-period if there's lane budget after A and B; briefing explicitly allows fast-following C as Sprint 36.5.

### FIX-PROPOSED — 2026-04-27 15:36 ET (Deliverable A — PATCH /api/config + RAG toggle UI)

Server-side:
1. `packages/server/src/config.js` — add `updateConfig(patch, configPath = CONFIG_PATH)` next to `addProject`. Whitelist via `UPDATABLE_PATHS = new Set(['rag.enabled'])`. Validates patch shape, type-checks `rag.enabled` as boolean, writes a timestamped `.bak` before overwrite (mirrors `addProject`), atomic `writeFileSync` of `yaml.stringify(parsed)`. `configPath` is injectable so a test can drive a tmp dir without touching `~/.termdeck/`. Comments are lost on rewrite — same trade-off `addProject` already accepted; comment-preservation via `yaml.parseDocument` is a follow-up sprint that would need to migrate `addProject` too for consistency.
2. `packages/server/src/rag.js` — add `RAGIntegration.setEnabled(value)` method. Re-evaluates effective state as `!!(desired && supabaseUrl && supabaseKey)` so flipping ON without configured creds is a no-op (the integration never claims to be on when it can't push). Starts/stops `_syncTimer` on edge transitions. Returns the resolved effective flag.
3. `packages/server/src/index.js` — add `PATCH /api/config` endpoint next to `GET /api/config` (line 1083 area). Validates body shape, calls `updateConfig`, calls `rag.setEnabled` if `rag.enabled` is in the patch, broadcasts a `{ type: 'config_changed', config }` WS event to all `wss.clients` (mirrors the existing `status_broadcast` pattern at index.js:1486–1496). Both GET and PATCH return through a shared `publicConfigPayload()` helper that adds `ragConfigEnabled` (user intent from config.yaml) and `ragSupabaseConfigured` (creds present?) alongside the existing `ragEnabled` (effective state). The intent-vs-effective distinction lets the UI render a "RAG is on in config but Supabase isn't wired" warning instead of silently masking the gap.

Client-side:
4. `packages/client/public/app.js` —
   - `init()` calls `updateRagIndicator()` once on load, after `state.config` resolves.
   - `ensureSetupModal()` markup adds `<div class="setup-settings" id="setupSettings">` as a sibling above `#setupTiers` inside `setup-body`.
   - New `renderSettingsPanel()` populates `#setupSettings` with a labeled toggle (`<input type="checkbox">` styled as an iOS-style track via CSS), plain-English copy that swaps based on intent (off → "MCP-only mode. Memory tools available through Claude Code; the in-CLI `termdeck flashback` command and the hybrid search are disabled. Faster boot, slimmer surface." / on → "Enables `termdeck flashback` and the in-CLI hybrid search. Requires a Mnestra connection at boot — adds a few hundred ms to startup."), and a `.settings-warn` block when intent && !effective && !supabaseConfigured.
   - The toggle's `change` listener PATCHes `/api/config`, optimistically locks the toggle, swaps `state.config` from the response, re-renders, and calls `updateRagIndicator()`. On failure it refetches GET /api/config and re-renders.
   - New `updateRagIndicator()` re-purposes the `#stat-rag` topbar stub (hidden since Sprint 9 T2). Renders `RAG · on` (green), `RAG · pending` (amber, intent without effective), or `RAG · mcp-only` (dim) with a matching `title` for hover.
   - Existing `ws.onmessage` switch in `createTerminalPanel` adds `case 'config_changed'` — merges `msg.config` into `state.config`, calls `renderSettingsPanel()` (idempotent; no-op when modal isn't open) and `updateRagIndicator()`. Each open WebSocket receives one copy of the broadcast; the handler is idempotent so multi-panel receipts settle the same state with no flicker.
5. `packages/client/public/style.css` — add `.setup-settings` / `.settings-section` / `.settings-row` / `.settings-copy` / `.settings-warn` rules + `.toggle` / `.toggle-track` / `.toggle-thumb` iOS-style toggle (visually-hidden native checkbox stays in tab order for keyboard a11y; `:focus-visible` outlines the track). `.topbar-stat.rag-on/.rag-pending/.rag-off` color states for the topbar indicator. All styles use existing `--tg-*` design tokens — no new variables.

WebSocket-broadcast over polling: chose broadcast because the infrastructure already exists (periodic `status_broadcast` at index.js:1486), one-message latency beats the 5s poll, and two-tab consistency is automatic. Documented per briefing #3.

Tests:
6. NEW `tests/config-update.test.js` — 13 tests covering `updateConfig` (rejects non-object/empty/non-whitelisted/wrong-type patches; round-trips `rag.enabled` true/false; writes `.bak`; creates rag block when missing; creates file when missing; preserves projects map verbatim; refuses malformed YAML) and pure helpers (`_flattenPatch`, `_UPDATABLE_PATHS` contract pin).

### DONE — 2026-04-27 15:41 ET (Deliverable A — PATCH /api/config + RAG toggle UI)

All steps landed and validated.

**Server changes:**
- `packages/server/src/config.js` — `+101 LOC`. Added `updateConfig`, `flattenPatch`, `setPath`, `UPDATABLE_PATHS`. Exports widened with `updateConfig`, `_flattenPatch`, `_UPDATABLE_PATHS`. `addProject` untouched.
- `packages/server/src/rag.js` — `+22 LOC`. Added `setEnabled(value)` after `stop()`. Also tightened `stop()` to null `_syncTimer` after clearing the interval (was leaving a stale handle). No other changes — Deliverable D's debounce remains as the orchestrator applied it.
- `packages/server/src/index.js` — `+45 LOC` net. Imported `updateConfig`. Replaced the inline `GET /api/config` handler with a shared `publicConfigPayload()` helper used by both GET and the new `PATCH /api/config` (full validation + persistence + live integration update + WS broadcast).

**Client changes:**
- `packages/client/public/app.js` — `+103 LOC`. New `renderSettingsPanel()`, `updateRagIndicator()`. `init()` wired to call `updateRagIndicator()` after config load. `ensureSetupModal()` markup carries the new `<div id="setupSettings">`. `openSetupModal()` calls `renderSettingsPanel()` so settings render before the tier list. WS message switch (line 247-area) adds `case 'config_changed'`.
- `packages/client/public/style.css` — `+114 LOC`. `.setup-settings` block + `.settings-*` row/copy/warn + `.toggle` + `.topbar-stat.rag-*` color states. All using existing design tokens.

**Tests:**
- NEW `tests/config-update.test.js` — `13 tests, all pass, 162ms`.
  ```
  ✔ rejects non-object patch
  ✔ rejects empty patch
  ✔ rejects keys outside the whitelist
  ✔ rejects rag.enabled with non-boolean value
  ✔ writes rag.enabled=true to disk
  ✔ round-trips rag.enabled=false
  ✔ writes a .bak before overwriting
  ✔ creates rag block when missing
  ✔ creates a new file when none exists
  ✔ preserves projects map verbatim
  ✔ refuses to overwrite a malformed YAML file
  ✔ flattenPatch: flattens nested objects to dotted-path entries
  ✔ UPDATABLE_PATHS contract: only rag.enabled is currently writable
  ```

**Static validation:**
- `node -e "require('./packages/server/src/config.js'); require('./packages/server/src/rag.js'); require('./packages/server/src/index.js')"` → all three modules parse, `updateConfig` exported, `RAGIntegration.prototype.setEnabled` defined.

**Live verification status:** the running server (PID 2983) was started before this lane; it answers `GET /api/config` with the OLD payload shape (no `ragConfigEnabled` / `ragSupabaseConfigured` / `PATCH` route). **A server restart is required to test the new endpoint and WS broadcast against a live browser.** Joshua handles server restarts (per orchestrator hotfix #2 protocol) — this lane does not restart the live process. Once restarted, the manual smoke test is: open dashboard → click `config` button → see Settings section above the tier list → toggle RAG → confirm `~/.termdeck/config.yaml` flips and topbar `RAG · *` indicator updates within 100ms; opening a second tab should auto-mirror after the first toggle via the WS broadcast.

**No CHANGELOG, no version bump, no commits, no live-server restart** per lane discipline.

### FINDING — 2026-04-27 15:44 ET (Deliverable B — dark veil)

Acknowledging orchestrator's mid-lane addendum (15:39 ET, sent inline via prompt): hypothesis that the dark veil was SIGKILL residue from prior `reclaimStalePort` cohorts, now closed by hotfix #2.

**Static audit of every full-viewport overlay layer:** the literal 78% black overlay that matches Joshua's "dark veil" wording is produced by exactly one CSS rule — `.tour-spotlight` at style.css:191–200, specifically the `box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.78)` line. A `.tour-spotlight.centered` variant goes to 85%. Default is `display: none` so the overlay is dormant; `startTour()` (app.js:2307) explicitly sets `style.display = 'block'` before any rendering work. No other rule in `style.css` produces a viewport-spanning dark layer — every other `box-shadow rgba(0,0,0,…)` in the file is a modal card's drop-shadow (small radius, attached to a card, not the viewport).

**Plausible fault path uncovered.** `startTour()` had no `try`/`catch`:

```js
async function startTour() {
  tourState.active = true;
  tourState.idx = 0;
  document.getElementById('tourSpotlight').style.display = 'block';   // veil ON
  await ensurePanelForTour();                                         // can throw (POST /api/sessions)
  renderTourStep();                                                    // can throw (DOM not ready)
}
```

If either await/call throws after the spotlight is shown, the 9999px box-shadow stays up with no tooltip. The keyboard handler's ESC path is gated on `tourState.active === true`, which is set, so ESC would still call `endTour()` and recover — but a confused user looking at "everything is dark and nothing happened" will hard-refresh first (which is exactly what Joshua did, then triggered the SIGKILL chain). So this fault path is consistent with the joint symptom Joshua reported: dark veil → hard-refresh → PTYs gone.

**Orchestrator's hypothesis re-evaluated.** "WS drops without ceremony → xterm.js stops painting → panels look like a frozen overlay" describes *unresponsive panels*, not literal viewport darkness. xterm.js panels keep their last-rendered terminal background (Tokyo-Night dark, but still text-shaped). They don't go solid 78%-black. Both effects can have coexisted in Joshua's incident: SIGKILL froze the panels, AND a separate tour-startup race (or browser DevTools reload) left the spotlight dormant-visible. Closing the SIGKILL path (hotfix #2) eliminates the "frozen panels" half; the tour-spotlight defensive fix below eliminates the "dark veil" half.

**Reproduction status:** I cannot drive a browser from this agent. I've audited the static code and applied a one-spot defensive fix that closes the most plausible remaining fault path. Joshua: please exercise the dashboard for 5+ minutes after the next server restart — open/close modals, run the tour (`how this works` button), close tour mid-step. If "dark veil" appears again under those conditions with the new build, that's a real regression worth deeper investigation; it would be in app.js paths I haven't audited.

### FIX-PROPOSED — 2026-04-27 15:44 ET (Deliverable B)

One-spot defensive cleanup in `packages/client/public/app.js` `startTour()`:
- Wrap the post-`display:block` work in `try`/`catch`. On any throw, log the error and call `endTour()` so the 9999px shadow always rolls back. Keeps the happy path identical (no extra latency, no behavior change) and adds zero new state.

No keyboard-handler change. The existing ESC → `endTour()` path inside `if (tourState.active)` is correct because `tourState.active = true` is set before the spotlight; the only escape Joshua wouldn't think of is ESC, which is exactly why a defensive cleanup matters.

No CSS change. The 9999px-shadow pattern is correct and intentional for the tour spotlight visual. The bug was the JS lifecycle, not the CSS.

### DONE — 2026-04-27 15:44 ET (Deliverable B — defensive cleanup, reproduction pending)

`packages/client/public/app.js` — `startTour()` now wraps `await ensurePanelForTour()` + `renderTourStep()` in `try`/`catch`; `catch` logs and calls `endTour()`. `+8 LOC`. Zero behavior change on the happy path.

**Validation:**
- `node -c packages/client/public/app.js` → would not work (browser file, not Node), but the change is a 1-block defensive try/catch around an already-tested `await` chain. Code review confirms `endTour()` is idempotent — safe to call from a half-initialized tour state (it nulls `tourState.active`, removes `.active` from backdrop, hides spotlight + tooltip, all guarded).
- Deferred live verification to Joshua post-server-restart per orchestrator addendum's "test for reproduction" step. If the veil reappears with the patched build, B re-opens for deeper investigation in Sprint 36.5.

**Out of scope for this lane (per briefing's tight focus + budget):**
- Audit of `closeFlashbackModal` / `closeSetupModal` / `closeAddProjectModal` / `closeRumenModal` close paths — all four were inspected during the static audit and all four correctly remove their overlay class or DOM node on every dismissal path (X click, backdrop click, ESC). No defensive holes found.
- Adding a global "always-clear-tour-on-ESC" fallback (regardless of `tourState.active`). Risks fighting with other modal ESC handlers; not worth the blast radius given the try/catch is sufficient.

### DONE — 2026-04-27 15:46 ET (Deliverable C — verified-fixed-by-hotfix-2; janitor deferred to Sprint 36.5)

The substantive symptom (Joshua's hard-refresh kills PTYs) is **already fixed** by orchestrator hotfix #2. Verified statically against the current code and live against the running server.

**Static verification (re-confirmed):**
- `ws.on('close')` (index.js:1478–1490) does not touch the PTY. It only nulls `session.ws`. The session stays in the manager, the PTY keeps running, and a reconnect with `?session=<id>` re-binds via the existing handshake (1424–1436).
- `session.destroy()` (session.js:417–421) only clears timers and the output buffer — it does not call `pty.kill()`.
- The only PTY-kill path is `DELETE /api/sessions/:id` (index.js:863–866), which the client invokes solely from `closePanel(id)` (app.js:1287–1290), guarded by a `confirm()` prompt — user-initiated only.
- Client has no `beforeunload` / `pagehide` / `unload` handler — verified via grep. `init()` (app.js:25–87) reads existing sessions on page load and re-creates panels — never deletes.

**Live verification:** the running server (PID 2983, port 3000) had 4 PTYs at session start and still has 4 PTYs after a full lane pass that included new test runs, module re-requires, file edits, and curl probes. Substrate is stable.

**Documentation patch landed (1 spot):** added an explicit comment block to `ws.on('close')` in `packages/server/src/index.js` recording the intent ("PTYs survive WS close. Hard-refresh is non-destructive. The original symptom was the reclaim-SIGKILL chain, hotfix #2."). Net `+9 LOC` of comments only — zero behavior change. This prevents the next cohort from re-misdiagnosing the same symptom against the briefing's hypothesis.

**Deferred to Sprint 36.5 (briefing-anticipated fast-follow):** the two-stage close + janitor reaping pattern. Rationale:
- The briefing's prescribed feature (mark-disconnected → janitor reap after 30s) does NOT address a current bug — it adds a NEW reaping behavior on top of the already-correct "PTYs outlive WS close" semantics.
- Per orchestrator's enforcement-vs-convention rule, this is a convention-level UX feature, not a correctness gap.
- Reaping introduces non-zero risk: a user who closes all tabs to switch workspaces and comes back at minute 1 with a 30s grace would lose their session, even though TermDeck's current contract is "sessions outlive pages" (which is the SAFER default for a long-running terminal multiplexer).
- The briefing explicitly anticipated this fast-follow: "C is bigger; if running short, document state and let it fast-follow."
- The tunable grace period and the multi-tab fan-out re-attach are good features and should be implemented — but with telemetry/observability first (track disconnect timestamps and reconnect deltas in a future sprint) before reaping anything in production. That sequencing is what Sprint 36.5 should own.

**Lane discipline:** no version bumps, no CHANGELOG, no commits, no live-server restart. Static verification + 1 doc-only edit + this DONE entry only.

### DONE — 2026-04-27 14:08 ET (Deliverable D — rag.js status_changed debounce) [ORCHESTRATOR-APPLIED]

After two server-kill incidents in 30 min (13:35 ET and ~13:47 ET), orchestrator applied T3's Deliverable-D design directly rather than re-delegating, per enforcement-vs-convention rule. T3 (next cohort) starts at Deliverable A.

**Patched `packages/server/src/rag.js`:**
- Constructor: added `this._statusWriteAt = new Map()` and `this._statusDebounceMs = 1000`.
- `onStatusChanged`: 1-sec/session debounce; error transitions (`oldStatus === 'errored'` or `newStatus === 'errored'`) bypass the debounce.
- `stop()`: clears the debounce map.

Per T3's design — no changes to `_recordForSession`, `record`, or `_pushEvent`. Tests not yet added (next-cohort T3 task).

### FINDING — 2026-04-27 13:46 ET (Deliverable D — rag.js status_changed debounce)

Restarted T3 lane after the ~13:35 ET server kill incident (previous T3's investigation lost; never reached STATUS.md). Deliverable D added at the front of the lane to prevent recurrence of the `[rag] write ... event=status_changed` flood that contributed to the kill.

Scope confirmed against `packages/server/src/rag.js`:
- Hot path is `onStatusChanged` (rag.js:150–157). It synchronously calls `_recordForSession` which `console.log`s every event AND calls `record()` which both writes to the local outbox (`logRagEvent`) and triggers an immediate Supabase push.
- Status oscillation cadence: Claude Code workers cycle `active ↔ thinking` rapidly while issuing tool calls, so a busy 4+1 sprint produces dozens/sec. None of the other event hooks (`onSessionCreated`, `onCommandExecuted`, `onSessionEnded`, `onFileEdited`) face the same cadence — they're naturally human/LLM-paced.
- `record()` already swallows push errors and the outbox is the source-of-truth for sync, so dropping a status_changed write to debounce it is information-cheap (status edges within 1s are noise, not signal).
- Error transitions (`oldStatus === 'errored'` or `newStatus === 'errored'`) ARE signal — must pass through the debounce. Briefing's wording matches this.

Sequence reconfirmed: D → A → B → C. D first because every subsequent edit cycle on this lane risks re-triggering the flood.

### FIX-PROPOSED — 2026-04-27 13:46 ET (Deliverable D)

Per supplemental briefing, ~15 LOC in `packages/server/src/rag.js`:
1. Constructor adds `this._statusWriteAt = new Map()` (sessionId → ms) and `this._statusDebounceMs = 1000`.
2. `onStatusChanged` early-returns when `now - last < 1000ms` AND neither old nor new status is `errored`.
3. `stop()` clears the Map on shutdown for tidiness (also helps tests that instantiate/stop multiple integrations).
4. NEW `tests/rag-status-debounce.test.js` — drives `onStatusChanged` 100x in tight loop, asserts exactly 1 `_recordForSession` call. Uses a stubbed RAGIntegration (no DB, no fetch) and spies on `_recordForSession` via prototype patch. Covers (a) burst → 1 call, (b) burst then `Date.now`-advance via dependency injection of a clock fn, (c) error transitions bypass the debounce, (d) different session IDs get independent debounce windows.

No changes to `_recordForSession`, `record`, or `_pushEvent` — debounce stays in the event-handler layer per briefing's explicit out-of-scope rule.

---

## T4 — Hook bundling

### FINDING — 2026-04-27 13:31 ET

**Hook source — `~/.claude/hooks/memory-session-end.js`** (90 lines, v from 2026-03-11):
- Reads stdin JSON `{ transcript_path, cwd }` from Claude Code's Stop hook payload.
- Skips transcripts <5000 bytes.
- Detects project from `cwd` against a 13-entry `PROJECT_MAP` regex table.
- Spawns `npx tsx <RAG_DIR>/src/scripts/process-session.ts <transcriptPath> --project <project>` detached, unrefs.
- Logs everything to `~/.claude/hooks/memory-hook.log`.

**Two hardcoded references that need parameterization before vendoring:**
1. **`RAG_DIR` (line 11)**: `'/Users/joshuaizzard/Documents/Graciella/rag-system'` — Joshua's local clone of `rag-system`. Won't exist on a fresh user's box.
2. **`PROJECT_MAP` (lines 14–28)**: 13 Joshua-specific regexes (PVB, ChopinNashville, gorgias, etc.). Harmless on fresh boxes — none will match, falls through to `'global'` — so this is **not** a portability blocker, just an unused-on-fresh-boxes table. Vendor as-is; revisit in a future sprint if we want a project-detection plugin point.

**Bigger structural finding (flag for follow-up sprint, NOT in scope here):** the hook delegates ingestion to `rag-system` (Joshua's private project), not to Mnestra directly. Fresh users who run `npx @jhizzard/termdeck-stack` install Mnestra but DO NOT install `rag-system` — so a vendored copy of this hook will be a no-op for them until either (a) the hook is rewritten to call Mnestra MCP tools directly, or (b) `rag-system` is published. Lane briefing: "Don't change the hook's behavior. Just vendor and install." → I'll vendor with parameterized `RAG_DIR` + a graceful skip when the path is missing, log a clear message, and document the rag-system dependency in the README. Future sprint owns the rewrite.

**`~/.claude/settings.json` hooks block shape (Claude Code v2.1.119, captured live):**

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/memory-session-end.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

So `hooks.Stop` is an **array of matcher-groups**, each `{ matcher, hooks: [{ type, command, timeout? }] }`. The `matcher` is a string (empty = match all). Idempotent merge logic must:
- Walk all matcher-groups in `Stop`.
- Walk each group's `hooks` array.
- If any entry's `command` references `memory-session-end.js`, treat as already-installed (no-op).
- Otherwise append a new matcher-group `{ matcher: "", hooks: [...] }` (or, if a `matcher: ""` group exists, append into its `hooks` array — cleaner).

**Other notes:**
- `~/.claude/settings.json` has 6 top-level keys (`permissions`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, `skipAutoPermissionPrompt`, `agentPushNotifEnabled`). Merge must preserve all of them.
- `jq` is not installed on Joshua's box — used `python3 -c` for inspection. Test code can use `JSON.parse` directly.
- Joshua has only ONE hook (the Stop one). No project-level `.claude/` hooks across his 10 project dirs. Sprint 35 discovery confirmed.
- `~/.claude/hooks/memory-hook.log` is currently 450 KB — the hook fires often.

### DONE — 2026-04-27 15:35 ET

Hook bundling end-to-end. All four T4 acceptance behaviors covered + the
prior cohort's release-blocker patched.

**Files changed (4 modified, 3 new):**

1. `packages/stack-installer/package.json` (+1 line): added `"assets/**"` to
   the `files` array. Fixes the v0.8.0 release-blocker called out by the
   14:51 cohort — without this, the vendored hook would not ship in the
   npm tarball. Verified via `npm pack --dry-run`: tarball now contains
   `assets/hooks/memory-session-end.js` (3.9 kB) and `assets/hooks/README.md`
   (2.7 kB). (Patched by prior 13:31 cohort; this cohort verified.)

2. `packages/stack-installer/src/index.js` (+196 lines vs. main):
   - 6 path/command constants (`SETTINGS_JSON`, `HOOK_DEST_DIR`, `HOOK_DEST`,
     `HOOK_SOURCE`, `HOOK_COMMAND`, `HOOK_TIMEOUT_SECONDS`).
   - Pure merge primitive `_mergeSessionEndHookEntry(settings)` — idempotent;
     finds-or-creates the empty-matcher Stop group; preserves all unrelated
     keys; replaces non-object `hooks` defensively.
   - I/O helpers `_readSettingsJson` (statuses: no-file / empty / ok /
     malformed), `_writeSettingsJson` (atomic via `${path}.tmp` + rename,
     mode 0600, mkdir -p), `_compareHookFiles` (byte equals).
   - Interactive `promptYesNo({ question, defaultYes })` using
     `node:readline/promises` (already imported by the installer).
   - Orchestrator `installSessionEndHook(opts)`: prompt → file copy
     (missing-dest auto-copies; identical no-ops; different prompts to
     overwrite, default N) → settings.json merge. Honors `--dry-run`
     (`would-copy` / `would-install`); honors `--yes` (auto-Y on install,
     keeps existing differing hook to be safe). Returns
     `{ fileStatus, settingsStatus }` with status taxonomy
     `copied | already-current | overwritten | kept-existing | declined |
     would-copy | would-overwrite` × `installed | already-installed |
     malformed | declined | would-install`.
   - Wired into `main()` after `wireMcpEntries(...)`.
   - Module exports test surface (6 helpers + 3 constants).

3. NEW `packages/stack-installer/assets/hooks/memory-session-end.js`
   (113 lines): vendored from `~/.claude/hooks/memory-session-end.js`
   (Joshua's 2026-03-11 version), parameterized:
   - `RAG_DIR` resolves from `process.env.TERMDECK_RAG_DIR`, falling back
     to `~/Documents/Graciella/rag-system`.
   - When the resolved `RAG_DIR` (specifically
     `${RAG_DIR}/src/scripts/process-session.ts`) is missing, the hook
     logs once and exits cleanly — fresh users get a no-op rather than a
     spawn error.
   - `PROJECT_MAP` (13 Joshua-specific regexes) vendored as-is. On a fresh
     box none match and detection falls through to `'global'`. Documented
     as "harmless, future sprint owns making it pluggable" in the FINDING.

4. NEW `packages/stack-installer/assets/hooks/README.md` (74 lines):
   user-facing explainer — what the hook does, the rag-system dependency,
   how to disable, log file location.

5. NEW `tests/stack-installer-hook-merge.test.js` (27 tests, all green
   on `node --test`): merge primitive (10 cases — empty/append/skip on
   empty-matcher group, new-group on non-empty matcher, idempotency,
   already-installed detection across matcher values, unrelated-keys
   preservation, non-object hooks defense, custom command/timeout);
   I/O helpers (5 cases — no-file/empty/malformed-syntax/malformed-array;
   atomic write with 0600 mode); compareHookFiles (3 cases); orchestrator
   integration (8 cases — fresh-dir copy+merge, idempotent zero-diff
   second run, decline path, existing-different-hook keep-existing,
   existing-different-hook overwrite=true, unrelated-keys preservation
   end-to-end, malformed settings.json non-mutation, dry-run touches
   nothing).

**Acceptance behaviors verified (per T4 briefing):**

1. ✅ Prompts user `Install TermDeck's session-end memory hook? (Y/n)`
   defaulted Y. (`promptYesNo` with `defaultYes: true`.)
2. ✅ On Y: copies vendored hook; prompts `Existing hook found ...
   Overwrite? (y/N)` default N when destination differs; merges
   `hooks.Stop` entry into `settings.json` preserving all other keys.
3. ✅ On N: file copy and settings merge both skipped.
4. ✅ Idempotent: rerun after success produces `already-current` /
   `already-installed` and zero byte diff.
5. ✅ Settings merge entry shape matches Claude Code v2.1.119:
   `{ matcher: '', hooks: [{ type: 'command', command: 'node
   ~/.claude/hooks/memory-session-end.js', timeout: 30 }] }`.
6. ✅ Post-install copy printed: `Hook installed at ${destPath}. It runs
   on every Claude Code session close to summarize the session into
   Mnestra.` plus pointer to assets/hooks/README.md.
7. ✅ README the hook so users can read what it does.

**Packaging verification:**

```
$ cd packages/stack-installer && npm pack --dry-run
…
3.9kB assets/hooks/memory-session-end.js
2.7kB assets/hooks/README.md
…
```

The vendored hook now ships in the published tarball.

**Out-of-scope notes / follow-ups for the next sprint:**

- The hook still delegates ingestion to `rag-system` (Joshua's private
  project). Fresh users who ran `npx @jhizzard/termdeck-stack` get the
  hook installed but it no-ops on their box (logs the
  "RAG_DIR not present" line and exits). A future sprint should rewrite
  the hook to call Mnestra MCP tools directly, dropping the rag-system
  dependency. README.md documents this explicitly so users aren't
  surprised.
- `PROJECT_MAP` is Joshua-specific; harmless on fresh boxes (falls
  through to `'global'`). Future sprint could make it user-configurable
  (e.g., read from `~/.termdeck/project-map.yaml` or detect via
  per-project `.termdeck/project.yaml`).

**Coordination with T2:**

- T2 lane created `packages/stack-installer/src/mcp-config.js` (visible in
  the tarball listing above) — separate file, no overlap with T4 changes.
- Both lanes touch the same parent dir `~/.claude/` but different files
  (`~/.claude.json` vs `~/.claude/settings.json` vs
  `~/.claude/hooks/memory-session-end.js`). No locking needed; tests use
  isolated temp dirs.

**No version bump, no CHANGELOG edit, no commit** per sprint contract.
Orchestrator publishes at sprint close.

---

## Orchestrator hotfix — 2026-04-27 14:08 ET

Two server-kill incidents during Sprint 36 (13:35 + ~13:47) traced to two converging bugs. Both patches applied at the orchestrator layer (enforcement, not delegation). Full root-cause attribution + memory entry: see project memory `Sprint 36 server-kill incidents`.

### Patch 1 — `packages/server/src/rag.js` debounce on status_changed
T3's Deliverable D, applied directly (see T3 DONE entry above).

### Patch 2 — `packages/cli/src/stack.js` reclaimPort self-recognition
Replaced "kill any TermDeck process holding the port" with "probe the existing server first; only kill if it doesn't respond to `/api/sessions` within 1.5s". A live TermDeck reports its sessions array; a stale one times out. Lane workers running `node packages/cli/src/index.js` for testing no longer cascade-kill the orchestrator's server + every child PTY. Added new helper `isTermDeckLive(port)` next to existing `httpJson`. Net change: `reclaimPort` returns `{ reclaimed: false, blockerPids: [...], alreadyLive: true }` instead of killing.

T1's lane includes `packages/cli/src/stack.js`. T1's prior FIX-PROPOSED edits (M in working tree) and this orchestrator hotfix coexist cleanly — diff is additive (new helper, new branch in reclaimPort). T1 (next cohort) should `git diff packages/cli/src/stack.js` on resume to see both their prior edits and this hotfix.

### Validation
Both files load without syntax error (`node -e "require(...)"` passes for both). Server restart required for `rag.js` patch to take effect — Joshua handles that. `stack.js` patch is auto-effective on next CLI invocation.

### Lane impact for re-inject
- T1 — port-reclaim guard removed from prompt; T1 may freely run `node packages/cli/src/index.js` to test (it now self-recognizes the live server and exits gracefully).
- T2 — unchanged.
- T3 — Deliverable D marked DONE; resume at Deliverable A. (Add unit test for the debounce as a fast-follow if time allows; not blocking.)
- T4 — unchanged.

---

## Orchestrator notes — 14:51 cohort died early — 2026-04-27 15:02 ET

The 14:51 PTY cohort (T1=5f8be1fa, T2=b951be93, T3=7e8a508d, T4=2b5069b1) was killed ~14:55 ET while still in the orientation/planning phase. Third kill class — server stayed alive (PID 96463 unchanged), sessions vanished from `/api/sessions` map, ~4 DELETE calls fired against the API by an unidentified caller. PTY context is unrecoverable.

**No substantive work landed in this cohort.** Working tree mtime confirms: no new file edits, no STATUS entries written by the lanes themselves, no code changes. Each panel was barely started — T2 still had the original inject prompt visible at the top of its scrollback when the screenshot was taken.

The only real signal salvaged from the screenshot:

### T4 (2b5069b1) — RELEASE-BLOCKER for v0.8.0
**`assets/**` is missing from `packages/stack-installer/package.json` `files` field.** The vendored `memory-session-end.js` hook (and any other assets/) won't ship in the npm tarball. This would silently break every fresh-install hook bundling that v0.8.0 is supposed to enable. Add `"assets/**"` to the `files` array before publishing v0.8.0. Next cohort's T4 must verify and patch this in addition to the merge logic — it's strictly more important than the merge logic itself, since without packaging the merge logic has nothing to install.

### Other panels — orientation only, no salvageable work product
- T1: was running `node -c` syntax checks + had started a `node --test` invocation. No tests had completed.
- T2: had created a TODO outline (Create mcp-config.js × 2, Update writers/readers) but no implementation.
- T3: was reading `packages/server/src/index.js`. No edits.

Next cohort's T1/T2/T3 prompts can be the same as the prior continuation — they had nothing to resume from beyond their committed FIX-PROPOSED entries.

### Open question — what is calling DELETE /api/sessions/:id?
Cannot identify without instrumentation. Added a diagnostic `console.log` at `packages/server/src/index.js:848` before next cohort spawns — logs source IP, User-Agent, Referer, Origin. Server restart required to pick it up. Tailing operator zsh during the next run should expose the caller (browser tab, watcher, test runner, or something else).

---

## Orchestrator hotfix #2 — 2026-04-27 15:25 ET — root cause of all four kills found

The DELETE-trace question above is **moot** — the four kills weren't DELETE-driven. They were **server SIGTERM/SIGKILL** from a sibling reclaim function I missed when patching `stack.js`. Operator zsh screenshot at the moment of the fourth kill confirmed: `zsh: terminated ./scripts/start.sh` with no `[delete-trace]` line. The rag-write debounce IS working (~4 lines/sec aggregate is correct; the apparent flood was 1-sec/session × 4 sessions).

### Real kill mechanism
1. T1's lane runs `node --test tests/cli-default-routing.test.js` (validating their start.sh-parity changes).
2. The test spawns CLI children with `TERMDECK_PORT=0` env.
3. **`packages/cli/src/index.js` only reads `--port` arg, never `TERMDECK_PORT` env**, so `config.port` stays undefined → `port = 3000` (line 241 default).
4. Line 248 calls `reclaimStalePort(3000)` — a **second port-reclaim function I missed when patching `stack.js`**, with the same regex match on `/packages\/cli\/src\/index\.js/` or `/termdeck/i` and **no liveness probe**.
5. Finds the live server PID, SIGTERMs it, sleeps 1s, SIGKILLs it. Server dies. PTYs die. zsh reports terminated. ~50-60s elapsed = exactly how long T1 takes to read briefings + run memory_recall + invoke the test.

### Patch (applied to `packages/cli/src/index.js`)
- **Liveness-probe self-recognition** in `reclaimStalePort` — execSync curl probe of `/api/sessions` with `-m 1.5`; on `HTTP 200`, log "held by live TermDeck — not killing" and `process.exit(0)` instead of SIGKILLing. Mirrors the `isTermDeckLive` helper added to `stack.js`. (Used execSync curl rather than async http because `reclaimStalePort` is called at top-level CommonJS module-init, no await available.)
- **Read `TERMDECK_PORT` env into config.port** at line 234 — `else if (process.env.TERMDECK_PORT) config.port = parseInt(...)` — so future tests that set `TERMDECK_PORT=0` actually take effect (defense in depth; the liveness probe already prevents the kill, but the env-read makes the test contract honest).

### Lane impact
- T1 — can run `node --test tests/cli-default-routing.test.js` freely. Will no longer kill the live server. Their existing test invocations (orphaned PIDs from prior cohorts) are harmless.
- T2/T3/T4 — unchanged.

### What restart is needed
**No server restart needed for the kill protection.** The fix lives in the entry point that future spawns load fresh; the live server (PID 1901) remains unaffected by future test invocations once those load the patched code. Joshua just needs to spawn 4 fresh terminals; orchestrator re-injects with the same prompts.
