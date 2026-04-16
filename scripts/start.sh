#!/bin/bash
# TermDeck Full Stack Launcher — boots TermDeck + Mnestra + Rumen
# Usage: ./scripts/start.sh [--port PORT]
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'

SECRETS_FILE="${HOME}/.termdeck/secrets.env"
MNESTRA_PORT="${MNESTRA_PORT:-37778}"
EXTRA_ARGS=()

# ── Parse flags ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done
PORT="${PORT:-${TERMDECK_PORT:-3000}}"

echo ""
echo -e "${BOLD}TermDeck Stack Launcher${RESET}"
echo -e "${DIM}─────────────────────────────────${RESET}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERMDECK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Verify Node 18+ ──────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "  ${RED}✗${RESET} Node.js is not installed. TermDeck requires Node 18+."; exit 1
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo -e "  ${RED}✗${RESET} Node $NODE_MAJOR detected — TermDeck requires Node 18+. Current: $(node -v)"; exit 1
fi

# ── Load secrets ──────────────────────────────────────────────────────
if [ -f "$SECRETS_FILE" ]; then
  set -a; source "$SECRETS_FILE"; set +a
  KEY_COUNT=$(grep -cE '^[A-Z_]+=' "$SECRETS_FILE" 2>/dev/null || echo 0)
  echo -e "  ${GREEN}✓${RESET} Secrets loaded ${DIM}($KEY_COUNT keys from $SECRETS_FILE)${RESET}"
else
  echo -e "  ${YELLOW}⚠${RESET} No secrets file ${DIM}($SECRETS_FILE not found — Tier 1 only)${RESET}"
fi

# ── Check transcript migration ────────────────────────────────────────
if [ -n "$DATABASE_URL" ]; then
  if ! psql "$DATABASE_URL" -c "SELECT 1 FROM termdeck_transcripts LIMIT 0" 2>/dev/null; then
    echo -e "  ${YELLOW}⚠${RESET} Transcript table not found. Run: psql \$DATABASE_URL -f config/transcript-migration.sql"
  fi
fi

# ── Kill stale processes ──────────────────────────────────────────────
for CHECK_PORT in $PORT $MNESTRA_PORT; do
  STALE_PID=$(lsof -ti ":$CHECK_PORT" 2>/dev/null || true)
  if [ -n "$STALE_PID" ]; then
    kill $STALE_PID 2>/dev/null || true; sleep 1
    echo -e "  ${YELLOW}⚠${RESET} Killed stale process on port $CHECK_PORT"
  fi
done

# ── Start Mnestra (if installed) ──────────────────────────────────────
MNESTRA_CMD="" MNESTRA_ROWS="0" MNESTRA_ACTIVE=false
if command -v mnestra &>/dev/null; then
  MNESTRA_CMD="mnestra"
elif [ -f "$HOME/Documents/Graciella/engram/dist/mcp-server/index.js" ]; then
  MNESTRA_CMD="node $HOME/Documents/Graciella/engram/dist/mcp-server/index.js"
fi

if [ -n "$MNESTRA_CMD" ]; then
  if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    $MNESTRA_CMD serve &>/dev/null &
    MNESTRA_PID=$!; sleep 2
    HEALTH=$(curl -s --max-time 3 "http://localhost:$MNESTRA_PORT/healthz" 2>/dev/null || echo '{}')
    MNESTRA_ROWS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('store',{}).get('rows',0))" 2>/dev/null || echo "0")
    if [ "$MNESTRA_ROWS" != "0" ]; then
      MNESTRA_ACTIVE=true
      echo -e "  ${GREEN}✓${RESET} Mnestra running ${DIM}(PID $MNESTRA_PID, $MNESTRA_ROWS memories on :$MNESTRA_PORT)${RESET}"
    else
      echo -e "  ${YELLOW}⚠${RESET} Mnestra started but store empty or not connected ${DIM}(PID $MNESTRA_PID)${RESET}"
    fi
    # Check MCP config for mnestra entry
    MCP_CFG="${HOME}/.claude/mcp.json"
    if [ ! -f "$MCP_CFG" ] || ! python3 -c "import json; d=json.load(open('$MCP_CFG')); assert 'mnestra' in str(d)" 2>/dev/null; then
      echo -e "  ${DIM}  └ Hint: add a \"mnestra\" entry to ~/.claude/mcp.json so Claude Code can use it${RESET}"
    fi
  else
    echo -e "  ${YELLOW}⚠${RESET} Mnestra installed but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping"
  fi
else
  echo -e "  ${DIM}─${RESET} Mnestra not installed ${DIM}(Tier 2+ — install with: npm install -g @jhizzard/mnestra)${RESET}"
fi

# ── Build summary line ────────────────────────────────────────────────
SUMMARY="Stack: TermDeck :$PORT"
if $MNESTRA_ACTIVE; then
  SUMMARY="$SUMMARY | Mnestra :$MNESTRA_PORT ($(printf "%'d" "$MNESTRA_ROWS") memories)"
fi
RUMEN_DIR="$TERMDECK_ROOT/packages/server/src/setup/rumen"
if [ -d "$RUMEN_DIR" ] && [ -n "$DATABASE_URL" ]; then
  RUMEN_AGO=$(psql "$DATABASE_URL" -tAc "SELECT NOW() - MAX(created_at) FROM rumen_jobs" 2>/dev/null | sed 's/\.[0-9]*//' || true)
  if [ -n "$RUMEN_AGO" ]; then
    SUMMARY="$SUMMARY | Rumen (last job ${RUMEN_AGO} ago)"
  else
    SUMMARY="$SUMMARY | Rumen (no jobs yet)"
  fi
fi

# ── Start TermDeck ────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${SUMMARY}${RESET}"
echo ""
cd "$TERMDECK_ROOT"
exec node packages/cli/src/index.js --port "$PORT" "${EXTRA_ARGS[@]}"
