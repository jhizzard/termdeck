# T4 — Boot banner RAG state + minimal launcher parity

## Goal

Two deliverables:

1. **RAG state in boot banner**: After the existing TermDeck boot banner, print a one-line indicator showing whether `rag.js` is active. Users should always know what mode they're in.

2. **Minimal `scripts/start.sh` parity in the published CLI**: Port the two highest-value behaviors — stale-port reclaim and transcript-table-missing hint — into `packages/cli/src/index.js`. (The rest of `scripts/start.sh` parity is Sprint 36 / Phase B.)

## Files (yours)

- `packages/cli/src/index.js` (boot banner, port reclaim, hints)
- `packages/server/src/index.js` (banner output region only)

## Files NOT yours (don't touch)

- `packages/cli/src/init-mnestra.js` (T1)
- `packages/cli/src/init-rumen.js` (T3)
- `packages/cli/src/doctor.js` (T3 owns; new file)
- `packages/server/src/setup/` (T2)

## Concrete changes

### 1. RAG state line after the banner

After the existing TermDeck banner block, read `config.rag.enabled` and print one of:

```
RAG: off (MCP-only mode) — toggle in dashboard at http://localhost:<port>/#config to enable session/project/developer memory tables
```

OR (if `rag.enabled: true`):

```
RAG: on — events syncing to mnestra_session_memory / mnestra_project_memory / mnestra_developer_memory
```

Style: dim text, single line, no decoration beyond the existing banner aesthetic. Match the existing `printf` / `console.log` pattern wherever the banner lives.

### 2. Port stale-port reclaim from `scripts/start.sh:127–154`

Lift the logic from the script:

- Use `lsof -ti TCP:<port> -sTCP:LISTEN` (macOS/Linux) or `fuser -n tcp <port>` fallback to find PIDs holding the target port
- For each PID, check `ps -o command= -p <pid>` to see if it matches `packages/cli/src/index.js` or contains `termdeck`
- If the holder IS a TermDeck process: SIGTERM, 1s grace, then SIGKILL. Continue with boot.
- If the holder is non-TermDeck: print a clear error with a "try a different port" hint and exit non-zero.

Read `packages/cli/src/index.js` first to see if any port-conflict logic already exists. If yes, extend it — don't duplicate. If no, add a helper function `reclaimStalePort(port)` and call it before the server binds.

### 3. Port transcript-table hint from `scripts/start.sh:309–313`

If `DATABASE_URL` is set and `psql` is available on PATH, on boot run:

```bash
psql $DATABASE_URL -c "SELECT 1 FROM termdeck_transcripts LIMIT 0"
```

If it fails, print a hint:

```
[hint] Transcript backup table missing. Run: termdeck doctor (or psql $DATABASE_URL -f config/transcript-migration.sql)
```

Note: `termdeck doctor` is shipped by T3. If T3 isn't merged when you write this, reference the `psql` command directly — orchestrator will reconcile the hint copy at sprint close.

### 4. NOT in scope (deliberate non-port)

These `scripts/start.sh` behaviors are Sprint 36 / Phase B — DO NOT port them this sprint:
- Mnestra autostart (lines 156–276)
- Mnestra restart-on-empty-store with secrets re-load
- MCP-config absence hint (lines 278–284)
- Rumen last-job age check (lines 286–307)
- The full Step 1/4 → Step 4/4 launcher choreography

## Manual test

```bash
# 1. RAG: off banner
sed -i.bak 's/enabled: true/enabled: false/' ~/.termdeck/config.yaml
termdeck
# Expected: banner with "RAG: off (MCP-only mode) — toggle in dashboard..."
# Ctrl+C

# 2. RAG: on banner
sed -i.bak 's/enabled: false/enabled: true/' ~/.termdeck/config.yaml
termdeck
# Expected: banner with "RAG: on — events syncing..."
# Ctrl+C

# 3. Stale port reclaim
termdeck &      # boot first instance
TERM_PID=$!
sleep 2
termdeck        # second boot — should reclaim port 3000 from the first
# Expected: no port conflict error; first instance gets killed; second boots cleanly

# 4. Non-TermDeck process holding port
python3 -m http.server 3000 &
HTTP_PID=$!
termdeck
# Expected: clear error message + suggested next-port command + exit 1
kill $HTTP_PID
```

## Status posting

Append to `docs/sprint-35-reconciliation/STATUS.md`:

```
## YYYY-MM-DD HH:MM ET — [T4 FINDING] <observation>
## YYYY-MM-DD HH:MM ET — [T4 FIX-PROPOSED] <approach>
## YYYY-MM-DD HH:MM ET — [T4 DONE] <one-line summary>
```

## Out of scope

- Mnestra autostart parity (Sprint 36 / Phase B)
- MCP-config-hint parity (Sprint 36 / Phase B)
- No CHANGELOG edits — orchestrator handles
- No version bumps — orchestrator handles
- No commits — orchestrator handles
