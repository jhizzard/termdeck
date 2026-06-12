# RESTART — 2026-06-09 — Hardening (render-watchdog + crash-guard + supervisor) + Brad feedback

**You are picking up at:** 4 hardening items shipped but **UNCOMMITTED** on branch
`hardening/s71-72-followups`, 3 inbound web-chat MCP connectors live and proven, and
Brad's 3-fold feedback in the orchestrator's queue awaiting a fresh sprint.

---

## 1. Boot sequence (fresh orchestrator)

1. `memory_recall(project="termdeck", query="2026-06-09 hardening render-watchdog crash-guard supervisor bridge web connectors Brad feedback")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read THIS doc.
6. Then begin at § 2.

---

## 2. Current state — what shipped this session (2026-06-09)

### 2a. Bridge WEB connectors (INBOUND) — 3/3 live and proven

All three inbound web-chat MCP connectors are fully wired and proven end-to-end
(OAuth 2.1/PKCE + operator-secret consent; memory_recall round-trips confirmed):

- **Claude.ai** — proven in the prior session (2026-06-08). `memory_recall` returned
  24 memories end-to-end. One narrow residual deferred: live smoke of the
  approval-gated terminal-state tools (`list_panels` / `read_panel`) when panels are
  open — low-risk, test-covered server-side.
- **ChatGPT** — proven this session. Real UI is the **"New App" dialog**, NOT the
  "Developer Mode → Connectors" path that `connect-chatgpt.md` currently describes.
  `connect-chatgpt.md` is **stale and needs updating** (open follow-up #7 below).
  Round-trip latency: ~2.35s for `memory_recall`.
- **Grok web** — proven this session (grok.com Connectors → New → Custom). ~30
  sessions + a dozen tool calls accumulated. Grok web provenance is DEFERRED (see
  § 2d).

**Kitchen finding (memory written to Mnestra):** the bridge logs NO client identity.
Server-side there is no way to distinguish ChatGPT traffic from Claude vs Grok. This
is a deliberate MCP-spec gap (the transport layer carries no caller identity), not a
TermDeck bug — but it is a limitation to document and a future enhancement candidate.

**Custom-instructions snippet:** a reusable snippet was authored so each web chat
proactively calls `memory_recall` at session start. Gemini web has no MCP surface
(CLI-only — Gemini gets Mnestra on the outbound/local path via `~/.gemini/settings.json`).

**Bridge is EPHEMERAL:** the cloudflared quick-tunnel (`impose-imagine-widescreen-package.trycloudflare.com`)
and operator secret (`0cceb1a2a1c8a939`) are gone. Re-create them at next session via
the two-step pattern in `docs/RESTART-PROMPT-2026-06-08-bridge-web-connectors.md` § 2.

### 2b. Hardening items — SHIPPED, UNCOMMITTED on `hardening/s71-72-followups`

All 4 items are in the working tree, not yet committed. Orchestrator must commit + publish.

**Committed file set (`git status --porcelain`):**
```
 M packages/server/src/index.js
 M packages/server/tests/web-chat-seams.test.js
?? docs/SELF-HEALING.md
?? scripts/com.jhizzard.termdeck-supervise.plist
?? scripts/termdeck-supervise.sh
```

**Item 1 — Bridge allowlist visibility fix (config-only, no code change).**
The bridge default-deny allowlist was filtering out panels whose Mnestra row had
`project=None` or home `cwd` (Codex/Claude panels running outside the termdeck repo).
Fix: the bridge hot-reload allowlist file at `~/.termdeck/bridge-allowlist.json` was
set to `"*"` (wildcard pass-all). This is a config change — no code, no file in the
working tree. Auditor confirmed 1 → 3 visible panels after the fix.

**Item 2 — Render-watchdog (`packages/server/src/index.js`).**
`setupWebChatSession` now re-navigates if the page doesn't paint within ~8s (tunable
via `TERMDECK_WEBCHAT_RENDER_SETTLE_MS`=8000 / `TERMDECK_WEBCHAT_RENDER_ATTEMPTS`=2 /
`TERMDECK_WEBCHAT_RENDER_STEP_MS`=500), else degrades to `'errored'`. The recovery is a
full re-navigation (`handle.navigate(startUrl)` / `page.goto`, NOT `page.reload` — a
reload does NOT clear the Grok flaky-first-launch wedge), in the `ensureWebChatRendered()`
helper. Root: the Grok white-screen flakiness
was a cold-start wedge, NOT a CDN/chunk-blocking issue (that was a red herring —
Mnestra memory corrected). +2 regression tests; suite now 11/11 in
`packages/server/tests/web-chat-seams.test.js`.

**Item 3 — Server crash guard (`packages/server/src/index.js`).**
Fail-soft `unhandledRejection` + `uncaughtException` handlers added to the `main()`
startup block. Prevents a single bad panel or MCP call from taking down the whole
TermDeck server.

**Item 4 — Stack supervisor + SELF-HEALING.md.**
`scripts/termdeck-supervise.sh` — detect-by-port, adopts a running stack, writes
stable operator-secret + public-url state files to `~/.termdeck/`. Validated via
dry-run + a real server recovery. `scripts/com.jhizzard.termdeck-supervise.plist` —
launchd unit (operator-installed — Claude Code cannot install launchd agents directly).
`docs/SELF-HEALING.md` — operator run-book. The launchd plist goes to
`~/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist` and is activated with
`launchctl load -w`.

### 2c. Grok web-chat OUTBOUND panel — flakiness diagnosis

Root cause of the white-screen flakiness: cold-start wedge, not CDN blocking.
Isolation experiments: 5 fresh Chrome repros all rendered (blocked `cdn.grok.com`
chunks were a red herring — Mnestra memory corrected). A full `page.goto` clears the
wedge; a `page.reload` does NOT. The render-watchdog (Item 2) is the engineered fix.

### 2d. Deferred items (EXPLICITLY GATED — do not autonomously close)

- **#5 — Grok-web provenance.** Flip `web-chat-grok` `sourceAgent:'grok'` →
  `'grok-web'`; add `grok-web` to bundled hooks' `ALLOWED_SOURCE_AGENTS` + byte-floor
  exemption; bump hook stamps; refresh installed copy. **Why gated:** (a) bundled hooks
  ship in the published tarball → release-sensitive; (b) cross-repo — Mnestra
  `source_agents` enum must add `grok-web` (else filter-by-agent silently broken);
  (c) must ship atomically. Belongs in a deliberate hooks-release sprint.
- **#6 — Multi-provider outbound panels.** ChatGPT web panel + Claude web panel.
  Driven by Brad's incoming specs (see § 3).

---

## 3. Brad's 3-fold feedback → NEXT-SPRINT SCOPE (R730 v1.8.0 cutover + on-prem)

Source: 2 emails to `admin@nashvillechopin.org` from `bheath.tbhcoach@gmail.com`
("TermDeck v1.8.0 rollout — issues to close" 2026-06-08; "v1.8.0 / Mnestra switchover —
R730 gap map" 2026-06-09) + a WhatsApp paste (Brad, `+15127508576`). Brad is **holding
the v1.8.0 cutover** on the R730 until these clear. His fleet (3+1+1) is **standing by to
BUILD this sprint to a PR for Josh's review** — it needs a crisp scope + repo pointer
("work out the sprint need clearly to keep him in lane").

**R730 current state:** termdeck/stack **1.6.1**, mnestra **0.4.9**, rumen **0.5.3** — NOT
on 1.8.0. 2-port topology (master :3100 / 3 sub-orchs Aetheria·Structural360·pkachu :3200)
done on 1.6.1 but **sharing one `config.yaml` + session DB by convention**. Mnestra still on
the **`memory_items`** schema (~973 memories + pkachu's mirrored conversation corpus), NOT
the `mnestra_*` layered schema. Inbound bridge + outbound Grok panel **not set up** on the
R730 (proven on Josh's machine only). Runbook drafted by Brad at
`/home/nacho/RESTART-RUNBOOK-2026-06-08.md`.

**Sprint items (concrete):**
1. **Multi-instance isolation (TOP — the headline blocker).** termdeck CLI has NO
   `--data-dir`/`--config`/`--instance` flag → two instances collide on
   `~/.termdeck/config.yaml` + the session DB. Need real per-instance isolation (a flag
   OR `TERMDECK_HOME`/`TERMDECK_CONFIG` env; separate session DB; per-instance auth token;
   SHARED Mnestra :37778). **First task: verify whether 1.8.0 added this; if not, build it.**
2. **IPv4-only-host DB bug (real — audit our code).** The direct `db.<ref>.supabase.co`
   endpoint is IPv6-only; IPv4-only hosts (the R730) → PoolTimeout. Fix = the IPv4 pooler
   (`aws-1-…pooler.supabase.com`, user `postgres.<ref>`). **Brad warns the v1.8.0
   bridge/webhook will PoolTimeout on ANY IPv4-only host if it makes the same direct-
   endpoint assumption** → audit the Mnestra-webhook + bridge DB endpoint resolution.
3. **Flush-before-recall (bridge design).** Does the bridge commit + reindex pending
   auto-saved memory BEFORE serving a recall, or is there read-after-write staleness (the
   connector returns memory a sync-cycle behind)? Design/verify the bridge→Mnestra path.
4. **Egress denylist for Brad's org literals.** Populate his deployment's
   `~/.termdeck/bridge-redact.json` (now first-class config) with HIS org literals.
5. **Mnestra schema migration `memory_items` → `mnestra_*` (layered).** Part of the cutover
   or independent? Safe sequence to preserve the 973 + pkachu corpus — migrate / dual-write /
   start-fresh? (Mnestra/engram repo.)
6. **BIG NEW ASK — fully on-prem Mnestra + Rumen.** Self-hosted Supabase (Docker) on the R730
   incl. Rumen's edge function on the **local edge-runtime**, so memory + private/financial
   data lives on-prem (privacy + backup, motivated by Josh's data wipe). Deliver: feasibility
   + migration order + gotchas (pgvector in the self-hosted image, RLS parity, the memory
   webhook, edge-runtime parity, JWT/secrets, backups). Orch read: FEASIBLE (pgvector + RLS +
   edge-runtime all self-host; the IPv4 issue is moot on localhost). Brad's orch willing to
   scope + build.
7. **Cutover sequence + backups.** Recommended LINEAR step order (pull → build bridge →
   tunnel → connectors → Grok panel → schema), which steps need Josh vs self-contained, and a
   backup-first list of destructive/one-way ops (session DB, Mnestra Supabase, config).

**Already resolved (to convey to Brad):**
- **Gemini OAuth/test-users:** Gemini web has NO MCP connector surface → it is NOT a bridge
  connector → no custom Cloud OAuth app / test-user add needed. The Gemini CLI uses a normal
  Google login (Code Assist).
- **Connectors proven** (Josh's 2026-06-09 FYI): Claude.ai/ChatGPT/Grok all pull Mnestra;
  Grok opens in a TermDeck panel. ChatGPT UI = the "New App" dialog (`connect-chatgpt.md`
  stale → follow-up #3).
- **Brad's recommendation (agree):** do the **single-instance move to :3100 + v1.8.0 NOW**
  (clean, works today); add multi-instance as a fast-follow once item 1 lands.

**Resolved by the orchestrator (2026-06-09) — answers, not open questions:**
- **Multi-instance:** 1.8.0 did NOT add it. Config + session DB are hardcoded to
  `os.homedir()/.termdeck/` with NO `--data-dir`/`TERMDECK_CONFIG`/`TERMDECK_HOME` override
  (verified in `os-detect.js` + `init.js`). → Sprint item: add a `TERMDECK_DATA_DIR` (or
  `--data-dir`) that redirects ONLY config + session DB per instance, keeping `$HOME`/`.claude`/
  Mnestra shared + a per-instance auth token. Interim: Brad's share-by-convention is fine.
- **Schema migration:** INDEPENDENT of the v1.8.0 cutover — the bridge talks to Mnestra over the
  HTTP webhook (schema-agnostic), so Brad cuts over on the old `memory_items` schema and migrates
  to `mnestra_*` separately. Safe approach: pg_dump snapshot → backfill-migrate (never start-fresh
  on the 973 + pkachu corpus) → verify counts.
- **Cutover order:** back up (pg_dump Mnestra + snapshot session DB + config) → pull/build v1.8.0
  (incl. mcp-bridge) → single-instance move to :3100 → bridge (AFTER the IPv4-pooler + flush-before-
  recall checks; populate redact literals; named tunnel) → connectors → optional Grok panel →
  schema migration (independent) → multi-instance fast-follow.
- **On-prem self-host (the one genuine Josh call):** recommend GREEN-LIGHT a scoped 1–2 day SPIKE
  (Docker Supabase + pgvector + one migration + the webhook + one edge-fn invoke) before a full
  migration. Brad's orch runs the spike. Josh's only yes/no.

**4th Brad artifact (2026-06-09) — pkachu personal-assistant PWA proposal**
(`~/Documents/Graciella/ChopinNashville/SideHustles/pkachu-assistant-PROPOSAL.md`, 538 lines,
post grok inversion-QA, awaiting Brad's greenlight). NOT a TermDeck/Mnestra build — Brad's fleet
builds pkachu; it CONSUMES the TMR stack cleanly: Mnestra via the sanctioned RPC
(`memory_recall`/`memory_hybrid_search`, read-only, NOT raw SQL); gated on Leg-2 PR #29 (pkachu's
conversation-corpus mirror into `memory_items` `project='pkachu-conversations'`); respects
F2/F3/RLS. **The one pull on Josh:** its privacy routing (§3.2 / Open-Q §10.1 — "privacy-tagged
chunks force local") is a downstream consumer of **mnestra privacy_tags #15/#20** — gives Josh's
deferred 4 design answers a concrete consumer + raises priority. It is also the WHY behind Brad's
on-prem ask. (Doc carries Brad's Supabase ref — keep it out of any TermDeck repo.)

---

## 4. Open follow-ups (priority order for next orchestrator session)

1. **Commit + publish the 4 hardening items.** Orchestrator job: read `docs/RELEASE.md`
   FIRST, version bump, CHANGELOG entry, gitleaks scan, commit
   `hardening/s71-72-followups`, npm publish (Josh Passkey), push + tag.
2. **Brad's 3-fold feedback** — process after § 3 is filled by the orchestrator.
3. **`connect-chatgpt.md` doc fix.** The real UI is the **"New App" dialog**, not
   "Developer Mode → Connectors". Update to match the proven flow.
4. **Bridge live smoke — terminal-state tools.** `list_panels` / `read_panel` through
   Claude.ai with panels open (the one narrow residual from the 2026-06-08 acceptance
   test). Low-risk — needs a double-panel session.
5. **Named cloudflared tunnel** (stable hostname). Ephemeral tunnels break connectors on
   restart. Option A2 from `packages/mcp-bridge/docs/tunnel.md`.
6. **Grok-web provenance sprint** (deferred #5 — see § 2d).
7. **mnestra #15/#20** (privacy_tags) — Brad's 4 design answers still needed.
8. **PR #22 review → merge** (Josh). Branch `hardening/s71-72-followups`. After the
   hardening commit lands.
9. **agy language-server MCP wiring** (Antigravity `RefreshMcpServers` mechanism).
10. **orch/xterm input-accumulation audit** — promised Brad publicly on termdeck#12.

---

## 5. Resume THIS session (its accumulated mental model)

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume 5a3416fb-72bb-483b-baf2-15673f2546e4
```

(Session JSONL verified on disk: `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/5a3416fb-72bb-483b-baf2-15673f2546e4.jsonl`.)

---

## 6. Reference pointers

- **Prior restart prompt (bridge WEB connectors):**
  `docs/RESTART-PROMPT-2026-06-08-bridge-web-connectors.md` — bridge bring-up procedure,
  ChatGPT/Grok/Gemini wiring instructions, Deck A state.
- **Phase 1 / v1.8.0 handoff:**
  `docs/HANDOFF-2026-06-08-mcp-bridge-grok-panel.md`
- **Self-healing run-book:**
  `docs/SELF-HEALING.md` (new, untracked)
- **Release process (read before committing or publishing):**
  `docs/RELEASE.md`
- **Installer pitfalls (mandatory before touching bundled hooks):**
  `docs/INSTALLER-PITFALLS.md`
- **Architecture:**
  `docs/ARCHITECTURE.md`
