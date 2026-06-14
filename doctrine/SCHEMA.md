# Doctrine registry — field contract

The doctrine registry is the machine-readable source of truth for TermDeck's
operating rules. `doctrine/registry.jsonl` is **one JSON object per line**
(JSONL — not YAML, not a JSON array). Blank lines and lines beginning with `#`
or `//` are ignored. `doctrine/index.js` loads, validates, screens, and merges
it; `doctrine/SCHEMA.md` (this file) is the authoring contract.

> **Scope note (Sprint 78 T1).** This sprint ships the registry + loader +
> throttle + seed only. Rumen `doctrine_registry` DB staging is Sprint 79;
> git-hook / inject-refusal / PreToolUse-deny *enforcement* and the
> `sprint-frontmatter.js` retrofit are Sprint 80. Today every shipped entry is
> advisory; the `enforcement` block declares the *intended* surface so later
> sprints have a target, and the loader already **rejects** entries that claim
> an enforcement level a surface cannot architecturally deliver (see below).

## Entry fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | Stable kebab-case slug. Later overlays override a repo entry with the same `id`. |
| `title` | string | ✅ | Short human title. |
| `severity` | enum | ✅ | `critical` \| `high` \| `medium` \| `low`. The rule's inherent importance (sorting/telemetry); **not** the enforcement action. |
| `scope` | enum | ✅ | `universal` (ships in the repo/tarball) \| `operator-local` (a pattern-less **stub** in the repo; the real content lives ONLY in `~/.claude/doctrine/registry.local.jsonl`, never shipped). |
| `audience` | string | ✅ | `all` \| `worker` \| `orchestrator` \| `auditor` \| `operator`. `loadDoctrine({audience})` keeps `all` + the requested audience. Brad's baked copy is **`all` only**. |
| `trigger` | string \| string[] | – | Lifecycle phase the rule is relevant to (e.g. `pre-release`, `commit`, `status-append`, `compaction-near`, `always`). `loadDoctrine({event})` filters on it; `always`/absent always matches. |
| `check` | object | ✅ | `{ type, ... }`. See **check.type** below. |
| `enforcement` | object | ✅ | `{ surface, max_severity, ref }`. See **enforcement** below. |
| `source` | object | – | `{ incident, memory_recall_query }` — provenance; `memory_recall_query` is a paste-ready `memory_recall` query for the backstory. |
| `advisory` | object | – | `{ one_line, procedure_path, cooldown_hours }`. `one_line` is what reaches an agent — **≤ 200 chars** (longer ⇒ entry rejected). |
| `status` | enum | ✅ | `active` \| `proposed` \| `deprecated`. |
| `version` | integer | – | Per-entry revision. |

### `check.type` ∈ `regex` \| `script` \| `sql` \| `manual`

- `regex` — `check.pattern` (+ optional `check.flags`) is compiled at load with
  per-entry try/catch; a malformed pattern drops **only that entry** (logged),
  never the whole load. The compiled `RegExp` is attached as `_checkRegex`.
- `script` — `check.script` names the executable check (e.g. a gitleaks hook).
  Inventory of an already-mechanized rule; not run by the loader this sprint.
- `sql` — `check.sql` is the verifying query (e.g. an RLS advisor). Not run by
  the loader this sprint.
- `manual` — an **honesty entry**: a real rule that is not yet machine-checkable
  (prose residue). Kept in the census so coverage stats can't lie by omission.

### `enforcement`

- `enforcement.surface` ∈ `git-hook` \| `preToolUse-deny` \| `inject-refusal` \|
  `server-monitor` \| `inject-advisory` \| `status-append`.
- `enforcement.max_severity` ∈ `block` \| `warn` \| `advise` — the strongest
  action this surface may take.
- `enforcement.ref` — pointer to the canonical procedure (doc path / anchor).

#### max_severity-per-surface (the validator **REJECTS** violations — AMEND-3)

`block` is only architecturally possible where there is a real interception
point that can deny. The advisory surfaces have none, so a registry entry
claiming `block` there is a lie and is **dropped at load** (logged; the valid
remainder still loads).

| surface | `block` | `warn` | `advise` | why |
|---|:--:|:--:|:--:|---|
| `git-hook` | ✅ | ✅ | ✅ | pre-commit/pre-push can refuse the operation |
| `preToolUse-deny` | ✅ | ✅ | ✅ | PreToolUse hook can deny the tool call (Sprint 80) |
| `inject-refusal` | ✅ | ✅ | ✅ | sprint-dispatch can refuse to inject |
| `server-monitor` | ❌ | ✅ | ✅ | observation only — nothing to deny |
| `inject-advisory` | ❌ | ✅ | ✅ | re-routed PTY advice — capped at warn |
| `status-append` | ❌ | ✅ | ✅ | STATUS.md is append-only via direct tool calls — no interception point; structurally advisory forever |

## Overlays + precedence

`loadDoctrine()` merges, lowest precedence first (later **overrides by `id`**):

1. repo `doctrine/registry.jsonl` (shipped in the tarball).
2. `~/.claude/doctrine/registry.local.jsonl` — operator-local rules
   (`origin='local'`). **Never** in the repo or tarball. Holds the real scrub
   patterns for the `operator-local` stub. Absent ⇒ skipped.
3. `~/.termdeck/doctrine-local/*.jsonl` — operator overlay dir
   (`origin='local'`). Absent ⇒ skipped.

**Both overlays absent ⇒ the repo entries, never an error.** Paths resolve at
call time from `os.homedir()` and are overridable via
`opts.{repoRegistry,claudeOverlay,termdeckOverlayDir}` (tests).

## Forbidden-string screen (load-time, fail-soft)

At load, every entry's `title` + `advisory.one_line` + `advisory.procedure_path`
+ `enforcement.ref` + `source.{incident,memory_recall_query}` is screened
through the operator's `gitleaks` (+ `~/.gitleaks.toml`). An entry that trips is
**dropped + logged** — it never reaches agent context or public STATUS.md. The
forbidden patterns are **never hardcoded** in `index.js` (the patterns are the
leak). If gitleaks is absent or errors, the screen **fails soft**: one warning,
entries pass unscreened (the repo registry is gitleaks-clean via the pre-commit
hook; overlays are operator-local + lower-risk).

## `doctrine/index.js` API (consumed by T2 + Sprint 79/80)

```js
const doctrine = require('../../../doctrine'); // from packages/server/src/*

loadDoctrine({ event?, cwd?, audience?, noCache?, /* test: repoRegistry, claudeOverlay, termdeckOverlayDir, gitleaksBin, gitleaksConfig */ })
  // → Array<entry> (validated, regex-compiled, screened, merged). Never throws.

validateEntry(entry)            // → { valid: boolean, errors: string[] }
compileTrigger(entry)           // → entry clone with _checkRegex (throws on bad regex — caller skips)
screenEntries(entries, opts?)   // → entries minus forbidden-string trips (fail-soft)
clearCache()                    // drop the mtime/size-keyed load cache

setDb(db)                       // inject the shared better-sqlite3 handle (server startup)
DOCTRINE_EVENTS_SQL             // canonical doctrine_events DDL (database.js execs it)
```

### Throttle contract — **stable for T2** (per-RULE registry-stage layer)

> Two distinct throttle layers exist and **stack** (PLANNING §8.2 — do not
> conflate). This is the per-RULE layer. T2 owns a separate per-ENTRY advisory
> layer (24h per-entry cooldown + 5/session + 1/10min + once-per-(session,
> dedup_key)). Neither replaces the other.

```js
shouldNotify(rule_id, dedupe_key, {
  lane,            // target panel/session for the per-lane budget (string|null)
  surface,         // for the doctrine_events audit row
  session_id,      // for the audit row
  db,              // override the injected handle (tests)
  now,             // Date|ms|ISO clock override (tests)
  cooldownMs,      // default 30*60*1000 (per-rule 30-min cooldown)
  hourlyBudget,    // default 3 (hard 3 advisories / lane / hour → ORCH overflow)
  record,          // default true: record the decision into doctrine_events
} = {}) → {
  notify: boolean,
  reason: 'ok' | 'rule-cooldown-active' | 'lane-hourly-budget-exceeded'
        | 'no-db-failsoft' | 'throttle-error-failsoft',
  outcome: 'notified' | 'suppressed-cooldown' | 'overflow-orch'
         | 'notified-failsoft' | 'error',
  recorded: boolean,
  route?: 'orch',  // present when overflow → route to ORCH instead of injecting
}
// NEVER throws. No db ⇒ { notify:true, reason:'no-db-failsoft' } (T2's
// per-entry layer backstops spam). Budget counts only delivered ('notified')
// rows; suppressed/overflow rows do not consume budget.

recordGateEvent({ rule_id, dedupe_key, lane, surface, outcome, reason, session_id, detail }, { db?, now? })
  → { recorded: boolean, reason? }   // NEVER throws (rides hook/commit/inject/PTY paths)
```

### `doctrine_events` (SQLite, sibling of `flashback_events`)

```
id INTEGER PK | fired_at TEXT | rule_id TEXT | dedupe_key TEXT | lane TEXT
| surface TEXT | outcome TEXT | reason TEXT | session_id TEXT | detail TEXT
```
Indexed on `(rule_id, fired_at DESC)` and `(lane, fired_at DESC)`. Created in
the shared `~/.termdeck/termdeck.db` handle (no second DB file).
