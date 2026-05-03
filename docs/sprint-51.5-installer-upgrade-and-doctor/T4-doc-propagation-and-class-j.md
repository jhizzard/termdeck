# Sprint 51.5 — T4 (Claude): Doc propagation + new failure Class J + checklist item #11

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T4; canonical reference in [docs/INSTALLER-PITFALLS.md](../INSTALLER-PITFALLS.md) § Failure-class taxonomy):**

Meta-lane that ensures the synthesis stays load-bearing across all four agents. Addresses **all classes** by making the canonical reference reachable from every agent runtime. **Introduces NEW Class J** (Multi-arg CLI parse drift / multi-line clipboard shred) — Brad's 2026-05-03 takeaways #3 + #4 fold together as a single failure mode rooted in "assume one-keystroke / one-invocation atomicity at every wizard handoff."

The orchestrator already drafted ledger entry #14, Class J in the taxonomy table, and pre-ship checklist item #11 in `docs/INSTALLER-PITFALLS.md` 2026-05-03. T4 verifies propagation and adds the snippets that other lanes need.

## Files

- EDIT `CLAUDE.md` (TermDeck root) — confirm the read-order table still routes installer/wizard/migration-runner/bundled-hook work to `docs/INSTALLER-PITFALLS.md`. (It does as of Sprint 51 close, but verify: `grep -A3 "Touch the installer" CLAUDE.md` should mention INSTALLER-PITFALLS.md.) No edit needed if already pointed correctly; if the file structure has shifted, refresh the row.
- Run `npm run sync:agents` and verify it produces a clean diff (or no diff if already synced). The sync writes `AGENTS.md` (Codex + Grok) and `GEMINI.md` from the canonical CLAUDE.md.
- EDIT `docs/AGENT-RUNTIMES.md` § 6 — add `docs/INSTALLER-PITFALLS.md` to the "How to add a new agent" pre-flight read list. Rationale: agent-adapter work that touches the bundled hook, settings, or anything Class-E-shaped (private-path dependencies) should consult INSTALLER-PITFALLS.md before merging.
- Confirm Mnestra memory has surface-able entries for the canonical doc:
  - `memory_recall(query="installer pitfalls")` from a fresh Claude session in any project should surface the canonical-doc memory entry within the top 3.
  - `memory_recall(query="multi-arg CLI parse drift")` should surface the new Class J entry.
  - If either is missing, add via `memory_remember(category="architecture", source_type="reference", text="<one-paragraph pointer to docs/INSTALLER-PITFALLS.md>", project=null)` (project=null for global so it surfaces cross-project).
- Optional: add a one-line snippet to the lane-brief boilerplate template that Sprint 51 T3 introduced (if it exists at `docs/templates/sprint-lane-brief.md` or similar — grep first): "Before installer-adjacent work, read `docs/INSTALLER-PITFALLS.md`."

## Verification gates

```bash
# 1. CLAUDE.md routes to INSTALLER-PITFALLS.md.
grep -B1 -A1 "INSTALLER-PITFALLS" CLAUDE.md
# Expect: at least one row in the read-order table mentioning the doc.

# 2. Sync agents — should be a no-op.
npm run sync:agents
git status -- AGENTS.md GEMINI.md
# Expect: clean (no diff).

# 3. Cross-doc reachability — minimum 4 hits across docs.
git grep -l INSTALLER-PITFALLS docs/ CLAUDE.md AGENTS.md GEMINI.md
# Expect: at least 4 files.

# 4. Mnestra memory probe.
mnestra recall "installer pitfalls"
# Expect: top 3 results include the canonical-doc reference memory.

# 5. Class J ledger entry exists.
grep -c "Class \*\*J\*\*" docs/INSTALLER-PITFALLS.md
# Expect: >= 2 (one in checklist item #11, one in the taxonomy table, one in ledger #14 fix area).

# 6. Pre-ship checklist has 11 items.
grep -c "^[0-9]\+\\. " docs/INSTALLER-PITFALLS.md | head -1
# Expect: 11 numbered items in the checklist section.
```

## Ledger entry #14 — verification only

The orchestrator drafted entry #14 in `docs/INSTALLER-PITFALLS.md` 2026-05-03. T4 verifies it captures all 5 of Brad's takeaways:

1. ✓ Edge Function `DATABASE_URL` lacks `SUPABASE_DB_URL` fallback (T1 owns the fix).
2. ✓ Vault dashboard panel removed/relocated (T3 owns the SQL-Editor URL pivot).
3. ✓ `supabase secrets set` v2.90.0 multi-arg unreliable (T3 owns per-secret refactor) → Class J.
4. ✓ Clipboard `\r\n` shred on multi-line `!` pastes (T4 codifies into Class J + checklist #11).
5. ✓ Class-A drift root cause confirmed identical on `jizzard-brain` (T1 audit-upgrade primary scope) + Rumen 002 templating bonus (T1 mirrors the templating call in audit-upgrade applier).

If any takeaway is missing or under-described, edit the ledger entry to fill the gap. Don't refactor the entry — append.

## Acceptance criteria

1. **`npm run sync:agents` is a no-op** (or produces a clean diff that's purely the new Sprint 51.5 lane brief metadata if any auto-sync touches sprint planning files — confirm in FINDING).
2. **`git grep INSTALLER-PITFALLS` in TermDeck shows ≥4 hits** across the doc itself + CLAUDE.md + Sprint 51 PLANNING.md + Sprint 51.5 PLANNING.md (4 minimum; more is fine).
3. **`memory_recall(query="installer pitfalls")` from a fresh Claude session** surfaces the canonical-doc memory entry within the top 3 results.
4. **Class J taxonomy + ledger #14 + checklist item #11** all present in `docs/INSTALLER-PITFALLS.md` and consistent (Class J in all three references; no leftover "Class K" typos from the orchestrator's initial draft — confirm with `grep -c "Class K" docs/INSTALLER-PITFALLS.md` returns 0).
5. **`docs/AGENT-RUNTIMES.md` § 6** lists `docs/INSTALLER-PITFALLS.md` in the new-agent pre-flight read list.
6. **No regressions.** Sprint 50's 428/428 tests stay green. The doc-only changes don't touch any code-path.

## Coordination

- **T4 is independent of T1, T2, T3** — purely doc + memory work.
- **T4 is the last lane to land before sprint close** — orchestrator likely merges T4 last so the doc references stay accurate even if T1/T2/T3 land changes that affect what the canonical reference says (e.g., if T1 ships the audit-upgrade and the ledger entry #14 fix-area should reference the actual landed file path).

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5 doc propagation INSTALLER-PITFALLS Class J multi-arg CLI parse drift checklist item 11")
3. memory_recall(query="installer pitfalls canonical doc cross-project reference")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (your subject)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md
9. Read this brief
10. Run the verification gates (the bash block above) and document each result in your FINDING post.
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md (especially § 6).
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/scripts/sync-agent-instructions.js (so you understand what `npm run sync:agents` does).
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
