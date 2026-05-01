# Sprint 45 prep notes — Grok session context + model selection heuristic

**Last updated:** 2026-05-01
**Status:** Captured in advance of Sprint 45 PLANNING.md authoring. Two architectural concerns Joshua flagged at Sprint 44 close that materially affect Sprint 45 T3 (Grok adapter implementation) — empirically resolved here so the lane agent doesn't have to rediscover.

## Concern 1: Does Grok maintain session context across calls?

**Answer: YES, via two distinct mechanisms.** `grok --help` (run on Joshua's machine 2026-05-01 with `grok-dev@1.1.5`) reveals:

```
-s, --session <id>             Continue a saved session by id, or use 'latest'
-p, --prompt <prompt>           Run a single prompt headlessly
```

### Mechanism A: TUI mode (default, when `--prompt` is absent)

Invoking `grok` (no `--prompt`) opens an interactive TUI inside the PTY. Conversation persists naturally for the lifetime of the process — same shape as a `claude` Claude Code panel. Closing the TUI ends the session.

**TermDeck panel implication:** the Grok adapter's `spawn` config should default to `{ binary: 'grok', defaultArgs: [], env: { GROK_API_KEY: ..., GROK_MODEL: ... } }` — i.e. no `--prompt`, no `--session`. The PTY hosts the TUI; user types prompts; the TUI handles conversation context. This is the lowest-friction path for human-driven panel work.

### Mechanism B: Headless `--prompt` + `--session`

Each `--prompt` invocation IS a fresh API call by default — Joshua's intuition was correct on that point — but `--session <id>` or `--session latest` chains the call into an existing saved session. State is persisted to disk (probably `~/.grok/sessions/`; verify at lane-time).

**Orchestrator inject implication:** the inject script (analogous to `inject-sprint45.js`) targeting Grok lanes can either:

- Wait for the human to open a `grok` TUI panel, then PTY-paste the boot prompt into it (works exactly like Claude — the TUI accepts pasted multi-line input via bracketed-paste), OR
- Spawn `grok --prompt "..." --session latest` directly with the boot prompt and chain subsequent prompts via the same session id.

The TUI path is more consistent with the Claude pattern; the headless path is more programmable. **Recommendation: TUI by default for panels; headless only for orchestrator background tasks (e.g. a scheduled audit).**

### Implication for Sprint 45 T3 (Grok adapter)

Per the 7-field adapter contract from Sprint 44 T3 (`docs/AGENT-RUNTIMES.md`):

```js
{
  matches: (cmd) => /^grok\b/.test(cmd),
  spawn: {
    binary: 'grok',
    defaultArgs: [],          // TUI mode — conversation persists in the PTY process
    env: {
      GROK_API_KEY: process.env.GROK_API_KEY,
      GROK_MODEL: chooseModel(taskHint),    // see Concern 2 below
    },
  },
  patterns: { /* observe Grok TUI's prompt/thinking/tool patterns at lane time */ },
  statusFor: (state) => { /* ... */ },
  parseTranscript: (raw) => { /* read ~/.grok/sessions/<id>/* per the on-disk format */ },
  bootPromptTemplate: (lane, sprint) => { /* same shape as Claude's */ },
  costBand: 'subscription',  // Joshua's SuperGrok Heavy carries the rate limits
}
```

The `parseTranscript` path is non-obvious and needs lane-time investigation. Grok's session storage at `~/.grok/sessions/` (or wherever it lands) is the analog to Claude's transcript JSONL. The Mnestra session-end hook needs an adapter-specific parser to extract memories from a Grok session.

## Concern 2: Model selection heuristic — Claude (orchestrator) chooses

The 11 models from Joshua's `grok models` output break into clear price/capability tiers. **The wrong default could 10x your bill** on routine tasks (Heavy reasoning at $2/$6 per 1M vs Fast variants at $0.2/$0.5 per 1M).

### Tier table

| Tier | Models | Price (in/out per 1M tokens) | Use case |
|---|---|---|---|
| **Cheap fast non-reasoning** | `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning` (legacy) | $0.2 / $0.5 | Routine tasks, simple Q&A, rapid iteration |
| **Cheap fast reasoning** | `grok-4-1-fast-reasoning`, `grok-4-fast-reasoning` (legacy) | $0.2 / $0.5 | Light reasoning under budget |
| **Code-specific** | `grok-code-fast-1` | $0.2 / $1.5 | Code generation, refactoring (output token premium reflects code-quality tuning) |
| **Heavy reasoning** | `grok-4.20-0309-reasoning` (alias `grok-beta`) | $2 / $6 | Hard problems, deep analysis, audit work |
| **Heavy non-reasoning** | `grok-4.20-0309-non-reasoning` | $2 / $6 | High-quality non-CoT output (rare use case — usually Reasoning is right at this price) |
| **Multi-agent** | `grok-4.20-multi-agent-0309` (alias `grok-4.20-multi-agent`) | $2 / $6 | Parallel research, "use all sub-agents" tasks (general / explore / vision / verify / computer fan-out) |
| **Flagship** | `grok-4-0709`, `grok-3` | $3 / $15 (Opus-tier) | Reserved for cases where Heavy isn't enough — rare |
| **Budget compact** | `grok-3-mini` | $0.3 / $0.5 | Very cheap, less capable; rarely the right call |

### Heuristic that the Grok adapter should implement

```js
function chooseModel(taskHint) {
  switch (taskHint) {
    case 'code':            return 'grok-code-fast-1';
    case 'multi-agent':     return 'grok-4.20-multi-agent-0309';
    case 'reasoning-deep':  return 'grok-4.20-0309-reasoning';
    case 'reasoning-quick': return 'grok-4-1-fast-reasoning';
    case 'flagship':        return 'grok-4-0709';
    default:                return 'grok-4-1-fast-non-reasoning';  // cheapest sane default
  }
}
```

The default is **`grok-4-1-fast-non-reasoning`** — the cheapest sane choice, 10x cheaper than Heavy. Tasks that genuinely need Heavy must opt in via `taskHint='reasoning-deep'` or `taskHint='multi-agent'`.

### Where the `taskHint` comes from

Three options, increasing in cleverness:

1. **Lane brief frontmatter** (Sprint 46 T1's `agent: grok` field could be extended to `agent: grok, model-hint: code`). Per-lane explicit, manual.
2. **Boot-prompt-time orchestrator decision.** When the orchestrator constructs the boot prompt, it inspects the lane brief's content (T1 = "graph viewer controls" → `code`; T2 = "audit dashboard with funnel chart" → `code`; etc.) and picks the hint heuristically. Claude (orchestrator) does the picking; Grok (lane agent) just executes against the chosen model.
3. **Runtime self-selection.** Grok itself routes between models via the multi-agent fan-out (which is what `grok-4.20-multi-agent-0309` does internally). The orchestrator picks the multi-agent model and trusts Grok's routing.

**Recommendation: option 2 for Sprint 45 T3 (Claude chooses at boot-prompt construction time);** option 1 as a future override; option 3 reserved for tasks that explicitly call for parallel sub-agent fan-out.

### Where the model is set in the spawn config

The `GROK_MODEL` env var (per Grok CLI's auth flow doc) is the cleanest path. The adapter's `spawn.env` field includes `GROK_MODEL` set per `chooseModel(taskHint)`. The TUI inherits it; the user can override at any prompt with `--model <id>` if needed.

Alternatively, the adapter passes `--model <id>` as a `defaultArgs` entry. Either works.

## Open questions for Sprint 45 T3 lane

- **Where does Grok persist sessions on disk?** Likely `~/.grok/sessions/<session-id>/...`. Format unclear — needs `ls ~/.grok/sessions/` + `cat <one-of-the-files>` at lane time to characterize. Affects `parseTranscript` design.
- **Does Grok's TUI accept bracketed-paste correctly?** Joshua's two-stage submit pattern (paste + 400ms settle + `\r` alone) is mandatory for Claude panels; Grok's TUI is a different reader (Bun + OpenTUI). Lane-time test: paste a 200-line prompt into a Grok TUI and see if it lands intact.
- **What's the `--batch-api` cost reduction factor?** Header lists "async, lower cost" — exact discount unknown. Could be a major cost lever for orchestrator-driven scheduled work where latency doesn't matter.
- **Does `--session latest` survive across orchestrator restarts?** If sessions persist on disk, yes. If they're memory-only, the orchestrator needs to capture session ids explicitly.
- **Does Grok have its own equivalent of Claude's `tool_use` / `thinking` events that the analyzer can pattern-match?** Affects the adapter's `patterns` field. Empirical observation needed.

## Cross-references

- Sprint 44 T1 lane brief (canonical Grok install reference): `docs/sprint-44-multi-agent-foundation/T1-grok-install.md`
- Sprint 44 T4 (canonical reference doc): `docs/AGENT-RUNTIMES.md`
- Multi-agent design memorialization: `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`
- Sprint 44 close-out CHANGELOG entry: `CHANGELOG.md` § `[0.13.0]`
- Joshua's verified-end-to-end test (2026-05-01): `grok --model grok-4.20-0309-reasoning --prompt "what is 2+2"` → returned correct answer with bash sub-agent verification
