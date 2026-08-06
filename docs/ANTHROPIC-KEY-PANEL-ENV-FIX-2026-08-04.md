# ANTHROPIC_API_KEY Panel-Env Hygiene Fix — Handoff for Next Orchestrator Session

**Date:** 2026-08-04
**Severity:** Billing-critical environment hygiene (RED audit finding, near-miss)
**Status:** Investigated, fix specified, NOT yet implemented. Interim operator mitigation in §4.

---

## §1 Incident summary (near-miss — get the framing right)

On 2026-08-01 the operator purchased **$900 of Anthropic Console API credits** believing
Claude Code (running in TermDeck panels) needed them. It did not — the operator's Max plan
at `admin@nashvillechopin.org` covers Claude Code. **CORRECTED FACTS: the $900 was NOT
consumed. Refund processed 2026-08-04; actual API consumption was ~negligible. This is a
NEAR-MISS, not a burn.** Do not carry forward any "we burned $900" framing.

The RED finding, verbatim facts:

- `ANTHROPIC_API_KEY` lives at `~/.termdeck/secrets.env:14`.
- It is consumed via `~/.termdeck/config.yaml:67` (`anthropicApiKey: ${ANTHROPIC_API_KEY}`,
  inside the `rag:` section).
- It sits in the **running TermDeck server's process env** (PID 994 — verified live via
  `ps eww 994` during this investigation: the key IS present).
- Every panel PTY inherits the server's env wholesale, **plus** a second independent
  merge of secrets.env directly into each PTY env (see §2, Vector B).
- Claude Code **silently prefers an env `ANTHROPIC_API_KEY` over Max-plan OAuth**. A panel
  with the key in env routes ALL its token traffic to Console API billing; `/status` shows
  "API key" instead of the Max account, but nobody looks unless prompted.

**The vector is live today.** Any future panel session — especially a dual-deck 3+1+1
sprint with 8 high-token worker/auditor panels — would route Max-plan-covered work to API
billing silently. The only reasons this stayed a near-miss: consumption happened to be
negligible and Anthropic granted the refund. Neither is a control.

Legitimate API-key workloads (ForeCede advisor, Podium processing) must carry their keys
in **their own service envs**, never via TermDeck's panel inheritance.

Shell-rc check (clean): `~/.zshrc` / `~/.zprofile` / `~/.zshenv` do NOT source
secrets.env — the leak surface is entirely TermDeck-mediated. That makes the fix fully
ours to ship.

---

## §2 Dependency map (what actually consumes the key)

### 2a. Runtime consumers — what breaks if the key vanishes from panel envs

**Answer: nothing panel-side.** No panel feature reads `ANTHROPIC_API_KEY`. The single
runtime consumer runs **inside the server process**, not in any child:

| Consumer | File:line | What it does | Behavior without key |
|---|---|---|---|
| Session-log LLM summaries | `packages/server/src/session-logger.js:132` (`config.rag?.anthropicApiKey \|\| process.env.ANTHROPIC_API_KEY`); API call `:85-93` (`api.anthropic.com`, model from `config.sessionLogs.summaryModel`, default `claude-haiku-4-5` per `config.js:165`) | Optional Haiku summary appended to session logs | **Graceful**: `:147` warns `ANTHROPIC_API_KEY not set — writing logs without LLM summary` and continues |

That is the ONLY `api.anthropic.com` call site in `packages/server/src` (grep-verified;
the advisor, morning-brief/cron, periodic capture, and Mnestra hooks do NOT use it —
Mnestra's hooks need `OPENAI_API_KEY` for embeddings, not Anthropic).

### 2b. Config/plumbing sites (write-side, not API consumers)

- `packages/server/src/config.js:29` — `['rag','anthropicApiKey']` in the `${VAR}`
  interpolation registry; `:151` default `null`; `:232` example template.
- Setup wizard: `packages/server/src/index.js:1508/1555` (`POST /api/setup/configure`
  writes the key into secrets.env), `:1568` (**exports it into the live server's
  `process.env` at runtime** — re-arms Vector A without a restart), `:1817-1829`
  (autopilot pass-through), `:4671` + `:4687` (`updateConfigYamlForRag` **auto-re-adds**
  `anthropicApiKey: ${ANTHROPIC_API_KEY}` to config.yaml whenever the rag section is
  rewritten — deleting line 67 by hand is NOT durable), `setup/yaml-io.js:57,81`.
- CLI init flows (init-time only, run in the operator's own shell, not panels):
  `packages/cli/src/init.js:278,455-456` (skips Rumen Tier 3 without the key),
  `init-mnestra.js:173,244,521,550`, `init-rumen.js` (pushes the key to **Supabase
  edge-function secrets** via `supabase secrets set`).
- Rumen edge functions (`packages/server/src/setup/rumen/functions/*`) read
  `Deno.env.get('ANTHROPIC_API_KEY')` — **in Supabase cloud, from their own vault**.
  Completely unaffected by anything we strip locally.
- `~/.termdeck/config.yaml.*.bak` — **7 of the ~13 backups carry the
  `${ANTHROPIC_API_KEY}` pattern**. Inert (nothing reads .bak), but a restore-from-bak
  re-activates the config reference. Dormant re-activation risk; the durable fix (§3)
  makes this harmless anyway because the boundary moves to the spawn site.

### 2c. Spawn-site analysis — HOW the key reaches panels (two independent vectors)

**The PTY spawn site:** `packages/server/src/index.js:2453-2467`:

```js
const term = pty.spawn(spawnShell, args, {
  ...,
  env: {
    ...process.env,        // ← Vector A: server env passed WHOLESALE
    ...secretFallback,     // ← Vector B: secrets.env merged per-key
    ...adapterSpawnEnv,    // adapter-declared overlays (land last, win)
    TERMDECK_SESSION: session.id, ...
  }
});
```

**Vector A — server env inheritance.** The stack-installer launcher
(`packages/stack-installer/src/launcher.js:325`) builds
`childEnv = { ...process.env, ...secrets }` from a full parse of secrets.env — **no
exclusion list at the launcher level** — and spawns the TermDeck server with it (`:344`,
Step 4; Mnestra at `:332` gets the same). That is how PID 994's env got the key. The
spawn site then spreads `process.env` into every panel. Secondary re-arm: the setup
wizard's `index.js:1568` injects the key into the running server's env directly.

**Vector B — direct secrets.env merge.** `readTermdeckSecretsForPty()`
(`index.js:196-224`, cached once per server lifetime at `:140`) reads secrets.env and
merges every key into the PTY env as a fallback, excluding ONLY the five
management-grade tokens in `SECRETS_EXCLUDED_FROM_PTY` (`index.js:162-168`:
`SUPABASE_ACCESS_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PAT`, `OPENAI_ADMIN_KEY`,
`NPM_TOKEN`). `ANTHROPIC_API_KEY` is **deliberately passed through**, and the test suite
**locks the leak in**: `packages/cli/tests/spawn-env-exclusion.test.js:82` asserts
`!SECRETS_EXCLUDED_FROM_PTY.has('ANTHROPIC_API_KEY')` and `:191` asserts
`out.ANTHROPIC_API_KEY === 'sk-ant-real'`. **The fix must flip these assertions** — a
naive add-to-the-set will correctly fail CI until the tests are updated.

Both vectors must be closed. Killing only the secrets.env line leaves Vector A armed
until the server restarts; killing only Vector B leaves `...process.env` leaking.

**Existing precedent for per-panel opt-in:** the adapter env-overlay mechanism
(`index.js:2378-2387`; e.g. codex adapter declares
`env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY }` at
`packages/server/src/agent-adapters/codex.js:463`) lands last and wins. This is the
natural re-injection path for a panel that genuinely wants API billing.

### 2d. `termdeck doctor` — current state

Exists: `packages/cli/src/doctor.js` (entry `:937`). Current sections:
1. npm version check across the stack packages (Sprint 28).
2. Supabase schema check (Sprint 35 T3, `_runSchemaCheck`, pgvector/table/column probes).
3. **Agent CLI auth** (`_runAgentAuthCheck` at `:587`) — iterates adapters that expose a
   `checkAuth(opts)` function, static-only (`live:false`), never spawns/networks.
   **Only `agent-adapters/gemini.js:419` implements it today.** The claude adapter
   (`agent-adapters/claude.js`) has **no `checkAuth`** and declares `env: {}` (`:223`).
4. Standalone-shell shim probes (Sprint 68-REDUX T2 — PATH order, shim resolution,
   real-binary discovery; `--no-shims` to skip).

No section today notices that `ANTHROPIC_API_KEY` would reach panel envs, and nothing
detects Claude Code's auth mode. The registration plumbing for the new check is free:
implement `checkAuth` on the claude adapter and section 3 picks it up automatically.

---

## §3 THE FIX (sprint-ready spec)

Four deliverables, shaped for one lane plus test coverage. Estimated hotfix-sized diff.

### (a) Panel PTY env hygiene — strip billing-routing vars by DEFAULT

New constant in `packages/server/src/index.js`, sibling to `SECRETS_EXCLUDED_FROM_PTY`:

```js
// Billing-routing vars: Claude Code silently prefers these over Max-plan OAuth.
// Stripped from EVERY panel env by default; re-injected only via explicit
// per-panel opt-in (see apiBilling below). 2026-08-01 near-miss: $900 Console
// credits bought under the belief panels needed them (refunded — vector was live).
const BILLING_ROUTING_EXCLUDED_FROM_PTY = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',   // same precedence trap, different var
]);
```

Apply at BOTH vectors in the `pty.spawn` env construction (`index.js:~2410-2467`):
1. **Vector A**: build the base as a filtered copy of `process.env` with
   `BILLING_ROUTING_EXCLUDED_FROM_PTY` keys deleted (do NOT mutate `process.env` —
   the server-side session-logger still needs it).
2. **Vector B**: `readTermdeckSecretsForPty()` additionally skips keys in
   `BILLING_ROUTING_EXCLUDED_FROM_PTY` (or the merged result is filtered at the spawn
   site — either, but cover the union so a future third merge can't resurrect the leak;
   filtering the FINAL env object immediately before `pty.spawn`, after all spreads
   except the opt-in, is the most future-proof placement).

**Per-panel opt-in override:** `POST /api/sessions` accepts `apiBilling: true` (default
false). When true, the spawn site re-injects `process.env.ANTHROPIC_API_KEY` (and
AUTH_TOKEN if set) AFTER the strip — via the existing `adapterSpawnEnv`-style
last-spread position. Persist the flag on `session.meta` so `/api/sessions` output shows
which panels are API-billed (fleet legibility; the dashboard can badge them later).
Validation: reject `apiBilling: true` with 400 if neither var is available server-side,
so the flag never silently no-ops.

### (b) Server-side features keep the key internally — never exported to children

- `session-logger.js` continues reading `config.rag.anthropicApiKey` /
  `process.env.ANTHROPIC_API_KEY` **in the server process**. No change needed — (a)
  filters children only. Add a code comment at `session-logger.js:132` marking this as
  the sanctioned server-side consumer.
- `index.js:1568` (setup wizard's runtime export into `process.env`) is fine to keep
  — it feeds the server-side consumer — but add a comment that panel envs are filtered
  downstream, so this export must never be relied on to reach children.
- Launcher (`launcher.js:325`): optionally mirror the strip for the **Mnestra** child
  (it doesn't need Anthropic), but the server child MUST keep receiving the key (it is
  the sanctioned consumer). Low priority; the spawn-site filter is the load-bearing gate.

### (c) `termdeck doctor` check

Implement `checkAuth(opts)` on `packages/server/src/agent-adapters/claude.js` (auto-picked
up by the existing Agent CLI auth section, `doctor.js:587`):
- **Leak probe:** re-use/require the server's `readTermdeckSecretsForPty` +
  `BILLING_ROUTING_EXCLUDED_FROM_PTY` exports (`index.js:4813` already exports the
  exclusion set — export the new one alongside) and answer: *would ANTHROPIC_API_KEY
  reach a panel env under current code + current secrets.env + current process.env?*
  Post-fix the answer is structurally "no" unless opted in; pre-fix (or on an old server
  version) it flags RED with the remediation hint ("comment out secrets.env:14 +
  restart, or upgrade @jhizzard/termdeck").
- **Auth-mode probe (static, live:false):** inspect `~/.claude.json` / Claude Code
  settings for OAuth-account presence, and report `max-oauth` vs `api-key-env` vs
  `unknown`. If `ANTHROPIC_API_KEY` is in the doctor's own env AND an OAuth account
  exists, emit the warning: "Claude Code will prefer the env API key over your Max
  plan — panels spawned from this env will API-bill."
- Follow gemini.js:419's contract: structured verdict, never throws, never spawns.

### (d) Migration note + CHANGELOG + regression test

- **Migration note** (CHANGELOG + README secrets section): "If you keep
  `ANTHROPIC_API_KEY` in `~/.termdeck/secrets.env` for session-log summaries, that
  continues to work server-side. As of vX.Y.Z it is NO LONGER exported to panel PTYs.
  Panels that should bill to the API must be created with `apiBilling: true`. Genuine
  API workloads (service daemons like ForeCede/Podium) belong in their own service
  envs, not secrets.env."
- **Flip the lock-in tests:** `packages/cli/tests/spawn-env-exclusion.test.js:82`
  (assert the key IS excluded — new set or unioned set, match implementation) and
  `:191` (assert `!('ANTHROPIC_API_KEY' in out)`).
- **New regression test (the acceptance gate):** spawn a real panel (or drive the
  extracted env-builder with a fixture env containing `ANTHROPIC_API_KEY=sk-ant-canary`
  + a secrets.env fixture containing it too — covering BOTH vectors), assert the canary
  is absent from the child env; second case with `apiBilling: true` asserts present.
  Extract the env-construction into a pure `buildPanelEnv({processEnv, secrets,
  adapterEnv, apiBilling})` helper if needed for deterministic testing (same seam
  pattern as `_setSpawnSessionEndHookImplForTesting`).

---

## §4 Interim operator mitigation (tonight, before any panel work)

1. **Comment out the key:** `~/.termdeck/secrets.env:14` → prefix with `#`
   (`# ANTHROPIC_API_KEY=sk-ant-...`). Do NOT delete config.yaml:67 — the wizard
   regenerates it (`index.js:4671`) and with the env var absent, `${ANTHROPIC_API_KEY}`
   interpolation resolves to unset → `config.js` treats it as null. Harmless.
2. **Restart the TermDeck server.** Mandatory: PID 994's env retains the key
   (verified live), and the secrets cache is read-once-per-server-lifetime
   (`_termdeckSecretsCache`, `index.js:140`). Kill + relaunch via the usual launcher.
3. **Verify:** open a fresh panel, run `claude`, then `/status` — must show the Max
   plan login (`admin@nashvillechopin.org`), NOT "API key". Belt-and-suspenders:
   `echo $ANTHROPIC_API_KEY` in the fresh panel must print empty.
4. **What temporarily breaks** (per the §2a map — all graceful):
   - Session-log Haiku summaries: logs still written, with a one-line warn
     (`session-logger.js:147`). Only observable loss.
   - `termdeck init --rumen` / Tier 3 re-provisioning would skip the Anthropic step if
     run while commented (`init.js:455`). Don't run init flows until the durable fix.
   - Rumen edge functions in Supabase: **unaffected** (key already in their vault).
   - Mnestra memory hooks: **unaffected** (they use OPENAI_API_KEY, which stays).

---

## §5 Priority recommendation: HOTFIX before next panel work

**Ship (a)+(d)-core as a hotfix commit BEFORE the next sprint inject; fold (c) doctor +
(b) comments + launcher polish into Sprint 70/71.** Argument from the findings:

1. **The vector is live and scales with exactly the work queued next.** The operator has
   a dual-deck ready — 8 concurrent high-token panels is the worst-case realization of
   this bug. The near-miss stayed near only because consumption was negligible and the
   refund was granted; neither holds for a multi-hour dual-deck sprint burning real
   tokens against Console billing.
2. **The interim mitigation is NOT durable on its own.** The wizard re-adds the config
   line (`index.js:4671`) and re-exports the key into the running server
   (`index.js:1568`); any future secrets.env edit or wizard run silently re-arms both
   vectors; 7 config backups carry the pattern. Only a spawn-boundary strip is durable.
3. **The hotfix is small and fully mapped.** One new Set + filter at one spawn site
   (both vectors converge at `index.js:2453-2467`), two test assertions flipped, one
   new regression test on an existing, purpose-built harness
   (`spawn-env-exclusion.test.js`). No consumer breaks: the ONLY runtime consumer is
   server-side and untouched. This is precisely the Sprint 64 T1 exclusion pattern,
   extended by one category — precedent, seam, and test file all exist.
4. **Doctor/adapter work is genuinely sprint-shaped**, needs the claude `checkAuth`
   design and cross-package export plumbing — right-sized for a Sprint 70/71 lane, and
   not needed to close the billing hole once (a) lands.

**Tonight:** §4 interim. **Before next inject:** hotfix (a) + tests. **Sprint 70/71:**
(b) polish + (c) doctor + migration docs.
