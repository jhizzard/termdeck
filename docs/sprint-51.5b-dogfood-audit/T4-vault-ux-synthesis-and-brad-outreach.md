# Sprint 51.5b — T4 (Claude): Vault UX dogfood + cross-project synthesis + Brad outreach prep

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T4):**

Verify Sprint 51.5 T3's wizard text pivot from "click Vault in dashboard" to SQL-Editor deeplinks works in active wizard surface. Synthesize T1-T3's findings into either an `INSTALLER-PITFALLS.md` ledger #15 entry (if a new failure class surfaces) or a "v1.0.1 dogfood — clean" close-out note. Draft a WhatsApp-ready message for Brad summarizing what Joshua found on his own box. **Audit-only.**

## Sequence

### 1. Wizard text audit

```bash
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck

# Find any remaining "click Vault" text in active wizard surface
git grep -in "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/

# Expected:
# - Zero hits in packages/ (active wizard surface)
# - Some hits in docs/INSTALLER-PITFALLS.md (incident-history commentary; intentional)
# - Some hits in docs/sprint-51.5*/ planning docs (sprint history; intentional)
```

If any active wizard surface (anything under `packages/`) still says "click Vault", T3-Sprint-51.5's pivot is incomplete — that becomes a Sprint 51.6 hotfix item.

### 2. Click-through SQL-Editor deeplinks

For every deeplink the wizard emits (preconditions.js audit hint, init-rumen.js printNextSteps, GETTING-STARTED.md), open the URL in a browser and confirm:

- The URL opens Supabase SQL Editor for the correct project.
- The `content` query param decodes to a valid `select vault.create_secret(...)` call.
- Single-quote escaping in the value works (the helper escapes `'` to `''` per Postgres convention).

Document any URL that fails to open or pre-fills incorrectly.

### 3. Synthesize T1-T3 findings

Wait for T1, T2, T3 to post DONE in STATUS.md. Read each FINDING + DONE post. Categorize each finding as one of:

- **Green / expected behavior.** v1.0.1 worked as designed. No action needed.
- **Cosmetic / known.** e.g., the `evalAllZeros` `=0=0` renderer glitch T2 flagged in Sprint 51.5; deferred to v1.0.2 polish.
- **New failure mode.** Doesn't fit Classes A-J. Append a new ledger entry #15 to `docs/INSTALLER-PITFALLS.md` (and a new Class K row in the taxonomy if the failure mode is broad enough to warrant one).
- **v1.0.1 regression.** Existing failure class but v1.0.1 didn't catch it. Bump to Sprint 51.6 / v1.0.2 hotfix scope.

Most likely outcome (given Sprint 51.5's care): a few green + 1-2 cosmetic + 0 new failure modes + 0 regressions. If that's the case, write a "v1.0.1 dogfood — clean" close-out note in STATUS.md instead of a ledger entry.

### 4. Brad WhatsApp outreach draft

Draft a one-paragraph WhatsApp message for Brad summarizing what Joshua found. Tone: transparent, brief, factual. Two templates depending on outcome:

**Template A — all green:**

```
v1.0.1 dogfooded clean on my own box. Audit-upgrade caught a Class A drift on petvetbid (memory_items.source_agent column missing despite the migration file shipping — same pattern as your jizzard-brain bug, just on my side). Audit-upgrade applied mig 015 cleanly. mnestra doctor correctly flagged the cron-all-zeros symptom that hid the gap for 2 days. Per-secret CLI loop, vault.create_secret auto-apply, SQL-Editor deeplink — all working end-to-end. v1.0.1 is the structural fix you asked for. Re-run termdeck init --rumen on jizzard-brain when you have a sec and tell me what audit-upgrade reports.
```

**Template B — found a regression:**

```
v1.0.1 dogfood pass surfaced a regression on my box: <one-sentence summary of the regression>. Sprint 51.6 hotfix in flight. I'll send v1.0.2 link when it lands. Don't run termdeck init --rumen on jizzard-brain until then unless you want to be the first to test the hotfix.
```

Customize with the actual findings. Joshua sends via the wa.me deep-link inject pattern (per global CLAUDE.md mandate; never copy-paste).

### 5. STATUS.md final close-out post

After T1, T2, T3 are all DONE and T4's synthesis is complete, append a final orchestrator-style close post to STATUS.md:

```markdown
### [ORCHESTRATOR] CLOSE — 2026-05-XX HH:MM ET — Sprint 51.5b dogfood audit complete

All four lanes DONE.

T1 verdict: <PASS | FAIL — one-line reason>
T2 verdict: <PASS | FAIL — one-line reason>
T3 verdict: <PASS | FAIL — one-line reason>
T4 verdict: <PASS | FAIL — one-line reason>

Overall: <v1.0.1 is dogfood-clean | Sprint 51.6 / v1.0.2 hotfix triggered for: ...>

Brad WhatsApp message <sent | drafted ready to send>.

If all PASS: Sprint 52 (cost-monitoring panel) and Sprint 24 (Maestro SaaS readiness) are unblocked. Pick whichever is more pressing for the next inject.

If any FAIL: Sprint 51.6 PLANNING.md authored at docs/sprint-51.6-<name>/PLANNING.md before any feature work proceeds.
```

## Acceptance criteria

1. **Wizard text audit clean.** `git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/` returns zero hits.
2. **All SQL-Editor deeplinks open correctly.** Manual click-through verifies each URL.
3. **T1-T3 synthesis complete.** Each finding categorized. Ledger entry #15 written if any new failure surfaces; close-out note written if all clean.
4. **Brad WhatsApp draft ready.** Template chosen + customized; Joshua sends via wa.me inject.
5. **STATUS.md final close-out post landed.**

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5b dogfood T4 Vault SQL-Editor URL wizard text Brad WhatsApp outreach synthesis ledger entry")
3. memory_recall(query="WhatsApp inject deep-link wa.me pattern Brad notification")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (Class B for the Vault path-mismatch context)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/PLANNING.md + STATUS.md
8. Read this brief
9. Wait for T1, T2, T3 to post DONE in STATUS.md before running step 3 (synthesis).
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/preconditions.js (verify Vault hint pivoted) + packages/cli/src/init-rumen.js (verify printNextSteps pivoted) + docs/GETTING-STARTED.md (verify line 257 pivoted)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. **Audit-only — no code edits, no commits.**

T4 is the merge-last lane: do NOT post the orchestrator close-out post until T1, T2, T3 are all DONE.
