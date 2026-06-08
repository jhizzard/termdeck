# RESTART — 2026-06-08 — Bridge WEB connectors (ChatGPT → Grok → Gemini)

**You are picking up at: wiring ChatGPT's web interface to the MCP Bridge.** Josh
already dug through ChatGPT's controls and found the custom-MCP entry point (the
**"New App"** dialog — screenshot at `~/.claude/image-cache/9d0bad43-2d1a-4f0b-91fd-6aa46418242f/1.png`).
This session brought the bridge + tunnel up and proved it's publicly reachable;
the only thing left is the per-provider connector UI (Josh's hands) + a smoke per
provider. Order: **ChatGPT → Grok → Gemini.**

> This is the INBOUND layer (web chat UIs pull *in* from the bridge). It is a
> SEPARATE thing from the OUTBOUND CLI-panel work (codex/grok/agy CLIs reading
> Mnestra via their own local config) — that was the 4-CLI 360, already done.

---

## 1. Boot sequence (fresh orchestrator)
1. `memory_recall(project="termdeck", query="SESSION-STATE 2026-06-08 9d0bad43 bridge web connectors ChatGPT Grok Gemini")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`, then `./CLAUDE.md`.
4. Read THIS doc + the companion `docs/RESTART-PROMPT-2026-06-07-cli-runtime-migration-handoff.md` (its **§ 4-CLI 360 verification** has the CLI-side findings) and `docs/HANDOFF-2026-06-08-mcp-bridge-grok-panel.md` (Phase-1 / v1.8.0).
5. Then begin at § 2.

---

## 2. FIRST: bring the bridge + tunnel up (likely down at restart)
The bridge + cloudflared quick-tunnel from the prior session are **ephemeral** —
assume they're gone. Re-create them:

**Prereqs (verify each):**
- TermDeck server on `:3000` — `curl -s http://127.0.0.1:3000/api/sessions` (panel tools need it). Start: `set -a; . ~/.termdeck/secrets.env; set +a; node packages/server/src/index.js`.
- Mnestra HTTP webhook on `:37778` (memory tools route here) — `curl -s -o /dev/null -w '%{http_code}' http://localhost:37778/mnestra` (404 on GET = up). Start if down: `mnestra serve` (env `MNESTRA_WEBHOOK_PORT=37778`).
- `cloudflared` installed (`cloudflared --version` → 2026.5.2 present this session).
- `~/.termdeck/bridge-redact.json` exists with the 4 internal literals (it does — auto-scrubs egress). **Do not** put those literals anywhere external.

**Bring-up (two steps — the tunnel URL is only known after it starts):**
```bash
# 1) tunnel — note the printed https://<random>.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:8870

# 2) bridge — pin PUBLIC_URL to that tunnel URL; choose an operator secret
cd packages/mcp-bridge
TERMDECK_BRIDGE_PUBLIC_URL=https://<tunnel-host> \
TERMDECK_BRIDGE_OPERATOR_SECRET=<generate: openssl rand -hex 8> \
MNESTRA_WEBHOOK_URL=http://localhost:37778/mnestra \
TERMDECK_API_BASE=http://127.0.0.1:3000 \
TERMDECK_BRIDGE_ALLOWLIST_PROJECTS=termdeck \
node src/server.js
```
**Prove reachability before touching a provider** (all three must pass):
```bash
H=https://<tunnel-host>
curl -s "$H/healthz"                                              # {ok:true, tools:6, auth:oauth}
curl -s "$H/.well-known/oauth-protected-resource/mcp"            # resource + authorization_servers
curl -si -X POST "$H/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | grep -i www-authenticate                                      # 401 + WWW-Authenticate at the PRM
```
> **Prior-session ephemeral values** (reuse ONLY if those processes are somehow still alive): URL `https://coding-diabetes-attributes-recipes.trycloudflare.com/mcp`, operator secret in the session-end email. Quick tunnels rotate the host every run, so normally you regenerate. For a stable host, use a cloudflared **named** tunnel (`docs/mcp-bridge/.../tunnel.md` Option A2).

---

## 3. Wire ChatGPT (THE kick-off — from the screenshot)
ChatGPT's actual custom-MCP UI is the **"New App"** dialog (this differs from
`connect-chatgpt.md`'s "Connectors → Developer Mode" wording — **update that doc**;
see follow-ups). Fields, per the screenshot:
- **Name:** e.g. `TermDeck Mnestra` (Description optional).
- **Connection:** toggle = **Server URL** (NOT "Tunnel" — we front it with our own cloudflared). Paste the bridge MCP endpoint **`https://<tunnel-host>/mcp`**. (The field placeholder shows `https://example.com/sse`; ignore the `/sse` hint — our bridge is **Streamable-HTTP** at `/mcp`, which ChatGPT's MCP client supports.)
- **Authentication:** **OAuth**. "Advanced OAuth settings" auto-discovers once a valid URL is entered (it reads our PRM → DCR).
- Tick **"I understand and want to continue"** (the risk-ack) → **Create**.
- → OAuth 2.1/PKCE → the bridge's `/authorize` consent → **enter the operator secret** → connected; the 6 tools appear under the App.
- **Smoke:** *"Call memory_recall for my notes on the TermDeck MCP Bridge."* → expect a redacted memory list. Watch the bridge stdout log server-side for `/register` → `/authorize` → `/token` → `/mcp` tools/call to confirm.
- Requires a ChatGPT plan with custom MCP / Developer-Mode Apps (Plus/Pro/Business).

## 4. Wire Grok (web)
`grok.com/connectors → New → Custom` → paste **`https://<tunnel-host>/mcp`** →
**OAuth 2.1/PKCE** → consent (operator secret) → enable. Smoke: *"Use memory_recall
to pull my decisions about the MCP Bridge."* Requires **SuperGrok / Premium+**
(free tier has no BYO-MCP). NB: this is the inbound Grok WEB connector — unrelated
to the Grok-Build CLI panel (that reads Mnestra via its own `~/.grok/user-settings.json`).

## 5. Gemini — "see what we can do"
As of this session the bridge README marks Gemini web **✗ — the consumer app has
no custom-MCP-connector surface**. Next session: (a) re-verify whether Gemini's
web/app has since added a custom-MCP/connector feature (the product evolves); if
yes, wire it like the others. (b) If still no, the fallback is the **Gemini CLI**,
which already reads `~/.gemini/settings.json` `mcpServers` (mnestra is wired there)
— i.e. Gemini gets Mnestra on the OUTBOUND/local path, not the inbound bridge.
Document the outcome either way.

---

## 6. Full session state (2026-06-08, session 9d0bad43) — for context
(Authoritative detail in the `SESSION-STATE 2026-06-08 9d0bad43` Mnestra memory.)
- **Phase 1 (PR #22):** Deck A MCP-Bridge FINAL-VERDICT GREEN on acceptance (live claude.ai `memory_recall` = 24 memories; 86/86 bridge tests). Hardening #1 (web-chat-driver README `headful:false` is rejected), #7 (root `npm test` now globs mcp-bridge + web-chat-driver; mcp-bridge a workspace; **589/584-pass/5-skip**), #8 (status-parser "Monitor v2" verb-vocab fix +3 tests). #2 grok-web provenance deferred (cross-repo + release-sensitive). Brad sweep: termdeck **PR#11** leak scrubbed (internal ref removed from public body); **issue#12** triaged + public comment (Bug1 layout-focus fixed v1.6.1; the new web-chat client input verified clean of Brad's accumulation pattern; original long-lived-panel Bug2 still open/non-deterministic — **owe Brad an orch-input audit**).
- **Phase 2:** the Codex/Gemini/Grok CLI-runtime migration shipped in **v1.7.0 / Sprint 70** — NOT this session.
- **Phase 3 — the live 4-CLI 360 (Josh's priority):** server up + Claude/Codex/agy/Grok-Build spawned via the API. **Live MCP-read PROVEN: Claude (`max/effort`, 40 results), Codex (`gpt-5.5 xhigh fast`, 40), Grok-Build (38).** **agy (Antigravity) MCP-read DEFERRED** — Antigravity MCP is language-server-mediated (exa LS, `RefreshMcpServers` RPC), NOT a config file; `agy.js` `mcpConfig` set to `null` (finding documented in the adapter header + `RESTART-PROMPT-2026-06-07...` § 360). 4-provider demo: 4 distinct risk takes. Capture (write-on-close) is test-proven.
- **Phase 4 — security:** de-secreted `~/.codex/config.toml` + `~/.grok/user-settings.json` (removed inline Supabase service-role key + OpenAI key + project ref → `secrets.env` fallback, matching Claude/Gemini; verified codex still recalls 38; backups `.bak-2026-06-08`).
- **PR #22** = branch `hardening/s71-72-followups`, commits `5a8001b` / `1e6c28d` / `8c07fe9` (+ this restart doc). **NOT merged** — Josh reviews + Passkey-publishes per `docs/RELEASE.md`. TermDeck server LEFT UP on `:3000`.

## 7. Open follow-ups (priority order)
1. **Bridge web connectors** — ChatGPT → Grok → Gemini (§ 3–5). THE active task.
2. **PR #22** review → merge → npm publish (Josh, Passkey; npm-before-push per RELEASE.md).
3. **mnestra #15/#20** (privacy_tags) — needs Josh's **4 design answers**; #20 (Josh impl) supersedes Brad's #15 spec-draft.
4. **orch/xterm input-accumulation audit** — promised Brad publicly on termdeck#12.
5. **agy language-server MCP wiring** (Antigravity `RefreshMcpServers` mechanism) — the deferred agy memory-read.
6. **web-chat-grok parity-test exemption** (no `spawn` block, by design) + fold the root-level `tests/` dir into a CI lane (it's NOT in the `npm test` glob today — 2 parity tests fail there, pre-existing).
7. **Doc fix:** `connect-chatgpt.md` describes "Developer Mode → add connector" but the real UI is the **"New App"** dialog (§ 3) — update to match the screenshot.

## 8. Resume THIS session (its accumulated mental model)
```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && claude --resume 9d0bad43-2d1a-4f0b-91fd-6aa46418242f
```
(Session JSONL verified on disk this session, ~3.6 MB.)
