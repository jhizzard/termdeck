#!/usr/bin/env bash
# termdeck-watchdog.sh — external REAL-READINESS watchdog for the TMR bridge HA pair.
#
# Drive via launchd (com.jhizzard.termdeck-watchdog, StartInterval ~300s). Each run
# probes real readiness — POST /token with a junk body, GREEN iff the response is a
# 4xx (NOT 5xx / no-response) — against three public surfaces:
#   1. public | https://bridge.joshuaizzard.dev      (the Load Balancer / user path)
#   2. imac   | https://imac-bridge.joshuaizzard.dev (iMac origin, direct to its tunnel)
#   3. air    | https://air-bridge.joshuaizzard.dev  (Air  origin, direct to its tunnel)
#
# WHY POST /token and not GET /healthz: /healthz is a static GET that never touches
# the body-parse path. The 2026-06-13 OAuth outage kept /healthz green while POST
# /token & /register 500'd (stale iconv-lite after a dep reshuffle). This probe
# exercises the exact path that breaks, so "green" means *actually serving*, and the
# per-origin hostnames let one machine see a SILENT single-origin degradation (the
# failure that motivated this watchdog: an origin dropping out of the LB pool while
# the public hostname stayed green via failover).
#
# On a RED *transition* it iMessages Josh (self). DEDUPED: one alert per state change
# (green->red and red->green), never one per tick. If the LOCAL origin is red it first
# self-heals (kill :8870 + kickstart the supervisor) and re-probes before alerting.
#
# bash 3.2-safe (macOS /bin/bash) — no associative arrays. Exactly three targets.
#
# Modes:
#   (no args)            normal run
#   WATCHDOG_DRY=1 ...   probe + log only; no self-heal, no alert, no state write
#   ... test-alert       send a single test iMessage and exit (validate the alert path)
#
# State: ~/.termdeck/watchdog-state.json   Log: ~/.termdeck/logs/watchdog.log
set -uo pipefail

STATE_DIR="${HOME}/.termdeck"
LOG_DIR="${STATE_DIR}/logs"; mkdir -p "$LOG_DIR"
export SF="${STATE_DIR}/watchdog-state.json"
LOG_FILE="${LOG_DIR}/watchdog.log"
SUPERVISOR_LABEL="com.jhizzard.termdeck-supervise"
PROBE_TIMEOUT="${WATCHDOG_PROBE_TIMEOUT:-12}"
SELF_HEAL_WAIT="${WATCHDOG_SELF_HEAL_WAIT:-15}"
DRY="${WATCHDOG_DRY:-0}"

ts()  { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Real-readiness probe: POST /token junk -> echo the HTTP status code.
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
    -X POST "$1/token" -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=__watchdog_probe__' 2>/dev/null
}
is_green() { case "$1" in 4[0-9][0-9]) return 0;; *) return 1;; esac; }

# Resolve Josh's self iMessage address from the imessage MCP config (survives changes).
self_address() {
  python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['imessage']['env']['IMESSAGE_SELF_ADDRESS'])" 2>/dev/null
}

# Send via Messages.app. Message + address pass through the env (system attribute) so
# arbitrary text / newlines can't break the AppleScript source.
send_imessage() {
  local addr; addr="$(self_address)"
  if [ -z "$addr" ]; then log "ALERT(no-self-addr): $1"; return 1; fi
  MSG="$1" ADDR="$addr" /usr/bin/osascript - <<'OSA' 2>>"$LOG_FILE"
on run
  set m to (system attribute "MSG")
  set a to (system attribute "ADDR")
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send m to buddy a of svc
  end tell
end run
OSA
}

# ---- test-alert mode ------------------------------------------------------------
if [ "${1:-}" = "test-alert" ]; then
  if send_imessage "TermDeck watchdog test @ $(hostname -s) $(date '+%a %H:%M %Z') - alert path OK."; then
    log "test-alert: iMessage sent OK"; echo "sent"
  else
    log "test-alert: iMessage FAILED"; echo "FAILED"; exit 1
  fi
  exit 0
fi

# Which origin is THIS machine (for self-heal targeting), from the local bridge label.
LOCAL_ORIGIN="$(curl -s --max-time 4 http://127.0.0.1:8870/healthz 2>/dev/null | sed -n 's/.*"origin":"\([a-z0-9_-]*\)".*/\1/p')"

# ---- prior state (plain vars; bash 3.2) -----------------------------------------
prev_public=""; prev_imac=""; prev_air=""
if [ -f "$SF" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      public) prev_public="$v";; imac) prev_imac="$v";; air) prev_air="$v";;
    esac
  done < <(python3 -c "import json,os;d=json.load(open(os.environ['SF']));[print(f'{k}={v}') for k,v in d.items() if k!='ts']" 2>/dev/null)
fi
prev_of() { case "$1" in public) echo "$prev_public";; imac) echo "$prev_imac";; air) echo "$prev_air";; esac; }

# ---- probe loop -----------------------------------------------------------------
new_public=""; new_imac=""; new_air=""
ALERTS=()
healed=0
for entry in "public|https://bridge.joshuaizzard.dev" \
             "imac|https://imac-bridge.joshuaizzard.dev" \
             "air|https://air-bridge.joshuaizzard.dev"; do
  name="${entry%%|*}"; url="${entry##*|}"
  code="$(probe "$url")"
  if is_green "$code"; then status="green"; else status="red"; fi

  if [ "$status" = "red" ] && [ "$name" = "$LOCAL_ORIGIN" ] && [ "$healed" = "0" ] && [ "$DRY" != "1" ]; then
    log "$name RED (HTTP ${code:-000}), is LOCAL origin — self-heal: restart bridge :8870 + supervisor tick"
    pids="$(lsof -ti tcp:8870 2>/dev/null)"; [ -n "$pids" ] && kill $pids 2>>"$LOG_FILE"
    launchctl kickstart -k "gui/$(id -u)/${SUPERVISOR_LABEL}" 2>>"$LOG_FILE"
    healed=1
    sleep "$SELF_HEAL_WAIT"
    code="$(probe "$url")"; if is_green "$code"; then status="green"; log "$name recovered post-self-heal (HTTP $code)"; fi
  fi

  case "$name" in public) new_public="$status";; imac) new_imac="$status";; air) new_air="$status";; esac
  prev="$(prev_of "$name")"
  note=""; [ "$DRY" = "1" ] && note=" (DRY)"
  log "probe $name -> HTTP ${code:-000} ($status) [prev=${prev:-none}]$note"

  if [ "$status" = "red" ] && [ "$prev" != "red" ]; then
    ALERTS+=("🔴 ${name} DOWN — POST /token => HTTP ${code:-no-response}")
  elif [ "$status" = "green" ] && [ "$prev" = "red" ]; then
    ALERTS+=("🟢 ${name} recovered")
  fi
done

if [ "$DRY" = "1" ]; then
  log "DRY run — state not written; ${#ALERTS[@]} would-be alert(s): ${ALERTS[*]:-none}"
  exit 0
fi

# ---- persist state --------------------------------------------------------------
PUB="$new_public" IM="$new_imac" AIR="$new_air" TSV="$(ts)" \
  python3 -c "import json,os;open(os.environ['SF'],'w').write(json.dumps({'public':os.environ['PUB'],'imac':os.environ['IM'],'air':os.environ['AIR'],'ts':os.environ['TSV']}))"

# ---- alert on changes -----------------------------------------------------------
if [ "${#ALERTS[@]}" -gt 0 ]; then
  body="TermDeck bridge watchdog @ $(hostname -s) $(date '+%a %H:%M %Z')"$'\n'"$(printf '%s\n' "${ALERTS[@]}")"
  if send_imessage "$body"; then log "iMessage sent (${#ALERTS[@]} change(s))"; else log "iMessage send FAILED"; fi
fi
exit 0
