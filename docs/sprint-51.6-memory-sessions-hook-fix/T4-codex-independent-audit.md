# Sprint 51.6 — T4 (Codex, auditor): Independent audit + verification harness

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T4):**

You are Codex, running outside the Sprint 51.5 substrate that built v1.0.1. Your job is **independent audit** — verify T1's instrumentation findings, T2's schema diagnosis, and T3's fix are all correct and consistent. Catch things the Claude lanes (working from inside their own assumptions) might miss.

You have access to the Mnestra MCP (memory_recall, memory_remember). You have access to psql via the autoMode rule landed earlier this session for `~/.termdeck/secrets.env`-derived `DATABASE_URL`. You can read all files in the termdeck repo and `~/Documents/Graciella/engram`.

## Audit phases

### Phase A: Pre-T3 audit (runs in parallel with T1/T2)

Goal: independently confirm or contradict T1's instrumentation finding and T2's schema diagnosis.

1. **Re-do T2's schema probe from a fresh psql session.** Run `\d memory_sessions` against petvetbid; capture the schema. Diff your output against T2's FINDING. Document any discrepancy (could be a serialization issue, could be an actual divergence between sessions).

2. **Re-do T1's instrumentation pattern.** Open a NEW Claude Code session in any directory; do a trivial interaction; `/exit`. Watch `/tmp/hook-fired.log` for the timestamp pattern. Confirm T1's writeup matches what you observe. If T1's instrumentation has been removed (T1 finished and restored), re-instrument briefly with the same pattern; restore when done.

3. **Cross-check: did T1 actually restore the hook?** `diff ~/.claude/hooks/memory-session-end.js packages/stack-installer/assets/hooks/memory-session-end.js`. If the installed hook diverges from bundled (other than a known intentional delta T1 documented), T1 didn't fully clean up. Flag in `[T4-CODEX] AUDIT` post.

4. **Validate the two-bug claim.** Pull last 50 memory_items rows by created_at; confirm source_agent='claude' rows landed only AFTER 2026-05-03 23:01 UTC (Codex's mig 015 application). If any landed before, the source_agent column was added earlier and the timing claim is off.

### Phase B: Post-T3 verification (runs after T3 posts FIX-LANDED)

Goal: prove the fix actually works in the user's path, not just in T3's tests.

1. **Install v1.0.2 from npm.** `npm install -g @jhizzard/termdeck@1.0.2` (or whichever package gets bumped per T3's chosen path). Verify version with `node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"`.

2. **Run audit-upgrade against petvetbid.** `termdeck init --mnestra` — verify migration 017 (if Path A or C) applies cleanly. Capture stdout.

3. **Probe pre-fire baseline.**
   ```bash
   psql "$DATABASE_URL" -c "select count(*) from memory_sessions"
   ```
   Note the count.

4. **Trigger a fresh /exit.** Open a new Claude Code session; trivial interaction; /exit. Wait 5s.

5. **Probe post-fire.**
   ```bash
   psql "$DATABASE_URL" -c "select count(*) from memory_sessions; select * from memory_sessions order by created_at desc limit 1"
   ```
   **Expected: count grew by 1; the new row contains the expected fields populated correctly.** This is the canonical proof v1.0.2 fixes the bug.

6. **source_agent regression check.**
   ```bash
   psql "$DATABASE_URL" -c "select source_agent, count(*) from memory_items where created_at > 'NOW() - 5 minutes'::interval group by source_agent"
   ```
   Expected: at least 1 row with `source_agent='claude'` matches the recent /exit. If absent, the v1.0.2 fix broke the previously-working memory_items branch — that's a regression T3 has to address.

7. **Run mnestra doctor against petvetbid.**
   ```bash
   mnestra doctor
   ```
   Expected: cron-all-zeros may still fire red until rumen-tick has fresh successful runs (4-6 ticks at 15-min intervals = ~1-2 hours wait). Schema-drift probe should be all green post-fix. MCP path parity green.

### Phase C: Findings synthesis

Write a `[T4-CODEX] AUDIT` post in STATUS.md categorizing:
- **CONFIRMED** — your independent audit matches T1/T2/T3's findings.
- **DIVERGENCE** — your audit contradicts a Claude lane's finding; surface for orchestrator review.
- **GAP** — Claude lanes didn't cover this and your audit found it. Specify what.

Then write a final `[T4-CODEX] DONE — VERIFIED` (or `DONE — REOPEN T3 — <reason>`) post.

If REOPEN: orchestrator triggers a v1.0.3 hotfix; do not let v1.0.2 ship-and-claim-success while a known regression is live.

## What "good audit" looks like

- **Independent reproduction**, not just rubber-stamping the Claude lanes.
- **Specific evidence** in every claim — psql output, hook source line numbers, file diffs, npm view results.
- **Adversarial mindset** on the fix — if T3 ships a one-line patch, audit whether the patch addresses the root cause or merely a symptom.
- **Restore claims verified** — if a Claude lane says "I restored the hook," prove it via `diff` rather than trusting the assertion.

## Boot

```
1. date '+%Y-%m-%d %H:%M ET'
2. memory_recall(project="termdeck", query="Sprint 51.6 T4 Codex audit memory_sessions hook v1.0.2 verification petvetbid two-bug picture")
3. memory_recall(query="Codex chopin-in-bohemia source_agent column drift mig 015 manual application 2026-05-03")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/PLANNING.md
7. Read STATUS.md (watch for T1/T2/T3 FINDING posts as they land)
8. Read T1-hook-instrumentation.md, T2-schema-audit.md, T3-fix-and-ship-v1-0-2.md (the lanes you're auditing)
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js (current bundled hook)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md ledger entries #13 (Brad drift) + #14 (Brad takeaways) for failure-class context.
```

Post in `[T4-CODEX] FINDING/AUDIT/VERIFY/DONE` shape so the orchestrator can pattern-match. **Audit-only — no code changes, no commits, no publishes.**
