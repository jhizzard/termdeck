# RESTART — 2026-06-12 — Publishes PENDING (npm login), Sprints 75/76 staged-by-spec

**You are picking up at:** Sprints 73+74 fully merged to main, ALL field work done
(migrations applied, hooks refreshed, 557-row backfill complete, #12 answered, Brad
updated) — but **npm publishes are PENDING on Josh's login**, and main currently
claims versions that are not on npm yet. Fix that FIRST.

---

## 1. Boot sequence

1. `memory_recall(project="termdeck", query="2026-06-12 close-out publish pending backfill 557 sprint 75 76")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`, then `./CLAUDE.md`, then THIS doc, then `docs/RELEASE.md`.
4. Begin at § 2 — nothing else happens before the publishes.

## 2. ⚠️ FIRST ACTION — the publish wave (BLOCKED on Josh's npm login)

**Skew warning:** `origin/main` in BOTH repos already carries the version bumps
(termdeck 1.9.0 / stack 1.8.2 via PR #24; mnestra 0.5.0 via mnestra#21) but npm
still serves 1.8.1 / 0.4.9. RELEASE.md's "never let main lie about npm" rule is
currently violated in the safe direction (merged-not-published). Close it:

1. Josh: `npm login --auth-type=web` (browser + Passkey). Verify `npm whoami`.
   (2026-06-12 morning: stale token caused PUT 404 on publish; a backgrounded
   login died at the interactive prompt — login must run interactively, `!`-prefix
   in the Claude Code prompt works.)
2. termdeck repo, main, clean tree (rumen functions already synced + pack verified
   2026-06-12 ~10:40 ET — supervise assets, both rumen fns, transcript SQL all in
   tarball): `npm publish --auth-type=web` (root) → `cd packages/stack-installer
   && npm publish --auth-type=web`.
3. engram repo, main: `npm publish --auth-type=web` (publishes @jhizzard/mnestra@0.5.0).
4. Tags: `git tag v1.9.0 && git push origin v1.9.0` (termdeck), `git tag v0.5.0 &&
   git push origin v0.5.0` (engram). KNOWN ISSUE: pre-push gitleaks sometimes scans
   the full historic range on tag pushes and blocks (Sprint 65/66 precedent) — if it
   does, the tag stays local; do NOT bypass; note it and move on.
5. Optional post-publish: `npm i -g @jhizzard/termdeck@1.9.0` on this machine
   (installed hooks were already refreshed from the repo on 06-12, so this is for
   CLI/server parity, not hooks).

## 3. What is ALREADY DONE today (2026-06-12, do not redo)

- PR #24 (termdeck) + #21 (mnestra) MERGED ~10:28 ET; #23 + #20 auto-closed (their
  commits ride along). Dependabot PRs remain open (both repos) — fold into a future
  deps pass.
- Migrations **023 (privacy_tags)** + **025 (web source_agents)** applied to the
  daily-driver Supabase project via MCP, hygiene VERIFIED post-apply (anon EXECUTE
  revoked, service_role granted, search_path = public, extensions, pg_catalog;
  privacy_tags column + GIN index present).
- Installed hooks refreshed: `~/.claude/hooks/memory-session-end.js` = v5,
  `memory-pre-compact.js` = v2 (both embed 3-large@1536).
- **Re-embed backfill EXECUTED LIVE: 557/557 rows, 0 failures, 23 batches** (dry-run
  first; marker `metadata.embedding_model='text-embedding-3-large@1536'`). The
  545→557 overnight drift confirmed the hooks-first ordering rule.
- #12 public reply posted: https://github.com/jhizzard/termdeck/issues/12#issuecomment-4692819638
- Brad WhatsApp update sent (all 4 gates: no-staleness verdict, IPv4 inventory,
  privacy_tags applied, #12 fix; + R730 upgrade heads-up re hooks v5/v2 + backfill
  runbook `engram/docs/runbooks/2026-06-11-reembed-hook-rows.md`).
- Windows: deferred, demand-gated (audit + ranked items in Mnestra). FB reply text
  is drafted in the 06-11 session transcript — Josh pastes manually.

## 4. Sprint 75 — Bridge wave (next sprint; single deck, 3+1+1, ~90 min)

Stage in `docs/sprint-75-bridge-wave/`. Repo: termdeck (T1/T2/T4); T3 touches docs/infra.

- **T1 — static-OAuth client registration in `packages/mcp-bridge`.** Goal: Gemini
  Enterprise custom MCP connector (preview) can register: it requires client_id/
  client_secret + auth/token URLs (STATIC registration) alongside the existing
  OAuth 2.1 DCR/PKCE path (auth core: `packages/mcp-bridge/src/auth.js` — hand-rolled
  HS256 JWTs, stateless access tokens, hashed refresh rotation, state file
  `~/.termdeck/bridge-auth.json`). Static client = pre-seeded entry in the clients
  store + secret verification at the token endpoint. Pair with Josh buying ONE
  Gemini Enterprise Standard seat ($35 m2m; the $21 Business edition lacks custom MCP).
- **T2 — DATABASE_URL ingress classify+warn (termdeck side).** Execute S74-T2's
  blind-executable `CARRY-OVER-SPEC` post (Sprint 74 STATUS.md, 20:45 ET): part B
  (classify+warn at every ingress) + part C (doctor/preflight surfacing); part A
  (prompt copy) may already be done — verify. Reuse mnestra's `src/db-endpoint.ts`
  classifier semantics.
- **T3 — cloud third bridge origin (fail-safe).** Provision a small VPS (~$5/mo,
  Josh authorizes the spend), run mcp-bridge + cloudflared (own named tunnel
  `termdeck-bridge-cloud`), share `bridge-auth.json`, add as Cloudflare LB pool 3
  (imac → air → cloud; monitor /healthz; design + per-machine-tunnel doctrine in
  Mnestra "BRIDGE HIGH-AVAILABILITY DESIGN" + AIR-SETUP.html Part 3). Flag:
  memory-tools-only on the cloud origin (no panels); consider a bridge flag to
  disable terminal-state tools there. ALSO note AIR-SETUP Part 3 (Air-side tunnel +
  LB) itself is NOT yet executed — fold the LB creation into this lane.
- **T4 — auditor (Codex or Grok).** Standard adversarial brief + CHECKPOINT
  discipline + the 06-11 lessons: wake-signals at every queue transition; verb-
  anchored regexes; RED ≠ parked.
- **Also fold in:** installer literal-`~` absolute-path fix (stack-installer writes
  `node ~/.claude/hooks/...` into settings.json — latent all-platform bug, Windows
  audit item 4; INSTALLER-PITFALLS review applies).

## 5. Sprint 76 — Memory inbox (after 75; engram repo + bridge tool)

Design is ADOPTED and fully spec'd: Mnestra memory "EXPLORATION DECISIONS
2026-06-11" + `docs/RESTART-PROMPT-2026-06-11-gemini-ha-windows-and-sprint-path.md`
§ 2b. Prereqs ALL SHIPPED: four `*-web` enum values (migration 025), webhook
source_agent threading, layered-schema awareness. Lanes: T1 `memory_inbox` table +
SECURITY DEFINER RPC (five RLS gates); T2 bridge `memory_propose` tool (web
connectors only; canonical `memory_remember` stays CLI-only; pending rows EXCLUDED
from recall); T3 Rumen promotion pass (dedup, kitchen-vs-recipe, redaction literals,
size/rate caps, rejection_reason audit trail); T4 auditor.

## 6. Standing items (not sprint-shaped)

- Josh: Gemini Enterprise seat; FB Windows reply paste; cloud-VPS green-light
  (pre-authorized up to ~$20/mo on 06-11); Brad on-prem spike yes/no; iMac Energy
  settings + auto-login decision (fail-safe tier 1).
- Dependabot PRs both repos. mnestra #15/#20 privacy design answers (4) — now have
  a live consumer (privacy_tags shipped; Brad's pka next).
- Repo debris: untracked `2026-05-09-*.txt` + `rollout-*.md` at termdeck root —
  review/delete. engram untracked: `docs/sprint-privacy-tags/` briefs + migration
  024 (email-assistant, separate initiative) — leave for their owners.

## 7. Resume the 2026-06-11/12 orchestrator session

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume d4928bf9-ee86-40bf-bce8-3a7135eec12a
```
