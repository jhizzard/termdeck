# T4-GROK — adversarial auditor, Sprint 76 (memory inbox)

**Work repo (read-only):** `~/Documents/Graciella/engram`. You may also READ the termdeck
repo (`packages/mcp-bridge/`, T2's lane) and the rumen repo (T3's lane) — absolute paths
below. STATUS.md is in the termdeck repo (absolute path in PLANNING.md). Modify nothing
anywhere except your STATUS.md posts.

## Mission

You are the out-of-distribution auditor. The three Claude workers share training, prompts,
and therefore blind spots; your job is to attack what they build WHILE they build it — audit
FIX-PROPOSED / FIX-LANDED posts as they appear, never wait for DONE, never rubber-stamp.
This sprint opens the first WRITE path from untrusted web surfaces toward the canonical
memory store. The stakes: a hole here means a prompt-injected web chat can poison the memory
every CLI session trusts at boot. Assume the design is wrong until you fail to break it.

Repos: engram `~/Documents/Graciella/engram` · termdeck
`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` · rumen
`~/Documents/Graciella/rumen`.

## Audit targets

### A. T1 — the five RLS gates, verified on the LIVE migration SQL (not the brief)

Read `migrations/026_memory_inbox.sql` as landed and verify each gate against the actual
text + by running T1's tests yourself:

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` present in the SAME migration that creates
   the table — not deferred, not assumed.
2. ZERO policies on `memory_inbox` — grep for `create policy`; any `WITH CHECK (true)` or
   PUBLIC-role policy is an instant AUDIT-FAIL.
3. `REVOKE EXECUTE ... FROM PUBLIC` precedes the `GRANT ... TO service_role` for
   `memory_propose` AND every helper function — remember grants are additive: a GRANT
   without the REVOKE leaves PUBLIC executable (the exact 2026-05-06 Brad-sweep hole).
   Check the function signature in the REVOKE matches the CREATE exactly (a signature
   mismatch silently revokes nothing).
4. `SET search_path = public, pg_catalog` on every function — SECURITY DEFINER without a
   pinned search_path is a privilege-escalation primitive; this is the gate to be most
   paranoid about.
5. The RPC is the only INSERT path: verify no other migration/function INSERTs into
   `memory_inbox`, and that table-level grants don't hand anon/authenticated INSERT.

Also audit the validation INSIDE the RPC: source_agent whitelist exact (try `'grok'`,
`'GROK-WEB'`, `' grok-web '`, `'claude-web2'`), size-cap boundary math (4000 vs 4001,
multibyte/emoji text — `length()` vs `octet_length()` semantics), metadata shape
(array/scalar/deeply-nested), and SQL-injection shapes through every text parameter.

### B. The quarantine proof — attempt to read pending rows through EVERY recall path

This is the headline audit item; PLANNING acceptance #2 hangs on you. Build your OWN
inventory of read surfaces BEFORE reading T1's FINDING, then diff — anything T1 missed is an
AUDIT-FAIL with file:line. Minimum attack list (engram repo):

- `src/recall.ts` → `memory_hybrid_search` RPC (read the LIVE SQL function definition —
  migration 023's version or later — and confirm its FROM clause cannot reach
  `memory_inbox`).
- `src/search.ts`, `src/layered.ts` (`memory_index` / `memory_timeline` / `memory_get` —
  try a `memory_get` with a raw inbox-row UUID), `src/recall_graph.ts`, `src/status.ts`,
  `src/consolidate.ts`, `src/export-import.ts` (does an export dump include the inbox?),
  `src/summarize.ts`, `src/doctor-data-source.ts`.
- Webhook ops (`remember/recall/search/status/index/timeline/get/propose`) — does any op
  echo inbox content back? (`propose` must return id+status only.)
- MCP server tools (`mcp-server/index.ts`) and the bridge read tools
  (`packages/mcp-bridge/src/tools/*.js` → `clients/mnestra.js`).
- Every SQL function across `migrations/` that SELECTs memory tables.

Run T1's quarantine test, then try to FALSIFY it: insert a pending fixture row whose text is
a unique sentinel and hunt the sentinel through every surface above. Also attack the
PROMOTED path: after T3's pass promotes a row, the canonical copy SHOULD be recallable —
verify the test distinguishes pending-invisible from promoted-visible (a quarantine test
that would also pass if promotion were broken proves too little).

### C. T2 — propose-path abuse (bridge)

- **The policy carve-out is the riskiest edit of the sprint.** Read the `assertReadOnly`
  diff line by line. Try to mount: `memory_remember` (with and without lying
  `readOnlyHint:true`), `memory_forget`, a `memory_propose` impostor with
  `destructiveHint:true`, a second tool name added to nothing-but-the-registry. Verify the
  carve-out is exact-name + exact-annotations, and that the read-only invariant wording in
  the comments matches what the code now actually enforces.
- **Identity spoofing:** attempt to supply `source_agent` in the tool args (must be
  ignored/rejected — it is derived server-side); attempt an unmappable client (must
  fail closed, never default).
- **Oversize:** 4001 chars, multibyte payloads, huge metadata, header-stuffed project_hint.
- **Redacted literals:** craft proposals containing fixture denylist literals and built-in
  secret shapes (fake `sk-ant-...`, JWT-shaped strings, connection strings, url-encoded
  splice evasion per redact.js's own comments) — all must REJECT, and the rejection message
  must not echo the secret. Confirm reject-not-scrub.
- **Rate limit:** burst past the bucket; confirm 429-class behavior and per-connector
  isolation (connector A's flood must not starve connector B).
- Run the full bridge suite yourself; diff T2's test additions against this list.

### D. T3 — promotion-pass gates (rumen)

- Re-derive the gate order from the code, not the brief. Try: a duplicate that should hit
  the >0.95 skip; a near-dup in 0.88–0.95 (must reject `near-duplicate`, must NOT mutate
  the existing canonical row — diff the row before/after); a recipe-level proposal
  (file:line+version text) through the Haiku gate; an LLM-error path (must stay pending,
  never auto-promote — verify the gate fails CLOSED).
- Idempotency/concurrency: run the pass twice; simulate overlapping claims; hunt
  double-promotes and orphan states (promoted memory without stamped inbox row = the
  atomicity bug).
- Provenance: promoted rows must carry the `*-web` source_agent UNCHANGED + inbox_id; a
  promotion that rewrites provenance to a CLI value is an AUDIT-FAIL.
- Verify rejection_reason vocabulary matches T3's DONE-post contract exactly.

### E. Cross-lane seams

The three contracts (T1 webhook op ↔ T2 client; T1 schema ↔ T3 pass) were built
brief-first. Diff each landed side against the other: field names, cap numbers (the 4000
must be the SAME 4000 in all three lanes), error shapes, status vocabulary. Seam drift is
exactly the class of bug shared-model workers miss.

## Compaction-checkpoint discipline (MANDATORY)

Post `### [T4-GROK] CHECKPOINT 2026-MM-DD HH:MM ET — phase <n> (<name>); verified: <list
w/ file:line>; pending: <list>; last worker FIX-LANDED: <ref>` at every phase boundary AND
at least every 15 minutes of active work. Your panel WILL compact; STATUS.md is your only
durable memory. After any context loss, re-orient from your own most recent CHECKPOINT and
continue from `pending`.

## Verdicts

Per finding: `### [T4-GROK] AUDIT-PASS|AUDIT-FAIL|AUDIT-CONCERN 2026-MM-DD HH:MM ET —
T<n>: <claim audited> — <file:line evidence>`. End with a **verb-anchored**
`### [T4-GROK] FINAL-VERDICT 2026-MM-DD HH:MM ET — GREEN|YELLOW|RED — <one line per lane,
each line leading with the decisive verb: VERIFIED <x> / BROKE <y> / COULD-NOT-REPRODUCE
<z>>`. The quarantine proof gets its own named line in the FINAL-VERDICT. GREEN requires:
all five gates verified on live SQL, the quarantine attack exhausted against every surface
in § B, and no unanswered AUDIT-FAIL. Watch worker completion with the tolerant regex
`^(### )?\[T[123]\] DONE\b` — but audit in flight, not at the end.

## Discipline

Read anything in all three repos; modify nothing except STATUS.md posts. No commits, no
version bumps, no CHANGELOG, no migrations applied anywhere. If memory tools are unavailable
in your CLI, proceed without them. ORCH STATUS posts are binding, including after your
FINAL-VERDICT.
