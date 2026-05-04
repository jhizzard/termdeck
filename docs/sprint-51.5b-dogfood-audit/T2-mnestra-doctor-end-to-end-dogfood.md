# Sprint 51.5b — T2 (Claude): mnestra doctor end-to-end dogfood

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T2):**

Run `mnestra doctor` against `petvetbid` (Joshua's daily driver) and against a deliberately broken project (T3's throwaway). Verify the output accuracy, false-positive resistance, and recommendation specificity. **Audit-only.**

## Sequence

### 1. Substrate

```bash
date '+%Y-%m-%d %H:%M ET'
which mnestra && mnestra --version           # expect mnestra@0.4.1+ from @jhizzard/mnestra
mnestra doctor --help                         # confirm subcommand registered
```

If `mnestra doctor` is not a recognized subcommand, the v1.0.1 wave's mnestra publish didn't include T2's CLI registration. Document and fail the lane.

### 2. Run against petvetbid (Joshua's daily driver)

```bash
mnestra doctor
# Or with explicit project ref if that's the CLI shape:
# mnestra doctor --project-ref luvvbrpaopnblvxdxwzb
```

**Expected output (most likely):**

```
✗ rumen-tick all-zeros — N of last 10 successful runs reported sessions_processed=0 AND insights_generated=0
  → likely schema drift — run `termdeck init --rumen` to audit
  → reference: docs/INSTALLER-PITFALLS.md ledger #13
✓ rumen-tick latency — p95 = ~Xs over last 10 runs
✓ graph-inference-tick all-zeros — fresh schedule (≤6 cycles); deferred until next cycle
✓ graph-inference-tick latency — p95 = ~Ys over last 10 runs
[? red/green depending on Codex's mig 015 + T1's audit-upgrade pass] schema drift
✓ MCP config path parity — mnestra registered in ~/.claude.json only (canonical)

Doctor complete. 1 red, 0 yellow, 5 green, 0 unknown. Exit 1.
```

The cron-all-zeros red is **expected** — it correctly identifies the still-broken state from the P0 (or, if T1 already ran and the hook hypothesis confirmed, the recovered state where new memory_sessions writes are landing but rumen-tick hasn't caught up yet).

**Failure modes to watch for:**

- `mnestra doctor` errors out before any probe runs: likely a startup config issue. Document the error.
- All probes return `unknown`: the migration-016 SECURITY DEFINER wrappers aren't installed (T1 should have applied mig 016 via audit-upgrade; if it didn't, that's a T1 regression).
- Schema-drift probe says everything's fine but a manual probe shows otherwise: the doctor's probe set has a gap.
- Renderer cosmetic glitch (`sessions_processed=0 AND insights_generated=0=0` — T2 flagged this in Sprint 51.5 as a known cosmetic bug deferred): document if it appears, doesn't fail the lane.

### 3. Run against a deliberately broken project

Coordinate with T3 — they're provisioning a throwaway `termdeck-dogfood-2026-05`. Once T3 lands the basic install, deliberately break it:

```bash
psql "$TEST_DATABASE_URL" -c "alter table memory_relationships drop column weight cascade"
psql "$TEST_DATABASE_URL" -c "select cron.unschedule('graph-inference-tick')"

mnestra doctor --project-ref <test-ref>
```

**Expected:**

```
[? cron-all-zeros may not fire if cron is freshly suspended; threshold is ≥6 zero-runs]
✗ schema drift — 1 artifact missing: M-009 (memory_relationships.weight)
  → run `termdeck init --rumen` to apply
✗ graph-inference-tick cron suspended — pg_cron job 'graph-inference-tick' not found
  → run `termdeck init --rumen` to re-schedule
[other probes green]

Doctor complete. 2 red, 0 yellow, 4 green, 0 unknown. Exit 1.
```

### 4. Cold-boot tolerance test

If T3's throwaway project has a fresh cron schedule (≤5 runs so far), `mnestra doctor` against it should NOT fire cron-all-zeros red — the ≥6-cycle threshold should hold.

```bash
mnestra doctor --project-ref <fresh-test-ref>
# Expected: cron-all-zeros = green or yellow, never red on a freshly-provisioned project.
```

Document the result. If red fires on a fresh project, the threshold logic has a bug.

### 5. MCP config path parity test

Three fixtures:

```bash
# Fixture A: canonical only
ls ~/.claude.json && (! ls ~/.claude/mcp.json 2>/dev/null)
mnestra doctor   # Expected: MCP config path parity = green

# Fixture B: legacy only (simulate by temporarily moving canonical)
mv ~/.claude.json ~/.claude.json.bak && touch ~/.claude/mcp.json
mnestra doctor   # Expected: MCP config path parity = red, recommends termdeck init --mnestra to migrate
mv ~/.claude.json.bak ~/.claude.json && rm ~/.claude/mcp.json   # restore

# Fixture C: both (simulate by adding a placeholder legacy entry)
cp ~/.claude.json ~/.claude.json.bak && echo '{"mcpServers": {"mnestra": {}}}' > ~/.claude/mcp.json
mnestra doctor   # Expected: MCP config path parity = yellow, recommends removing legacy entry
mv ~/.claude.json.bak ~/.claude.json && rm ~/.claude/mcp.json   # restore
```

Document any divergence from expected.

## Acceptance criteria

1. **mnestra doctor subcommand registered.** Step 1 confirms.
2. **petvetbid output accurate.** Cron-all-zeros red fires correctly (or correctly clears post-T1's hook fix); recommendations cite specific migration/cron names; ledger #13 / #14 references resolve.
3. **Deliberately broken project produces 2 reds with specific recommendations.**
4. **Cold-boot tolerance holds.** Fresh project (≤5 runs) does NOT fire red.
5. **MCP config path parity correct on all 3 fixtures** (canonical-only=green, legacy-only=red, both=yellow).
6. **Cosmetic renderer glitch documented** (if it appears) but doesn't fail the lane.
7. **Exit codes correct.** Exit 0 if all green; exit 1 if any red; exit 2 if any yellow but no red. Suitable for CI.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="mnestra", query="Sprint 51.5b dogfood mnestra doctor end-to-end probe set ≥6-cycle threshold MCP path parity")
3. memory_recall(project="termdeck", query="Sprint 51.5 T2 mnestra doctor migration 016 SECURITY DEFINER wrappers")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (Class I + ledger #13)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/PLANNING.md + STATUS.md
8. Read this brief
9. cd ~/Documents/Graciella/engram (mnestra repo) and read src/doctor.ts + src/doctor-data-source.ts (the v0.4.1 deliverable you're exercising)
10. Read ~/Documents/Graciella/engram/migrations/016_mnestra_doctor_probes.sql (the SECURITY DEFINER wrappers)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in TermDeck `docs/sprint-51.5b-dogfood-audit/STATUS.md`. **Audit-only.**
