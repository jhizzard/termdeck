#!/usr/bin/env bash
# TermDeck — canonical nohup launcher (Sprint 60 v1.0.14).
#
# Drop into ~/start-termdeck.sh (or anywhere on PATH) and invoke without args.
# Designed for Linux dev boxes that don't have systemd-user available, or
# where the user wants a quick "background TermDeck" without writing a unit.
# For systemd installations, prefer docs/examples/termdeck.service instead.
#
# Sprint 60 v1.0.14 fixes incorporated:
#   - Brad #4-class observability gap: stdout and stderr go to SEPARATE files
#     so a final traceback survives an abrupt process death (pre-fix: nohup's
#     default merges stderr into the same fd as stdout, and an unflushed
#     buffer at crash time loses the final stack to oblivion).
#   - Per-boot banner: the server itself prints an ISO-timestamped banner at
#     boot (Item 5 in v1.0.14), so even with log rotation a single tail of
#     the active termdeck.log makes crash boundaries trivially greppable.
#
# Recommended pairing: set up logrotate using docs/examples/termdeck.logrotate
# (system-wide install: sudo cp docs/examples/termdeck.logrotate /etc/logrotate.d/termdeck).

set -euo pipefail

LOG_DIR="$HOME/.termdeck"
STDOUT_LOG="$LOG_DIR/termdeck.log"
STDERR_LOG="$LOG_DIR/termdeck.err"
PID_FILE="$LOG_DIR/termdeck.pid"

mkdir -p "$LOG_DIR"

# If a previous TermDeck is already running, refuse to start a second instance.
# (The launcher's stale-port reclaim handles single-instance hygiene at the
# port level, but a duplicate parent process produces a confusing log
# interleave that's not worth the convenience.)
if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "TermDeck already running with PID $EXISTING_PID — exiting."
    echo "Tail: tail -f $STDOUT_LOG"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Source secrets.env for non-shell launchers (cron, systemd-fallback, etc.)
# so DATABASE_URL et al. are visible to TermDeck's preflight probes. The
# launcher itself also reads secrets.env directly (Sprint 59 Brad #1 fix),
# so this is belt-and-suspenders for any hook/child that doesn't.
if [ -f "$LOG_DIR/secrets.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$LOG_DIR/secrets.env"
  set +a
fi

# Boot banner into BOTH log streams so the per-stream tail finds the
# restart boundary even before the server's own banner lands.
echo "" | tee -a "$STDOUT_LOG" "$STDERR_LOG" >/dev/null
echo "════ start-termdeck.sh boot · $(date -u +'%Y-%m-%dT%H:%M:%SZ') ════" \
  | tee -a "$STDOUT_LOG" "$STDERR_LOG" >/dev/null

# nohup with split stdout/stderr.
nohup termdeck --no-stack \
  > "$STDOUT_LOG" 2> "$STDERR_LOG" </dev/null &

CHILD_PID=$!
echo $CHILD_PID > "$PID_FILE"

echo "TermDeck started (pid $CHILD_PID)"
echo "  stdout: $STDOUT_LOG"
echo "  stderr: $STDERR_LOG"
echo "  pid file: $PID_FILE"
echo ""
echo "Monitor:"
echo "  tail -f $STDOUT_LOG"
echo "  tail -f $STDERR_LOG"
echo ""
echo "Stop:"
echo "  kill $CHILD_PID"
