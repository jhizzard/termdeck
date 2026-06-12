# T1 — Static OAuth client registration in `packages/mcp-bridge`

## Mission

The bridge's OAuth 2.1 Authorization Server (`packages/mcp-bridge/src/auth.js`) only mints
clients via RFC 7591 Dynamic Client Registration. The **Gemini Enterprise custom MCP
connector (preview) cannot DCR** — it requires a STATIC registration: client_id +
client_secret entered by the admin, plus the authorize/token URLs. Add static client support
ALONGSIDE DCR: pre-seeded client entries in the clients store + client_secret verification at
the token endpoint + a config surface for adding a static client + a docs page for the Gemini
Enterprise connector flow. Streamable-HTTP transport is already native on both sides — auth
registration is the only gap.

## Mandatory pre-reads

1. `packages/mcp-bridge/src/auth.js` — the whole file (559 lines). It is hand-rolled HS256 on
   node:crypto (jose is ESM-only, package is CommonJS — locked decision), stateless access
   JWTs (never stored), HASHED refresh tokens with OAuth 2.1 rotation, state file
   `~/.termdeck/bridge-auth.json` (mode 0600). Key anchors: `freshState()` :116-118
   (`{jwtSecret, clients, refresh}`), `createFileStore` :123-145, `createBridgeAuth` options
   resolution :148-194, `clientsStore` :310-330 (`getClient`/`registerClient` — DCR mints
   `client_secret` for non-public clients at :322-325), `exchangeAuthorizationCode` :383-403,
   `exchangeRefreshToken` :405-429, static-BEARER dev fallback :192-193 + :434-441 (distinct
   concept — do not conflate; it bypasses OAuth entirely and stays dev-only),
   `info` block :529-541, exports :547-558.
2. The installed MCP SDK's token-endpoint client authentication:
   `packages/mcp-bridge/node_modules/@modelcontextprotocol/sdk/server/auth/` (router.js wires
   `mcpAuthRouter`; the token handler authenticates the client against `clientsStore` records).
   **Verify exactly where/whether `client_secret` is compared** for confidential clients, and
   which auth methods it accepts (`client_secret_post` vs `client_secret_basic`). Post a
   FINDING with file:line. If the SDK does NOT verify the secret, the verification you add in
   our provider/store layer is the load-bearing gate — say so explicitly.
3. `packages/mcp-bridge/docs/connect-chatgpt.md` + `connect-claude.md` + `connect-grok.md` —
   the docs-page shape your Gemini Enterprise page must match.
4. `packages/mcp-bridge/test/auth.test.js` — the existing test idioms (node:test, injected
   `createMemoryStore`).

## Scope (files you own)

- `packages/mcp-bridge/src/auth.js` — all static-client work lives here:
  - **Config surface.** `options.staticClients` (array of
    `{ client_id, client_secret, redirect_uris, client_name?, scope? }`) plus env fallback
    `TERMDECK_BRIDGE_STATIC_CLIENT_ID` / `TERMDECK_BRIDGE_STATIC_CLIENT_SECRET` /
    `TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS` (comma-separated) for the single-client
    common case. Follow the existing explicit-option > env > default resolution style (:148-194).
  - **Seeding.** Merge static clients over the persisted DCR clients at `getClient` time
    (recommended: keep static clients IN-MEMORY, layered above `state.clients`, and never
    write them into `bridge-auth.json` — the secret should have exactly one source of truth,
    the config. If you deviate, post a FINDING with the rationale). Static entries get
    `token_endpoint_auth_method: 'client_secret_post'` (plus `'client_secret_basic'` if the
    SDK supports it — see pre-read 2), `grant_types: ['authorization_code','refresh_token']`,
    `client_secret_expires_at: 0`.
  - **Secret verification at the token endpoint.** Whatever pre-read 2 reveals: either prove
    the SDK compares `client_secret` timing-safely against the store record (then your test
    pins it), or add the comparison in our layer using the existing `timingSafeEqualStr`
    (:55-59). A static client presenting a wrong/absent secret MUST get `invalid_client`,
    never a token.
  - **Collision guard.** A DCR registration can never mint an id colliding with a static id
    (DCR ids are `mcp_`-prefixed random :315 — assert static ids must NOT start with `mcp_`,
    or check explicitly).
  - **Redaction.** The static secret must never appear in logs, the boot banner, `/healthz`,
    or the `info` block (:529-541 — extend `info` with `staticClientIds` only, never secrets).
- `packages/mcp-bridge/docs/connect-gemini-enterprise.md` — NEW. The operator flow: where in
  the Gemini Enterprise admin console the connector is configured; what to paste
  (client_id, client_secret, authorize URL `https://<bridge-host>/authorize`, token URL
  `https://<bridge-host>/token` — confirm exact mounted paths from `mcpAuthRouter`, post the
  real ones); how to obtain Gemini's redirect URI and feed it into
  `TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS`; the consent-page/operator-secret step;
  Streamable-HTTP endpoint `https://<bridge-host>/mcp`. Placeholders only — never a real
  hostname secret or project ref.
- Tests — NEW `packages/mcp-bridge/test/auth-static-client.test.js` (**must be flat in
  `test/`** — the canonical root glob is `packages/mcp-bridge/test/*.test.js`, no
  subdirectories):
  1. Static client token grant end-to-end: seeded client → authorize → code → token exchange
     WITH correct secret → access+refresh issued; wrong secret → `invalid_client`; absent
     secret → rejected.
  2. Refresh rotation for the static client: old refresh invalidated, new one works, scope
     escalation rejected (mirror :405-429 semantics).
  3. DCR path unaffected: existing DCR registration + grant still works with static clients
     configured; `registerClient` cannot clobber a static id.
  4. Static client never persisted: after a grant, `bridge-auth.json` (memory-store state)
     contains no static client_secret.

## Known traps (post a FINDING either way — do not silently route around)

- **PKCE.** OAuth 2.1 mandates PKCE and our `authorize` stores `code_challenge` (:246-257);
  the SDK token handler verifies the verifier. Gemini Enterprise's connector may or may not
  send PKCE as a confidential client. Empirically determine what the SDK's authorize handler
  does when `code_challenge` is absent, and decide: if Gemini can't PKCE, you need a
  deliberate, secret-verified, confidential-client-only relaxation — flag it loudly for T4
  and ORCH veto; never relax PKCE for public clients.
- **Redirect URI.** Static client redirect_uris must be exact-matched (the SDK validates
  against the client record). The doc must tell the operator how to get the exact value.

## NOT in scope

- `packages/mcp-bridge/src/server.js`, `src/tools/`, `src/policy.js` — T3 owns server.js this
  sprint. If your config surface genuinely needs a server.js touch (e.g., boot banner line),
  post `### [T1] HANDOFF-REQUEST` addressed to T3 and wait for ACK.
- Buying/configuring the Gemini Enterprise seat (Josh), live tunnel/LB work (T3 docs, Josh executes).
- Version bumps, CHANGELOG, commits, publishes.

## Acceptance

1. Static client completes grant + refresh rotation in tests; wrong secret rejected.
2. DCR regression tests green; full `npm test` from repo root green.
3. `connect-gemini-enterprise.md` shipped with real (verified) endpoint paths.
4. FINDING posted for the SDK secret-verification location AND the PKCE decision, file:line.
5. No secret in logs/banner/healthz/info/state-file (test-pinned where feasible).

## Lane discipline

Post shape: `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / HANDOFF-REQUEST / DONE), `### ` prefix mandatory, in
`docs/sprint-75-bridge-wave/STATUS.md`. Tolerant read regex for anything you poll:
`^(### )?\[T<n>\] <VERB>\b`. Stay in lane. All tests inside the canonical `npm test` glob.
No commits, no version bumps, no CHANGELOG. **Before posting DONE:** check STATUS.md for
unacknowledged HANDOFF-REQUESTs targeting T1. **After DONE: PERIPHERY WATCH** — re-read
STATUS.md every few minutes until FINAL-VERDICT; answer AUDIT-CONCERNs touching your lane.
ORCH decisions posted after your DONE still bind you.
