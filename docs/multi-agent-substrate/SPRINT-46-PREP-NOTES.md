# Sprint 46 prep notes — Mixed-agent 4+1 + per-agent launcher buttons + installer flow

**Last updated:** 2026-05-01
**Status:** Captured in advance of Sprint 46 PLANNING.md authoring.

## Lanes anticipated for Sprint 46

The trilogy memorialization (`docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` § 3 Sprint 46) plus Joshua's 2026-05-01 addition give Sprint 46 four lanes:

| Lane | Goal |
|---|---|
| **T1 — Per-lane agent assignment in PLANNING.md** | Lane brief frontmatter: `agent: claude \| codex \| gemini \| grok`. Default `claude`. Inject script reads the field per-lane. |
| **T2 — Per-agent boot prompt templates + cross-agent STATUS.md merger** | `boot-prompt-{agent}.md` files. Pre-rendered context for non-Claude agents (Codex/Gemini don't have memory_recall MCP — TermDeck pre-renders into a flat file). Standardize STATUS.md format across heterogeneous agents. |
| **T3 — Per-agent launcher buttons + failsafe detection** ← **NEW from Joshua 2026-05-01** | Add Gemini / Grok / Codex one-click launch buttons to the TermDeck dashboard alongside the existing Claude button. Each button does a `which <binary>` health check at click time: if the binary is missing or the API key isn't set, the button opens the "install or connect" modal instead of launching. |
| **T4 — "Install or Connect Other Models" UI + installer step** ← **NEW from Joshua 2026-05-01** | Permanent dashboard surface (modal or sidebar tab) listing every supported agent with status (`installed + connected` / `installed + no key` / `not installed`). One-click flows: install via `npm i -g <package>` (Gemini, Grok via grok-dev) or document the auth flow (Codex via OpenAI). Plus: a step in `@jhizzard/termdeck-stack` installer that asks the user which agents they want to set up at install time (defaults to all four; opt-out per agent). |

## Joshua's 2026-05-01 additional requirement (T3 + T4)

Verbatim ask: *"We also need to add gemini, grok, and Codex (ChatGPT) button launchers to TermDeck, I suppose, and they should have failsafes in case a person doesn't have those or hasn't activated them. Maybe they need a step in the installer and a permanent 'install or connect other models' somewhere in the panel."*

Two distinct surfaces:

### T3 — Inline button launchers (lightweight, per-launch)

- The TermDeck dashboard's launcher area (currently has a Claude button + freeform input) gains 3 new buttons: Gemini, Grok, Codex.
- Each button calls a NEW `GET /api/agent-availability` endpoint that runs `which {binary}` + checks for the relevant API key in env / secrets.env, returns:
  ```json
  {
    "claude":  { "installed": true,  "configured": true,  "ready": true },
    "codex":   { "installed": true,  "configured": true,  "ready": true },
    "gemini":  { "installed": true,  "configured": false, "ready": false, "missing": ["GEMINI_API_KEY"] },
    "grok":    { "installed": true,  "configured": true,  "ready": true }
  }
  ```
- If `ready: true`: button launches the agent in a new panel (same flow as the Claude button today).
- If `ready: false`: button opens the "Install or Connect" modal (T4) pre-filtered to the missing agent.

### T4 — Permanent "Install or Connect" UI + stack-installer step

The dashboard surface is one of:

- **Modal** triggered from a topbar button or from a not-ready inline launcher button click.
- **Sidebar tab** in the existing settings drawer.

Recommendation at lane-time: modal first (lower scope, no settings-drawer refactor); sidebar tab can come in Sprint 47+.

The modal lists each supported agent with its current state and one of these CTAs:

- `installed + configured` → green check, "Launch a panel"
- `installed + missing key` → "Add your API key" (opens a secrets-env editor or a CLI command snippet)
- `not installed` → "Install" (runs `npm i -g <pkg>` via a shell-command relay; **requires Joshua's permission allowlist** so the install can run autonomously when authorized)

The stack-installer step (`packages/stack-installer/src/index.js`) gains a new prompt:

```
Which AI agents do you want to install? (use space to toggle, enter to confirm)
[*] Claude Code (anthropic) — already detected
[*] Codex (openai) — install via `npm i -g @openai/codex`
[ ] Gemini (google) — install via `npm i -g @google/gemini-cli`
[ ] Grok (xai SuperGrok Heavy) — install via `npm i -g grok-dev`
```

Each opt-in runs the install and prompts for the relevant API key. Skipped agents can be added later via the dashboard's "Install or Connect" modal.

### Failsafe behaviors

- **Binary missing at panel-launch time:** show toast "Gemini CLI not installed. Click here to install." with a link to the modal.
- **API key missing at panel-launch time:** show toast "GEMINI_API_KEY not set. Click here to add." opens the secrets editor.
- **Bad API key (auth fails):** captured by the agent's first prompt (returns 401-style). Toast says "Gemini API key rejected. Update via Connect modal."
- **Stack-installer skip:** user can skip all agent installs and add them later via the dashboard. No agent-install is required to use TermDeck for shell sessions.

## Open questions for Sprint 46 lane-time

- Should the "Install" button in the modal actually run `npm i -g`, or just copy the command to clipboard and let the user run it? Security implication: autonomous global npm install needs Joshua's permission allowlist OR a confirmation dialog.
- What's the spec for the "Connect" flow when a key is missing? Inline secret input (typed into the modal, persisted to `~/.termdeck/secrets.env`)? Or just instructions ("paste this in your terminal")?
- Does the stack-installer prompt for API keys at install time, or just install the binary and defer the key prompt to first-launch? Recommendation: defer key prompts (they're sensitive; the user might want to copy from their password manager).
- Codex requires OpenAI auth (login flow), not just an API key. The "Connect" experience for Codex is different from Gemini/Grok. Lane brief addresses per-agent.

## Cross-references

- Sprint 45 PLANNING.md: out-of-scope items deferred to Sprint 46 are listed there
- Sprint 45 T4 lane brief: refactors the launcher to drive from the registry — Sprint 46 T3 builds on that foundation by adding per-agent buttons that read from the registry
- AGENT-RUNTIMES.md: canonical reference for which agents are supported + their auth conventions; Sprint 46 T3/T4 surface this in UI

---

## Sprint 46 close-out side-tasks (queued 2026-05-01 by Joshua)

### A. Private "everything" backup repo

**Joshua's ask:** "I need to have a private way of saving everything to the cloud. Maybe a backup 'everything' repo that is private and hosted on Github."

**Recommended architecture: separate `~/.termdeck-private/` directory + private GitHub remote.**

Cleanest separation. Sensitive operational docs (full RESTART-PROMPTs with personal context, chat IDs, phone numbers, internal financials, full-fidelity sprint debriefs) live there. Public TermDeck repo references private docs by name only ("see RESTART-PROMPT-2026-05-01 in the private archive").

Setup runbook:

```bash
# 1. Create private directory + git repo
mkdir -p ~/.termdeck-private
cd ~/.termdeck-private
git init -b main

# 2. Create private GitHub repo (one-time, via gh CLI or web UI)
gh repo create jhizzard/termdeck-private --private --source=. --remote=origin

# 3. Initial structure
mkdir -p archive/{restart-prompts,sprint-debriefs,credentials-context,personal-context}
echo "# TermDeck Private Archive — sensitive ops not for public consumption" > README.md

# 4. Pre-fill with the unredacted versions of recently-redacted docs
# (run from the public repo as source-of-truth; preserve real values privately)
cp /path/to/public/docs/RESTART-PROMPT-*.md ~/.termdeck-private/archive/restart-prompts/
# manually re-insert the redacted values from your password manager / memory_recall

# 5. Commit + push
git add .
git commit -m "initial archive — pre-Sprint-46 baseline"
git push origin main
```

Alternative architectures rejected:

- **Two-remote setup on the same repo** (`origin`=public, `private`=private). Brittle; gitignored files don't sync to either remote without elaborate hooks.
- **`docs/private/` directory in the public repo, gitignored.** Doesn't get backed up to GitHub at all (defeats the cloud-backup ask).
- **Encrypted blobs in the public repo.** Adds key-management overhead for low payoff; private repo is simpler.

**Recommendation: option A (separate directory + private repo).** Sprint 46 close-out task: bootstrap the private repo + migrate the unredacted versions of the docs touched by the 2026-05-01 redaction commit (`13d588e`).

### B. CHANGELOG.md redaction at Sprint 46 close

The 2026-05-01 forward-only redaction commit deliberately skipped `CHANGELOG.md` because the orchestrator was actively editing it during Sprint 45 close-out. After Sprint 45 (and Sprint 46) are both closed, run the same `sed` redactions against CHANGELOG so the same convention applies historically. CHANGELOG entries are historical records, but the project refs they contain are the same kind of identifier we redacted everywhere else. The audit will resurface those as "still in CHANGELOG" until this is done.

```bash
sed -i '' \
  -e 's/luvvbrpaopnblvxdxwzb/<project-ref>/g' \
  -e 's/rrzkceirgciiqgeefvbe/<project-ref-brad>/g' \
  -e 's/+15127508576/<phone-redacted>/g' \
  -e 's/15127508576/<phone-redacted>/g' \
  -e 's/6943410589/<chat-id-redacted>/g' \
  CHANGELOG.md
```

Run this in the Sprint 46 close-out commit (alongside the v0.15.0 entry). One-line task; no review burden.

### C. INSTALL-FOR-COLLABORATORS.md post-Sprint-45-publish refresh

Sprint 45 ships `termdeck@0.14.0`. The "DEFER Rumen tier" guidance was already flipped at Sprint 44 close, but the version pin needs to update. Sprint 46 close-out task: pin `INSTALL-FOR-COLLABORATORS.md` to `v0.15.0` versions (Sprint 46's target) + mention the new agent-launcher buttons + Install-or-Connect modal as user-facing capabilities.
