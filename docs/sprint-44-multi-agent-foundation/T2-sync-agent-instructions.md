# Sprint 44 — T2: `scripts/sync-agent-instructions.js`

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Build a pure-Node script that reads `CLAUDE.md` (canonical) and emits `AGENTS.md` (Codex + Grok shared) + `GEMINI.md` mirrors with agent-specific lead-in banners. Header banner on each generated file:

```
<!-- AUTO-GENERATED from CLAUDE.md by sync-agent-instructions.js. Do not edit directly. -->
```

Add `npm run sync:agents` to root `package.json`. Generated mirrors are **committed** (visible to external GitHub readers — Brad / Unagi SWE lead / future contributors land on GitHub first). The script is **idempotent** — re-running on already-synced files produces no diff.

## Files
- NEW `scripts/sync-agent-instructions.js`
- `package.json` (add `scripts.sync:agents`)
- NEW `tests/sync-agent-instructions.test.js`
- NEW `AGENTS.md` at repo root (committed)
- NEW `GEMINI.md` at repo root (committed)

## Design

```js
// scripts/sync-agent-instructions.js
const SOURCES = {
  AGENTS: { lead: 'For Codex CLI and Grok CLI users — content mirrors CLAUDE.md.' },
  GEMINI: { lead: 'For Gemini CLI users — content mirrors CLAUDE.md.' },
};

function syncFromClaude(canonicalPath, mirrors) {
  const claude = fs.readFileSync(canonicalPath, 'utf-8');
  for (const [name, { lead }] of Object.entries(mirrors)) {
    const banner = `<!-- AUTO-GENERATED from CLAUDE.md by sync-agent-instructions.js. Do not edit directly. -->\n\n> ${lead}\n\n`;
    const target = `${name}.md`;
    fs.writeFileSync(target, banner + claude);
    console.log(`✓ wrote ${target} (${(banner + claude).length} bytes)`);
  }
}
```

(Real implementation handles existing-file diff suppression, idempotency, error cases.)

## Acceptance criteria
1. `npm run sync:agents` from TermDeck root produces `AGENTS.md` + `GEMINI.md`.
2. Diff against `CLAUDE.md` shows only the auto-generated banner + agent-specific lead-in.
3. Re-running on already-synced files produces no `git diff` — idempotent.
4. Tests pass: covers banner injection, lead-in correctness, content fidelity (every byte of CLAUDE.md after the banner), idempotency on re-run, error handling for missing CLAUDE.md.
5. **Generated files are committed** to the repo (so Brad / Unagi SWE / external readers see them on GitHub).

## Lane discipline
- Append-only STATUS.md updates with `T2: FINDING / FIX-PROPOSED / DONE`.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T2 owns the sync script. Does NOT touch Grok install (T1), the adapter registry (T3), or AGENT-RUNTIMES.md (T4).

## Pre-sprint context

- Joshua's canonical instruction file is `~/.claude/CLAUDE.md` (global) AND `<project>/CLAUDE.md` (project-level). The sync script handles **the project-level CLAUDE.md** at the TermDeck repo root — global is left alone.
- Codex CLI looks for `AGENTS.md` (hierarchical, per OpenAI repo's own structure).
- Grok CLI looks for `AGENTS.md` (hierarchical, "merged from git root down to cwd" per superagent-ai/grok-cli README).
- Gemini CLI looks for `GEMINI.md`.
- The convergence finding (memorialized in `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` § 2): **Codex AND Grok share AGENTS.md.** That's why this lane only generates 2 files, not 3.
