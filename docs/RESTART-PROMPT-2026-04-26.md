# RESTART PROMPT — 2026-04-26

Paste this into a fresh Claude Code session opened in the TermDeck repo (or anywhere — the boot sequence handles project location).

---

```
I'm continuing work on TermDeck (~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck).

Boot sequence:

1. memory_recall(project="termdeck", query="v0.7.2 Sprint 34 chopin-nashville harness hook")
2. memory_recall(project="termdeck", query="recent decisions and bugs")
3. memory_recall(query="Sprint 35 PROJECT_MAP iteration order subject summary insights badge")
4. Read ~/.claude/CLAUDE.md
5. Read ./CLAUDE.md
6. Read docs/RESTART-PROMPT-2026-04-26.md (this file — for the full picture below)
7. Read docs/sprint-34-project-tag-fix/POSTMORTEM.md (the immediate prior context)
8. Then I'll signal what topic to dig into for the new session.
```

---

## Where things stand at end-of-day 2026-04-26

**Live npm versions** (all published today):

| Package | Version |
|---|---|
| `@jhizzard/termdeck` | **0.7.2** |
| `@jhizzard/termdeck-stack` | **0.3.2** |
| `@jhizzard/mnestra` | 0.2.2 (unchanged since 0.6.5 corpus fix) |
| `@jhizzard/rumen` | 0.4.3 (unchanged) |

**Local main:** `2ea6b87` (Sprint 34 ship). Clean working tree. Both joshuaizzard-com and engram repos clean.

**Today's arc:** Brad's eight-incident wizard saga closed yesterday (v0.6.1 → v0.6.9), then today's runtime arc shipped v0.7.0 → v0.7.2. Sprint 32 (4+1, v0.7.0 runtime correctness), Sprint 33 (4+1 forensic, v0.7.1 Flashback regex fix), Sprint 34 (4+1, v0.7.2 chopin-nashville corpus repair + writer-side regression lock + audit logs). Three sprints in one day, all 4+1 orchestrated, all integrated cleanly.

**Test posture:** 17 test files, 130 pass / 0 fail / 2 skipped (Sprint 35 deferrals). Live-server contract suites (flashback-e2e, health-contract, transcript-contract, rumen-contract) green when run against a live TermDeck + Mnestra.

## Sprint 35 — leads with the harness hook fix

Locked in global memory and Josh's instruction: **"Make sure that major finding is executed in Sprint 35. Has to get done."**

### Lane 1 (headline) — `~/.claude/hooks/memory-session-end.js:17`

Josh's user-owned Claude Code harness hook is the upstream root cause of every chopin-nashville mis-tag. PROJECT_MAP iterates in array order and returns first-match. The `/ChopinNashville|ChopinInBohemia/i` pattern matches before any leaf-specific entry. There are no entries for `termdeck`, `mnestra`/`engram`, `rumen`, `podium`, or `claimguard` in the map at all.

**Fix shape — pick one:**
- **A (small, fast):** insert leaf-first patterns BEFORE the ChopinNashville entry. ~10 LOC. Same shape addresses gorgias→claimguard and engram→mnestra mis-tags too.
  ```js
  { pattern: /\/SideHustles\/TermDeck\/termdeck/i, project: 'termdeck' },
  { pattern: /\/Graciella\/engram/i, project: 'mnestra' },
  { pattern: /\/Graciella\/rumen/i, project: 'rumen' },
  { pattern: /\/ChopinInBohemia\/podium/i, project: 'podium' },
  { pattern: /\/Unagi\/gorgias-ticket-monitor/i, project: 'claimguard' },
  // existing ChopinNashville entry stays as fallback for non-leaf paths
  ```
- **B (cleaner):** rewrite `detectProject()` as longest-substring-wins over a canonical project map. ~30 LOC.

This is OUTSIDE every npm-published repo. Cannot be shipped as part of a TermDeck/Mnestra/Rumen package. Josh executes locally.

### Lane 2 — broader corpus backfill

After the harness hook is fixed, ~864 more rows still need one-time reclassification:
- 368 rows tagged `gorgias` → should be `claimguard`
- 117 rows tagged `gorgias-ticket-monitor` → should be `claimguard`
- ~379 rows tagged `global` → mostly `mnestra` (engram/Graciella content) + others by content match

Pattern: same shape as Sprint 34's `scripts/migrate-chopin-nashville-tag.sql`. Just expand the WHERE clause. Reuse the metadata stash pattern for reversibility (use `rebrand_v0_7_3_from` to distinguish from Sprint 34's `rebrand_v0_7_2_from`).

After this backfill, the two skipped invariant tests in `tests/project-tag-invariant.test.js` (gorgias→claimguard and global→mnestra) un-skip and lock in.

### Lane 3 — per-panel subject summary (Josh requested 2026-04-26)

A few words at the top of each TermDeck terminal panel describing what it's about. Schema: `sessions.subject TEXT NULL` (in-place schema migration in `database.js`, same pattern as v0.7.0's `theme_override`). Server: PATCH `/api/sessions/:id { subject: '...' }`. Client: small inline-editable field in panel header near the project tag, click-to-edit text input, persists on blur. Use cases: 4+1 sprint orchestration ("T1 lane: theme persistence"), workflow labels, fifth-terminal coordination view. Optional Haiku auto-suggest deferred. ~80 LOC total.

### Lane 4 — Rumen Insights badge counter sync (Josh reported mid-Sprint-34)

Marking insights as seen via the modal doesn't decrement the panel header's "N new" badge until full panel refresh. Fix: optimistic-update the client state on click (option C from the memory). ~30 LOC client + 5 LOC server. Pattern is the same as the existing status-dot WS sync.

### Lane 5 (parallel content track) — joshuaizzard.com stack-installer blog post (Josh requested 2026-04-26 evening)

Short post pitching the unified four-layer stack as one-command-installable: `npx @jhizzard/termdeck-stack` → TermDeck display + Mnestra memory + Rumen learning + Supabase MCP, all wired in ~90 seconds. Match the existing portfolio post tone (narrative, ~400–600 words). Filename: `src/content/blog/the-stack-in-one-command.mdx` (or similar). Reference the v0.7.x install-time-correctness arc as proof the friction has been hardened. Optional sibling: a unified tagline-card near the top of `page.tsx` that ties the three flagship cards together with a "one command, the whole stack" hook.

Not blocking the harness-hook fix; pure content track that one terminal can take while the other three handle Lanes 1-4. Or write between sprints during a quieter moment.

### Lane 6 — TMR 4+1 orchestrator discipline guardrail (Brad retro 2026-04-26 evening)

Brad forwarded a self-retro from the ClaimGuard Sprint 4 run (via Josh, evening of 2026-04-26): orchestrator held twice for fresh authorization when prior authorization already explicitly covered the next step (Q1=ii merge, Q4=i T4 approval). Pattern-match was "destructive=ask" without recalling the path was already authorized. Standalone-Claude review on the same retro caught a second-order issue: orchestrator framed RLS options as "path A/B/C" without stating whether A was the same as the previously-chosen Q2.3=(i) column-REVOKE or a new option from new findings — silent relabel forces re-authorization of choices already made.

**Fix — two guardrails together (rules #14 and #15) in `~/.claude/plans/skill-tmr-orchestrate/guardrails.md`:**

**Guardrail #14 — over-cautiousness rule (when prior auth already covers next step).** Three cases:
1. **Obviously covers next step** (Q1=ii means merge; merge is next step) → proceed silent.
2. **Arguably covers next step** (auth applied to artifact X, but X has been amended via a separate decision) → proceed with one-line extension sentence: *"Proceeding with [action] under prior authorization [Q-number]; this assumes [the extension being made]. Will hold if you object."*
3. **Genuinely new info** (finding that didn't exist at time of prior decisions, e.g. fresh RLS leak) → hold for fresh auth.

Plus the labeling rule: when surfacing path A/B/C options after prior decisions, the orchestrator MUST cross-reference the prior Q-number explicitly — state whether each label maps to a previously-chosen option or is a new option from new findings.

**Guardrail #15 — enforcement-vs-convention rule (added late evening 2026-04-26 from Brad's standalone-Opus retro on the same ClaimGuard Sprint 4 run).** When orchestrator surfaces a security or correctness finding, its DEFAULT recommendation must be **enforcement-level fix** (DB-level RLS, separate table, service_role-only route, automated test), NOT **convention-level fix** (documented "never do X" rules). Convention layers fail silently; enforcement layers fail loudly. Convention-level acceptable ONLY when ALL of: (a) enforcement-level cost > 4 hrs, AND (b) no plausible single-line exploit path exists, AND (c) the convention is paired with an automated test that would fail loudly if violated. Otherwise: enforcement. The Phase-1 framing "no user-facing impact today, harden later if a real exploit appears" is a trap because the relevant failures (an applicant reading "AI recommended disposition: decline" before you've decided) don't surface as complaints — they surface as silent withdrawals. Brad's standalone Opus caught two of these in one evening (Q5 six-routes audit drop, and ai_review_* fields readable via Supabase JS + devtools). Both times the right call was the higher-cost enforcement fix while the cost was still low and context was fresh.

**Why both rules together:** orchestrator miscalibrates risk in BOTH directions — over-asks when prior auth covered next step (#14), and under-asks when a finding has no user-impact today (#15). Same root: under-weighting latent risk vs immediate friction. The asymmetric risk is the silent failure mode in each — silent scope drift on #14, silent trust erosion on #15.

**Possibly model-capability correlated.** TermDeck doesn't pin a model — panels run whatever Claude Code defaults to at launch (currently Sonnet 4.6). The standalone Opus 4.7 sessions are catching what the in-panel orchestrator misses. **Practical fix:** when running a 4+1 sprint where the orchestrator will make security/correctness tradeoffs, launch the orchestrator panel with `ANTHROPIC_MODEL=claude-opus-4-7 claude` or `claude --model claude-opus-4-7`. Workers stay on Sonnet (cheap; they execute well-scoped lanes); orchestrator gets Opus (judgment lives there). Both rules also work on Sonnet — they're durable past any single model — but the model swap is a 5-second config change that compounds the discipline.

This is a TMR skill edit, not a TermDeck code change. Lives at `~/.claude/plans/skill-tmr-orchestrate/guardrails.md` (skill repo, separate from any npm-published artifact). Same "outside every npm repo" position as Lane 1 (the harness hook). One terminal can take this lane in parallel with Lanes 1-5; ~50 LOC of skill-doc text for both rules. Cross-project memory already stores both rules (mcp `memory_recall(query="orchestrator over-cautiousness")` for #14, `memory_recall(query="orchestrator enforcement convention")` for #15).

## Other pending work (not Sprint 35 unless scope allows)

- **Migration-001 idempotency** (CREATE OR REPLACE FUNCTION return-type collision when re-running migrations against an upgraded store). Surfaced 2026-04-25 v0.6.3 live test. Doesn't affect fresh installs.
- **Rumen-MCP NULL `source_session_id`** (memories written via the MCP path don't reach Rumen synthesis because Rumen filters by `source_session_id IS NOT NULL`). Discovered 2026-04-26.
- **Drag-and-drop file paths + image paste in terminals** (Josh reported 2026-04-26 mid-Sprint-32). Browser security caveats for filesystem path access; needs design.
- **Theme picker UX overhaul** (per-project palettes, custom themes). Lower priority.
- **HN launch readiness:** jhizzard HN account at 1 karma + 3 comments, needs 15+ before Show HN. Tester feedback (David Zhao, Jonathan, Yasin) still pending in writing — Brad's eight-incident series is its own valuable tester data over WhatsApp.
- **Theme persistence + auth-cookie + /api/health/full** all shipped in v0.7.0; Brad gets the theme reset link automatically on his v0.7.2 upgrade.

## Operational notes

- **npm publish flow:** Josh authenticates via passkey in the browser, NOT an authenticator OTP. Never suggest `--otp=<code>` placeholders. The agent prepares the release; Josh runs `npm publish --access public` from each package dir.
- **4+1 orchestration:** when Josh runs four parallel Claude Code panels in TermDeck for a sprint, ALWAYS inject prompts via `POST /api/sessions/:id/input` (bracketed-paste markers + `\r`), never copy-paste blocks for him. Updated convention in `~/.claude/CLAUDE.md`.
- **Live UPDATE statements against petvetbid Supabase:** require Josh's pre-approval. Sprint 34 model: design SQL with dry-run pre-flight, post counts to STATUS.md, sample inspection, then execute Block 2 in one transaction with metadata stash for reversibility.
- **Communication channel:** Josh and Brad communicate via WhatsApp, NOT iMessage. The `mcp__imessage__*` tools cannot read or send WhatsApp. The `wa.me/<E164>?text=<urlencoded>` deep link opens WhatsApp Desktop with prefilled text — Josh taps Send manually.

## Where the docs live

- This restart prompt: `docs/RESTART-PROMPT-2026-04-26.md`
- Today's POSTMORTEMs: `docs/sprint-33-flashback-debug/POSTMORTEM.md`, `docs/sprint-34-project-tag-fix/POSTMORTEM.md`
- Today's sprint scaffolds: `docs/sprint-32-v070/`, `docs/sprint-33-flashback-debug/`, `docs/sprint-34-project-tag-fix/`
- Project CLAUDE.md (always loaded): `./CLAUDE.md`
- Global CLAUDE.md (always loaded, has the 4+1 inject convention): `~/.claude/CLAUDE.md`
- Prior restart prompts: `docs/RESTART-PROMPT-2026-04-19.md`, `docs/RESTART-PROMPT-2026-04-18.md` (both predate v0.5–v0.7 work; treat as historical context only)
- Live npm registry: `npm view @jhizzard/termdeck version` (currently 0.7.2)
- Memory store: `petvetbid` Supabase, project ref `luvvbrpaopnblvxdxwzb`. Mnestra has ~4,889 memory_items; chopin-nashville is now 827 (down from 1,219 after Sprint 34 backfill).

## When you start tomorrow

The boot sequence above tells the new session what to load. After that loads, signal the topic. Most likely opening moves:
- *"Sprint 35 — fix the harness hook"* → goes straight to `~/.claude/hooks/memory-session-end.js`, no scaffold needed (it's a single-file ~10 LOC fix; doesn't need 4+1 orchestration unless we bundle the broader backfill SQL + subject-summary feature into one sprint).
- *"Plan Sprint 35 properly with all four lanes"* → 4+1 scaffold like Sprint 32/33/34, four lanes laid out above.
- *"Start the day with a different project"* (BHHT / Chopin in Bohemia) → memory_recall on that project; TermDeck context stays warm via memory.

Brad got a WhatsApp upgrade ping at 18:35 ET 2026-04-26. He'll likely confirm the upgrade went through tomorrow morning. If he reports anything, Sprint 35 sequencing might shift.
