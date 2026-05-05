# T4 — Codex auditor + Agent integration stack sweep (Codex panel, NOT Claude)

You are T4 in Sprint 55. **Codex auditor + agent-integration cell-runner.** Dual role:
1. **Adversarial auditor** for T1/T2/T3 work AS IT LANDS (read their WIP files, verify their claims, catch share-blind gaps before FIX-PROPOSED becomes ledger).
2. **Agent integration cell-runner** for the small set of cells T4 owns directly (SessionEnd hook fires, settings.json wiring stability, multi-agent adapter registry, cross-agent STATUS.md merger).

This sprint runs in Mode A (overnight autonomous) OR Mode B (interactive morning). Same brief either way; only orchestrator's monitoring posture differs.

## Approval mode (MANDATORY for this lane — set BEFORE step 1)

Before doing ANY tool call, set your approval mode to **`auto-review`**. NOT prompt-on-every-tool — that mode caused 5+ minute stalls in Sprint 51.5b and broke the demo flow. The auto-review mode is the canonical 3+1+1 auditor mode canonized 2026-05-04 ~16:00 ET.

`auto-review` = act on read-only ops without prompting; pause for confirmation on destructive ops (rm, force-push, drop). Use `/approvals` or your CLI's approval-mode command to set this BEFORE step 1 below. **If you don't, the sprint stalls overnight — Joshua won't be at the keyboard to click prompts.**

Mandate canonized in cross-project memory `3+1+1 hardening rule candidate (Sprint 51.5b learning 2026-05-04)`.

## Boot sequence

1. `date '+%Y-%m-%d %H:%M ET'`
2. memory recall (your CLI's equivalent): query "Sprint 55 multi-lane full stack sweep full surface area Codex auditor"
3. memory recall: query "3+1+1 hardening rules checkpoint compaction discipline post shape Codex auto-review approval mode"
4. memory recall: query "Sprint 53 Sprint 54 picker rewrite synthesis bug rumen 0.5.2 relate.ts memory_hybrid_search"
5. memory recall: query "petvetbid externally facing scrub feedback codename" — confirm codename rule applies
6. Read `~/.claude/CLAUDE.md` (global rules — same as Claude lanes follow)
7. Read `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (project router)
8. Read `docs/sprint-55-full-stack-sweep/PLANNING.md` (sprint scope, Lane T4 section)
9. Read `docs/sprint-55-full-stack-sweep/STATUS.md`
10. Read all 3 worker briefs: `T1-install-sweep.md`, `T2-api-ui-sweep.md`, `T3-backend-sweep.md` — know what each lane is supposed to deliver so you can audit against contract.
11. Read `docs/INSTALLER-PITFALLS.md` ledger entries #16-#21 — context for what failure classes to expect.

## Lane focus — adversarial review + own cells

### Adversarial review (~70% of your effort)

Per Sprint 53's pattern (canonical 3+1+1):
- **Independent reproduction:** when T1/T2/T3 post a FINDING, re-run the same probe (or a variant) and confirm/refute.
- **Audit code BEFORE FIX-LANDED:** read T1/T2/T3 WIP files (T1-SWEEP-CELLS.md, T2-SWEEP-CELLS.md, T3-SWEEP-CELLS.md, plus any FIX-PROPOSED diffs) and flag issues before they become ledger entries.
- **Surface share-blind gaps:** all 3 workers are Claude — they share training, may make the same wrong assumption. You're Codex. Be skeptical of any claim that "looks right" because workers all agreed.
- **Validate ledger candidates:** when a worker proposes a new Class letter, verify the failure pattern is genuinely novel vs. fitting an existing class.

### Own cells (~30% of your effort)

Per PLANNING.md Lane T4 section. Cells:
1. SessionEnd hook fires from a Claude Code session — verify memory_sessions row + memory_items session_summary row written
2. SessionEnd hook fires from a Codex CLI session — does it write? Probably NO; document the gap if so
3. SessionEnd hook handles malformed/empty session content gracefully
4. ~/.claude/settings.json wiring stays intact across init --mnestra re-runs
5. ~/.claude.json mcpServers entry preserved across init --rumen
6. Multi-agent adapter registry — verify Claude / Codex / Gemini / Grok adapter exports
7. Cross-agent STATUS.md merger (Sprint 47 T4) — does it parse all 4 lane shapes uniformly?
8. Agent costBand declarations — ready for Sprint 56 cost-monitoring panel work

Output to `docs/sprint-55-full-stack-sweep/T4-SWEEP-CELLS.md` (NEW).

## Phase plan

- **Phase A (00:00-00:10):** Boot sequence complete. Approval mode confirmed = auto-review. Substrate verified independently (npm view all 4 packages, git log -1 each repo, psql probe of rumen_insights count). Post `### [T4-CODEX] CHECKPOINT phase A complete; approval mode = auto-review; substrate verified`.
- **Phase B (00:10-00:30):** Pre-emptive review of T1/T2/T3 lane briefs themselves — flag any contract bugs the orchestrator (Claude) may have authored. Sprint 53 had 5 catches in this phase alone.
- **Phase C (00:30-90:00):** Audit per FIX-PROPOSED as workers land them. Run own cells 1-8 in parallel.
- **Phase D (90:00-end):** Sprint-close audit. Verify all 4 SWEEP-CELLS.md files exist + are well-formed. Post final `### [T4-CODEX] DONE — Sprint 55 ACCEPT|REOPEN`.

## Lane discipline

- **Post shape:** `### [T4-CODEX] STATUS-VERB 2026-05-04 HH:MM ET — <gist>` in shared STATUS.md. The `### ` prefix and `[T4-CODEX]` tag are MANDATORY.
- **CHECKPOINT mandate:** every phase boundary + every 15 min of active work. STATUS.md is the durable substrate; on compact, self-orient from your most recent CHECKPOINT.
- **No version bumps. No CHANGELOG edits. No commits.** You're the auditor; you don't ship code.
- **READ-ONLY-ONLY for overnight (Mode A):** same as worker lanes.
- **Codename scrub:** never reference the internal Supabase project codename in posts.

## When you're done

Phase D — `### [T4-CODEX] DONE — Sprint 55 <ACCEPT|REOPEN>` with full evidence dump:
- All 4 SWEEP-CELLS.md files exist, well-formed, cell counts noted
- T4's own cells exercised + status
- Cross-cutting findings (= bugs that span T1/T2/T3 lanes)
- Final ledger candidates (Class letter assignments)
- Honest read on Sprint 55 acceptance: GREEN POST | YELLOW POST | RED defer

Begin.
