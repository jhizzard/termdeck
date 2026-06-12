# Bridge high availability — Cloudflare Load Balancer setup (one procedure)

**Purpose.** Put `bridge.joshuaizzard.dev` behind a Cloudflare Load Balancer
with three origins in failover order — **iMac → Air → cloud** — so the web-chat
connectors (Claude.ai / ChatGPT / Grok / Gemini Enterprise) survive either Mac
sleeping, and survive *both* Macs sleeping on memory-only service from the
cloud origin. This one doc subsumes the previously-unexecuted "AIR-SETUP
Part 3" (the Air's own tunnel) **and** the new cloud pool: execute it
top-to-bottom once.

**Design canon (adopted 2026-06-11).** Each machine runs its **own** named
tunnel fronting its local bridge on `:8870`. **Never** run one named tunnel as
replicas on two machines — Cloudflare splits traffic across replicas and
divergent backend state breaks connectors nondeterministically. One machine,
one tunnel; the LB does deterministic failover. MCP sessions bounce at
failover and self-heal (the bridge's spec-compliant `404` on an unknown
session id makes the client re-handshake automatically).

**Cost:** LB base plan ~$5/mo (the third origin may add ~$1/mo — confirm on the
enable screen) + ~$5/mo VPS ≈ $10–11/mo, inside the ~$20/mo pre-authorization.

---

## Current state (before this procedure)

| Origin | Tunnel | State |
|---|---|---|
| iMac | `termdeck-bridge` | **Live.** `bridge.joshuaizzard.dev` currently CNAMEs this tunnel directly; supervisor (`scripts/termdeck-supervise.sh` via launchd) keeps bridge + tunnel up. |
| Air | `termdeck-bridge-air` | **Not yet created** — Part A below creates it. |
| Cloud VPS | `termdeck-bridge-cloud` | **Not yet provisioned** — Part B (= `cloud-origin.md`) provisions it. |

## Part 0 — shared env contract (precondition for everything below)

All origins must present the same OAuth surface. Verify each origin's bridge
env before wiring the LB:

- `TERMDECK_BRIDGE_PUBLIC_URL=https://bridge.joshuaizzard.dev` — on **every**
  origin. Tokens are audience-bound to this exact resource; an origin pinned
  elsewhere rejects LB-minted tokens.
- `TERMDECK_BRIDGE_OPERATOR_SECRET` — same value everywhere.
- `TERMDECK_BRIDGE_JWT_SECRET` — same fresh value everywhere, rolled out in a
  stated maintenance window **before** the cloud pool activates (ratified
  default; full step, encoding warning, and the file-borne fallback live in
  `cloud-origin.md` § Step 3.2 — execute it there).
- Static-client env (Gemini Enterprise, if configured) — same values everywhere.
- `~/.termdeck/bridge-auth.json` copied to every origin (DCR clients + refresh
  hashes), `~/.termdeck/bridge-redact.json` too if present.
- **Origin labels** so the verification matrix is deterministic:
  `TERMDECK_BRIDGE_ORIGIN_LABEL=imac` / `air` / `cloud` per machine.

On the Macs, the env carrier is `~/.termdeck/supervisor.env` — the supervisor
`set -a`-sources it each tick, so every var in it reaches the bridge it spawns.
After editing it, bounce that Mac's bridge and let the supervisor restart it
with the new env (this is the maintenance-window mechanic):

```bash
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill   # next 60s tick restarts it
sleep 70 && curl -s http://127.0.0.1:8870/healthz # confirm mode/origin/resource
```

On the iMac, add to `~/.termdeck/supervisor.env` now:

```bash
TERMDECK_BRIDGE_ORIGIN_LABEL=imac
# plus TERMDECK_BRIDGE_JWT_SECRET=<the one value> when running the Step 3.2 window
```

## Part A — the Air origin (AIR-SETUP Part 3, restated standalone)

**A1. iMac — stage the auth state** (AirDrop or scp, never email/cloud/commit):

```bash
mkdir -p ~/termdeck-air-kit/secrets-bundle
cp ~/.termdeck/bridge-auth.json            ~/termdeck-air-kit/secrets-bundle/
cp ~/.termdeck/bridge-operator-secret.txt  ~/termdeck-air-kit/secrets-bundle/
cp ~/.termdeck/bridge-redact.json          ~/termdeck-air-kit/secrets-bundle/ 2>/dev/null || true
```

**A2. Air — create the Air's own named tunnel:**

```bash
cloudflared tunnel login                      # pick the joshuaizzard.dev zone
cloudflared tunnel create termdeck-bridge-air
cloudflared tunnel list                       # note the UUID → <AIR-TUNNEL-UUID>
```

**Do not** run `cloudflared tunnel route dns` — the hostname will be owned by
the LB, not a CNAME. Write the Air's `~/.cloudflared/config.yml` (UUID in both
places):

```yaml
tunnel: <AIR-TUNNEL-UUID>
credentials-file: /Users/<you>/.cloudflared/<AIR-TUNNEL-UUID>.json
ingress:
  - hostname: bridge.joshuaizzard.dev
    service: http://127.0.0.1:8870
  - service: http_status:404
```

**A3. Air — place the synced state + supervisor config.** Same hostname as the
iMac, **different tunnel name** — that's the whole trick:

```bash
cp ~/termdeck-air-kit/secrets-bundle/bridge-auth.json           ~/.termdeck/
cp ~/termdeck-air-kit/secrets-bundle/bridge-operator-secret.txt ~/.termdeck/
cp ~/termdeck-air-kit/secrets-bundle/bridge-redact.json         ~/.termdeck/ 2>/dev/null || true
cat > ~/.termdeck/supervisor.env <<'EOF'
TERMDECK_TUNNEL_NAME=termdeck-bridge-air
TERMDECK_PUBLIC_HOSTNAME=bridge.joshuaizzard.dev
TERMDECK_BRIDGE_ORIGIN_LABEL=air
EOF
```

(Add `TERMDECK_BRIDGE_JWT_SECRET=<the one value>` here during the Step 3.2
maintenance window, same as the iMac.)

**A4. Air — install the supervisor** (auto-starts bridge + tunnel, self-heals,
survives reboots):

```bash
REPO=~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
cp "$REPO/scripts/com.jhizzard.termdeck-supervise.plist" ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist
```

**A5. Air — verify locally:**

```bash
curl -s http://127.0.0.1:8870/healthz
# → { "ok":true, "mode":"full", "origin":"air",
#     "resource":"https://bridge.joshuaizzard.dev/mcp", ... }
```

## Part B — the cloud origin

Execute **`cloud-origin.md`** top-to-bottom (VPS + `mnestra serve` + memory-only
bridge + `termdeck-bridge-cloud` tunnel + its Verify section). Its Step 3.2 is
the shared-secret maintenance window that must complete — on all three origins —
**before** Part C adds the cloud pool. Note the `<CLOUD-TUNNEL-UUID>` it
produces.

## Part C — build the Load Balancer

Dashboard: **dash.cloudflare.com → joshuaizzard.dev → Traffic → Load
Balancing → enable** (base plan). Then, in order:

1. **Monitor** `bridge-healthz`: type **HTTPS**, port **443**, method GET, path
   **`/healthz`**, expected code **200**, expected body **`"ok":true`**
   (substring, optional but recommended), interval **60s**, timeout **5s**,
   retries **2**, follow redirects **off**.
2. **Pool** `bridge-imac`: one origin, address
   **`<IMAC-TUNNEL-UUID>.cfargotunnel.com`** (UUID from `cloudflared tunnel
   list` on the iMac), **Host header `bridge.joshuaizzard.dev`**, weight 1;
   attach the monitor; health threshold 1.
3. **Pool** `bridge-air`: same shape with `<AIR-TUNNEL-UUID>.cfargotunnel.com`.
4. **Pool** `bridge-cloud`: same shape with `<CLOUD-TUNNEL-UUID>.cfargotunnel.com`.
5. **Wait until all three pools show Healthy** in the dashboard. If a pool
   stays unhealthy, fix it *before* creating the LB (each machine:
   tunnel process up? bridge `/healthz` 200 locally?).
6. **Load Balancer** on hostname **`bridge`** (full name
   `bridge.joshuaizzard.dev`): proxied **on**, traffic steering **Failover
   (Off)**, pool order **bridge-imac → bridge-air → bridge-cloud**, session
   affinity **None** (deliberate — see Maintenance; affinity adds nothing under
   failover steering).
7. **Cutover:** the dashboard will flag the existing `bridge` CNAME (→ the
   iMac tunnel) as conflicting — **delete that CNAME** when prompted. The LB
   answers the hostname the moment the record swaps, and the iMac pool is
   primary, so the connectors never see a dead hostname; in-flight MCP
   sessions at most re-handshake once (spec-`404` → automatic re-init).
   The tunnels' `*.cfargotunnel.com` addresses stay valid as **LB origins**
   (they are not directly fetchable from the public internet — for hands-on
   per-origin testing use a temporary routed test hostname, see
   `cloud-origin.md` § Verify).

## Verification matrix

Run from any machine (`H=https://bridge.joshuaizzard.dev`). Failover detection
takes roughly one monitor interval + retries (~60–90s) per transition.

| # | State | Action | Expected `curl -s $H/healthz` |
|---|---|---|---|
| 1 | all origins up | — | `"mode":"full","origin":"imac"` |
| 2 | iMac down | iMac: `launchctl unload ~/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist && pkill -f 'cloudflared tunnel'` (or just sleep the iMac); wait ~90s | `"mode":"full","origin":"air"` |
| 3 | both Macs down | same on the Air; wait ~90s | `"mode":"memory-only","origin":"cloud","tools":2` |
| 4 | still #3 | live web chat: run a `memory_recall` | succeeds (memory via cloud); panel tools **absent** from the tool list in a *fresh* chat session (providers cache tool lists per conversation — open a new chat to observe) |
| 5 | restore | iMac + Air: `launchctl load -w …` (or wake them); wait ~90s | back to `"origin":"imac"` (failover steering returns to the highest-priority healthy pool) |

Each crossing in 2/3/5 can cost one refresh-rotation reconnect for a connector
that refreshes against a different origin than last time — that is the accepted
seam, next section. A full token-grant proof against the cloud origin is
matrix row 3+4: both Macs down, connect (or refresh) a chat via `$H`, then
`memory_recall` — minted via the LB hostname, served by the cloud origin.

## Maintenance — the one seam to remember

**Refresh-token rotation is per-origin state with no sync** (rotation rewrites
a hash in the serving origin's `bridge-auth.json` only). After a failover, a
connector's next refresh against a different origin can fail → that chat
re-runs OAuth (operator consent secret needed). **Ratified default: accept the
re-auth** — worst case a one-time "reconnect" prompt, never silent breakage —
with this hygiene rule:

> After (a) adding/re-authorizing any connector, or (b) any window where a
> non-primary origin served (trip, outage), re-copy `~/.termdeck/bridge-auth.json`
> from the origin that served to the other two.

Rejected alternatives, for the record: session affinity (moot under Failover
steering — only origin *death* moves traffic, and affinity cannot survive
that) and periodic bidirectional file sync (rotating hashes + last-writer-wins
= silent clobber risk). The static client's registration is config-borne and
survives failover by construction; its refresh chain is file-borne like all
others — same hygiene applies.

Also remember: `list_panels` / `read_panel` always show the **serving**
machine's panels (that's a feature when traveling); the cloud origin doesn't
mount them at all (`mode: "memory-only"` in `/healthz` is the tell).
