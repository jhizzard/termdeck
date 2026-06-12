# T2 — `termdeck init --bridge` guided wizard step

## Mission

Automate the Tier 5 install flow that shipped as docs today (PR #23,
`docs/GETTING-STARTED.md` § Tier 5). Today the permanent-bridge setup is copy-paste shell
steps + hand-edited files; `SELF-HEALING.md` explicitly flags a guided wizard as the future
enhancement. Build it: `termdeck init --bridge`.

## Mandatory pre-reads

1. **`docs/INSTALLER-PITFALLS.md` — non-negotiable.** Every design decision in your DONE
   post must trace to a pitfall class it avoids.
2. `docs/GETTING-STARTED.md` § Tier 5 (the manual flow you are automating — keep them in lockstep).
3. `scripts/termdeck-supervise.sh` header (config contract: `supervisor.env`, state files).
4. Existing wizard structure: `packages/cli/src/init-mnestra.js` (follow its prompt/verify/
   fail-soft idioms; your step is a sibling, not a fork).

## Scope (files you own)

- `packages/cli/src/` — new `init-bridge.js` (or the idiomatic equivalent you find) wired to
  `termdeck init --bridge` in `packages/cli/src/index.js`.
- Wizard behavior, in order:
  1. Preflight: `cloudflared` on PATH (print install hint if not); detect existing
     `~/.cloudflared/cert.pem` + tunnel credentials; detect existing `~/.termdeck/supervisor.env`.
  2. Prompt for tunnel name (default `termdeck-bridge`) + public hostname.
  3. **Print** the three operator-interactive cloudflared commands (login/create/route) —
     do NOT run them (browser auth); offer to wait/re-check, then verify credentials exist.
  4. Write `~/.cloudflared/config.yml` (tunnel id from the credentials JSON, ingress →
     `http://127.0.0.1:8870`) — back up any existing file first, never clobber silently.
  5. Write/merge `~/.termdeck/supervisor.env` (`TERMDECK_TUNNEL_NAME`, `TERMDECK_PUBLIC_HOSTNAME`).
  6. **Print** the operator-only supervision install (launchctl on darwin / systemctl --user
     on linux, per the Tier 5 doc) — the sandbox/installer must never run launchctl itself.
  7. Verify pass: if the stack is up, run the four Tier 5 reachability checks and print results.
- Tests: wizard-step unit tests following the existing init-* test idiom (no network in tests;
  inject fetchers/exec the way the existing wizard tests do).

## NOT in scope

- The supervisor script itself (shipped v1.8.1, do not modify).
- Tier 5 doc rewrites beyond a short "or run `termdeck init --bridge`" pointer added to the
  top of the Tier 5 section.
- Provider connector automation (OAuth flows are human-in-the-loop by design).

## Acceptance

1. Idempotent: second run detects existing state and offers update-or-keep, never duplicate writes.
2. Never executes interactive-auth or privileged commands; prints them with exact paths.
3. Backs up before overwriting any existing config.yml/supervisor.env.
4. Tests green; INSTALLER-PITFALLS traceability table in DONE post.

## Lane discipline

Post shape: `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in
`docs/sprint-73-provenance-and-installer/STATUS.md`. Stay in lane. No commits.
