#!/bin/sh
# docker/run-fixture.sh — shared POSIX-sh entrypoint for Sprint 58 install fixtures
#
# Sprint 58 (Environment Coverage Catch-Net), T1 GHACTIONS+DOCKER lane.
# Used by docker/Dockerfile.{ubuntu,fedora,alpine,debian} as ENTRYPOINT.
#
# This script is POSIX sh-compatible (no bashisms). Required because Alpine's
# Dockerfile fixture deliberately omits bash (busybox ash only), per
# T4-CODEX FINDING 2026-05-05 16:21 ET re: bash false-RED risk on Alpine.
#
# Inputs (passed via `docker run --env-file ...` or `-e ...`):
#   FIXTURE_INTENT             required; one of:
#                                baseline               -> gating GREEN scenario
#                                brad-5-no-zsh          -> Brad #5 reproducer (PTY shell hardcode)
#                                brad-5-alpine-bashism  -> Alpine bashism catcher
#   DATABASE_URL               required (test Supabase pg URL)
#   SUPABASE_URL               required
#   SUPABASE_SERVICE_ROLE_KEY  required
#   OPENAI_API_KEY             required (init --mnestra needs it for embeddings)
#   ANTHROPIC_API_KEY          optional (enables Haiku session summaries; can be empty)
#
# Outputs:
#   stdout: human-readable progress log
#   exit  : 0 fixture's actual outcome matches expected for the FIXTURE_INTENT
#         : 1 fixture catches a bug (REPRODUCER stays RED, or GATING goes RED)
#         : 2 infrastructure failure (env vars missing, server didn't bind, etc.)
#
# Cross-references:
#   - Brad's 9-finding field report:  CHANGELOG.md § [1.0.12] Notes
#   - Sprint 58 PLANNING:             docs/sprint-58-environment-coverage/PLANNING.md
#   - ORCH 16:21 ET two-mode taxonomy: docs/sprint-58-environment-coverage/STATUS.md
#   - Parallel JSON schema reference:  scripts/hetzner-systemd-smoke.sh (termdeck-systemd-smoke/v1)

set -e

log() {
  echo "[fixture] $*"
}

err() {
  echo "[fixture] ERROR: $*" >&2
}

write_no_zsh_config() {
  # Force spawnTerminalSession() onto its hardcoded fallback branch:
  #   const spawnShell = isPlainShell ? cmdTrim : (config.shell || '/bin/zsh')
  # A missing/empty config shell is the direct Brad #5 catch surface.
  cat > "$TD_HOME/.termdeck/config.yaml" <<EOF
port: 3000
host: 127.0.0.1
shell:
defaultTheme: tokyo-night
rag:
  enabled: false
sessionLogs:
  enabled: false
EOF
  log "wrote no-zsh probe config with empty shell"
}

run_no_zsh_pty_probe() {
  log "spawning termdeck server for pre-init PTY no-zsh probe ..."
  termdeck --no-stack --port 3000 --no-open > /tmp/td.out 2>&1 &
  TD_PID=$!

  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done

  if ! curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    err "server did not bind /api/health within 30s before PTY probe"
    log "--- server log tail ---"
    tail -n 80 /tmp/td.out 2>/dev/null || true
    kill "$TD_PID" 2>/dev/null || true
    exit 2
  fi
  log "server up on /api/health"

  log "POST /api/sessions before init wizards (Brad #5 catch surface) ..."
  RESP=$(curl -fsS -X POST http://127.0.0.1:3000/api/sessions \
    -H 'content-type: application/json' \
    -d '{"command":""}' 2>/tmp/curl.err) || {
    err "POST /api/sessions failed: $(cat /tmp/curl.err)"
    kill "$TD_PID" 2>/dev/null || true
    exit 2
  }

  SID=$(printf '%s' "$RESP" | node -e 'try { console.log((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).id||""); } catch (e) { console.log(""); }')
  if [ -z "$SID" ]; then
    err "couldn't parse session id from /api/sessions response: $RESP"
    kill "$TD_PID" 2>/dev/null || true
    exit 2
  fi
  log "session id: $SID"

  sleep 2
  STATUS_JSON=$(curl -fsS "http://127.0.0.1:3000/api/sessions/$SID" 2>/dev/null || true)
  STATUS=$(printf '%s' "$STATUS_JSON" | node -e 'try { console.log(((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).meta||{}).status||""); } catch (e) { console.log(""); }')
  DETAIL=$(printf '%s' "$STATUS_JSON" | node -e 'try { console.log(((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).meta||{}).statusDetail||""); } catch (e) { console.log(""); }')
  EXIT_CODE=$(printf '%s' "$STATUS_JSON" | node -e 'try { const v=((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).meta||{}).exitCode; console.log(v == null ? "" : String(v)); } catch (e) { console.log(""); }')

  kill "$TD_PID" 2>/dev/null || true

  if [ "$STATUS" = "active" ] || [ "$STATUS" = "idle" ]; then
    log "PTY shell spawn SUCCEEDED before init wizards (status=$STATUS)"
    exit 0
  fi

  if [ "$STATUS" = "errored" ] && printf '%s\n' "$DETAIL" | grep -Eiq 'zsh|ENOENT|not found|No such file'; then
    err "confirmed Brad #5 before init wizards: status=$STATUS detail=$DETAIL"
    log "--- server log tail ---"
    tail -n 80 /tmp/td.out 2>/dev/null || true
    exit 1
  fi

  err "unexpected PTY probe result: status=$STATUS exitCode=$EXIT_CODE detail=$DETAIL"
  log "--- /api/sessions response ---"
  printf '%s\n' "$STATUS_JSON"
  log "--- server log tail ---"
  tail -n 80 /tmp/td.out 2>/dev/null || true
  exit 2
}

# ---- 1. Validate env --------------------------------------------------------

if [ -z "$FIXTURE_INTENT" ]; then
  err "FIXTURE_INTENT not set (expected: baseline | brad-5-no-zsh | brad-5-alpine-bashism)"
  exit 2
fi

if [ -z "$DATABASE_URL" ]; then
  err "DATABASE_URL not set — pass --env-file or -e via docker run"
  exit 2
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  err "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set"
  exit 2
fi

if [ -z "$OPENAI_API_KEY" ]; then
  err "OPENAI_API_KEY not set (Mnestra direct mode requires it for embeddings)"
  exit 2
fi

# ---- 2. Confirm fixture invariants for REPRODUCER intents ------------------

case "$FIXTURE_INTENT" in
  brad-5-no-zsh)
    if command -v zsh > /dev/null 2>&1; then
      err "FIXTURE-INVARIANT-BROKEN: zsh IS installed; brad-5-no-zsh cannot reproduce"
      exit 2
    fi
    log "fixture invariant OK: zsh is NOT installed"
    ;;
  brad-5-alpine-bashism)
    if command -v bash > /dev/null 2>&1; then
      err "FIXTURE-INVARIANT-BROKEN: bash IS installed; alpine-bashism cannot reproduce"
      exit 2
    fi
    log "fixture invariant OK: bash is NOT installed (busybox ash only)"
    ;;
  baseline)
    if ! command -v zsh > /dev/null 2>&1; then
      err "FIXTURE-INVARIANT-BROKEN: zsh missing on baseline; brad-5 would falsely trigger"
      exit 2
    fi
    log "fixture invariant OK: baseline scenario (zsh installed)"
    ;;
  *)
    err "unknown FIXTURE_INTENT=$FIXTURE_INTENT"
    exit 2
    ;;
esac

# ---- 3. Write ~/.termdeck/secrets.env --------------------------------------

TD_HOME="${HOME:-/root}"
mkdir -p "$TD_HOME/.termdeck"
SECRETS="$TD_HOME/.termdeck/secrets.env"

# Baseline: NO surrounding quotes (Brad #2 not triggered).
cat > "$SECRETS" <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL=$DATABASE_URL
OPENAI_API_KEY=$OPENAI_API_KEY
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOF
chmod 600 "$SECRETS"
log "wrote $SECRETS"

if [ "$FIXTURE_INTENT" = "brad-5-no-zsh" ]; then
  write_no_zsh_config
fi

# ---- 4. CLI launchers parse ------------------------------------------------

if ! termdeck --help > /dev/null 2>&1; then
  err "termdeck --help failed — install path broke"
  exit 2
fi
log "termdeck --help OK"

if ! termdeck-stack --help > /dev/null 2>&1; then
  err "termdeck-stack --help failed — install path broke"
  exit 2
fi
log "termdeck-stack --help OK"

if [ "$FIXTURE_INTENT" = "brad-5-no-zsh" ]; then
  run_no_zsh_pty_probe
fi

# ---- 5. Init wizards (--yes non-interactive) --------------------------------

log "running termdeck init --mnestra --yes ..."
if ! termdeck init --mnestra --yes; then
  err "termdeck init --mnestra --yes FAILED"
  exit 1
fi
log "init --mnestra OK"

log "running termdeck init --rumen --yes ..."
if ! termdeck init --rumen --yes; then
  err "termdeck init --rumen --yes FAILED"
  exit 1
fi
log "init --rumen OK"

# ---- 6. Doctor probes ------------------------------------------------------

log "running termdeck doctor ..."
if ! termdeck doctor; then
  err "termdeck doctor FAILED — at least one probe RED"
  exit 1
fi
log "doctor OK (all probes GREEN)"

# ---- 7. Brad #5 PTY-spawn smoke --------------------------------------------
#
# Skip on alpine-bashism (the catch surface there is bash-not-installed; the
# session-spawn would also fail because zsh-not-installed and we don't want
# to double-count Brad #5 against the Alpine fixture).

if [ "$FIXTURE_INTENT" = "brad-5-alpine-bashism" ]; then
  log "skipping PTY-spawn probe on alpine-bashism intent (focus is bashism, not zsh)"
  exit 0
fi

log "spawning termdeck server in background for PTY-spawn smoke ..."
termdeck > /tmp/td.out 2>&1 &
TD_PID=$!

i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if ! curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
  err "server did not bind /api/health within 30s"
  log "--- server log tail ---"
  tail -n 80 /tmp/td.out 2>/dev/null || true
  kill "$TD_PID" 2>/dev/null || true
  exit 1
fi
log "server up on /api/health"

log "POST /api/sessions to spawn shell PTY (Brad #5 catch surface) ..."
RESP=$(curl -fsS -X POST http://127.0.0.1:3000/api/sessions \
  -H 'content-type: application/json' \
  -d '{"command":""}' 2>/tmp/curl.err) || {
  err "POST /api/sessions failed: $(cat /tmp/curl.err)"
  kill "$TD_PID" 2>/dev/null || true
  exit 1
}

SID=$(printf '%s' "$RESP" | node -e 'try { console.log((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).id||""); } catch (e) { console.log(""); }')
if [ -z "$SID" ]; then
  err "couldn't parse session id from /api/sessions response: $RESP"
  kill "$TD_PID" 2>/dev/null || true
  exit 1
fi
log "session id: $SID"

# Give the PTY ~4s to either go active or hit ENOENT.
sleep 4

STATUS=$(curl -fsS "http://127.0.0.1:3000/api/sessions/$SID" 2>/dev/null \
  | node -e 'try { console.log((JSON.parse(require("fs").readFileSync(0,"utf-8"))||{}).status||""); } catch (e) { console.log(""); }')

kill "$TD_PID" 2>/dev/null || true

if [ "$STATUS" = "active" ]; then
  log "session status=active — PTY shell spawn SUCCEEDED"
  exit 0
fi

err "session status=$STATUS — likely Brad #5 (PTY shell ENOENT)"
log "--- server log tail ---"
tail -n 80 /tmp/td.out 2>/dev/null || true
exit 1
