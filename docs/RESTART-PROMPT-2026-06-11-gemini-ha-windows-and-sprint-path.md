# RESTART — 2026-06-11 — Gemini path found · Bridge HA · Windows audit · Sprint 73/74 still staged

**You are picking up at:** Sprints 73 + 74 fully staged (briefs + inject script written 2026-06-10,
NEVER injected — STATUS.md has only the ORCH SCAFFOLD post in each), PR #23 (Tier 5 docs, branch
`docs/tier5-bridge-install`) awaiting Josh review, and a 2026-06-11 exploration session that produced
four new workstreams: the Gemini universal-memory path, the web-chat memory inbox design, bridge
high-availability (LB failover, shipped as operator doc), and a Windows-support audit.

---

## 1. Boot sequence (fresh orchestrator)

1. `memory_recall(project="termdeck", query="2026-06-11 Gemini Enterprise static OAuth memory_inbox bridge load balancer failover Windows audit")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read THIS doc, then `docs/RESTART-PROMPT-2026-06-09-hardening-and-brad-feedback.md` for anything § 5 below marks as still-open.
6. Then begin at § 3 (the planned path).

---

## 2. What the 2026-06-11 session produced (exploration + docs; NO code, NO commits, NO publishes)

### 2a. Gemini universal-memory path — RESOLVED on paper

- **BigQuery/Vertex mirror idea: REJECTED.** Consumer Gemini cannot reach BigQuery (Gemini-in-BigQuery
  is a Cloud-console surface) or Vertex RAG corpora (API-side only). Mirror plumbing is easy; the
  doorway doesn't exist.
- **PATH ADOPTED: one Gemini Enterprise Standard seat ($30/mo annual, $35 m2m — the $21 Business
  edition is excluded) + a static-OAuth-client addition to `packages/mcp-bridge`.** Gemini Enterprise
  custom MCP connectors (preview) require: Streamable-HTTP (✓ native), public HTTPS (✓
  `bridge.joshuaizzard.dev/mcp`), OAuth 2.0 with a STATICALLY registered client (✗ — bridge does
  DCR/PKCE today). That static-client path is the ONE work item.
- Josh's $200/mo plan is the consumer top tier ($199.99, Genie+Mariner) — it does NOT include Gemini
  Enterprise. Spark (consumer) has 3 partner connectors, no custom path yet; when it opens, the
  Enterprise seat can be cancelled.
- $0 fallback if Enterprise disappoints: Drive-digest mirror + Gem knowledge files.
- Josh action pending: verify subscriptions (gemini.google.com → Manage subscription; admin.google.com
  → Billing; console.cloud.google.com → Gemini Enterprise) and buy the trial seat.

### 2b. Web-chat memory inbox — DESIGN ADOPTED (Josh's design; not yet built)

Policy evolution: "CLIs write canonical; **web chats write proposals**."
- New `memory_inbox` table (engram repo; design against the layered `mnestra_*` schema from day one).
  Inserts only via SECURITY DEFINER RPC (five RLS gates).
- Bridge exposes `memory_propose` to web connectors only; `memory_remember` stays CLI-only.
- Pending rows EXCLUDED from `memory_recall` until promoted (quarantines prompt-injection poisoning).
- Promotion via Rumen pass gated by: dedup vs canonical, kitchen-vs-recipe test, redaction scan
  (`bridge-redact.json` literals), size caps, per-connector rate limits. Rejected rows keep
  `rejection_reason`.
- **Enum dependency:** needs `claude-web` / `chatgpt-web` / `grok-web` / `gemini-web` in Mnestra
  `source_agents`. Sprint 74 T1 already owns the `grok-web` enum work → see § 3 scope-expansion note.
- Accepted trade-off: async promotion = read-after-write staleness (same class as S74 T3
  flush-before-recall).

### 2c. Bridge high-availability — DESIGNED + DOCUMENTED (operator doc, not repo)

- `~/termdeck-air-kit/AIR-SETUP.html` Part 3 (local file, do-not-commit) now carries the full recipe:
  **each Mac runs its OWN named tunnel** (iMac `termdeck-bridge`, Air `termdeck-bridge-air`) fronting
  its local bridge :8870; a **Cloudflare Load Balancer (~$5/mo)** owns `bridge.joshuaizzard.dev` with
  Failover steering (imac → air), monitor = HTTPS GET `/healthz` expect 200, affinity None.
- Works because bridge access tokens are STATELESS HS256 JWTs — syncing `bridge-auth.json` (jwtSecret
  + DCR clients + hashed refresh tokens) to both machines makes either origin valid. Standing
  maintenance rule: re-sync `bridge-auth.json` toward the other machine after any connector
  add/re-auth or any trip where the Air served (worst case: one-time reconnect prompt).
- **NEVER run one named tunnel as replicas on two machines** — nondeterministic split-brain.
- Fail-safe analysis (power outage at home): tier 1 free = iMac "start after power failure" + auto-login
  (FileVault trade-off — Josh decides); the COMPLETE answer = a **third cloud origin** (small VPS,
  ~$5/mo) as LB pool 3 (imac → air → cloud). Memory tools work identically there;
  `list_panels`/`read_panel` return empty. Endgame candidate: flip pool order to cloud-first, which
  converges with Brad's on-prem ask. **PENDING Josh green-light.**

### 2d. Windows-support audit (background agent, full report in Mnestra)

- WSL2 works TODAY; Mnestra + Rumen are already native-Windows-clean (pure Node + cloud Supabase).
- Native Windows TermDeck blocked by, ranked: (1) no win32 prebuilt for
  `@homebridge/node-pty-prebuilt-multiarch` (3–5 d incl. CI); (2) `spawn-shell.js:23-24` hardcoded
  `/bin/sh` fallback, no win32 branch; (3) `lsof`/`fuser`/`ps` in port-reclaim
  (`packages/cli/src/index.js:114-126`, `stack.js:195-210`); (4) installer writes LITERAL
  `~/.claude/hooks/...` into settings.json — **latent all-platform robustness bug, fix = absolute
  paths at install time** (INSTALLER-PITFALLS candidate); (5) bash-only scripts + no Task Scheduler
  story. Total ≈ 1–2 weeks. Public stance taken on FB: "WSL2 today, native ~1–2 weeks, moved up the
  backlog" — no date committed. Demand-gated backlog item.

### 2e. Lane permission hardening (from Brad's classifier-deadlock question — answered via WhatsApp)

- The auto-mode tool-safety classifier is pinned to Sonnet 4.6 (separate background call, NOT the
  session's model); when it's unavailable it FAILS CLOSED → denies all Bash (GH issue
  anthropics/claude-code#39259). No flag repoints it.
- **Bake into all future lane briefs / lane settings:** unattended lanes use
  `permissions.defaultMode: "dontAsk"` + explicit allow (`Bash(npm *)`, `Bash(git *)`, `Bash(node *)`,
  test runners) + deny (`git push *`, `* --force*`, `rm -rf *`) +
  `fallbackModel: ["claude-sonnet-4-6","claude-haiku-4-5"]`. PreToolUse hook "allow" does NOT bypass
  ask/deny rules; a bare `Bash` ask rule defeats allow rules. Candidate addition to the 3+1+1 section
  of `~/.claude/CLAUDE.md`.

### 2f. Public-facing artifacts from today

- FB launch teaser posted (repos + npm packages; "shared brain… next few days").
- FB reply draft re: Windows (in chat history). FB Messenger reply draft for Tommy Callaway (Josh
  pastes manually — Messenger has no inject channel; candidate to wire one).
- Brad WhatsApp: classifier answer SENT 2026-06-11 evening.

---

## 3. The planned path (ordered)

1. **Inject Sprints 73 + 74** — already fully staged (`docs/sprint-73-provenance-and-installer/`,
   `docs/sprint-74-mnestra-provenance-and-db-integrity/`, inject script
   `inject-s73-s74-prompts.js`). Standard preflight: `GET /api/sessions`, 8 panels, two-stage submit.
   **ORCH scope-expansion call at inject time:** S74 T1's enum migration should add ALL FOUR
   `*-web` source_agents values (`claude-web`, `chatgpt-web`, `grok-web`, `gemini-web`) in ONE
   migration, not just `grok-web` — the inbox sprint (item 3) depends on it, and enum churn should
   happen once. Also fold § 2e lane-permission settings into the lane briefs before inject.
2. **Sprint 75 (bridge wave, termdeck repo):** (a) static-OAuth-client registration path in
   `packages/mcp-bridge` (unblocks Gemini Enterprise connector); (b) cloud third origin + LB
   failover productized as Tier 5b docs (+ optional `mcp-bridge` flag to disable terminal-state
   tools on panel-less hosts); (c) absolute-path fix for installer-written hook commands (§ 2d item
   4 — INSTALLER-PITFALLS review applies).
3. **Sprint 76 (memory inbox, engram repo):** schema + RPC + bridge `memory_propose` + Rumen
   promotion pass, per § 2b. Depends on S74's enum.
4. **Windows sprint:** backlog, demand-gated; ranked items in § 2d / Mnestra.
5. **Josh-only actions:** review/merge PR #23; subscription verification + Gemini Enterprise seat;
   iMac Energy settings (+ auto-login decision); green-light cloud third origin (~$5/mo VPS).

## 4. Repo hygiene note

Branch `docs/tier5-bridge-install` is checked out (PR #23 tip = 413ebfb). UNTRACKED files that should
be committed in the next docs commit: `docs/RESTART-PROMPT-2026-06-09-*.md`, THIS doc,
`docs/sprint-73-*/`, `docs/sprint-74-*/`. The stray root-level `2026-05-09-*.txt` + `rollout-*.md`
recap files are session debris — review then delete or gitignore. Read `docs/RELEASE.md` before any
commit (docs-only → commit, no release).

## 5. Still open from the 2026-06-09 restart doc

- `connect-chatgpt.md` stale ("New App" dialog) — may be fixed by PR #23; verify.
- Bridge live smoke of `list_panels`/`read_panel` via Claude.ai with panels open.
- mnestra #15/#20 privacy_tags — Brad's 4 design answers; pkachu PWA is the downstream consumer.
- Brad R730 v1.8.0 cutover scope (his fleet builds; our S74 covers the IPv4-pooler +
  flush-before-recall audit halves).
- agy language-server MCP wiring; orch/xterm input-accumulation audit (S73 T3 covers this — verify
  at inject).

## 6. Resume the 2026-06-11 session (its accumulated mental model)

```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume d4928bf9-ee86-40bf-bce8-3a7135eec12a
```
