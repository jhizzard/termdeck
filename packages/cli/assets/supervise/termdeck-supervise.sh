#!/usr/bin/env bash
# termdeck-supervise.sh — keep the TermDeck stack self-healing.
#
# Ensures (and restarts if down) the four daily-driver processes. Every check is
# by PORT, never by process-arg path — `pgrep -f 'mcp-bridge/src/server.js'` is a
# known false-negative because the bridge's argv is just `node src/server.js`.
#   1. TermDeck server     :3000
#   2. Mnestra webhook     :37778
#   3. cloudflared tunnel  (public HTTPS → :8870; named = stable URL, quick = ephemeral)
#   4. MCP bridge          :8870  (re-pinned to the CURRENT tunnel URL via /healthz drift check)
#
# Idempotent: run once to bring the stack up; run on a timer (launchd/cron) to
# keep it up. State lives in ~/.termdeck: a STABLE operator secret + the current
# public URL + per-component logs. A stable secret means a bridge restart never
# silently changes the consent secret; the URL file means the bridge always
# re-pins to wherever the tunnel currently is.
#
# Config (env, or ~/.termdeck/supervisor.env):
#   TERMDECK_REPO_DIR          default: derived from this script's location
#   TERMDECK_SECRETS_ENV       default: ~/.termdeck/secrets.env
#   TERMDECK_TUNNEL_NAME       a named cloudflared tunnel → STABLE url (recommended once you
#                              have a Cloudflare domain). Unset ⇒ ephemeral quick tunnel.
#   TERMDECK_PUBLIC_HOSTNAME   the https host routed to the named tunnel (required if NAME set)
#   TERMDECK_BRIDGE_ALLOWLIST_PROJECTS  default '*' (panels visible to web chats; still approval-gated)
#   TERMDECK_SUPERVISE_DRY_RUN=1   log intended actions, start/kill NOTHING (safe to test live)
set -uo pipefail

STATE_DIR="${HOME}/.termdeck"
LOG_DIR="${STATE_DIR}/logs"
mkdir -p "$LOG_DIR"
# Operator overrides first, then defaults.
if [ -f "${STATE_DIR}/supervisor.env" ]; then set -a; . "${STATE_DIR}/supervisor.env"; set +a; fi

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TERMDECK_REPO_DIR:-$(cd "${SELF_DIR}/.." && pwd)}"
SECRETS_ENV="${TERMDECK_SECRETS_ENV:-${STATE_DIR}/secrets.env}"
SECRET_FILE="${STATE_DIR}/bridge-operator-secret.txt"
URL_FILE="${STATE_DIR}/bridge-public-url.txt"
ALLOWLIST_PROJECTS="${TERMDECK_BRIDGE_ALLOWLIST_PROJECTS:-*}"
DRY="${TERMDECK_SUPERVISE_DRY_RUN:-0}"

ts()  { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" | tee -a "${LOG_DIR}/supervise.log" >&2; }
port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
would() { [ "$DRY" = "1" ]; }

ensure_secret() {
  [ -s "$SECRET_FILE" ] && return 0
  would && { log "DRY: would generate a stable operator secret at $SECRET_FILE"; return 0; }
  ( umask 077; openssl rand -hex 16 > "$SECRET_FILE" )
  log "generated a stable operator secret at $SECRET_FILE"
}

start_server() {
  port_up 3000 && return 0
  would && { log "DRY: would START TermDeck server :3000"; return 0; }
  log "TermDeck server :3000 DOWN — starting"
  ( cd "$REPO_DIR" || exit 1
    set -a; [ -f "$SECRETS_ENV" ] && . "$SECRETS_ENV"; set +a
    nohup node packages/server/src/index.js >>"${LOG_DIR}/server.log" 2>&1 & )
}

start_webhook() {
  port_up 37778 && return 0
  would && { log "DRY: would START Mnestra webhook :37778"; return 0; }
  log "Mnestra webhook :37778 DOWN — starting"
  ( set -a; [ -f "$SECRETS_ENV" ] && . "$SECRETS_ENV"; set +a
    MNESTRA_WEBHOOK_PORT=37778 nohup mnestra serve >>"${LOG_DIR}/mnestra.log" 2>&1 & )
}

tunnel_up() { pgrep -f 'cloudflared tunnel' >/dev/null 2>&1; }

start_tunnel() {
  if [ -n "${TERMDECK_TUNNEL_NAME:-}" ]; then
    tunnel_up && return 0
    would && { log "DRY: would START named tunnel '${TERMDECK_TUNNEL_NAME}'"; return 0; }
    log "named cloudflared tunnel '${TERMDECK_TUNNEL_NAME}' DOWN — starting (stable URL)"
    nohup cloudflared tunnel run "${TERMDECK_TUNNEL_NAME}" >>"${LOG_DIR}/cloudflared.log" 2>&1 &
    echo "https://${TERMDECK_PUBLIC_HOSTNAME:?set TERMDECK_PUBLIC_HOSTNAME for a named tunnel}" > "$URL_FILE"
    return 0
  fi
  tunnel_up && [ -s "$URL_FILE" ] && return 0
  would && { log "DRY: would START quick tunnel + capture trycloudflare URL"; return 0; }
  log "quick cloudflared tunnel DOWN — starting + capturing URL"
  : > "${LOG_DIR}/cloudflared.log"
  nohup cloudflared tunnel --url http://127.0.0.1:8870 >>"${LOG_DIR}/cloudflared.log" 2>&1 &
  for _ in $(seq 1 40); do
    local url; url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG_DIR}/cloudflared.log" 2>/dev/null | head -1)
    [ -n "$url" ] && { echo "$url" > "$URL_FILE"; log "tunnel URL captured: $url"; return 0; }
    sleep 1
  done
  log "WARN: quick tunnel URL did not appear within 40s"
}

bridge_resource() {
  curl -s --max-time 5 http://127.0.0.1:8870/healthz 2>/dev/null \
    | sed -n 's/.*"resource":"\([^"]*\)".*/\1/p'
}

start_bridge() {
  local pub; pub="$(cat "$URL_FILE" 2>/dev/null || true)"
  [ -z "$pub" ] && { log "no public URL yet — skipping bridge"; return 1; }
  local want="${pub%/}/mcp"
  if port_up 8870; then
    [ "$(bridge_resource)" = "$want" ] && return 0
    would && { log "DRY: would RESTART bridge (URL drift → $want)"; return 0; }
    log "bridge URL drift — restarting to re-pin $want"
    lsof -nP -ti TCP:8870 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 1
  else
    would && { log "DRY: would START MCP bridge :8870 (url=$want)"; return 0; }
    log "MCP bridge :8870 DOWN — starting"
  fi
  ensure_secret
  ( cd "${REPO_DIR}/packages/mcp-bridge" || exit 1
    TERMDECK_BRIDGE_PUBLIC_URL="$pub" \
    TERMDECK_BRIDGE_OPERATOR_SECRET="$(cat "$SECRET_FILE")" \
    MNESTRA_WEBHOOK_URL="http://localhost:37778/mnestra" \
    TERMDECK_API_BASE="http://127.0.0.1:3000" \
    TERMDECK_BRIDGE_ALLOWLIST_PROJECTS="$ALLOWLIST_PROJECTS" \
    nohup node src/server.js >>"${LOG_DIR}/bridge.log" 2>&1 & )
}

# Adopt an already-running stack: if we don't yet know the public URL but the
# bridge is already serving, learn it from /healthz (so we never spawn a second
# tunnel over a healthy one). Recording the URL is metadata-only — safe in dry-run.
adopt_url() {
  [ -s "$URL_FILE" ] && return 0
  port_up 8870 || return 0
  local res; res="$(bridge_resource)"
  [ -z "$res" ] && return 0
  echo "${res%/mcp}" > "$URL_FILE"
  log "adopted existing bridge public URL: ${res%/mcp}"
}

main() {
  log "supervise tick (dry=$DRY) — repo=$REPO_DIR"
  start_server
  start_webhook
  adopt_url
  start_tunnel
  start_bridge
  log "state: server=$(port_up 3000 && echo up || echo DOWN) webhook=$(port_up 37778 && echo up || echo DOWN) bridge=$(port_up 8870 && echo up || echo DOWN) url=$(cat "$URL_FILE" 2>/dev/null || echo none)"
}

main "$@"
