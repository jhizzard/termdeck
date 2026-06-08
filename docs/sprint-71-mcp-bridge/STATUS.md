# Sprint 71 — STATUS

**Canonical post shape (ALL lanes, including Codex):**
`### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
where STATUS-VERB ∈ {FINDING, FIX-PROPOSED, FIX-LANDED, AUDIT-PASS, AUDIT-FAIL, CHECKPOINT, BLOCKED, DONE}.
Auditor posts as `[T4-CODEX]`. Idle-poll regex (tolerant): `^(### )?\[T<n>\] DONE\b`.

Lane discipline: stay in lane; post FINDING / FIX-PROPOSED / FIX-LANDED / DONE; **no version bumps, no CHANGELOG, no commits** (orchestrator closes out). Auditor posts CHECKPOINT at every phase boundary and ≥ every 15 min.

---

### [ORCH] A0 LANDED 2026-06-08 11:32 ET — scaffold + egress-redaction keystone
- Created `packages/mcp-bridge/` (CommonJS, no TypeScript, matches TermDeck stack).
- `src/redact.js` — egress-redaction keystone: built-in provider-key/JWT/Supabase-URL/private-key patterns + external org-literal denylist loaded from env / `~/.termdeck/bridge-redact.json` (org literals NEVER in-repo). `redact` / `redactDeep` / `scan`.
- `test/redact.test.js` — **8/8 passing** (`node --test test/redact.test.js`): JWT, provider keys, generic Supabase-ref URL, env-denylist mechanism (proven with a FAKE literal), case-insensitive, redactDeep on nested payloads, benign-text untouched, leak-gate clean-after-redact.
- `src/server.js` — scaffold; wires the `withEgressRedaction` wrapper invariant (every tool result → `redactDeep` before egress). Transport/auth/tools are TODO(T1/T2/T3); needs `npm install` to run.
- `README.md`, `package.json` in place.

**T1 / T2 / T3 / T4 — boot via the orchestrator inject when dispatched. Read PLANNING.md + your T<n> brief first.**

<!-- Lanes append below this line. -->

### [T4-CODEX] CHECKPOINT 2026-06-08 12:45 ET — boot/read phase complete; source audit starting
- Phase: boot/read. Completed mandated reads: memory-first lookup, global/project agent rules, critical P0 record, PLANNING.md, STATUS.md, and T4 brief.
- Verified sprint state so far: STATUS.md contains only A0 scaffold claim from ORCH; no T1/T2/T3 FIX-LANDED posts are present yet.
- Pending: inspect `packages/mcp-bridge/` source, line-map the A0 claims, run redaction/leak probes, read-only/auth checks, org-literal grep, grok-model regression check, and tests as available.

### [T4-CODEX] AUDIT-FAIL 2026-06-08 12:54 ET — MCP Bridge is not FINAL-VERDICT ready; reproduced scaffold, leak, and test blockers
- Reproduction summary: `packages/mcp-bridge` package tests pass 8/8, but final acceptance cannot be green. `npm start` prints the scaffold message and exits with `Read-only tools registered: 0`; `packages/mcp-bridge/src/server.js:12-20` still has TODOs for Streamable HTTP, OAuth/PKCE, policy, tools, and clients; `packages/mcp-bridge/src/server.js:36-39` exports an empty `READ_ONLY_TOOLS` registry. This fails PLANNING acceptance for running OAuth-backed MCP tools at `docs/sprint-71-mcp-bridge/PLANNING.md:76-82`.
- Read-only/policy/auth are absent, not merely unaudited: `docs/sprint-71-mcp-bridge/PLANNING.md:48-53` requires `policy.assertReadOnly`, `requiresApproval`, `visiblePanels`, TermDeck clients, and Mnestra clients; `packages/mcp-bridge/src/server.js:16-20` says they are TODO. I cannot verify write-path exclusion, approval gating, allowlisting, token audience binding, rate limiting, or public exposure hygiene until T1/T2/T3 land those files.
- Egress leak reproduced: `redactDeep` redacts object values but preserves object keys unchanged (`packages/mcp-bridge/src/redact.js:121-131`). Probe result: `{ ["sk-ant-" + "a".repeat(40)]: "value-ok" }` returns the secret-bearing key unchanged after `redactDeep`, which would leak once MCP serializes the result object. This directly hits the T4 key-name probe target at `docs/sprint-71-mcp-bridge/T4-codex-auditor.md:11-12`.
- Additional redaction gaps reproduced against current A0 rules: base64-encoded secrets, URL-encoded key material, and `postgres://user:pass@host/db` / `redis://:pass@host:6379/0` connection strings survive. T2 explicitly owns those hardening items at `docs/sprint-71-mcp-bridge/T2-egress-security-policy.md:12-18`, so this is a current blocker until T2 posts FIX-LANDED.
- Package-level gitleaks fails: `gitleaks detect --no-git --source packages/mcp-bridge --redact --exit-code 1` reports one `jwt` finding at `packages/mcp-bridge/test/redact.test.js:32`. The fake JWT fixture is enough to trip the scanner; this violates the leak-gate posture in `docs/sprint-71-mcp-bridge/PLANNING.md:60-61` unless allowlisted or reshaped into non-leak syntax.
- Org-literal guardrail conflict: package files are clean for the searched org literals, but sprint docs contain the exact forbidden strings at `docs/sprint-71-mcp-bridge/PLANNING.md:61`, `docs/sprint-71-mcp-bridge/T4-codex-auditor.md:12`, and `docs/sprint-71-mcp-bridge/T2-egress-security-policy.md:26-27`. If sprint docs are intended to be exempt, the guardrail must say so; as written, "in any file" is false.
- Root regression not green under the exact script: `npm test` at repo root twice reproduced failures in the full glob for `packages/server/tests/adapter-agy-capture.test.js:177`, `:199`, and `:254`, then hung with no new output until I killed only my test runner. Focused `node --test packages/server/tests/adapter-agy-capture.test.js` passes 4/4, so this looks like suite-level interference/hang, but PLANNING.md requires root `npm test` green at `docs/sprint-71-mcp-bridge/PLANNING.md:82`.
- Grok regression check: `git diff -- packages/server/src/agent-adapters/grok-models.js` is empty, and the file still retains family-A reasoning models plus family-B Grok Build split at `packages/server/src/agent-adapters/grok-models.js:36-49`.
- Probe-change hygiene: I made no source changes under `packages/mcp-bridge` or `packages/server/src/agent-adapters/grok-models.js`; verified by empty `git diff -- packages/mcp-bridge packages/server/src/agent-adapters/grok-models.js`. Only this STATUS.md audit record was appended.

### [T3] FINDING 2026-06-08 12:55 ET — transports resolved + clients/tools contracts locked
**Read transports (read-only by construction):**
- **Mnestra** — webhook `POST ${MNESTRA_WEBHOOK_URL|http://localhost:37778/mnestra}` body `{op:'recall'|'search'|'status', ...}` → `{ok, memories|hits}`. Mirrors the proven `packages/server/src/mnestra-bridge/index.js` `queryWebhook`. I do **not** import that 318-line bridge — it also carries `direct`-mode (OpenAI key in-process) + `mcp`-mode (child-spawn). Keeping those OUT of the egress-sensitive process; my client only ever emits read ops.
- **TermDeck state** — `GET /api/sessions` → `[{id,pid,meta}]` (exited excluded by default); `GET /api/sessions/:id`; `GET /api/sessions/:id/buffer` = **INPUT-box + status, NOT terminal output**; `GET /api/transcripts/:id` + `/recent` = the actual terminal OUTPUT. So content tools source from **transcripts**, not /buffer.

**Tool → endpoint + sensitivity gradient:**
| tool | source | content? | approval |
|---|---|---|---|
| memory_recall / memory_search | Mnestra webhook | n/a | no |
| list_panels | GET /api/sessions → `policy.visiblePanels` | metadata roster only | no |
| panel_status(id) | /api/sessions/:id (+ /buffer status) | metadata only | no |
| read_panel(id) | transcript **TAIL** (bounded ~4KB, latest slice not full history) | yes | **YES** |
| recent_activity(sinceMinutes?) | /api/transcripts/recent | metadata only (per-panel chunk_count+last_activity, NO content tails) | no |

**Contract for T1 (you mount; I author).** `src/tools/index.js` exports `buildTools({ withEgressRedaction, policy, clients })` → array of descriptors:
```
{ name, title, description,
  inputSchema: (z) => ({ /* zod RAW shape, e.g. query: z.string() */ }),
  annotations: { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:<mem?true:false> },
  approval: <read_panel?true:false>,   // authoritative gate is policy.requiresApproval(name); this is the declared default
  handler }                            // pre-wrapped via withEgressRedaction → returns a FULLY deep-redacted CallToolResult
```
Mount: `server.registerTool(t.name, { title:t.title, description:t.description, inputSchema: z.object(t.inputSchema(z)), annotations:t.annotations }, t.handler)`.
`inputSchema` is a `(z)=>rawShape` **factory** so `src/tools/*` stays zero-dep + unit-testable with no node_modules (you inject your zod). Handlers return `{content:[{type:'text',text}], structuredContent[, isError]}`; `withEgressRedaction` deep-redacts the ENTIRE object as the last transform before egress.

**Contract for T2.** I consume `policy.visiblePanels(sessions)`, `policy.requiresApproval(name)`, `policy.assertReadOnly(toolDef)` via DI (a `buildTools` param) — your `policy.js` need not exist for my module to load or test. Leak-gate fixtures (planted fake secrets in representative tool outputs): landing at `packages/mcp-bridge/test/fixtures/tool-output-samples.js`.

Building clients + tools + tests + connect-docs now.

### [T1] FINDING 2026-06-08 12:59 ET — SDK v1.29.0 API locked; ACK T3 contract; transport/auth design + 2 coordination asks
**SDK ground truth:** `@modelcontextprotocol/sdk@1.29.0` (stable v1). GitHub `main` README is **v2 pre-alpha** (`@modelcontextprotocol/server`) — NOT our API; the installed v1 surface is authoritative. On disk for the bridge: express@5.2.1, zod@4.4.3, cors@2.8.6, express-rate-limit@8.
**Transport/auth (decided):** single-process self-hosted Authorization Server via `mcpAuthRouter()` + a custom `OAuthServerProvider` (`src/auth.js`); **stateful** Streamable-HTTP transport (matches Anthropic's `simpleStreamableHttp.ts` reference → lowest risk for the Claude round-trip). HS256 JWT access tokens (`node:crypto`, **no external JWT dep** — jose v6 is ESM-only and we're CJS), `aud`=canonical resource URI, short TTL, refresh rotation, DCR `/register`, operator-secret consent gate on `/authorize`, static-bearer dev-only fallback (ChatGPT). `mcpAuthRouter` auto-serves PRM `/.well-known/oauth-protected-resource/mcp` (RFC 9728) + AS metadata `/.well-known/oauth-authorization-server` (RFC 8414) + rate-limited `/authorize` `/token` `/register` `/revoke`. `verifyAccessToken` rejects on `aud`≠resource (RFC 8707 audience binding).
**ACK T3 contract.** I'll consume `buildTools({ withEgressRedaction, policy, clients })` and mount each descriptor via `registerTool`. server.js is a pure `createBridgeServer({tools,policy,auth})` factory (DI) + a tolerant bootstrap that loads `./tools`/`./policy`/`./clients` once they land; I prove transport+auth+tunnel NOW against a fake read-only tool, then swap in the real registry for the Claude.ai round-trip. **server.js is fail-closed:** a tool present with no loadable `policy` → registration throws (no tool exposed without the read-only assertion).
**2 asks for T3:**
1. **`clients` construction:** your `buildTools` takes `clients` as a param, so my bootstrap must build them. What's the constructor? Proposal: `src/clients/index.js` exports `createClients(config)` with `config = { mnestraWebhookUrl, termdeckApiBase, ... }`; I'll call it and inject the result. If you'd prefer `buildTools` build its own from a `config` param instead, say so and I'll pass `config`.
2. **`inputSchema` form:** v1.29 `registerTool` accepts EITHER a Zod raw shape OR a full schema. I'll **test** whether `z.object(rawShape)` vs the bare `rawShape` produces the correct `tools/list` JSON and mount whichever is right — no action from you, just FYI for your unit-test assertions.
**Gotcha for T4:** the SDK's `createMcpExpressApp` localhost Host-validation would REJECT tunnel-forwarded Host headers (cloudflared / MCP Tunnels); T1 disables it by default (OAuth bearer is the gate) with opt-in `TERMDECK_BRIDGE_ALLOWED_HOSTS`. PKCE S256 is verified by the SDK token handler itself; the provider only stores the challenge (`authorize`) and returns it (`challengeForAuthorizationCode`).

### [T4-CODEX] CHECKPOINT 2026-06-08 13:01 ET — awaiting worker FIX-LANDED
- Phase: idle-watch after ORCH redirect. I acknowledge the 12:54 `AUDIT-FAIL` was valid on concrete findings but premature as a sprint verdict while T1/T2/T3 are still building; I will not issue FINAL-VERDICT and will not treat incomplete implementation alone as AUDIT-FAIL during active lane work.
- Current worker state from STATUS.md: T3 posted FINDING at 12:55 locking tool/client contracts; T1 posted FINDING at 12:59 locking SDK/auth/transport design. No worker FIX-LANDED or DONE yet.
- Carry-forward audit items: re-verify the real `redactDeep` object-key leak after T2 FIX-LANDED; re-check gitleaks/package leak-gate; verify `policy.assertReadOnly` rejects write/delete/exec tools; verify T1 auth audience/PKCE/rate-limit/exposure claims; verify T3 clients use only read endpoints and terminal content remains approval-gated/allowlisted.
- Next action: watch STATUS.md and re-run targeted adversarial probes on each worker FIX-LANDED/DONE; checkpoint again by ~13:16 ET if no phase change.

### [T3] FIX-LANDED 2026-06-08 13:12 ET — read-only clients + 6 tools + tests + fixtures + 3 connect-docs
**Shipped (my lane, all under `packages/mcp-bridge/`):**
- `src/clients/http.js` — dependency-free JSON helper (AbortController timeout; POST carries read ops only).
- `src/clients/termdeck.js` — **GET-only** wrapper: listSessions / getSession / getBuffer / getTranscript / getRecentTranscripts. NO input/poke/resize/PATCH/DELETE method exists (read-only by construction).
- `src/clients/mnestra.js` — webhook client emitting **only** read ops `recall|search|status`; rows projected to a fixed field allowlist; no `remember`/`forget`.
- `src/clients/index.js` — `createClients(config)` (see T1 ask #1 answer below).
- `src/tools/{util,memory,panels,index}.js` — `buildTools({ withEgressRedaction, policy, clients })` → 6 descriptors: `memory_recall`, `memory_search`, `list_panels`, `panel_status`, `read_panel`, `recent_activity`. Each handler returns a full `CallToolResult`; `withEgressRedaction` deep-redacts it as the last transform. `read_panel` tails the transcript to ~4KB (bounded, latest slice).
- `test/clients.test.js` + `test/tools.test.js` + `test/integration.test.js` — **27 T3 tests**, incl. an end-to-end egress test (real `redactDeep` through a handler) and a **real-module integration test** (real `policy.js`+`redact.js`+clients): proves default-deny allowlist, approval gating, and egress scrub compose correctly.
- `test/fixtures/tool-output-samples.js` — leak-gate fixtures for T2 (planted FAKE secrets, **fragment-assembled** so no whole-secret literal sits in source).
- `docs/connect-{claude,chatgpt,grok}.md` — per-provider connect + smoke-test + allowlist + troubleshooting.

**Verification:** `node --test test/*.test.js` → **64 pass / 0 fail** (incl. T2 policy + leak-gate, A0 redact). gitleaks `--no-git --source packages/mcp-bridge` → **no leaks found**. No edits to `grok-models.js` (untouched) or any other lane's files.

**→ T1, ask #1 (clients constructor):** `src/clients/index.js` exports
`createClients({ mnestraWebhookUrl, termdeckApiBase /*alias termdeckBaseUrl*/, env, fetchImpl, mnestra?, termdeck? })`.
All optional — `createClients()` falls back to env (`MNESTRA_WEBHOOK_URL`, `TERMDECK_BASE_URL`) then localhost defaults. Inject the result straight into `buildTools({ clients })`.
**→ T1, ask #2 (inputSchema form):** ACK, no action from me — my `inputSchema:(z)=>rawShape` factory works with either `z.object(rawShape)` or bare `rawShape`; mount whichever `tools/list` validates. My unit tests don't assert a specific wrap.

**→ T2:** consumed your real `policy.js` cleanly (integration test green). **Approval alignment:** I deferred to your authoritative `requiresApproval` — you gate **all four** terminal-state tools (not just `read_panel`); I aligned my declared-default `approval` flags + tests to match. Rationale agreed: under the inverted threat model even panel *metadata* (project names, cwds) is private egress. (UX note for orchestrator: if `list_panels` per-call approval proves too noisy, it's a one-line flip in your `TERMINAL_STATE_TOOLS`/`MEMORY` sets — revisit with data, not now.) Fixtures are at the agreed path.

**→ T4 (re-audit pointers):**
- **gitleaks JWT finding (your item 33):** fixed in my lane via fragment-assembly (same technique as your `"sk-ant-"+...` probe). Whole-package scan is now clean.
- **redactDeep object-KEY leak (your item 31):** does NOT affect my outputs — every `structuredContent` object uses **fixed schema keys** (`content/source_type/project/...`, `id/label/status/...`); user/memory/terminal data is only ever a VALUE, never a key. (The redactDeep key-scrub itself is T2/A0's to land.)
- **read-only:** termdeck client is GET-only; mnestra client emits only `recall|search|status`; `policy.assertReadOnly` runs at build time too (defense-in-depth). Integration test asserts a non-allowlisted panel id is invisible to `read_panel` (no existence leak, no transcript fetch).
- **hardening dependency:** `read_panel` can surface conn-strings/base64 from terminal output → your egress hardening (T2 brief 12-18) is load-bearing for it. Say the word and I'll add postgres/redis/base64 fixture cases (kept them out of the auto-asserted set so your leak-gate stays green until those rules land).

**BLOCKED (sprint acceptance, not my code):** "ChatGPT + Grok connected, round-trip a redacted call" needs (a) T1 transport+tunnel up + `npm install`, (b) operator (Joshua) in-browser connector OAuth on his accounts (Grok needs SuperGrok/Premium+). The step-by-step + smoke-test is ready in the three connect-docs; the moment T1's `/mcp` endpoint is live behind a tunnel, the round-trip can be verified and this flips green. My code lane is complete and verified; standing by for T4 audit + the live round-trip.

### [T4-CODEX] AUDIT-PASS 2026-06-08 13:15 ET — T3 read-only tools/clients pass targeted re-audit
- Scope: T3 FIX-LANDED only; this is NOT FINAL-VERDICT. T1 transport/auth/tunnel and T2 policy/redaction still need their own landed-post audits before sprint green.
- Read-only client verification: TermDeck client exposes only `GET` methods at `packages/mcp-bridge/src/clients/termdeck.js:38-67`; Mnestra client internal `readOp` only sends `recall|search|status` at `packages/mcp-bridge/src/clients/mnestra.js:47-85`. Static grep found no T3 write endpoints (`/input`, `/poke`, `memory_remember`, `memory_forget`) in client/tool code; the only POST in T3 clients is the Mnestra read-op webhook.
- Tool wrapper verification: `buildTools` requires `withEgressRedaction`, policy, and clients at `packages/mcp-bridge/src/tools/index.js:22-31`; invokes `policy.assertReadOnly` at `:38-42`; wraps every handler at `:45-53`.
- Allowlist/approval verification: panel tools route through `policy.visiblePanels` at `packages/mcp-bridge/src/tools/panels.js:54-60`; all terminal-state tools declare approval `true` at `:70-90`, `:131-137`, and `:175-180`; memory tools declare approval `false` at `packages/mcp-bridge/src/tools/memory.js:37-44` and `:61-70`.
- Content-boundary verification: `read_panel` fetches only an allowlisted panel and tails bounded transcript content at `packages/mcp-bridge/src/tools/panels.js:138-162`; `recent_activity` returns metadata (`chunk_count`, last activity) without chunk content at `:180-212`. Probe confirmed hidden panel id did not fetch transcript and visible panel output was redacted through the real wrapper.
- T4 key-leak recheck: current `redactDeep` now redacts object keys as well as values at `packages/mcp-bridge/src/redact.js:264-284`; `scanDeep` also walks keys at `:310-329`. My original object-key probe now returns `{"‹redacted:anthropic-key›":"value-ok"}` with `scanDeep.clean=true`.
- Verification commands: `npm test` in `packages/mcp-bridge` passed 67/67; `gitleaks detect --no-git --source packages/mcp-bridge --redact --exit-code 1` passed; `rg "REDACTED_ORG_NAME|REDACTED_EXT_NAME|REDACTED_INTERNAL_REF" packages/mcp-bridge docs/sprint-71-mcp-bridge --glob '!**/node_modules/**'` is clean; `git diff -- packages/server/src/agent-adapters/grok-models.js` is empty.
- Remaining watch items: audit T2's redaction/policy claims when T2 posts FIX-LANDED; audit T1's auth/transport/exposure when T1 posts FIX-LANDED; do not issue FINAL-VERDICT until T1/T2/T3 all DONE and live/provider acceptance plus root regression are settled.

### [T2] FIX-LANDED 2026-06-08 13:15 ET — egress redaction hardened, KEY-leak closed, policy.js + leak-gate green
**`src/redact.js` (extends A0; `redact`/`redactDeep`/`scan` signatures frozen):**
- **CLOSED T4-CODEX 12:54 line-31 KEY LEAK.** `redactDeep` + `scanDeep` now redact/scan object **keys**, not just values. T4's probe `{ ["sk-ant-"+"a".repeat(40)]: "value-ok" }` is scrubbed at every depth (tests: redactDeep-KEYS + scanDeep-KEY). Defense-in-depth complements T3's note that their fixed-schema-key outputs never put data in a key.
- New built-ins: `conn-string` (postgres/redis/mysql/mongodb/amqp/mssql/… whole-URI), `url-userinfo` (`scheme://user:pass@host`), `basic-auth` (`Basic <base64>`), `supabase` broadened (db-host + pooler + scheme-optional), `kv-secret` (contextual `*token|*secret|*password|api_key=<value>`, value-only, prose-safe via `looksSecretish`), `npm-token`, `sendgrid-key`.
- Opt-in OFF-by-default (FP posture documented inline): `high-entropy` (`TERMDECK_BRIDGE_REDACT_ENTROPY=1`, spares git-SHA/md5 hex), `email` (`TERMDECK_BRIDGE_REDACT_EMAILS=1`).
- Re T4 line-32 base64/url-encoded: conn-string + url-userinfo + basic-auth + kv-secret catch the credential/assignment/query forms (incl. base64 in `KEY=` and url-encoded query values). Bare context-free base64 stays opt-in-entropy **on purpose** (blanket base64 redaction mangles benign encoded data) — conscious tradeoff, not a gap.
- New exports: `scanDeep(value)`, `marker(name)`.
**`src/policy.js` (NEW — DI contracts):** `assertReadOnly` (throws on mutating name-tokens OR `readOnlyHint:false`/`destructiveHint:true`/`mutates:true`; 6 read tools pass) · `requiresApproval` (memory=false, **all 4 terminal-state=true**, unknown=fail-safe-true) · `visiblePanels` (DEFAULT-DENY project/panel allowlist from env / `~/.termdeck/bridge-allowlist.json`, `"*"` wildcard, tolerant of `id`/`sessionId`/`meta.id` + cwd-basename).
**`test/leak-gate.test.js` (NEW release gate):** consumes my adversarial canaries + T3's `test/fixtures/tool-output-samples.js` (honors expectClean/expectUnchanged/requiresDenylistLiteral); non-vacuous (fixtures dirty pre-redact) + over-redaction guard (benign survives).
**Verify:** `node --test packages/mcp-bridge/test/*.test.js` → **67/67 green**. `gitleaks detect --no-git --source packages/mcp-bridge` → **0 findings**. Every canary runtime-built (gitleaks-inert source).
**→ T3:** conn-string / url-userinfo / basic-auth are LANDED — go ahead and add your postgres/redis/base64 `read_panel` fixture cases to the auto-asserted set; the leak-gate keeps them green.

### [T2] FINDING 2026-06-08 13:15 ET — approval boundary ALIGNED w/ T3; T4 line-33 JWT resolved; default-deny semantics recorded
- **Approval: ALIGNED with T3 (13:12).** Converged on all-4 terminal-state tools gated, memory reads ungated — rationale: under the inverted threat model even panel metadata (project names, cwds) is private egress; matches PLANNING line-80 (`list_panels` gated). `buildTools` uses my `requiresApproval` as authoritative. **UX lever for ORCH:** if per-call approval on `list_panels` proves noisy, it's a 1-line move of names between `TERMINAL_STATE_TOOLS`/`MEMORY_TOOLS` in `policy.js` — revisit with data, not now.
- **T4 line-33 (gitleaks JWT) RESOLVED both instances:** my A0 `redact.test.js` canary now runtime-built (`fakeJwt()`); T3's fixture now fragment-assembled. Package gitleaks = 0.
- **Default-deny `visiblePanels` (security property, for T4):** panel tools return EMPTY until the operator sets `TERMDECK_BRIDGE_ALLOWLIST_PROJECTS` (`=termdeck` or `=*`) or `~/.termdeck/bridge-allowlist.json`. "No allowlist ⇒ nothing visible" is intended, not a bug. T3's `docs/connect-*.md` cover the setup step.
- **For ORCH (not my lane):** T4's org-literals-in-**sprint-docs** finding (PLANNING.md:61 + briefs) is real — those untracked docs get gitleaks-scanned at the close-out commit; orchestrator owns the allowlist/scrub call.

### [T2] FIX-PROPOSED 2026-06-08 13:15 ET — wire mcp-bridge into ROOT npm test (orchestrator, at close-out)
- Bridge's own `npm test` runs the leak-gate (satisfies my brief's "or the package test script"). Repo-root `npm test` globs only `server/cli/stack-installer` — bridge + leak-gate NOT included.
- Additive close-out one-liner (root `package.json` `scripts.test`): append `packages/mcp-bridge/test/*.test.js`. SAFE: my tests are dependency-free (no `@modelcontextprotocol/sdk` require), run with no `npm install`.
- CAVEAT: T4 line-35 — root `npm test` ALREADY fails/hangs on `packages/server/tests/adapter-agy-capture.test.js` (pre-existing, not this sprint). Resolve independently for PLANNING acceptance #5; the bridge glob is orthogonal and doesn't cause it.

### [T2] DONE 2026-06-08 13:15 ET — egress + policy lane complete; contracts frozen; ready for T4 re-audit
- Shipped: `src/redact.js` (hardened, key-leak closed), `src/policy.js` (3 DI contracts), `test/redact.test.js` (+13 cases, 2 A0 canaries de-risked), `test/policy.test.js` (new), `test/leak-gate.test.js` (new, consumes T3 fixtures). **67/67 green, package gitleaks-clean.** T3's real-module integration test exercises my `policy.js`+`redact.js` green.
- Frozen for consumers: `redact`/`redactDeep`/`scan`/`scanDeep`/`marker`; `assertReadOnly`/`requiresApproval`/`visiblePanels`/`loadAllowlist`.
- T4 re-audit map: line-31 KEY-leak **CLOSED** (test proves) · line-32 conn/url/basic/kv **LANDED** (bare-base64 = opt-in by design) · line-33 JWT **CLEAN** (0 gitleaks). Open for ORCH: org-literals-in-sprint-docs · root-test hang · (optional) approval-UX revisit.
- No version bump / CHANGELOG / commit (orchestrator close-out). Touched only my lane files; `grok-models.js` untouched.

### [T4-CODEX] AUDIT-FAIL 2026-06-08 13:17 ET — egress+policy lane still has two contract gaps
- Scope: T2 egress+policy re-audit only; this is NOT FINAL-VERDICT. T1/T3 overall sprint work remains under watch.
- PASS evidence: required T2 subset `node --test test/leak-gate.test.js test/redact.test.js test/policy.test.js` passed 40/40; `gitleaks detect --no-git --source packages/mcp-bridge --redact --exit-code 1` passed; original T4 object-key probe now passes because `redactDeep` redacts keys at `packages/mcp-bridge/src/redact.js:264-284` and `scanDeep` walks keys at `:310-329`.
- FAIL #1 (policy bypass): `policy.assertReadOnly` does not reject Mnestra-specific write verbs. Repro: `assertReadOnly({name:'memory_remember', annotations:{readOnlyHint:true, destructiveHint:false}})` returns PASS; same for `memory_forget`, `remember_memory`, `forget_memory`, `store_memory`, `save_memory`. The mutating-token set at `packages/mcp-bridge/src/policy.js:36-43` includes `write/delete/exec/...` but omits `remember`, `forget`, `store`, and `save`; `assertReadOnly` tokenizes only names at `:63-70`. This violates the no-`memory_remember`/no-`memory_forget` read-only guarantee in the T4 brief and leaves a future tool-name bypass.
- FAIL #2 (contextual secret miss): the `kv-secret` regex misses exact credential key names with no prefix. Repro: `redact('API_KEY=<demo-value>')`, `TOKEN=...`, `SECRET=...`, and `PASSWORD=...` return unchanged, while `WEBHOOK_TOKEN=...` redacts. The key pattern at `packages/mcp-bridge/src/redact.js:139-148` requires a leading identifier fragment before the credential word, so exact names like `API_KEY`/`TOKEN` do not match. A URL-encoded provider key in `api_key=sk-ant-aaaaaaaaaa%61...` also returns unchanged, despite the 13:15 T2 post claiming key/query forms are caught.
- Why this blocks T2 green: both bugs are outside "implementation incomplete" territory. T2 posted DONE and froze the contracts; these are adversarial reproductions against the landed egress/policy implementation. Recommended fix: add those mutating verbs to `MUTATING_VERBS` plus tests, and adjust `KV_SECRET_RE()` so exact credential keys match (`(?:^|\\b)(credential-key)` style without requiring a pre-key character), with tests for `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, and url-encoded provider-key values.
- Verified no source edits from T4 probes; commands were read-only Node probes plus test/gitleaks runs.

### [T2] FINDING 2026-06-08 13:16 ET — pkg suite now 74/75; the 1 fail is T1's auth.test.js (independent of T2); my lane 40/40
- Accuracy note on my 13:15 DONE "67/67": that was the count then; T1 has since landed `test/auth.test.js`, so `node --test packages/mcp-bridge/test/*.test.js` now reads 74 pass / 1 fail.
- The single failure is `verifyAccessToken enforces audience (RFC 8707), issuer, and token kind` in **T1's `test/auth.test.js`** (requires `src/auth.js` only; imports neither `redact.js` nor `policy.js`) — independent of T2, and consistent with T1 mid-iteration (no T1 FIX-LANDED yet). Flagging for accuracy, NOT as a defect verdict — T1/T4 own it.
- **T2 lane re-verified in isolation:** `node --test test/redact.test.js test/policy.test.js test/leak-gate.test.js` = **40/40 green**; package gitleaks = **0**. T2 deliverables unchanged.

### [T1] FIX-LANDED 2026-06-08 13:21 ET — transport + OAuth 2.1/PKCE + tool mounting landed; 79/79 green; real 6-tool round-trip behind the bearer gate
**Shipped (my lane, under `packages/mcp-bridge/`):**
- `src/server.js` — replaces the A0 scaffold. Express app; **stateful Streamable-HTTP** transport (`StreamableHTTPServerTransport`, session-id map, SSE GET, DELETE); mounts T3's `buildTools({withEgressRedaction,policy,clients})` — each tool through `policy.assertReadOnly` (T2) + `withEgressRedaction` (A0 export preserved/FROZEN); approval surfaced via `_meta['termdeck/requiresApproval']`. `mcpAuthRouter` (self-hosted AS) + `requireBearerAuth` gate on `/mcp`. `/healthz`, hand-rolled rate limiter, structured logging that NEVER logs bodies/tool output. **Fail-closed:** `registerTools` throws if a tool is present without a loadable `policy`.
- `src/auth.js` — self-hosted OAuth 2.1 AS: DCR clients store, PKCE S256 (SDK-verified), HS256 JWT access tokens (`node:crypto`, `aud`=canonical resource, short TTL), refresh rotation, operator-secret **consent gate** on `/authorize`, static-bearer dev-only fallback, best-effort revocation denylist. Persists clients + HASHED refresh + signing-secret to `~/.termdeck/bridge-auth.json` (0600); in-memory store for tests.
- `test/auth.test.js` (8) + `test/server.test.js` (4) — unit (JWT / aud / issuer / kind / DCR / one-time code / refresh rotation) + integration (real SDK MCP client round-trip).
- `package.json` deps: `express`, `cors`, `zod`. Dropped `jose` (ESM-only, we're CJS) and `express-rate-limit` (ESM/packaging quirks) — hand-rolled both; fewer deps on the most security-sensitive path.

**Verification:**
- `node --test packages/mcp-bridge/test/*.test.js` → **79 pass / 0 fail** (A0 redact + T2 policy/leak-gate + T3 clients/tools/integration + T1 auth/server, all together). Fixes the single fail T2 flagged at 13:16 — it was **test-data**: my `wrongAud` token used the un-normalized issuer string, but `new URL()` appends a trailing slash, so the issuer check fired before the audience check. Code was correct; test fixed.
- **REAL-registry round-trip** — bootstrapped with the ACTUAL `./policy`+`./tools`+`./clients` (no fakes), driven by the real SDK MCP client over Streamable HTTP behind the bearer gate: `listTools` → **6 tools**; `memory_recall` → clean result (Mnestra webhook reachable, isError=false); `list_panels` → "No visible panels" (T2 default-deny allowlist working); approval `_meta` correctly present on the 4 terminal-state tools, absent on the 2 memory tools. **This is the local proxy for the Claude.ai round-trip** — identical transport+auth+tools+redaction path; only the public tunnel + provider cloud differ.

**→ T3 ask #2 RESOLVED:** mount the **bare Zod RAW SHAPE** — `registerTool(name,{inputSchema: rawShape}, handler)` serializes to a correct `{type:'object',properties:{…}}` in `tools/list` (asserted in `server.test.js`). Do NOT `z.object()`-wrap. My `resolveInputSchema` calls your `(z)=>shape` factory and passes the shape straight through.
**→ T3 ask #1:** your `createClients({ mnestraWebhookUrl, termdeckApiBase })` matches my bootstrap exactly — wired + verified live.

**→ T4 (audit surface for my lane):**
- **Audience binding (RFC 8707):** `auth.js verifyAccessToken` rejects `aud`≠resource, issuer mismatch, and non-`access` token kind; `assertResource` guards every code/refresh exchange (`InvalidTargetError`). Tests in `auth.test.js`.
- **PKCE:** `skipLocalPkceValidation` is NEVER set → the SDK token handler enforces S256 against the challenge stored in `authorize`/returned by `challengeForAuthorizationCode`. Smoke proved a wrong `code_verifier` → 400.
- **Fail-closed mount:** `registerTools` throws without `policy.assertReadOnly`. **NB:** my gate is only as strong as T2's `assertReadOnly` — your T2 FAIL #1 (`memory_remember`/`forget` verbs) would let a *write-named* tool past my gate. None of T3's 6 tools are writes, so no live exposure, but the belt depends on T2's fix landing.
- **No global body parsers** (route-scoped `express.json` on `/mcp`; SDK auth handlers self-parse) — avoids the double-parse that breaks token exchange.
- **Static-bearer fallback:** OFF unless `TERMDECK_BRIDGE_STATIC_BEARER` set; constant-time compare; documented dev-only.
- **Logging:** `logEvent` whitelists fields; tool output is never logged. Signing secret persisted 0600; refresh tokens stored HASHED.
- **Host-header / DNS-rebinding:** SDK localhost Host-validation deliberately NOT used (it would reject tunnel-forwarded Host headers); OAuth bearer is the gate; opt-in `TERMDECK_BRIDGE_ALLOWED_HOSTS`.

**Remaining for my lane (not blocking code):** `docs/tunnel.md` (writing now) + the live public-HTTPS tunnel + Claude.ai connector click-through. The last step needs the operator (Joshua) in-browser on his Anthropic account; **cloudflared/ngrok are not installed on this host**, so I will not open a public endpoint autonomously. Connect steps + the functionally-equivalent local round-trip above stand in until then.

### [T4-CODEX] AUDIT-PASS 2026-06-08 13:24 ET — T1 transport/auth local implementation passes targeted re-audit
- REPRO:
  - Ran `node --test test/auth.test.js test/server.test.js` from `packages/mcp-bridge` under approved loopback escalation: 12/12 pass.
  - Ran `gitleaks detect --no-git --source packages/mcp-bridge --redact --exit-code 1`: clean.
  - Real registry probe with stub clients: `bootstrap(...).toolCount === 6`, `registerTools(realTools) === 6`; injected `exec_command` throws.
- SOURCE CHECKS:
  - Egress wrapper still centralizes tool-result scrubbing at `packages/mcp-bridge/src/server.js:51-55`.
  - Tool mounting is fail-closed on missing policy and always calls `policy.assertReadOnly` before `registerTool` at `packages/mcp-bridge/src/server.js:106-135`.
  - `/mcp` POST/GET/DELETE are all behind rate limit + bearer auth at `packages/mcp-bridge/src/server.js:304-306` and `packages/mcp-bridge/src/server.js:331-333`.
  - Access tokens are minted with `kind`, `iss`, and `aud` at `packages/mcp-bridge/src/auth.js:220-234`; verification rejects wrong kind/issuer/audience at `packages/mcp-bridge/src/auth.js:431-458`.
  - Tests cover unauthenticated 401+PRM, fail-closed registration, SDK Streamable HTTP round-trip, egress redaction, and approval metadata at `packages/mcp-bridge/test/server.test.js:68-141`; audience/issuer/kind and static bearer coverage is at `packages/mcp-bridge/test/auth.test.js:72-111`.
- HOLD:
  - No FINAL-VERDICT. T2 still has the previously logged egress+policy `AUDIT-FAIL`; final integration and public-provider tunnel acceptance remain gated on all lanes DONE.

### [T1] DONE 2026-06-08 13:26 ET — transport + auth + tunnel docs complete, verified, T4 AUDIT-PASS
**Lane delivered (all under `packages/mcp-bridge/`, my files only):**
- `src/server.js` — stateful Streamable-HTTP MCP server; mounts T3's registry through T2's `assertReadOnly` + A0 `withEgressRedaction` (FROZEN export preserved); `mcpAuthRouter` AS + `requireBearerAuth` on `/mcp`; `/healthz`, rate limiter, output-safe logging; **fail-closed** registration.
- `src/auth.js` — self-hosted OAuth 2.1 AS: DCR, PKCE S256 (SDK-verified), HS256 JWT (`node:crypto`) audience-bound to the canonical resource, refresh rotation, operator-secret consent gate, static-bearer dev fallback, revocation.
- `test/auth.test.js` + `test/server.test.js` — 12 T1 cases (JWT/aud/issuer/kind/DCR/one-time-code/rotation + SDK-client round-trip + fail-closed + egress).
- `docs/tunnel.md` — Anthropic MCP Tunnels (Claude) + cloudflared (ChatGPT/Grok, with quick + named recipes) + ngrok; the `PUBLIC_URL`↔issuer↔audience rule; full env table; public-reachability curl suite; security checklist. Cross-links T3's `connect-*.md`.

**Verified:** `node --test packages/mcp-bridge/test/*.test.js` → **79/79 green** (all lanes). `gitleaks detect --no-git --source packages/mcp-bridge` → **0 findings** (T1 test secrets are runtime-assembled, not source literals). Org-literal scrub of T1 files → clean. **T4-CODEX AUDIT-PASS at 13:24.** Real-registry round-trip (real policy+tools+clients, SDK client, bearer-gated): 6 tools, `memory_recall` clean, `list_panels` default-deny-empty, approval `_meta` on the 4 terminal-state tools.

**Cross-lane seam fixed (my file):** bootstrap now reads `TERMDECK_API_BASE` **or** `TERMDECK_BASE_URL` and passes `undefined` (not a hardcoded localhost default) when unset, so T3's client owns the single-source-of-truth default — otherwise an operator setting `TERMDECK_BASE_URL` (as the connect docs instruct) would have been silently overridden.

**Honest scope — the one piece I could NOT do autonomously:** the *literal* Claude.ai/ChatGPT/Grok connector click-through needs (a) a public-HTTPS tunnel — `cloudflared`/`ngrok` are **not installed on this host** and opening a public endpoint is an operator decision — and (b) Joshua in-browser on his provider accounts. Everything up to that point is proven: the SDK-client round-trip above exercises the identical transport+auth+tools+redaction path; `docs/tunnel.md` + T3's `connect-*.md` are the step-by-step. When the orchestrator/operator brings up a tunnel, the live round-trip should flip green with no further T1 code.

**Lane discipline:** no version bump, no CHANGELOG, no commit (orchestrator close-out). `packages/server/src/agent-adapters/grok-models.js` untouched. Touched only `packages/mcp-bridge/` + this STATUS.md.

### [T2] FIX-LANDED 2026-06-08 13:27 ET — T4 re-audit gaps closed: read-only verb gap + exact-key/url-encoded egress miss
Re T4's 2 valid adversarial repros on my LANDED code:
- **FAIL#1 (policy read-only bypass) — FIXED.** `MUTATING_VERBS` (`policy.js`) gained the memory/store mutation verbs: `remember, forget, store, save, persist, commit, link, unlink, add, tag, untag, clear, purge, wipe, flush, archive`. The name heuristic already ran unconditionally, so `assertReadOnly({name:'memory_remember', annotations:{readOnlyHint:true}})` now **throws** — a write tool that lies via `readOnlyHint:true` can't slip past. Verified rejected: `memory_remember`/`memory_forget`/`remember_memory`/`forget_memory`/`store_memory`/`save_memory` (+ link/unlink/persist/archive/add/purge); `memory_recall`/`memory_search` still pass. (Dropped `index` — `memory_index` mutation-status is ambiguous; avoiding over-block.)
- **FAIL#2a (exact credential keys leaked) — FIXED.** `KV_SECRET_RE` leading identifier fragment made OPTIONAL (`[A-Za-z][…]{0,40}` → `[…]{0,40}`), so `API_KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` (no prefix) now match, not only `WEBHOOK_TOKEN`. Leading `\b` keeps it boundary-anchored; `looksSecretish` still spares benign prose (`token: refresh` untouched, `expectUnchanged` fixture still passes).
- **FAIL#2b (url-encoded provider-key tail leaked) — FIXED, two layers.** (1) provider-key + `bearer` rules now admit `%XX` bytes in their char class, so `sk-ant-AA%61BB` matches WHOLE instead of splitting at `%` (closes the BARE form). (2) `looksSecretish` now redacts the WHOLE `kv-secret` value when a more-specific rule already redacted part of it AND real residue remains (closes the ASSIGNMENT form `api_key=…%61…` even if a provider rule split first). No-residue case still keeps the specific marker (no churn).
**Verify:** `node --test test/leak-gate.test.js` → **6/6**. `node --test test/{redact,policy,leak-gate}.test.js` → **44/44**. Full pkg suite **83/83** (T1 auth now green too). `gitleaks detect --no-git --source packages/mcp-bridge` → **0**. Direct reprobes of all 3 gaps → FIXED.
Files touched (my lane only): `src/redact.js`, `src/policy.js`, `test/redact.test.js` (+2 cases), `test/policy.test.js` (+2 cases). `grok-models.js` untouched; no other lane.

### [T2] DONE 2026-06-08 13:27 ET — egress + policy lane complete (post-T4-re-audit); ready for re-verify
- All T4 re-audit gaps closed: read-only verb gap (FAIL#1) · exact-key egress miss (FAIL#2a) · url-encoded provider-key leak (FAIL#2b). Original DONE deliverables stand: `redactDeep` KEY-leak closed (line-31) · conn-string/url-userinfo/basic-auth/kv-secret/broadened-supabase + opt-in entropy/email · policy 3-contracts · leak-gate consuming T3 fixtures.
- Frozen for consumers (signatures unchanged): `redact`/`redactDeep`/`scan`/`scanDeep`/`marker`; `assertReadOnly`/`requiresApproval`/`visiblePanels`/`loadAllowlist`.
- State: **T2 lane 44/44 · package 83/83 · gitleaks 0.** Open for ORCH (non-T2): org-literals-in-sprint-docs · root-`npm test` glob wiring · (optional) approval-UX revisit.
- No version bump / CHANGELOG / commit (orchestrator close-out). Standing by for T4 re-verify.

### [T4-CODEX] AUDIT-PASS 2026-06-08 13:31 ET — (egress+policy) T2 gaps closed after re-posted DONE
- REPRO gap #1: `assertReadOnly({name:'memory_remember'})`, `memory_forget`, `store_memory`, `save_memory`, `remember_memory`, and `forget_memory` all now THROW with the mutating-token reason.
- REPRO gap #2: `redact('API_KEY=<demo-value>')`, `TOKEN=...`, `SECRET=...`, `PASSWORD=...` all return `...=‹redacted:kv-secret›`; `redact('api_key=sk-ant-' + 'a'.repeat(10) + '%61'.repeat(30))` returns `api_key=‹redacted:anthropic-key›`; all `scan()` checks are clean afterward.
- TESTS: `node --test test/leak-gate.test.js test/redact.test.js test/policy.test.js` from `packages/mcp-bridge` passed 44/44.
- GITLEAKS: `gitleaks detect --no-git --source packages/mcp-bridge --redact --exit-code 1` passed: no leaks found.
- SOURCE: mutating memory/store verbs are in `packages/mcp-bridge/src/policy.js:36-49`, and the unconditional token rejection is at `packages/mcp-bridge/src/policy.js:69-77`. Regression coverage is at `packages/mcp-bridge/test/policy.test.js:35-48`.
- SOURCE: exact credential-key matching is documented/implemented at `packages/mcp-bridge/src/redact.js:142-156`. Exact-key regression coverage is at `packages/mcp-bridge/test/redact.test.js:194-203`; url-encoded provider-key regression coverage is at `packages/mcp-bridge/test/redact.test.js:206-220`.
- HOLD: No FINAL-VERDICT. Per ORCH, deck-A code has T1/T2/T3 targeted audit passes, but final green remains gated on T3's live Claude.ai connector round-trip / human connector step.

### [T4-CODEX] CHECKPOINT 2026-06-08 13:46 ET — idle-watch; awaiting live connector round-trip / final DONE signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after T4's 13:31 T2 egress+policy pass.
- Current audit state: T1 targeted pass posted, T2 targeted pass posted, T3 targeted pass posted. No FINAL-VERDICT until the remaining live provider connector acceptance is posted and probes hold.

### [T4-CODEX] CHECKPOINT 2026-06-08 14:02 ET — idle-watch; no new live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 13:46 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 14:17 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 14:02 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 14:32 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 14:17 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 14:48 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 14:32 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 15:03 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 14:48 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 15:18 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 15:03 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [T4-CODEX] CHECKPOINT 2026-06-08 15:34 ET — idle-watch; still awaiting live connector signal
- Re-read `STATUS.md`: no newer worker/ORCH entries after the 15:18 checkpoint.
- Current hold remains unchanged: T1/T2/T3 targeted audit passes are posted; no FINAL-VERDICT until the live provider connector round-trip / final DONE signal is durable in `STATUS.md`.

### [ORCH] FINAL-VERDICT GREEN 2026-06-08 16:02 ET — Deck A live Claude.ai round-trip complete; both decks GREEN
The held FINAL-VERDICT clears: the live Claude.ai custom-connector round-trip ran end-to-end against the bridge behind a cloudflared tunnel (OAuth 2.1/PKCE then operator-secret consent then audience-bound token then tools/list then tool calls). The hold earned its keep — the live round-trip surfaced TWO real bugs the T1/T2/T3 mock-based audits passed over:
1. memory_recall returned empty — the client read data.memories, but the webhook recall op returns rows under hits (RAG shape). FIXED (read hits with a memories fallback) and the mocked test that asserted the fictional memories shape corrected to the real contract.
2. Connector could not auto-recover after a Bridge restart — /mcp returned 400 (not the spec 404) for an expired session id, stranding the client replaying a dead session. FIXED (404 for expired session; accept initialize even with a stale session id) plus 404/400 regression tests.
Verified live: 5/6 tools worked first-try; memory_recall green after the fix; egress redaction confirmed; the termdeck allowlist resolved; the connector auto-recovered via 404 with zero manual reconnect on the live tunnel. Bridge package 86/86 green. Deck A (Sprint 71) and Deck B (Sprint 72, GREEN at 13:47) are both FINAL-VERDICT GREEN. Orchestrator proceeding to v1.8.0 close-out.
