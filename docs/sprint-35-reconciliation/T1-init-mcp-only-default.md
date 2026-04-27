# T1 — Init wizard MCP-only default

## Goal

Fresh `termdeck init --mnestra` (interactive or `--yes` flow) writes `rag.enabled: false` to the user's `~/.termdeck/config.yaml`. Add wizard messaging that explains the new default mode and how to opt into full RAG.

## Files (yours)

- `packages/cli/src/init-mnestra.js`

## Files NOT yours (don't touch)

- Anything in `packages/server/src/setup/` (T2 owns)
- `packages/cli/src/init-rumen.js` (T3 owns)
- `packages/cli/src/index.js` (T4 may touch banner; T3 may register `doctor` subcommand)
- New `packages/cli/src/doctor.js` (T3 owns)

## Concrete changes

### 1. Flip the default in `writeLocalConfig`

The relevant block is around `init-mnestra.js:414–417`:

```js
step('Updating ~/.termdeck/config.yaml (rag.enabled: true)...');
// ...
{
  enabled: true,
  // ...
}
```

Change `enabled: true` → `enabled: false`. Update the step message to reflect the new default:

```js
step('Updating ~/.termdeck/config.yaml (rag.enabled: false, MCP-only default)...');
```

### 2. Add wizard messaging before the writeLocalConfig step

Print a clear note explaining:
- Setup mode: **MCP-only (default)**
- Mnestra MCP tools fill `memory_items` as your AI workers call `memory_remember` / `memory_recall`
- TermDeck-side RAG (session/project/developer event tables) is **OFF by default**
- To enable: toggle in dashboard at `http://localhost:<port>/#config` OR set `rag.enabled: true` in `~/.termdeck/config.yaml`

Use whatever stylized block convention the existing wizard uses (e.g., the `[mode]` prefix tag or the boxed-info pattern). Keep the message under 6 lines so it doesn't drown the rest of the wizard output.

### 3. Update final wizard summary

The "Setup complete!" or equivalent final summary should include a one-line restatement of MCP-only default + dashboard toggle hint. This protects users who tab away during step output and only see the final summary.

## Manual test

After your changes:

```bash
# Wipe local config to simulate fresh install
mv ~/.termdeck/config.yaml ~/.termdeck/config.yaml.t1-test-bak

# Run wizard with --yes (uses cached secrets.env)
termdeck init --mnestra --yes

# Verify default is false
grep -A2 "^rag:" ~/.termdeck/config.yaml
# Expected:
# rag:
#   enabled: false
#   ...

# Restore your original config
mv ~/.termdeck/config.yaml.t1-test-bak ~/.termdeck/config.yaml
```

If `--yes` flow re-uses prior config and skips writeLocalConfig, run with `--reset` instead.

## Status posting

Append to `docs/sprint-35-reconciliation/STATUS.md`:

```
## YYYY-MM-DD HH:MM ET — [T1 FINDING] <observation>
## YYYY-MM-DD HH:MM ET — [T1 FIX-PROPOSED] <approach>
## YYYY-MM-DD HH:MM ET — [T1 DONE] <one-line summary>
```

## Out of scope

- No CHANGELOG edits — orchestrator handles
- No version bumps — orchestrator handles
- No commits — orchestrator handles
- No dashboard UI toggle — Phase B / Sprint 36
- No `rag.js` code path changes — Phase C decision
