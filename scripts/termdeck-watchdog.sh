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
# ALERTS GO VIA TELEGRAM, not iMessage. A launchd background job CANNOT drive
# Messages.app: osascript blocks forever on the un-showable "control Messages"
# automation prompt (verified 2026-06-13). Telegram's Bot API is a plain HTTPS POST
# (no TCC, no GUI session) and still pushes to Josh's phone. Token comes from
# ~/.claude/channels/telegram/.env; chat id from .../access.json. DEDUPED: one alert
# per state change (green->red and red->green), never per tick. If the LOCAL origin
# is red it self-heals (kill :8870 + kickstart the supervisor) and re-probes first.
#
# bash 3.2-safe (macOS /bin/bash) — no associative arrays. Exactly three targets.
#
# Modes:
#   (no args)            normal run
#   WATCHDOG_DRY=1 ...   probe + log only; no self-heal, no alert, no state write
#   ... test-alert       send a single test alert and exit (validate the alert path)
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
export TG_ENV="${HOME}/.claude/channels/telegram/.env"
export TG_ACCESS="${HOME}/.claude/channels/telegram/access.json"

ts()  { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Real-readiness probe: POST /token junk -> echo the HTTP status code.
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
    -X POST "$1/token" -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=__watchdog_probe__' 2>/dev/null
}
is_green() { case "$1" in 4[0-9][0-9]) return 0;; *) return 1;; esac; }

# Telegram bot token (from the channel .env; never hardcoded / committed).
tg_token() { grep -oE 'TOKEN=.*' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n'; }
# First allowed chat id from access.json (any signed integer >= 6 digits).
tg_chat() {
  python3 -c "import json,os
d=json.load(open(os.environ['TG_ACCESS']))
ids=[]
def w(o):
    if isinstance(o,dict):
        for k,v in o.items(): w(k); w(v)
    elif isinstance(o,list):
        [w(x) for x in o]
    else:
        s=str(o)
        if s.lstrip('-').isdigit() and len(s.lstrip('-'))>=6: ids.append(s)
w(d)
print(ids[0] if ids else '')" 2>/dev/null
}

# Send a push alert via Telegram. Returns 0 on HTTP 200.
send_alert() {
  local token chat code
  token="$(tg_token)"; chat="$(tg_chat)"
  if [ -z "$token" ] || [ -z "$chat" ]; then log "ALERT(no-telegram-config): $1"; return 1; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" 2>/dev/null)"
  [ "$code" = "200" ]
}

# ---- test-alert mode ------------------------------------------------------------
if [ "${1:-}" = "test-alert" ]; then
  if send_alert "TermDeck watchdog test @ $(hostname -s) $(date '+%a %H:%M %Z') — alert path OK (Telegram)."; then
    log "test-alert: Telegram sent OK"; echo "sent"
  else
    log "test-alert: Telegram FAILED"; echo "FAILED"; exit 1
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
  if send_alert "$body"; then log "Telegram alert sent (${#ALERTS[@]} change(s))"; else log "Telegram alert FAILED"; fi
fi
exit 0
