# T2 — Server: meta.role + exited-session filtering + WS exit propagation + idle/parked detection

You are T2 in Sprint 65 — Dashboard reliability + orch-panel awareness wave. Your lane is the server-side status-flip lifecycle: a new `meta.role` field, filtering exited sessions from `/api/sessions` by default, `410 Gone` on inject to dead panels, broadcasting `panel_exited` WS frames, and per-adapter idle/parked status detection.

## Boot sequence

1. `memory_recall(project="termdeck", query="meta.role explicit role flag POST /api/sessions spawnTerminalSession sessions.create persistence")`
2. `memory_recall(project="termdeck", query="per-adapter idle parked status detection Codex Worked for terminator Sprint 59")`
3. `memory_recall(query="recent decisions and bugs since Sprint 64 close")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/BACKLOG.md` § D.5 — Brad's 2026-05-13 v2 spec entry (Approach A reasoning) + § P0 (per-adapter idle/parked detection)
7. Read `docs/sprint-65-dashboard-reliability/PLANNING.md`
8. Read `docs/sprint-65-dashboard-reliability/STATUS.md`
9. Read this file in full

Then begin.

## Scope

Five sub-tasks. Ship as one coherent FIX-PROPOSED block.

### 2.1 — `meta.role` field (Approach A — explicit role flag)

**Whitelist:** `['orchestrator', 'worker', 'reviewer', 'auditor', null]`.

**`POST /api/sessions` body:** add optional `role` field. Validation:

```js
const ALLOWED_ROLES = ['orchestrator', 'worker', 'reviewer', 'auditor', null];
if (req.body.role !== undefined && !ALLOWED_ROLES.includes(req.body.role)) {
  return res.status(400).json({ ok: false, code: 'invalid_role', allowed: ALLOWED_ROLES });
}
```

**`spawnTerminalSession` signature** at `packages/server/src/index.js:1118`:

```js
function spawnTerminalSession({ command, cwd, project, label, type, theme, reason, role }) {
  // ... existing logic ...
  const session = sessions.create({
    type: type || 'shell',
    project: project || null,
    label: label || command || 'Terminal',
    command: command || config.shell,
    cwd: resolvedCwd,
    theme: theme || config.projects?.[project]?.defaultTheme || config.defaultTheme,
    reason: reason || 'launched via API',
    role: role || null,  // NEW
  });
  // ...
}
```

**`sessions.create()` persistence** in `packages/server/src/session.js`: add `role` to the meta dict:

```js
const meta = {
  // ... existing fields ...
  project: opts.project || null,
  role: opts.role || null,  // NEW
  // ...
};
```

Database column: optional. The existing `sessions` table at `packages/server/src/database.js:57-71` has columns `id, type, project, label, command, cwd, created_at, exited_at, exit_code, reason, theme, theme_override`. Adding `role TEXT` is a one-line ALTER. Migration:

- New migration file at `packages/server/src/setup/migrations/00<next>_session_role.sql` (or whatever the local convention is — verify at lane boot).
- `ALTER TABLE sessions ADD COLUMN role TEXT DEFAULT NULL;`
- Idempotent guard: `CREATE TABLE IF NOT EXISTS` pattern won't help here; use `PRAGMA table_info` + conditional ALTER, or `try/catch` around the ALTER.

**`status_broadcast` flow:** the existing `JSON.stringify({ type: 'status_broadcast', sessions: allMeta })` at `packages/server/src/index.js:2409` serializes the full meta dict. `meta.role` flows through unchanged.

### 2.2 — Filter exited sessions from `/api/sessions`

**Current behavior** at `packages/server/src/index.js:1109-1111`:

```js
app.get('/api/sessions', (req, res) => {
  res.json(sessions.getAll());
});
```

**New behavior:**

```js
app.get('/api/sessions', (req, res) => {
  const includeExited = req.query.includeExited === 'true';
  res.json(sessions.getAll({ includeExited }));
});
```

**`sessions.getAll()` in `session.js`:** accept the flag; default `false`:

```js
getAll(opts = {}) {
  const includeExited = opts.includeExited === true;
  const all = Array.from(this.sessions.values()).map(s => s.meta);
  if (includeExited) return all;
  return all.filter(m => m.status !== 'exited');
}
```

Verify the existing `sessions.getAll()` shape at lane boot — current shape may already iterate differently.

### 2.3 — `410 Gone` on inject to dead panels

At `POST /api/sessions/:id/input` (currently at `packages/server/src/index.js:1462`):

**Current behavior** (pre-fix): returns `200 {"ok":true,"bytes":N,"replyCount":M}` silently no-ops if `session.pty` has been nulled (or `session.meta.status === 'exited'`). Semantic trap.

**New behavior:**

```js
app.post('/api/sessions/:id/input', (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ ok: false, code: 'not_found' });

  // NEW: dead panel detection
  if (session.meta.status === 'exited' || !session.pty) {
    return res.status(410).json({
      ok: false,
      code: 'panel_exited',
      message: `Panel ${id} has exited`,
      exitCode: session.meta.exitCode,
      exitedAt: session.meta.exitedAt,
    });
  }

  // ... existing logic ...
});
```

**Cross-reference:** `POST /api/sessions/:id/resize` at index.js:1676 already returns `410` per Sprint 60 (Brad's 2026-05-07 #3 fold-in); mirror that exact response shape for consistency.

### 2.4 — WS `panel_exited` frame propagation

**Current behavior** at `packages/server/src/index.js:1212-1218` (inside `term.onExit`):

```js
session.meta.status = 'exited';
session.meta.exitCode = exitCode;
session.meta.statusDetail = `Exited (${exitCode})${signal ? `, signal ${signal}` : ''}`;
// ... onPanelClose ...
```

**Add broadcast:**

```js
const payload = JSON.stringify({
  type: 'panel_exited',
  sessionId: session.id,
  exitCode,
  signal: signal || null,
  exitedAt: session.meta.exitedAt || new Date().toISOString(),
});
// Reuse the WS broadcast mechanism that status_broadcast uses
for (const client of wsClients) {
  if (client.readyState === 1) client.send(payload);
}
```

The `wsClients` set already exists for `status_broadcast` — find its definition at lane boot and reuse.

### 2.5 — Per-adapter idle/parked status detection

This bundles the existing P0 from BACKLOG § P0 (idle/parked detection — surfaced + bit Sprint 59 twice in 90 min) into this sprint since it shares the `session.js` PATTERNS surface.

**Add per-adapter `idlePattern` declaration:**

If T2 in Sprint 64 lands first (likely; Sprint 65 is queued behind 64), then `adapter.spawn` already exists on each adapter file. Extend with `adapter.idlePattern`:

```js
// packages/server/src/agent-adapters/codex.js
module.exports = {
  // ... existing fields ...
  spawn: { command: 'codex', args: ['repl'], shellWrap: false },  // from Sprint 64 T2.4
  idlePattern: /─ Worked for \d+m \d+s ─/,  // unambiguous Codex turn-end terminator
};
```

```js
// packages/server/src/agent-adapters/claude.js
module.exports = {
  // ... existing fields ...
  idlePattern: /\n[│┃▎▍▌▋▊▉] (Try|Press|Tip:) /,  // Claude Code's idle-prompt-cursor — VERIFY shape at lane boot
};
```

```js
// packages/server/src/agent-adapters/gemini.js
module.exports = {
  // ... existing fields ...
  idlePattern: null,  // Research at lane boot; if no clear terminator, defer to 30-60s stale heuristic
};
```

```js
// packages/server/src/agent-adapters/grok.js
module.exports = {
  // ... existing fields ...
  idlePattern: null,  // Same — research at lane boot
};
```

**Detection logic in `session.js`:** in `analyzeOutput` (the existing pattern-matching function), if the adapter has an `idlePattern` and the rolling buffer matches it, flip `meta.status` to `'active'` (idle) and clear `meta.statusDetail`:

```js
analyzeOutput(data) {
  // ... existing pattern matching ...
  const adapter = AGENT_ADAPTERS[this.meta.type];
  if (adapter?.idlePattern && adapter.idlePattern.test(this.recentOutput)) {
    this.meta.status = 'active';
    this.meta.statusDetail = '';
    this.meta.lastActivity = new Date().toISOString();
  }
}
```

**Belt-and-suspenders 30-60s stale-`lastActivity` heuristic at the session-broadcast layer:** in the periodic status_broadcast (every 2s), if a session has `status: 'thinking'` (or `'reasoning'`) AND `lastActivity` is older than 60s, force-flip to `'active'`:

```js
// At the top of the broadcast tick
const STALE_THINKING_MS = 60 * 1000;
for (const session of sessions.values()) {
  if (['thinking', 'reasoning'].includes(session.meta.status)) {
    const lastActivityMs = new Date(session.meta.lastActivity).getTime();
    if (Date.now() - lastActivityMs > STALE_THINKING_MS) {
      session.meta.status = 'active';
      session.meta.statusDetail = '';
    }
  }
}
```

## Files of interest

- `packages/server/src/index.js:1109-1111` (`GET /api/sessions` route)
- `packages/server/src/index.js:1118-1175` (`spawnTerminalSession` — `role` param)
- `packages/server/src/index.js:1212-1218` (`term.onExit` — `panel_exited` broadcast)
- `packages/server/src/index.js:1397-1456` (`POST /api/sessions` — `role` validation)
- `packages/server/src/index.js:1462-1512` (`POST /api/sessions/:id/input` — `410 Gone`)
- `packages/server/src/session.js` (`sessions.create` — `role` field + `analyzeOutput` — idlePattern detection + stale heuristic in broadcast tick)
- `packages/server/src/database.js` (`role TEXT` column ALTER)
- `packages/server/src/setup/migrations/00<next>_session_role.sql` (NEW)
- `packages/server/src/agent-adapters/{codex,claude,gemini,grok}.js` (`idlePattern` field)
- `packages/server/tests/agent-adapters.test.js` (extend)
- `packages/server/tests/sessions-api.test.js` (extend with `role` + `410` + `includeExited` fences)

## Acceptance criteria

For this lane to close (post `### [T2] DONE`):

- `POST /api/sessions` accepts `role` field; whitelist enforced; unknown values return 400.
- `meta.role` persists in SQLite + flows through `status_broadcast` unchanged.
- `GET /api/sessions` excludes `meta.status === 'exited'` by default; `?includeExited=true` returns legacy shape.
- `POST /api/sessions/:id/input` returns 410 on dead panels with structured body.
- `term.onExit` broadcasts `panel_exited` WS frame in addition to the existing status flip.
- Codex `idlePattern` lands; Claude `idlePattern` lands (verify shape at lane boot); Gemini + Grok researched (land if obvious, defer to stale heuristic if not).
- Stale-`lastActivity` heuristic kicks in at 60s for `thinking`/`reasoning` statuses.
- `npm test` root green; expect ~10+ new fence tests across role validation, 410 response, idle detection, exited filtering.
- No version bumps, no CHANGELOG edits, no commits.

## Post discipline

`### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`

Standard verbs. `### ` prefix on every post.

If you discover the `sessions` table doesn't have an ALTER-friendly path (e.g., a critical index that would break), post `### [T2] FINDING ... — schema concern: <X>` and idle-poll for ORCH adjudication. The role column is structurally simple; expect this to be clean.

## Cross-cutting with T1

T1 expects:
- `meta.role` in the per-session meta dict (your 2.1).
- `panel_exited` WS frame (your 2.4).
- `meta.status === 'exited'` correctly set on PTY exit (existing behavior + your 2.4 broadcast).

T1's 1.2 (ORCH row) ONLY renders when `meta.role === 'orchestrator'`. If you ship 2.1 with default `null`, T1's ORCH row stays empty until operators tag panels — that's expected and correct.

## Cross-cutting with Sprint 64

Sprint 64 T2 (carve-out 2.4) adds `adapter.spawn` to each agent-adapter file. Your 2.5 extends the SAME files with `idlePattern`. If Sprint 64 ships first (likely), the structure is in place. If not, coordinate via FINDING posts.
