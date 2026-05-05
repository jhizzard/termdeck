#!/usr/bin/env bash
# scripts/hetzner-systemd-smoke.sh — Sprint 58 T2 fixture for Brad findings #7 + #8.
#
# Provisions a Hetzner Cloud CX22 Ubuntu 24 VM, installs the TermDeck stack,
# writes a fixture systemd unit that DELIBERATELY reproduces Brad's two
# environment-shape bugs (Type=simple TTY-check fail; missing
# Environment=PATH= so spawned `claude` panels can't find the binary), runs
# post-install probes, captures a structured JSON report, and ALWAYS tears
# down the VM on exit so we never leave a billable orphan.
#
# Pre-Sprint-59 the fixture is EXPECTED to report RED — that proves the
# catch-net catches the right thing. Sprint 59 ships `--service` + PATH=
# docs that turn this fixture from RED to GREEN.
#
# ── Required environment ──
#   HETZNER_API_TOKEN          Hetzner Cloud API token (Read+Write)
#   HETZNER_SSH_KEY_NAME       SSH key name registered in Hetzner console
#   HETZNER_SSH_PRIVATE_KEY    Private-key contents (PEM); written to a
#                              tmpfile and used for SSH/SCP
#   TEST_SUPABASE_URL          Test Supabase project URL
#   TEST_SUPABASE_SERVICE_ROLE_KEY   Test Supabase service-role JWT
#   TEST_DATABASE_URL          Test Supabase pg connection string
#   TEST_OPENAI_API_KEY        For Mnestra embeddings during init
#   TEST_ANTHROPIC_API_KEY     For Claude Code panels (optional but sourced)
#
# ── Optional environment ──
#   GITHUB_RUN_ID              GitHub Actions run ID (used for VM uniqueness;
#                              falls back to a timestamp for local runs)
#   VM_LOCATION                Hetzner location (default: fsn1)
#   REPORT_PATH                Local path to write the JSON report
#                              (default: ./hetzner-systemd-smoke-report.json)
#
# ── Exit codes ──
#   0  All checks GREEN. Sprint 59's fix has landed and the fixture is
#      working as a regression guard. The workflow is happy.
#   1  At least one check is RED. Pre-Sprint-59 this is the expected state
#      and proves the fixture catches Brad #7 + #8.
#   2  Infrastructure failure (couldn't provision, SSH never came up,
#      `hcloud` CLI missing, etc.). Different class — not a fixture
#      reporting RED but a true catch-net outage.
#
# ── Cost discipline ──
#   Run-to-run with full teardown ≈ €0.03/night × 30 = €0.90/month. The
#   trap handler deletes the VM on every exit path. If teardown itself
#   fails, the script logs the orphan VM ID so the orchestrator can finish
#   it via `hcloud server delete <id>`.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────

VM_TYPE="cx22"
VM_IMAGE="ubuntu-24.04"
VM_LOCATION="${VM_LOCATION:-fsn1}"
RUN_TAG="${GITHUB_RUN_ID:-local-$(date -u +%Y%m%d%H%M%S)-$$}"
VM_NAME="termdeck-systemd-smoke-${RUN_TAG}"
SSH_KEY_TMP="$(mktemp -t hetzner-ssh-key.XXXXXX)"
REMOTE_SETUP_TMP="$(mktemp -t termdeck-remote-setup.XXXXXX.sh)"
REPORT_PATH="${REPORT_PATH:-./hetzner-systemd-smoke-report.json}"

SSH_OPTS=(
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
)

# ── Logging + cleanup ────────────────────────────────────────────────────

log() {
  printf '[%s] [smoke] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# Always-run teardown. Runs even on `set -e` failure, even on SIGINT, even
# if the script crashes mid-provision. The cardinal sin is leaving a
# billable VM running, so this trap is the script's most important line.
cleanup() {
  local exit_code=$?
  log "cleanup: tearing down VM ${VM_NAME} (script exit_code=${exit_code})"
  if [[ -n "${HCLOUD_TOKEN:-}" ]]; then
    if hcloud server describe "${VM_NAME}" >/dev/null 2>&1; then
      if hcloud server delete "${VM_NAME}" >/dev/null 2>&1; then
        log "cleanup: VM ${VM_NAME} deleted"
      else
        log "cleanup: WARN — hcloud server delete failed for ${VM_NAME}"
        log "cleanup: ORPHANED VM — orchestrator must manually run: hcloud server delete ${VM_NAME}"
      fi
    else
      log "cleanup: VM ${VM_NAME} not found (nothing to delete)"
    fi
  else
    log "cleanup: HCLOUD_TOKEN unset — skipping (VM may not have been created)"
  fi
  rm -f "${SSH_KEY_TMP}" "${REMOTE_SETUP_TMP}" 2>/dev/null || true
  exit "${exit_code}"
}
trap cleanup EXIT

# ── Pre-flight ───────────────────────────────────────────────────────────

require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    log "FATAL: required environment variable ${var} is not set"
    exit 2
  fi
}

if ! command -v hcloud >/dev/null 2>&1; then
  log "FATAL: hcloud CLI not on PATH (install from https://github.com/hetznercloud/cli/releases)"
  exit 2
fi
if ! command -v ssh >/dev/null 2>&1 || ! command -v scp >/dev/null 2>&1; then
  log "FATAL: ssh/scp not on PATH"
  exit 2
fi

require_env HETZNER_API_TOKEN
require_env HETZNER_SSH_KEY_NAME
require_env HETZNER_SSH_PRIVATE_KEY
require_env TEST_SUPABASE_URL
require_env TEST_SUPABASE_SERVICE_ROLE_KEY
require_env TEST_DATABASE_URL
require_env TEST_OPENAI_API_KEY
require_env TEST_ANTHROPIC_API_KEY

export HCLOUD_TOKEN="${HETZNER_API_TOKEN}"

# Stage the SSH private key in a tmpfile with chmod 600.
printf '%s\n' "${HETZNER_SSH_PRIVATE_KEY}" > "${SSH_KEY_TMP}"
chmod 600 "${SSH_KEY_TMP}"

# ── Generate the remote setup script ─────────────────────────────────────
#
# Built locally so we can interpolate CI secrets without re-quoting through
# nested heredocs on the SSH wire. The script is SCP'd to the VM, executed
# under `bash -e`, and produces /tmp/smoke-report.json which we SCP back.

cat > "${REMOTE_SETUP_TMP}" <<REMOTE_SCRIPT
#!/usr/bin/env bash
set -euxo pipefail

log() { printf '[remote %s] %s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$*" >&2; }

# ── Brad #5 fixture: deliberately do NOT install zsh ──────────────────
log "apt update + install nodejs npm git curl (zsh DELIBERATELY omitted — Brad #5 fixture)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs npm git curl ca-certificates jq

NODE_VER=\$(node --version)
NPM_VER=\$(npm --version)
log "node: \${NODE_VER}, npm: \${NPM_VER}"

# Brad #6 fixture: --include=optional surfaces the claude-code optional dep
# quirk on Linux x64. We pass it on the global install so the smoke matches
# Brad's documented Linux install path.
log "global install @jhizzard/termdeck-stack@latest --include=optional"
npm install -g @jhizzard/termdeck-stack@latest --include=optional --silent 2>&1 | tail -50

log "write ~/.termdeck/secrets.env (chmod 600)"
mkdir -p /root/.termdeck
chmod 700 /root/.termdeck
cat > /root/.termdeck/secrets.env <<SECRETS_EOF
SUPABASE_URL=__SUPABASE_URL__
SUPABASE_SERVICE_ROLE_KEY=__SUPABASE_SERVICE_ROLE_KEY__
DATABASE_URL=__DATABASE_URL__
OPENAI_API_KEY=__OPENAI_API_KEY__
ANTHROPIC_API_KEY=__ANTHROPIC_API_KEY__
SECRETS_EOF
chmod 600 /root/.termdeck/secrets.env

log "termdeck init --mnestra --yes"
termdeck init --mnestra --yes 2>&1 | tail -100 || log "WARN: mnestra init exited non-zero (Brad-class env bugs may surface here too)"

log "termdeck init --rumen --yes"
termdeck init --rumen --yes 2>&1 | tail -100 || log "WARN: rumen init exited non-zero"

# ── Brad #7 + #8 fixture: systemd unit deliberately reproduces both bugs ──
log "writing fixture systemd unit at /etc/systemd/system/termdeck.service"
log "  - Type=simple → reproduces Brad #7 (launcher's TTY check fails under non-interactive parent)"
log "  - Environment=PATH= deliberately OMITTED → reproduces Brad #8 (~/.npm-global/bin missing)"
cat > /etc/systemd/system/termdeck.service <<UNIT_EOF
[Unit]
Description=TermDeck Multiplexer (Sprint 58 fixture — DELIBERATELY broken to catch Brad #7+#8)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/termdeck
EnvironmentFile=/root/.termdeck/secrets.env
# NOTE: Environment=PATH= deliberately omitted.
#       Sprint 59 docs add the PATH= line. Until then this unit FAILS,
#       which is exactly the proof that the fixture catches Brad #7+#8.
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
log "systemctl enable --now termdeck.service (failures are EXPECTED pre-Sprint-59)"
systemctl enable --now termdeck.service 2>&1 || log "systemctl enable failed (expected pre-Sprint-59)"

log "sleep 30s to let the service settle (or fail)"
sleep 30

# ── Probe 1: systemctl is-active ──
SYSTEMD_STATE=\$(systemctl is-active termdeck.service 2>&1 || true)
log "probe 1 (Brad #7): systemctl is-active termdeck.service = \${SYSTEMD_STATE}"

# ── Probe 2: healthz HTTP 200 ──
HEALTHZ_CODE=\$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/healthz 2>/dev/null || echo "000")
log "probe 2 (Brad #7): curl localhost:3000/healthz HTTP code = \${HEALTHZ_CODE}"

# ── Probe 3: journalctl scan for Brad #8 PATH-not-inherited evidence ──
journalctl -u termdeck.service --no-pager -n 500 > /tmp/journal-tail.txt 2>&1 || true
PATH_NOT_FOUND=\$(grep -ciE 'command not found|no such file|claude.*not found|exec.*not found|cannot execute' /tmp/journal-tail.txt 2>/dev/null || true)
PATH_NOT_FOUND="\${PATH_NOT_FOUND:-0}"
log "probe 3 (Brad #8): journalctl matches for PATH-not-inherited evidence = \${PATH_NOT_FOUND}"

# ── Build JSON report ──
status_for() {
  if [[ "\$1" == "\$2" ]]; then echo pass; else echo fail; fi
}
SYSTEMD_STATUS=\$(status_for "\${SYSTEMD_STATE}" "active")
HEALTHZ_STATUS=\$(status_for "\${HEALTHZ_CODE}" "200")
if [[ "\${PATH_NOT_FOUND}" -eq 0 ]]; then PATH_STATUS="pass"; else PATH_STATUS="fail"; fi

cat > /tmp/smoke-report.json <<JSON_EOF
{
  "schema": "termdeck-systemd-smoke/v1",
  "vm": {
    "name": "__VM_NAME__",
    "type": "cx22",
    "image": "ubuntu-24.04",
    "location": "__VM_LOCATION__"
  },
  "node_version": "\${NODE_VER}",
  "npm_version": "\${NPM_VER}",
  "fixture_intent": "Reproduces Brad #7 (Type=simple TTY-check fail) + Brad #8 (no Environment=PATH=). Pre-Sprint-59: expected RED. Post-Sprint-59 fix: expected GREEN.",
  "checks": {
    "systemd_is_active": {
      "expected": "active",
      "actual": "\${SYSTEMD_STATE}",
      "status": "\${SYSTEMD_STATUS}",
      "brad_finding": "#7"
    },
    "healthz_http_200": {
      "expected": "200",
      "actual": "\${HEALTHZ_CODE}",
      "status": "\${HEALTHZ_STATUS}",
      "brad_finding": "#7"
    },
    "no_path_not_found_in_journal": {
      "expected": "0 matches",
      "actual_matches": \${PATH_NOT_FOUND},
      "status": "\${PATH_STATUS}",
      "brad_finding": "#8",
      "note": "non-zero match count is positive evidence of PATH-not-inherited"
    }
  }
}
JSON_EOF

log "==== smoke-report.json (on VM) ===="
cat /tmp/smoke-report.json >&2
echo "==== /smoke-report ====" >&2
REMOTE_SCRIPT

# Substitute the secret values into the staged remote script (delimiter-safe
# because we use sed with a separator unlikely to appear in the values).
# This avoids `bash -c "ANTHROPIC=foo termdeck init"` quoting issues.
substitute() {
  local placeholder="$1"
  local value="$2"
  local file="$3"
  local sep
  for sep in '#' '|' '~' '@'; do
    if [[ "${value}" != *"${sep}"* ]]; then
      sed -i.bak "s${sep}${placeholder}${sep}${value}${sep}g" "${file}"
      rm -f "${file}.bak"
      return 0
    fi
  done
  log "FATAL: cannot substitute ${placeholder} — value contains all candidate separators"
  exit 2
}

substitute "__SUPABASE_URL__"               "${TEST_SUPABASE_URL}"               "${REMOTE_SETUP_TMP}"
substitute "__SUPABASE_SERVICE_ROLE_KEY__"  "${TEST_SUPABASE_SERVICE_ROLE_KEY}"  "${REMOTE_SETUP_TMP}"
substitute "__DATABASE_URL__"               "${TEST_DATABASE_URL}"               "${REMOTE_SETUP_TMP}"
substitute "__OPENAI_API_KEY__"             "${TEST_OPENAI_API_KEY}"             "${REMOTE_SETUP_TMP}"
substitute "__ANTHROPIC_API_KEY__"          "${TEST_ANTHROPIC_API_KEY}"          "${REMOTE_SETUP_TMP}"
substitute "__VM_NAME__"                    "${VM_NAME}"                         "${REMOTE_SETUP_TMP}"
substitute "__VM_LOCATION__"                "${VM_LOCATION}"                     "${REMOTE_SETUP_TMP}"

# ── Provision ────────────────────────────────────────────────────────────

log "provisioning VM ${VM_NAME} (${VM_TYPE}, ${VM_IMAGE}, ${VM_LOCATION})"
hcloud server create \
  --name "${VM_NAME}" \
  --type "${VM_TYPE}" \
  --image "${VM_IMAGE}" \
  --location "${VM_LOCATION}" \
  --ssh-key "${HETZNER_SSH_KEY_NAME}" \
  >/dev/null

VM_IP="$(hcloud server ip "${VM_NAME}")"
if [[ -z "${VM_IP}" ]]; then
  log "FATAL: VM ${VM_NAME} provisioned but no public IPv4 returned"
  exit 2
fi
log "VM IP: ${VM_IP}"

# ── Wait for SSH ─────────────────────────────────────────────────────────

log "waiting for SSH on ${VM_IP} (timeout 5 min)"
ssh_ready=0
for attempt in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" -i "${SSH_KEY_TMP}" "root@${VM_IP}" 'true' 2>/dev/null; then
    log "SSH alive after attempt ${attempt}"
    ssh_ready=1
    break
  fi
  sleep 10
done
if [[ "${ssh_ready}" -ne 1 ]]; then
  log "FATAL: SSH never came up after 5 min"
  exit 2
fi

# ── Push setup script + execute ──────────────────────────────────────────

log "scp setup script → VM"
scp "${SSH_OPTS[@]}" -i "${SSH_KEY_TMP}" "${REMOTE_SETUP_TMP}" "root@${VM_IP}:/tmp/setup.sh"

log "ssh: bash /tmp/setup.sh"
# Capture remote stdout/stderr but DON'T let the remote's exit code abort
# the script — we want to fetch the JSON report in every case so the
# workflow can inspect what failed.
set +e
ssh "${SSH_OPTS[@]}" -i "${SSH_KEY_TMP}" "root@${VM_IP}" 'bash /tmp/setup.sh'
remote_exit=$?
set -e
log "remote setup exited with code ${remote_exit}"

# ── Pull report back ─────────────────────────────────────────────────────

log "scp /tmp/smoke-report.json ← VM → ${REPORT_PATH}"
if ! scp "${SSH_OPTS[@]}" -i "${SSH_KEY_TMP}" "root@${VM_IP}:/tmp/smoke-report.json" "${REPORT_PATH}"; then
  log "FATAL: could not retrieve JSON report from VM"
  exit 2
fi

log "scp /tmp/journal-tail.txt ← VM (best-effort)"
scp "${SSH_OPTS[@]}" -i "${SSH_KEY_TMP}" "root@${VM_IP}:/tmp/journal-tail.txt" "${REPORT_PATH}.journal.txt" >/dev/null 2>&1 \
  || log "WARN: journal tail not retrieved"

# ── Parse + decide exit code ─────────────────────────────────────────────

log "==== smoke-report (local) ===="
cat "${REPORT_PATH}" >&2
echo >&2

# Exit 0 if every check is "pass"; exit 1 if any are "fail". We use a tiny
# inline node parser instead of jq so the script doesn't add a dependency
# on jq existing on the runner.
fail_count=$(node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  let n = 0;
  for (const [k, c] of Object.entries(r.checks || {})) {
    if (c.status !== "pass") n += 1;
  }
  console.log(n);
' "${REPORT_PATH}")

if [[ "${fail_count}" -eq 0 ]]; then
  log "all checks GREEN — fixture's regression-guard mode (post-Sprint-59-fix)"
  exit 0
fi

log "${fail_count} check(s) RED — fixture caught Brad-class regressions"
log "this is EXPECTED pre-Sprint-59. Post-fix the fixture must turn GREEN."
exit 1
