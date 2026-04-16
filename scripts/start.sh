#!/bin/bash
# TermDeck Full Stack Launcher
# Usage: ./scripts/start.sh
#
# Boots the entire TermDeck + Mnestra + Rumen stack in the right order.
# Gracefully skips components that aren't installed — always gets you
# to a working dashboard.

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

SECRETS_FILE="${HOME}/.termdeck/secrets.env"
CONFIG_FILE="${HOME}/.termdeck/config.yaml"
PORT="${TERMDECK_PORT:-3000}"
MNESTRA_PORT="${MNESTRA_PORT:-37778}"

echo ""
echo -e "${BOLD}TermDeck Stack Launcher${RESET}"
echo -e "${DIM}─────────────────────────────────${RESET}"
echo ""

# ── Step 0: Find the termdeck root ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERMDECK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Step 1: Load secrets ───────────────────────────────────────────
if [ -f "$SECRETS_FILE" ]; then
  set -a
  source "$SECRETS_FILE"
  set +a
  KEY_COUNT=$(grep -cE '^[A-Z_]+=' "$SECRETS_FILE" 2>/dev/null || echo 0)
  echo -e "  ${GREEN}✓${RESET} Secrets loaded ${DIM}($KEY_COUNT keys from $SECRETS_FILE)${RESET}"
else
  echo -e "  ${YELLOW}⚠${RESET} No secrets file ${DIM}($SECRETS_FILE not found — Tier 1 only)${RESET}"
fi

# ── Step 2: Kill stale processes ───────────────────────────────────
STALE_TD=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$STALE_TD" ]; then
  kill $STALE_TD 2>/dev/null || true
  sleep 1
  echo -e "  ${YELLOW}⚠${RESET} Killed stale process on port $PORT"
fi

STALE_MN=$(lsof -ti :$MNESTRA_PORT 2>/dev/null || true)
if [ -n "$STALE_MN" ]; then
  kill $STALE_MN 2>/dev/null || true
  sleep 1
  echo -e "  ${YELLOW}⚠${RESET} Killed stale process on port $MNESTRA_PORT"
fi

# ── Step 3: Start Mnestra (if installed) ───────────────────────────
MNESTRA_CMD=""
if command -v mnestra &>/dev/null; then
  MNESTRA_CMD="mnestra"
elif [ -f "$HOME/Documents/Graciella/engram/dist/mcp-server/index.js" ]; then
  MNESTRA_CMD="node $HOME/Documents/Graciella/engram/dist/mcp-server/index.js"
fi

if [ -n "$MNESTRA_CMD" ]; then
  if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    $MNESTRA_CMD serve &>/dev/null &
    MNESTRA_PID=$!
    sleep 2
    # Verify it's alive
    HEALTH=$(curl -s --max-time 3 "http://localhost:$MNESTRA_PORT/healthz" 2>/dev/null || echo '{}')
    ROWS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('store',{}).get('rows',0))" 2>/dev/null || echo "0")
    if [ "$ROWS" != "0" ]; then
      echo -e "  ${GREEN}✓${RESET} Mnestra running ${DIM}(PID $MNESTRA_PID, $ROWS memories on :$MNESTRA_PORT)${RESET}"
    else
      echo -e "  ${YELLOW}⚠${RESET} Mnestra started but store empty or not connected ${DIM}(PID $MNESTRA_PID)${RESET}"
    fi
  else
    echo -e "  ${YELLOW}⚠${RESET} Mnestra installed but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping"
  fi
else
  echo -e "  ${DIM}─${RESET} Mnestra not installed ${DIM}(Tier 2+ — install with: npm install -g @jhizzard/mnestra)${RESET}"
fi

# ── Step 4: Start TermDeck ─────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Starting TermDeck on port $PORT...${RESET}"
echo ""

cd "$TERMDECK_ROOT"
exec node packages/cli/src/index.js "$@"
