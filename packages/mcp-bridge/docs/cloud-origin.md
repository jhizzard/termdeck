# Cloud third origin — provision runbook (memory-only bridge on a VPS)

**Purpose.** Stand up the third, always-on origin of the bridge high-availability
chain: a small VPS running the MCP Bridge in **memory-only mode** behind its own
named Cloudflare tunnel (`termdeck-bridge-cloud`). When both Macs are down, the
load balancer (see `load-balancer.md`) fails `bridge.joshuaizzard.dev` over to
this origin, and the web-chat connectors keep serving **Mnestra memory** —
panel tools are absent by construction (there is no TermDeck server here).

This is an operator runbook: numbered steps, copy-paste commands, nothing here
executes itself. Every step is idempotent or says how to re-run safely.

**Cost guardrail:** smallest VPS tier ≈ $5/mo + Cloudflare LB ≈ $5/mo ≈ **$10/mo
total**, inside the pre-authorized ~$20/mo ceiling (2026-06-11).

---

## What this origin runs (and doesn't)

| Process | Port | Why |
|---|---|---|
| `mnestra serve` | `127.0.0.1:37778` | The bridge's memory tools call the Mnestra webhook, which talks to your cloud Supabase. Same corpus as the Macs. |
| MCP Bridge (`TERMDECK_BRIDGE_MEMORY_ONLY=1`) | `127.0.0.1:8870` | Serves `memory_recall` + `memory_search` only. `/healthz` reports `mode: "memory-only"`, `origin: "cloud"`. |
| `cloudflared tunnel run termdeck-bridge-cloud` | (outbound only) | Public HTTPS ingress without any open inbound port. |
| ~~TermDeck server~~ | — | **Not installed.** No panels exist here; the panel-tool family is never mounted (not present-but-erroring). |

**Trust boundary, stated plainly:** this VPS will hold your Supabase
service-role key, the bridge JWT signing secret, the operator consent secret,
and a copy of `bridge-auth.json`. Treat it like a Mac: SSH keys only, loopback
binds, outbound-only tunnel, 0600 secrets, automatic security updates.

## Preconditions

- [ ] The LB design is adopted and `load-balancer.md` is queued next (this
      runbook is its Part B).
- [ ] Cloudflare account with the `joshuaizzard.dev` zone (the same one the
      iMac's `termdeck-bridge` tunnel lives in).
- [ ] iMac bridge healthy (`curl -s http://127.0.0.1:8870/healthz` on the iMac)
      — it is the source of the auth state you will copy.
- [ ] Values in hand (collect on the iMac, transfer by `scp` only — never
      email/cloud/commit):
  - `~/.termdeck/bridge-auth.json` (DCR client registrations + hashed refresh tokens)
  - `~/.termdeck/bridge-operator-secret.txt` (consent secret)
  - `~/.termdeck/bridge-redact.json` if present (org redaction literals)
  - From `~/.termdeck/secrets.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
    `OPENAI_API_KEY` (Mnestra's needs)
  - T1's static-client values if the Gemini Enterprise connector is configured:
    `TERMDECK_BRIDGE_STATIC_CLIENT_ID` / `_SECRET` / `_REDIRECT_URIS`
    (+ `_ALLOW_NO_PKCE` only if explicitly in use)

---

## Step 1 — VPS

Any provider's smallest tier is enough (1 vCPU / 1 GB RAM / Ubuntu 24.04 LTS,
~$5/mo). Create it with your SSH key, no password auth. Then:

```bash
# as root, once
adduser --disabled-password --gecos '' bridge
mkdir -p /home/bridge/.ssh && cp ~/.ssh/authorized_keys /home/bridge/.ssh/ \
  && chown -R bridge:bridge /home/bridge/.ssh && chmod 700 /home/bridge/.ssh

apt-get update && apt-get -y upgrade
apt-get -y install ufw unattended-upgrades git curl
ufw default deny incoming && ufw default allow outgoing && ufw allow OpenSSH && ufw --force enable
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Nothing else opens an inbound port — the bridge and Mnestra bind loopback, and
cloudflared dials out.

## Step 2 — Node + the two services' code

```bash
# as root: Node 22 LTS (bridge requires >=20)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get -y install nodejs

# as bridge:
su - bridge
npm config set prefix ~/.npm-global && echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.profile && . ~/.profile
npm install -g @jhizzard/mnestra

# The bridge is repo-resident (private package, not published to npm):
git clone https://github.com/jhizzard/termdeck ~/termdeck
cd ~/termdeck/packages/mcp-bridge && npm install --omit=dev
```

## Step 3 — Secrets and the shared auth contract

All three origins (iMac, Air, cloud) must mint and verify each other's tokens.
Four things make that true; get each one right:

1. **Same public URL everywhere.** `TERMDECK_BRIDGE_PUBLIC_URL=https://bridge.joshuaizzard.dev`
   on **all** origins. The issuer and the RFC 8707 token audience derive from it
   (`src/auth.js` — `verifyAccessToken` rejects any token whose audience isn't
   this exact resource). An origin pinned to its own hostname would reject every
   token minted via the LB hostname.
2. **Same JWT signing secret everywhere — via env (ratified default).**

   > ⚠️ **ENCODING GOTCHA — read before touching the secret.** The state file
   > stores `jwtSecret` **base64url-encoded**; the env path uses the env
   > string's **raw UTF-8 bytes** (no decode). **Never paste the file's
   > `jwtSecret` value into `TERMDECK_BRIDGE_JWT_SECRET`** — it would derive a
   > *different* key and every cross-origin token would fail. Generate a fresh
   > value instead and set the *same string* on all three origins:
   >
   > ```bash
   > openssl rand -hex 32   # run ONCE, use this one value everywhere
   > ```

   **Do this inside a stated maintenance window, and BEFORE the cloud pool is
   activated in the LB** (sequencing ratified by ORCH, Sprint 75). On each Mac,
   add to `~/.termdeck/supervisor.env`:

   ```bash
   TERMDECK_BRIDGE_JWT_SECRET=<the one value>
   ```

   then bounce that Mac's bridge so the supervisor restarts it with the new env
   (`lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill`, wait one 60s supervisor
   tick, confirm `/healthz`). **Consequence, stated honestly:** outstanding
   access tokens (≤1h lifetime) are invalidated at that restart. Connectors
   recover **automatically** through their refresh token — refresh tokens are
   random strings matched by hash in `bridge-auth.json`, not JWTs, so they
   survive the signing-secret change; this is the same flow as routine hourly
   expiry. Worst case is a one-time "reconnect" prompt in a chat's connector
   settings.

   *Zero-disruption fallback (also supported):* set the env var on **no**
   origin and let the copied `bridge-auth.json`'s `jwtSecret` govern everywhere
   (today's de-facto Air pattern). Works identically; weaker against
   "file regenerated before it was copied" drift, which is why env-everywhere
   is the ratified default.
3. **Same operator secret everywhere** — the consent passphrase. Copy the
   iMac's value (step below).
4. **Same client knowledge everywhere.** DCR clients + refresh-token hashes
   live in `bridge-auth.json` → copy it. T1's static client (Gemini
   Enterprise) is **config-borne, not in the state file** → carry its env vars
   to every origin too.

On the VPS, as `bridge`:

```bash
mkdir -p ~/.termdeck && chmod 700 ~/.termdeck
```

From the iMac:

```bash
scp ~/.termdeck/bridge-auth.json           bridge@<VPS-IP>:.termdeck/
scp ~/.termdeck/bridge-operator-secret.txt bridge@<VPS-IP>:.termdeck/
scp ~/.termdeck/bridge-redact.json         bridge@<VPS-IP>:.termdeck/ 2>/dev/null || true
```

Back on the VPS, write the two env files (0600):

```bash
umask 077
cat > ~/.termdeck/secrets.env <<'EOF'
# Mnestra (memory store) — same values as the Macs' ~/.termdeck/secrets.env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
OPENAI_API_KEY=<openai-key>
MNESTRA_WEBHOOK_PORT=37778
EOF

cat > ~/.termdeck/bridge.env <<'EOF'
TERMDECK_BRIDGE_MEMORY_ONLY=1
TERMDECK_BRIDGE_ORIGIN_LABEL=cloud
TERMDECK_BRIDGE_PUBLIC_URL=https://bridge.joshuaizzard.dev
TERMDECK_BRIDGE_HOST=127.0.0.1
PORT=8870
MNESTRA_WEBHOOK_URL=http://localhost:37778/mnestra
TERMDECK_BRIDGE_JWT_SECRET=<the one value from step 3.2>
TERMDECK_BRIDGE_OPERATOR_SECRET=<contents of bridge-operator-secret.txt>
# T1 static client (only if the Gemini Enterprise connector is configured):
#TERMDECK_BRIDGE_STATIC_CLIENT_ID=<id>
#TERMDECK_BRIDGE_STATIC_CLIENT_SECRET=<secret>
#TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS=<uris>
EOF
chmod 600 ~/.termdeck/secrets.env ~/.termdeck/bridge.env ~/.termdeck/bridge-auth.json ~/.termdeck/bridge-operator-secret.txt
```

Deliberately **not** set: `TERMDECK_BRIDGE_ALLOWLIST_*` (panel tools don't
exist here, and default-deny is the right posture anyway), `TERMDECK_API_BASE`
(nothing to point it at), `TERMDECK_BRIDGE_STATIC_BEARER` (dev-only, never on a
public origin), and `TERMDECK_BRIDGE_ENABLE_PROPOSE` (the memory-proposal
channel ships dark, default-off — leaving it unset keeps this origin strictly
read-only with `tools: 2`; enabling it anywhere is a deliberate operator
decision outside this runbook).

### The known seam: refresh-token rotation is per-origin (read this once)

Refresh tokens **rotate on whichever origin serves the refresh**, and rotation
mutates only that origin's `bridge-auth.json` — there is no sync. After a
failover, a connector's next refresh against a *different* origin can miss the
hash lookup and fail; that chat then re-runs the OAuth flow (consent secret
required). **Ratified default (ORCH, Sprint 75): accept the re-auth.** It is
the simplest fail-safe — the cost is a one-time reconnect prompt, never silent
breakage — plus this hygiene rule:

> Re-copy `~/.termdeck/bridge-auth.json` from the origin that has been serving
> to the others after (a) adding or re-authorizing any connector, or (b) any
> window in which a non-primary origin served (a trip, an iMac outage).

Considered and rejected: **LB session affinity** (moot — Failover steering
already sends all traffic to the single highest-priority healthy pool;
affinity adds nothing across an origin death, which is the only transition
that matters) and **periodic bidirectional file sync** (rotating hashes +
last-writer-wins = silent clobber risk; not worth it at three origins). Note
the static client's *registration* survives any failover (it is config-borne),
but its refresh chain lives in the state file like everyone else's — same
seam, same answer.

## Step 4 — systemd units (printed here; you install them)

As root, create the three units:

```ini
# /etc/systemd/system/mnestra-serve.service
[Unit]
Description=Mnestra memory webhook (:37778)
After=network-online.target
Wants=network-online.target

[Service]
User=bridge
EnvironmentFile=/home/bridge/.termdeck/secrets.env
ExecStart=/home/bridge/.npm-global/bin/mnestra serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/termdeck-bridge.service
[Unit]
Description=TermDeck MCP Bridge (memory-only cloud origin, :8870)
After=network-online.target mnestra-serve.service
Wants=network-online.target

[Service]
User=bridge
EnvironmentFile=/home/bridge/.termdeck/bridge.env
WorkingDirectory=/home/bridge/termdeck/packages/mcp-bridge
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/cloudflared-bridge.service
[Unit]
Description=cloudflared named tunnel termdeck-bridge-cloud
After=network-online.target termdeck-bridge.service
Wants=network-online.target

[Service]
User=bridge
ExecStart=/usr/local/bin/cloudflared tunnel run termdeck-bridge-cloud
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable the first two now (cloudflared after step 5 creates the tunnel):

```bash
systemctl daemon-reload
systemctl enable --now mnestra-serve termdeck-bridge
```

## Step 5 — the named tunnel `termdeck-bridge-cloud`

As `bridge` on the VPS:

```bash
# install cloudflared (Linux amd64; pick the right arch if not)
sudo curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
sudo chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login          # browser opens — pick the joshuaizzard.dev zone
cloudflared tunnel create termdeck-bridge-cloud
cloudflared tunnel list           # note the UUID for termdeck-bridge-cloud → <CLOUD-TUNNEL-UUID>
```

**Do not run `cloudflared tunnel route dns`** — `bridge.joshuaizzard.dev` will
be owned by the load balancer, not a CNAME. Write the config:

```bash
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <CLOUD-TUNNEL-UUID>
credentials-file: /home/bridge/.cloudflared/<CLOUD-TUNNEL-UUID>.json
ingress:
  - hostname: bridge.joshuaizzard.dev
    service: http://127.0.0.1:8870
  - service: http_status:404
EOF
chmod 600 ~/.cloudflared/*.json
sudo systemctl enable --now cloudflared-bridge
```

## Verify (all from the VPS unless noted)

```bash
# 1. Mnestra serves and sees the shared corpus:
curl -s http://127.0.0.1:37778/healthz
#    → { "ok": true, ..., "store": { "rows": <thousands>, ... } }

# 2. Bridge is up, memory-only, labeled, pinned to the LB hostname:
curl -s http://127.0.0.1:8870/healthz
#    → { "ok":true, "mode":"memory-only", "origin":"cloud", "tools":2,
#        "resource":"https://bridge.joshuaizzard.dev/mcp", ... }

# 3. Audience/issuer wiring proven WITHOUT a token — the 401 must advertise the
#    PUBLIC hostname's resource metadata:
curl -si -X POST http://127.0.0.1:8870/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | grep -i www-authenticate
#    → ...resource_metadata="https://bridge.joshuaizzard.dev/.well-known/oauth-protected-resource/mcp"
```

Optional end-to-end public probe *before* the LB exists: temporarily route a
test hostname at the tunnel, curl checks 1–3 against
`https://bridge-cloud-test.joshuaizzard.dev`, then **delete that DNS route**.
(`<CLOUD-TUNNEL-UUID>.cfargotunnel.com` is not directly reachable from the
public internet — it only works as an LB/CNAME origin inside Cloudflare.)

```bash
cloudflared tunnel route dns termdeck-bridge-cloud bridge-cloud-test.joshuaizzard.dev
# ...curl the three checks against https://bridge-cloud-test.joshuaizzard.dev ...
# then delete the bridge-cloud-test CNAME in the Cloudflare DNS dashboard.
```

The full **token-grant-via-LB** proof (mint via `bridge.joshuaizzard.dev`,
served by the cloud origin with both Macs down, live `memory_recall` from a web
chat) is the load balancer doc's verification matrix — run it there, after the
cloud pool joins.

## Rollback

1. Cloudflare dashboard → Load Balancing → remove/disable the `bridge-cloud`
   pool (the LB chain reverts to iMac → Air).
2. On the VPS: `sudo systemctl disable --now cloudflared-bridge termdeck-bridge mnestra-serve`.
3. `cloudflared tunnel cleanup termdeck-bridge-cloud && cloudflared tunnel delete termdeck-bridge-cloud`.
4. Destroy the VPS at the provider.
5. **If you suspect the VPS was compromised** (it held real secrets): rotate
   `TERMDECK_BRIDGE_OPERATOR_SECRET` and `TERMDECK_BRIDGE_JWT_SECRET` on both
   Macs (forces re-auth of every connector), rotate the Supabase service-role
   key and `OPENAI_API_KEY`, and re-add connectors so stale DCR client secrets
   in the copied `bridge-auth.json` die with the old state.
