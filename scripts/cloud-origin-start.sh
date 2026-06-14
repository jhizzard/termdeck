#!/usr/bin/env bash
# cloud-origin-start.sh — Render start command for the always-on, memory-only
# bridge origin (3rd Cloudflare LB pool member; serves web-chat memory when BOTH
# Macs are off).
#
# Runs two processes in one Render service:
#   1. `mnestra serve`  — HTTP webhook on internal :37778  -> cloud Supabase
#   2. the mcp-bridge   — memory-only, 0.0.0.0:$PORT       -> localhost webhook
#
# Render sets cwd to the service rootDir (packages/mcp-bridge) and provides $PORT.
# ALL secrets come from Render env vars (never committed). See ../../render.yaml.
#
# Why bridge-auth.json from an env var: the bridge's jwtSecret must MATCH the Macs
# so OAuth access tokens issued on any origin validate here too. We materialize the
# shared file from the BRIDGE_AUTH_JSON secret at boot (Render's FS is ephemeral).
set -uo pipefail

MN_PORT="${MNESTRA_WEBHOOK_PORT:-37778}"

# 1. Shared bridge-auth.json (jwtSecret + client/refresh snapshot). Prefer a Render
#    Secret File (mounted at /etc/secrets/bridge-auth.json); fall back to the
#    BRIDGE_AUTH_JSON env var. Either way it MUST match the Macs' file so OAuth
#    tokens issued on any origin validate here too.
# Write to the EXACT path the bridge reads (node's os.homedir(), which may differ
# from the shell's $HOME on Render) so the bridge actually loads the shared secret.
DEST_DIR="$(node -e 'process.stdout.write(require("os").homedir())' 2>/dev/null)/.termdeck"
[ -n "$DEST_DIR" ] || DEST_DIR="$HOME/.termdeck"
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/bridge-auth.json"
if [ -f /etc/secrets/bridge-auth.json ]; then
  cp /etc/secrets/bridge-auth.json "$DEST"
  echo "[cloud-origin] bridge-auth.json -> $DEST ($(wc -c < "$DEST" | tr -d ' ') bytes)"
elif [ -n "${BRIDGE_AUTH_JSON:-}" ]; then
  printf '%s' "$BRIDGE_AUTH_JSON" > "$DEST"
  echo "[cloud-origin] bridge-auth.json from env -> $DEST ($(wc -c < "$DEST" | tr -d ' ') bytes)"
else
  echo "[cloud-origin] WARNING: no bridge-auth.json source — a NEW jwtSecret will be generated; Mac-issued tokens will NOT validate here."
fi
# Diagnostic: hash (not value) of the jwtSecret the bridge will load — compare to the Macs' de69cf9f3095.
node -e 'try{const c=require("crypto"),f=require("fs");const d=JSON.parse(f.readFileSync(process.argv[1],"utf8"));process.stdout.write("[cloud-origin] loaded jwtSecret sha256[:12] = "+c.createHash("sha256").update(String(d.jwtSecret)).digest("hex").slice(0,12)+"\n")}catch(e){process.stdout.write("[cloud-origin] WARN could not read jwtSecret: "+e.message+"\n")}' "$DEST" 2>/dev/null || true

# 2. Mnestra webhook (internal only) -> cloud Supabase. Needs SUPABASE_URL,
#    SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY in the env (Render secrets).
export MNESTRA_WEBHOOK_PORT="$MN_PORT"
echo "[cloud-origin] starting: mnestra serve on :$MN_PORT"
./node_modules/.bin/mnestra serve &
MN_PID=$!

# 3. Wait for the webhook before starting the bridge (bounded).
up=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${MN_PORT}/healthz" 2>/dev/null; then
    echo "[cloud-origin] mnestra webhook up after ${i}s"; up=1; break
  fi
  if ! kill -0 "$MN_PID" 2>/dev/null; then echo "[cloud-origin] FATAL: mnestra exited during boot"; exit 1; fi
  sleep 1
done
[ "$up" = "1" ] || echo "[cloud-origin] WARNING: mnestra webhook not confirmed up after 30s — starting bridge anyway"

# 4. The bridge (memory-only) on 0.0.0.0:$PORT — Render-facing, foreground = the service.
export TERMDECK_BRIDGE_HOST="${TERMDECK_BRIDGE_HOST:-0.0.0.0}"
export TERMDECK_BRIDGE_MEMORY_ONLY="${TERMDECK_BRIDGE_MEMORY_ONLY:-1}"
export MNESTRA_WEBHOOK_URL="${MNESTRA_WEBHOOK_URL:-http://127.0.0.1:${MN_PORT}/mnestra}"
echo "[cloud-origin] starting: bridge on 0.0.0.0:${PORT:-8870} (memory-only, origin=${TERMDECK_BRIDGE_ORIGIN_LABEL:-cloud})"
exec node src/server.js
