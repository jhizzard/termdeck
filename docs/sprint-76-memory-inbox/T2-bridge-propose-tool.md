# T2 — Bridge `memory_propose` tool (web connectors only)

**Work repo:** `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` —
your surface is `packages/mcp-bridge/`. **Your panel runs at the termdeck repo cwd but this
is Sprint 76** — post to the Sprint 76 STATUS.md by absolute path (PLANNING.md § Lane
discipline). Cross-deck posting is proven practice (Sprint 74 ran engram lanes against a
termdeck-repo STATUS.md).

## Boot context

The bridge (Sprint 71) is **read-only-by-construction**: `src/policy.js::assertReadOnly`
rejects any tool with `readOnlyHint:false` / `destructiveHint:true` / a mutating name-token;
`src/clients/mnestra.js` deliberately exports no write op and no generic `post(op)`. Sprint
76 adds exactly ONE quarantined write channel: `memory_propose`, which forwards a proposal to
the engram webhook's new `propose` op (T1's contract) where it lands in `memory_inbox` —
NEVER in `memory_items`. Canonical `memory_remember` stays absent from the web surface,
permanently. Every bridge consumer is by definition a web connector (CLIs talk to mnestra
over stdio MCP / webhook directly, not through the bridge) — "web connectors only" is
satisfied by the tool living here and nowhere else; your job is to make the channel
abuse-resistant and honestly labeled.

## Read first

- `packages/mcp-bridge/README.md` + `src/policy.js` (the read-only invariant you are about to
  deliberately, narrowly amend), `src/tools/index.js` + `src/tools/memory.js` (descriptor
  shape), `src/clients/mnestra.js` + `src/clients/http.js` (transport), `src/redact.js`
  (the external literal denylist you will reuse INGRESS-direction), `src/server.js:40-60`
  (handler wrapper — note handlers receive `(args, extra)`; `extra` carries the SDK's
  per-request auth info), `src/auth.js` (DCR client records: `client_id`, `client_name`).
- T1's brief (`T1-inbox-schema.md` § 4) for the webhook `propose` op contract: POST
  `{ op: 'propose', source_agent, text, project_hint?, metadata? }` → 200 `{ ok, id,
  status: 'pending' }` | 400 `{ ok: false, error }`. Caps: text ≤ 4000 chars, project_hint
  ≤ 128, metadata ≤ 8 KB JSON object. Build against this contract immediately; verify
  against T1's FIX-LANDED shape when it posts (HANDOFF-REQUEST in STATUS.md if reality
  diverges).

## Scope

### 1. Policy carve-out — the load-bearing design change (post as FIX-PROPOSED first)

`assertReadOnly` THROWS on `readOnlyHint:false` — and `memory_propose` must declare
`readOnlyHint:false`, because lying with `readOnlyHint:true` on a write tool is exactly the
deception the Sprint 71 auditor flagged. Do NOT weaken the heuristic. Evolve the contract
explicitly:

- New explicit registry in `policy.js`: `PROPOSE_TOOLS = new Set(['memory_propose'])` — the
  ONLY tools allowed to be non-read-only, by exact name.
- `assertReadOnly(toolDef)` gains a narrow carve-out: a tool whose name is in
  `PROPOSE_TOOLS` is exempt from the readOnlyHint/name-token rejection **iff** its
  annotations are exactly the honest proposal shape: `readOnlyHint:false`,
  `destructiveHint:false` (an INSERT into a quarantine inbox destroys nothing),
  `idempotentHint:false`, `openWorldHint:true`. Anything else still throws. The doc comment
  must state the new invariant: *"nothing secret egresses, nothing can mutate canonical
  state, nothing un-allowlisted is visible — plus exactly one quarantined proposal channel
  that can only append to memory_inbox."*
- `requiresApproval('memory_propose')` → **true** (explicitly classified, not via the
  default-deny fallthrough). A write crossing the bridge gets per-call human approval in the
  connector UI. ORCH may relax this at a later sprint with field data; ship conservative.
- Tests proving the carve-out is a needle, not a hole: `memory_remember`, `memory_forget`,
  `memory_store`, a `memory_propose` impostor with `destructiveHint:true`, and a
  `panel_propose` (name not in the registry) ALL still throw at mount.

### 2. Client: `propose()` on the mnestra client

`src/clients/mnestra.js` gains `propose({ sourceAgent, text, projectHint, metadata })` that
emits ONLY `op:'propose'` (keep the no-generic-`post(op)` discipline; update the header
comment that currently says the client only ever emits read ops). Map webhook 400s to thrown
errors carrying the webhook's reason so the connector sees WHY a proposal was refused.
Bounded response projection as with recall (id + status only — never echo the full row back).

### 3. Connector identity → `source_agent` (fail-closed)

The proposal's `source_agent` is NEVER caller-supplied — a web chat must not be able to
claim a different surface (or a CLI identity; T1's RPC rejects CLI values anyway —
defense-in-depth, not the only defense). Derive it server-side:

- From the per-request auth info (`extra` in the handler; access-token claims carry
  `client_id` — see `src/auth.js::mintAccessToken`), resolve the OAuth client record and its
  `client_name`.
- Map to the four values: operator-explicit map first (new optional
  `~/.termdeck/bridge-propose.json` `{ "clients": { "<client_id>": "claude-web", ... } }` +
  `TERMDECK_BRIDGE_PROPOSE_MAP` env override, same load pattern as `loadAllowlist`), then a
  conservative `client_name` heuristic (`/claude/i → claude-web`, `/chatgpt|openai/i →
  chatgpt-web`, `/grok|xai/i → grok-web`, `/gemini|google/i → gemini-web`).
- **Unmappable ⇒ reject the call** (fail-closed, clear error telling the operator to add the
  client to the map). Never default to any value.

### 4. Ingress redaction scan — BEFORE forwarding

The inverted-inverted threat model: redact.js scrubs EGRESS; proposals are INGRESS that will
later egress to every CLI session via recall once promoted. Scan `text` + `project_hint` +
metadata values BEFORE forwarding:

- Reuse redact.js's machinery — the external literal denylist
  (`~/.termdeck/bridge-redact.json` / `TERMDECK_BRIDGE_REDACT_LITERALS`) AND the built-in
  secret patterns. Export/refactor whatever redact.js internals you need rather than
  duplicating rules (keep it dependency-free).
- **Policy: REJECT, do not scrub-and-forward.** A proposal containing a denylisted literal
  or a matched secret pattern is refused with a reason naming the rule class (NOT the
  matched text — don't echo a secret back through the provider cloud). Rationale: a
  silently-sanitized memory is a corrupted memory; the proposer should rephrase.
- Hermetic tests (`TERMDECK_BRIDGE_REDACT_FILE` → fixture, the leak-gate.test.js idiom).

### 5. Per-connector rate limiting + size caps

- Mirror T1's caps at the bridge boundary (text ≤ 4000 after trim, project_hint ≤ 128,
  metadata ≤ 8 KB) — fail fast with a friendly error before any network hop.
- Rate limit keyed on resolved `client_id`: token bucket, default **10 proposals/hour,
  burst 3** per connector (env-tunable: `TERMDECK_BRIDGE_PROPOSE_RATE_PER_HOUR`,
  `_BURST`). In-memory state is acceptable (single bridge process; note in a comment that
  multi-origin HA resets buckets per origin — accepted, the DB-side caps in T3 are the
  durable backstop). 429-style tool error naming the retry window.

### 6. Tool descriptor + mount

`src/tools/memory.js` (or a sibling `propose.js` if cleaner) — descriptor per the house
shape: zod-factory `inputSchema` (`text` required; `project` optional → forwarded as
`project_hint`; NO source_agent in the schema — see § 3), honest annotations (§ 1),
`approval: true` via policy, handler pipeline: resolve identity → caps → rate limit →
ingress scan → `clients.mnestra.propose(...)` → `ok()` result that tells the model the
proposal is QUARANTINED PENDING REVIEW (so the chat doesn't claim "saved to memory") and
includes the inbox id. Errors via `toolError` (which already routes through egress
redaction). Description text must state: proposals are reviewed asynchronously, may be
rejected, and do not appear in recall until promoted.

### 7. Tests (canonical glob — `packages/mcp-bridge/test/*.test.js`, green via `npm test`)

Policy carve-out matrix (§ 1), identity mapping (explicit map wins, heuristic fallback,
unmappable rejects, caller-supplied source_agent in args is IGNORED), ingress-scan
reject (literal + builtin pattern + clean passes; rejection reason contains no secret),
caps boundaries, rate-limit (burst then 429, refill), client propose() op-shape +
400-mapping, end-to-end tool handler with mocked webhook, and a leak-gate-style test that
the tool RESULT path still passes egress redaction.

## NOT in scope

- engram-side anything (T1 owns the webhook op + RPC + schema — read their WIP, never edit
  the engram repo). The promotion pass (T3). `auth.js` client-registration changes (static
  OAuth = Sprint 75). Mounting the tool on the LIVE public bridge / PROD config — ships dark;
  Josh decides activation at close. No commits, no version bumps, no CHANGELOG.

## Acceptance

1. FIX-PROPOSED post for the policy carve-out (design + invariant wording) BEFORE landing it
   — this is the sprint's riskiest edit and T4 will audit it in flight.
2. `memory_propose` mounted with honest annotations; `memory_remember`/`memory_forget`
   provably still unmountable (tests).
3. Identity fail-closed; ingress scan reject-not-scrub; caps + rate limits enforced and
   tested.
4. Full bridge suite green; no existing test weakened to make room (changing an existing
   assertion requires a FINDING post explaining why).
5. DONE post states the exact operator setup needed at activation: bridge-propose.json map,
   redact literals expectation, rate-limit envs, approval behavior per connector.

## Lane discipline

Post shape: `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the Sprint 76 STATUS.md at the
absolute path in PLANNING.md. Idle-poll for T1's contract confirmation with
`^(### )?\[T1\] (FIX-LANDED|DONE)\b` (tolerant). Before posting DONE, answer any
unacknowledged HANDOFF-REQUEST naming T2; after DONE, enter PERIPHERY WATCH (re-read
STATUS.md until `^(### )?\[T4-GROK\] FINAL-VERDICT\b`; respond to AUDIT-* naming your lane).
Stay in lane. No commits, no version bumps, no CHANGELOG. ORCH STATUS posts are binding,
including post-DONE.
