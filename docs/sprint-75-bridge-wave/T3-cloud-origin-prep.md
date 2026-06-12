# T3 — Cloud third bridge origin: PREP ONLY (memory-only mode + runbook + LB doc)

## Mission

The bridge's high-availability chain (Cloudflare LB fronting `bridge.joshuaizzard.dev`,
per-machine named tunnels, design canon in the Mnestra "BRIDGE HIGH-AVAILABILITY DESIGN"
memory + `~/termdeck-air-kit/AIR-SETUP.html` Part 3) needs its third, always-on origin: a
small VPS running mcp-bridge behind its own named tunnel. This lane PREPARES everything —
code, runbook, LB procedure — and provisions NOTHING. Three deliverables:

- **(a)** a bridge mode/flag to run **memory-tools-only** — a cloud origin has no TermDeck
  server and no panels, so `list_panels`/`read_panel` must be cleanly absent there, not
  erroring;
- **(b)** a blind-executable **provision runbook** for the VPS origin;
- **(c)** the **Cloudflare LB setup doc** covering the not-yet-executed AIR-SETUP Part 3
  (Air-side tunnel + LB) AND the cloud pool as ONE operator procedure.

**HARD CONSTRAINT: no live provisioning.** No VPS purchase, no `cloudflared tunnel create`,
no Cloudflare dashboard/API mutations, no DNS changes. Josh executes your docs post-sprint
(spend pre-authorized up to ~$20/mo on 06-11).

## Mandatory pre-reads

1. `memory_recall(project="termdeck", query="BRIDGE HIGH-AVAILABILITY DESIGN per-machine tunnel Cloudflare load balancer")`
   — the adopted design canon: each Mac runs its OWN named tunnel fronting its local bridge;
   the LB (~$5/mo) health-checks origins and fails over; pool order imac → air → cloud.
2. `packages/mcp-bridge/docs/tunnel.md` — existing tunnel doc shape and the permanent
   `termdeck-bridge` tunnel (2026-06-10) it describes.
3. `packages/mcp-bridge/src/server.js` — your code surface: `loadTools` :374-378,
   `bootstrap` :381-416 (tools assembly + the fail-closed withhold at :409-414), `/healthz`
   :186-196, `main()` env handling :441-448.
4. `packages/mcp-bridge/src/tools/index.js` — `buildTools` assembles
   `buildMemoryTools(...) ++ buildPanelTools(...)` at :34-37.
5. `packages/mcp-bridge/src/auth.js` :112-145 + :163-180 — state file semantics
   (`~/.termdeck/bridge-auth.json`: jwtSecret + DCR clients + HASHED refresh tokens), because
   "shared bridge-auth.json across origins" is a load-bearing design point your runbook must
   get right. Coordinate with T1's static-client config (read their STATUS posts) — static
   clients are config-borne, NOT in the state file, so the runbook must carry BOTH the state
   file and the static-client env to the cloud origin.

## Deliverable (a) — memory-tools-only flag (code + tests)

- Flag: `TERMDECK_BRIDGE_MEMORY_ONLY=1` env + `options.memoryOnly` (follow the existing
  option > env precedence style). Naming is yours if you justify it in a FIX-PROPOSED.
- Implementation point: the tools assembly seam — either pass the flag through
  `loadTools`/`buildTools` so `buildPanelTools` is never invoked, or filter by descriptor
  name post-build. Prefer never-invoked: on a panel-less host the termdeck client's base URL
  points at nothing, and a tool that exists-but-always-errors is worse than absent (it
  burns the consumer chat's tool-call budget and confuses the model).
- `/healthz` (:186-196) should surface the mode (e.g. `mode: 'memory-only'`) so the LB doc's
  verification step can assert which origin flavor answered. Keep `/healthz` secret-free.
- The flag must NOT disable memory tools, auth, redaction, or rate limiting. Egress
  redaction (`withEgressRedaction`) remains wrapped on everything — it is a FROZEN contract.
- **Tests** — NEW `packages/mcp-bridge/test/memory-only-mode.test.js` (**flat in `test/`**,
  matching the canonical glob `packages/mcp-bridge/test/*.test.js`):
  1. Flag on → mounted tool names contain the memory tools and contain NO panel tools
     (assert on actual registered names, not counts).
  2. Flag off → both families present (regression).
  3. `/healthz` reports the mode.
  4. Fail-closed interaction preserved: tools-without-policy still withholds (the :409-414
     branch) regardless of flag.

## Deliverable (b) — provision runbook (doc only)

NEW `packages/mcp-bridge/docs/cloud-origin.md` (lives beside `tunnel.md`). Blind-executable
operator procedure, migration-runbook style (purpose / preconditions / numbered steps /
verify / rollback):

1. VPS selection + sizing (smallest tier, ~$5/mo; any provider; Ubuntu LTS assumed; note
   Josh's ~$20/mo pre-authorization ceiling).
2. Node install + mcp-bridge install/run on the VPS (no panels, no TermDeck server),
   `TERMDECK_BRIDGE_MEMORY_ONLY=1`, `TERMDECK_BRIDGE_PUBLIC_URL=https://bridge.joshuaizzard.dev`
   (CRITICAL: issuer/resource must be the PUBLIC LB hostname on ALL origins, or audience
   binding (RFC 8707, auth.js :446-449) rejects tokens minted via another origin), operator
   secret + JWT secret via env, process supervision (systemd unit — print, don't execute).
3. **Shared auth state.** All origins must verify each other's tokens and serve each other's
   clients: same `TERMDECK_BRIDGE_JWT_SECRET` (env beats state file, auth.js :172-174 — use
   env on every origin rather than copying the file's secret), same operator secret, same
   static-client config (T1's env), and a copy of `~/.termdeck/bridge-auth.json` for DCR
   clients. **Document the known seam honestly:** refresh-token ROTATION state is a
   per-origin file with no sync — a refresh served by origin A invalidates the hash in A's
   file only; after LB failover the client's next refresh against origin B can fail and the
   consumer chat will re-run the OAuth flow. State the mitigation options (LB session
   affinity; periodic state-file sync; accept re-auth as the failover cost) and which one
   the runbook adopts as default (recommend: accept re-auth — simplest, fail-safe; flag for
   ORCH ratification). Do NOT paper over this; it is the first thing T4 will probe.
4. cloudflared install + **named tunnel `termdeck-bridge-cloud`** (create/route/run commands
   spelled out for Josh to run; you run nothing), credentials file handling, systemd for
   cloudflared.
5. Verify section: `curl https://<tunnel-hostname>/healthz` shows `mode: memory-only`;
   token minted via the LB hostname works against the cloud origin directly.
6. Rollback: remove pool member, destroy tunnel, destroy VPS.

Placeholders for anything account-specific. Never the internal Supabase project name/ref.

## Deliverable (c) — Cloudflare LB setup doc (doc only)

NEW `packages/mcp-bridge/docs/load-balancer.md` — ONE consolidated operator procedure that
covers BOTH the unexecuted AIR-SETUP Part 3 (Air's own tunnel + joining the LB) and the new
cloud pool, so Josh executes a single doc top-to-bottom:

1. Current state preamble: iMac origin live behind tunnel `termdeck-bridge`; Air tunnel +
   LB NOT yet executed; cloud origin from runbook (b).
2. LB creation on zone `joshuaizzard.dev` for hostname `bridge` (~$5/mo): monitor = HTTPS
   GET `/healthz`, expected 200 (+ optionally body contains `"ok":true`); three pools in
   priority/failover order **imac → air → cloud**; sensible intervals/retries (state them).
3. Air steps (subsume AIR-SETUP.html Part 3 — restate, don't reference-only, so the doc
   stands alone): named tunnel on the Air fronting its local bridge, same env contract as
   (b) step 2-3.
4. Cutover note: `bridge.joshuaizzard.dev` currently CNAMEs the iMac tunnel directly — the
   LB replaces that record; sequence so the Gemini/Claude/ChatGPT connectors never see a
   dead hostname (create LB → verify via LB → done; tunnels keep their own
   `*.cfargotunnel.com` addressability for direct testing).
5. Verification matrix: kill iMac bridge → LB serves Air; kill both Macs → LB serves cloud
   (memory-only); each step's expected `/healthz` evidence.

## NOT in scope

- `packages/mcp-bridge/src/auth.js` (T1 owns it). If shared-state needs an auth.js change
  (e.g., exporting a state-sync helper), post `### [T3] HANDOFF-REQUEST` to T1 and wait for ACK.
- Any live provisioning/mutation (see hard constraint), any spend.
- LB pool weighting/geo-steering sophistication — failover-priority only.
- Version bumps, CHANGELOG, commits, publishes.

## Acceptance

1. Memory-only flag implemented; the 4 tests above green inside the canonical glob; full
   root `npm test` green; redaction/auth/rate-limit provably untouched by the flag.
2. `cloud-origin.md` blind-executable, with the shared-auth seam (refresh rotation across
   origins) documented + a default mitigation proposed for ORCH ratification.
3. `load-balancer.md` is a single standalone procedure covering Air Part 3 + cloud pool +
   cutover + verification matrix.
4. Zero live mutations performed (T4 will look for evidence you ran cloudflared/CF API calls
   — there must be none).

## Lane discipline

Post shape: `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / HANDOFF-REQUEST / DONE), `### ` prefix mandatory, in
`docs/sprint-75-bridge-wave/STATUS.md`. Tolerant read regex: `^(### )?\[T<n>\] <VERB>\b`.
Stay in lane. No commits, no version bumps, no CHANGELOG. **Before posting DONE:** check for
unacknowledged HANDOFF-REQUESTs targeting T3 (T1 may route a server.js touch to you — you own
server.js this sprint). **After DONE: PERIPHERY WATCH** — re-read STATUS.md every few minutes
until FINAL-VERDICT; answer AUDIT-CONCERNs touching your lane. ORCH decisions posted after
your DONE still bind you.
