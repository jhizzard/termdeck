#!/usr/bin/env bash
# termdeck-watchdog.sh — external REAL-READINESS watchdog for the TMR bridge HA fleet.
#
# Drive via launchd (com.jhizzard.termdeck-watchdog, StartInterval ~300s). Each run
# probes real readiness — POST /token with a junk body, GREEN iff the response is a
# 4xx (NOT 5xx / no-response) — against four public surfaces:
#   1. public | https://bridge.joshuaizzard.dev        (the Load Balancer / user path)
#   2. imac   | https://imac-bridge.joshuaizzard.dev   (iMac origin, direct to its tunnel)
#   3. air    | https://air-bridge.joshuaizzard.dev    (Air  origin, direct to its tunnel)
#   4. cloud  | https://termdeck-cloud-origin.onrender.com (always-on Render origin / LB pool #3)
#
# WHY POST /token and not GET /healthz: /healthz is a static GET that never touches
# the body-parse path. A green /healthz can hide a dead OAuth/memory path. This probe
# exercises the real path, and the per-origin hostnames let one machine see a SILENT
# single-origin degradation behind the load balancer.
#
# DEBOUNCE: alerts only after ALERT_THRESHOLD (default 2) CONSECUTIVE red probes
# (~10 min), so transient LB/tunnel re-convergence blips don't page. A recovery alert
# fires when a CONFIRMED-down target (>= threshold) goes green again. Self-healing of
# the LOCAL origin still happens on the FIRST red probe (it only affects alerting cadence).
#
# ALERTS GO VIA TELEGRAM (a launchd background job can't drive Messages.app). Token from
# ~/.claude/channels/telegram/.env; chat id from .../access.json. bash 3.2-safe.
#
# Modes: (no args) normal | WATCHDOG_DRY=1 probe+log only | test-alert (send one test alert)
# State: ~/.termdeck/watchdog-state.json (per-target consecutive-fail counts)  Log: ~/.termdeck/logs/watchdog.log
set -uo pipefail

STATE_DIR="${HOME}/.termdeck"
LOG_DIR="${STATE_DIR}/logs"; mkdir -p "$LOG_DIR"
export SF="${STATE_DIR}/watchdog-state.json"
LOG_FILE="${LOG_DIR}/watchdog.log"
SUPERVISOR_LABEL="com.jhizzard.termdeck-supervise"
PROBE_TIMEOUT="${WATCHDOG_PROBE_TIMEOUT:-12}"
SELF_HEAL_WAIT="${WATCHDOG_SELF_HEAL_WAIT:-15}"
ALERT_THRESHOLD="${WATCHDOG_ALERT_THRESHOLD:-2}"   # consecutive reds before a DOWN alert
DRY="${WATCHDOG_DRY:-0}"
export TG_ENV="${HOME}/.claude/channels/telegram/.env"
export TG_ACCESS="${HOME}/.claude/channels/telegram/access.json"

ts()  { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
    -X POST "$1/token" -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=__watchdog_probe__' 2>/dev/null
}
is_green() { case "$1" in 4[0-9][0-9]) return 0;; *) return 1;; esac; }

tg_token() { grep -oE 'TOKEN=.*' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n'; }
tg_chat() {
  python3 -c "import json,os
d=json.load(open(os.environ['TG_ACCESS']))
ids=[]
def w(o):
    if isinstance(o,dict):
        [ (w(k),w(v)) for k,v in o.items() ]
    elif isinstance(o,list):
        [w(x) for x in o]
    else:
        s=str(o)
        if s.lstrip('-').isdigit() and len(s.lstrip('-'))>=6: ids.append(s)
w(d)
print(ids[0] if ids else '')" 2>/dev/null
}
send_alert() {
  local token chat code; token="$(tg_token)"; chat="$(tg_chat)"
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

LOCAL_ORIGIN="$(curl -s --max-time 4 http://127.0.0.1:8870/healthz 2>/dev/null | sed -n 's/.*"origin":"\([a-z0-9_-]*\)".*/\1/p')"

# ---- prior consecutive-fail counts (default 0; tolerates old string-format state) ----
pf_public=0; pf_imac=0; pf_air=0; pf_cloud=0
if [ -f "$SF" ]; then
  while IFS='=' read -r k v; do
    case "$k" in public) pf_public="$v";; imac) pf_imac="$v";; air) pf_air="$v";; cloud) pf_cloud="$v";; esac
  done < <(python3 -c "import json,os
try:
  d=json.load(open(os.environ['SF']))
  for k in ('public','imac','air','cloud'):
    v=d.get(k,0)
    print(f'{k}={int(v) if str(v).isdigit() else 0}')
except Exception: pass" 2>/dev/null)
fi
prevfails() { case "$1" in public) echo "${pf_public:-0}";; imac) echo "${pf_imac:-0}";; air) echo "${pf_air:-0}";; cloud) echo "${pf_cloud:-0}";; esac; }

# ---- probe loop -----------------------------------------------------------------
nf_public=0; nf_imac=0; nf_air=0; nf_cloud=0
ALERTS=()
healed=0
for entry in "public|https://bridge.joshuaizzard.dev" \
             "imac|https://imac-bridge.joshuaizzard.dev" \
             "air|https://air-bridge.joshuaizzard.dev" \
             "cloud|https://termdeck-cloud-origin.onrender.com"; do
  name="${entry%%|*}"; url="${entry##*|}"
  code="$(probe "$url")"
  status=red; is_green "$code" && status=green

  # self-heal the LOCAL origin on a red probe (before counting), then re-probe
  if [ "$status" = "red" ] && [ "$name" = "$LOCAL_ORIGIN" ] && [ "$healed" = "0" ] && [ "$DRY" != "1" ]; then
    log "$name RED (HTTP ${code:-000}), LOCAL origin — self-heal: restart bridge :8870 + supervisor tick"
    pids="$(lsof -ti tcp:8870 2>/dev/null)"; [ -n "$pids" ] && kill $pids 2>>"$LOG_FILE"
    launchctl kickstart -k "gui/$(id -u)/${SUPERVISOR_LABEL}" 2>>"$LOG_FILE"
    healed=1; sleep "$SELF_HEAL_WAIT"
    code="$(probe "$url")"; if is_green "$code"; then status=green; log "$name recovered post-self-heal (HTTP $code)"; fi
  fi

  prev="$(prevfails "$name")"; case "$prev" in ''|*[!0-9]*) prev=0;; esac
  if [ "$status" = "green" ]; then
    newf=0
    [ "$prev" -ge "$ALERT_THRESHOLD" ] && ALERTS+=("🟢 ${name} recovered")
  else
    newf=$((prev+1))
    [ "$newf" -eq "$ALERT_THRESHOLD" ] && ALERTS+=("🔴 ${name} DOWN — POST /token => HTTP ${code:-no-response} (${newf} consecutive)")
  fi
  case "$name" in public) nf_public=$newf;; imac) nf_imac=$newf;; air) nf_air=$newf;; cloud) nf_cloud=$newf;; esac
  note=""; [ "$DRY" = "1" ] && note=" (DRY)"
  log "probe $name -> HTTP ${code:-000} ($status) fails=${newf}/${ALERT_THRESHOLD} [prev=${prev}]$note"
done

if [ "$DRY" = "1" ]; then
  log "DRY run — state not written; ${#ALERTS[@]} would-be alert(s): ${ALERTS[*]:-none}"
  exit 0
fi

# ---- persist state (consecutive-fail counts) -----------------------------------
PUB="$nf_public" IM="$nf_imac" AIR="$nf_air" CLOUD="$nf_cloud" TSV="$(ts)" \
  python3 -c "import json,os;open(os.environ['SF'],'w').write(json.dumps({'public':int(os.environ['PUB']),'imac':int(os.environ['IM']),'air':int(os.environ['AIR']),'cloud':int(os.environ['CLOUD']),'ts':os.environ['TSV']}))"

# ---- alert on confirmed transitions --------------------------------------------
if [ "${#ALERTS[@]}" -gt 0 ]; then
  body="TermDeck bridge watchdog @ $(hostname -s) $(date '+%a %H:%M %Z')"$'\n'"$(printf '%s\n' "${ALERTS[@]}")"
  if send_alert "$body"; then log "Telegram alert sent (${#ALERTS[@]} change(s))"; else log "Telegram alert FAILED"; fi
fi
exit 0
