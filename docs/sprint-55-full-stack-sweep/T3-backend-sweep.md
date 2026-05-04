# T3 — Edge Functions + Cron + MCP stack sweep (Claude worker)

You are T3 in Sprint 55. Lane focus: **diagnose Sprint 54's still-open synthesis bug + adversarial sweep across rumen-tick / graph-inference Edge Functions + every cron schedule + every MCP tool.** Cell #1 is the Sprint 54 followthrough — closing the `insights_generated: 0 from sessions_processed: 4` mystery.

## Boot the panel with: `claude --dangerously-skip-permissions`

## Boot sequence

1. `date '+%Y-%m-%d %H:%M ET'`
2. `memory_recall(project="termdeck", query="Sprint 54 synthesis bug rumen 0.5.2 relate.ts memory_hybrid_search 8-arg")`
3. `memory_recall(query="Sprint 53 picker rewrite memory_sessions extract.ts 1-row-per-session bundled hook")`
4. `memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback codename")`
5. `memory_recall(query="3+1+1 hardening rules checkpoint post shape")`
6. Read `~/.claude/CLAUDE.md`
7. Read `./CLAUDE.md`
8. Read `docs/sprint-55-multi-lane-stack sweep/PLANNING.md` — Lane T3 section (Cell #1 = synthesis bug)
9. Read `docs/sprint-55-multi-lane-stack sweep/STATUS.md`
10. Read `~/Documents/Graciella/rumen/src/relate.ts`, `synthesize.ts`, `extract.ts`, `index.ts` (the post-Sprint-54 source)

## Cell #1 — Sprint 54 synthesis bug diagnosis (PRIORITY)

This is the END-RESULT cell. Joshua's Sprint 53/54 framing was clear: "If we have all this technology and learning and it's not synthesizing anything, we've accomplished nothing." rumen_insights count is stuck at 233. Sprint 54 closed the relate.ts 8-arg call but didn't move the count. The bug is downstream.

### Step 1.1 — Upgrade supabase CLI to 2.98+ for function logs access

```bash
brew upgrade supabase  # or equivalent on Linux
supabase --version  # want 2.98+
```

If the upgrade fails, document the path forward and proceed with alternate diagnostics (psql probes + direct rumen-tick fires with stdout capture).

### Step 1.2 — Pull rumen-tick function logs from the most recent failed tick

```bash
supabase functions logs rumen-tick --project-ref luvvbrpaopnblvxdxwzb 2>&1 | tail -200
```

Look for:
- `[rumen-extract]` lines — confirms picker found N candidates
- `[rumen-relate]` lines — `mode=hybrid` vs `mode=keyword-only`; per-signal `matched X prior memories` line; any `failed for signal` errors
- `[rumen-synthesize]` lines — `signals=N` (= signals with related.length > 0); `apiKeyMissing=true|false`; `tokens=N` if Anthropic was called; `done: produced=N`
- `[rumen-surface]` lines — what got written to memory_items / rumen_insights

The actual error category will jump out. Possibilities (per PLANNING.md):
- (A) Embedding generation fails → keyword-only mode → low similarity scores → all filtered → related: [] for all signals
- (B) memory_hybrid_search returns rows but ALL below minSimilarity (0.01) — unlikely given the psql test passed
- (C) Synthesize Anthropic call fails silently → falls to placeholder → SHOULD still emit (placeholders count as insights)
- (D) Surface phase fails to write to memory_items / rumen_insights → insights generated but not persisted

### Step 1.3 — Once root cause is identified, write the FIX-PROPOSED with diff

DO NOT publish or ship — orchestrator does that at sprint close.

If category is (A) — embedding fail — possible fixes:
- Increase minSimilarity threshold tolerance: relate.ts line 35 `minSimilarity` default could be lowered further (currently 0.01)
- Add fallback embedding path
- Investigate why OpenAI calls fail in production (rate limit? auth?)

If category is (B) — threshold issue — adjust the threshold OR the search function's scoring.

If category is (C) — synthesize Anthropic fail — the fallback to placeholder should engage; if it doesn't, fix the fallback path.

If category is (D) — surface write fail — fix the surface.ts INSERT path.

### Step 1.4 — Verify fix manually (via test against the daily-driver project)

After FIX-PROPOSED, manually fire rumen-tick AGAIN to verify the fix:

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"')
SERVICE_ROLE=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"')
PROJECT_REF=$(echo "$SUPABASE_URL" | sed -E 's|^https?://([^.]+)\..*|\1|')
curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/rumen-tick" -H "Authorization: Bearer $SERVICE_ROLE" -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
```

If `insights_generated > 0`: 🎉 Sprint 55 acceptance criterion #4 met.

NB: the manual fire requires the FIX to be DEPLOYED — which means rumen package republish + init --rumen --yes. This is a SHIP step that should happen interactively with Joshua, NOT autonomously overnight. For overnight (Mode A), STOP at FIX-PROPOSED. Joshua + orchestrator ship in the morning, then fire to verify.

## Cells 2-20 (per PLANNING.md Lane T3 section)

After Cell #1 either lands a fix-proposed OR is documented as deferred, proceed through cells 2-20:
- rumen-tick fire variants (empty, full, missing API key)
- graph-inference fire variants
- MCP tool exercise (memory_recall, memory_remember, memory_forget, memory_search, memory_status)
- Schema enumeration: `pg_proc` overload sweep — every function in public schema, look for stale signatures
- cron.job table audit
- Mig presence verification (017, 018, etc.)

Output to `docs/sprint-55-multi-lane-stack sweep/T3-SWEEP-CELLS.md`.

## Lane discipline

- Post shape: `### [T3] …` in shared STATUS.md.
- CHECKPOINT every 30 min.
- READ-ONLY-ONLY (no npm publish, no git push, no destructive psql writes). Reading rumen_jobs / memory_items / cron.job_run_details is fine. UPDATE rumen_processed_at unstamps require orchestrator authorization (per Sprint 54 precedent).
- Codename scrub.

## When you're done

Post `### [T3] DONE 2026-05-04 HH:MM ET — Edge Functions + Cron + MCP PASS|YELLOW|RED — synthesis-bug diagnosis: <category A|B|C|D>` with full evidence.

If Cell #1 yielded a clear fix path: `### [T3] DONE — synthesis bug DIAGNOSED — FIX-PROPOSED at <file:line>; orchestrator ships at sprint close`.

Begin.
