# T1 — Client: chips + ORCH pin + tile auto-removal + optional Path A layouts

You are T1 in Sprint 65 — Dashboard reliability + orch-panel awareness wave. Your lane is the biggest client-side surface this sprint: project-filter chips, the orchestrator-panel visual treatment, panel tile auto-removal on PTY exit, and optionally 10/12/16-panel grid layouts.

## Boot sequence

1. `memory_recall(project="termdeck", query="Brad 2026-05-13 v2 dashboard spec chips orch-pin meta.role projects_changed status_broadcast")`
2. `memory_recall(project="termdeck", query="app.js layout setLayout layoutMode CSS Grid panel filter")`
3. `memory_recall(query="recent decisions and bugs since Sprint 64 close")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 entry + 2026-05-13 v2 spec entry + the 2026-05-14 8-panel/multi-port entry (for Path A fold-in context)
7. Read `docs/sprint-65-dashboard-reliability/PLANNING.md`
8. Read `docs/sprint-65-dashboard-reliability/STATUS.md`
9. Read this file in full

Then begin.

## Scope

Three required sub-tasks (1.1, 1.2, 1.3) + one optional (1.4 — Path A fold-in adjudicated by orchestrator at sprint inject).

### 1.1 — Project-filter chips at top of dashboard

**Container:** new element in `packages/client/public/index.html` above the grid container:

```html
<div id="project-chips" class="project-chips-row">
  <!-- chips render here dynamically -->
</div>
```

**Render shape (one chip per project + "All"):**

```html
<button class="project-chip" data-project="aetheria">
  <span class="project-chip-label">aetheria</span>
  <span class="project-chip-count">(3)</span>
</button>
```

The "All" chip uses `data-project=""` (empty string sentinel).

**Auto-discovery:** on every `status_broadcast` WS frame (already handled in `app.js:230` ws.onmessage switch case `'status_broadcast':` at line ~502), dedupe `meta.project` across all visible sessions. Drop `null` values; under Approach A (T2 lane), null-project sessions with `meta.role === 'orchestrator'` flow into the ORCH-pin row. Null-role + null-project sessions can still be shown (Joshua may run shells without project tags).

**Active count:** for each chip, count sessions where `meta.project === chip.dataset.project` (or all sessions for "All"). Re-render counts on every frame.

**Click handler:** single-select; the clicked chip gets `class="project-chip active"`; all others lose `active`. The grid then filters: add `panel--filtered-out` to every tile where `meta.project !== selectedProject` (and `meta.project !== null` if "All" is selected). `display: none` via CSS on `panel--filtered-out`.

**localStorage persistence:**
- Key: `termdeck.dashboard.projectFilter` (literal string).
- Value: the selected `data-project` value (string; empty string for "All").
- On dashboard load, read the key and apply the filter. If absent, default to "All".

**Cross-tab behavior:** local to each tab via localStorage (origin-scoped). No WS coordination — the existing `projects_changed` broadcast (Sprint 42 T4) is for ADD/REMOVE project, not for filter state. Document that two tabs CAN have different filter selections; this is fine.

### 1.2 — Orchestrator panel pin + visual distinction

**Pin row container:** new element ABOVE the grid container (and above the chip row):

```html
<div id="orch-pin-row" class="orch-pin-row">
  <!-- panels with meta.role === 'orchestrator' render here -->
</div>
```

The ORCH row collapses to zero height when no orch panel exists (CSS: `:empty { display: none; }`).

**Panel rendering routing:** when iterating sessions to render tiles, check `meta.role === 'orchestrator'`. If yes, render into `#orch-pin-row`. If no, render into the standard `.grid-container`.

**Visual class:** every orch-row tile gets `class="term-panel panel--role-orch"`. The new CSS class:

```css
.panel--role-orch {
  border: 2px solid var(--tg-accent-orch, #d4a017);  /* gold/amber; use a CSS var so themes can override */
  box-shadow: 0 0 0 1px rgba(212, 160, 23, 0.3);
}

.panel--role-orch .panel-type::before {
  content: "ORCH ";
  font-weight: 700;
  color: var(--tg-accent-orch, #d4a017);
  margin-right: 4px;
}

.orch-pin-row {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 2fr;  /* orch tile fixed-min width on left */
  gap: 8px;
  margin-bottom: 8px;
  padding: 0 8px;
}

.orch-pin-row:empty {
  display: none;
}
```

**ORCH always wins for label slot:** in the title-bar render at `app.js:373-376` (where `<span class="panel-type">` + `<span class="panel-project">` render), the ORCH badge prepends to `.panel-type`. When both ORCH and project label would render, ORCH appears first.

**Always top-left:** the orch row's CSS Grid template ensures the orch tile is always grid-column 1. If multiple orch panels exist (rare; defensible only if Joshua runs multiple orchestrator sessions), they stack left-to-right in spawn order.

**Independence from chip filter:** the orch row is OUTSIDE the `.grid-container` filtering scope. `panel--filtered-out` is only applied inside the grid, never to the orch row.

### 1.3 — Tile auto-removal on panel exit

**New WS frame handler at `app.js:230` ws.onmessage switch:**

```js
case 'panel_exited':
  handlePanelExited(data.sessionId, data.exitCode);
  break;
```

**Handler:**

```js
function handlePanelExited(sessionId, exitCode) {
  const tile = document.getElementById(`panel-${sessionId}`);
  if (!tile) return;
  // Grace period — let the user see the final lines
  tile.classList.add('panel--exiting');
  setTimeout(() => {
    tile.remove();
    // Also tear down the xterm.js instance if held in memory
    const terminal = state.terminals.get(sessionId);
    if (terminal) {
      terminal.dispose();
      state.terminals.delete(sessionId);
    }
  }, TILE_EXIT_GRACE_MS);
}
```

Where `TILE_EXIT_GRACE_MS = 3000` (configurable via a `data-tile-exit-grace-ms` attribute on `<body>` for tests).

**Belt-and-suspenders:** in the periodic re-render that already runs from `status_broadcast`, also check: if a session's `meta.status === 'exited'` AND `lastActivity` is older than 60s AND the tile is still in the DOM, force-remove it. This catches missed `panel_exited` frames.

**CSS for the exiting state:**

```css
.panel--exiting {
  opacity: 0.5;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
```

So the user sees the tile dim out before it vanishes.

### 1.4 — OPTIONAL: Path A 10/12/16-panel layouts

**Only if orchestrator folds this in at sprint inject** (decision based on T1 bandwidth estimate after 1.1-1.3 are scoped).

**Layout additions at `app.js:4368`:**

```js
const layouts = ['1x1', '2x1', '2x2', '3x2', '2x4', '4x2', '2x5', '5x2', '4x3', '3x4', '4x4', 'orch'];
```

**Keyboard shortcuts at the same handler:** keys `7` / `8` / `9` / `0` map to the new layouts in order (push `'orch'` to a higher slot or document the rebind).

**CSS Grid templates in `style.css`** (precedent at lines 313-319):

```css
.grid-container.layout-2x5 { grid-template-columns: 1fr 1fr; grid-template-rows: repeat(5, 1fr); }
.grid-container.layout-5x2 { grid-template-columns: repeat(5, 1fr); grid-template-rows: 1fr 1fr; }
.grid-container.layout-4x3 { grid-template-columns: repeat(4, 1fr); grid-template-rows: 1fr 1fr 1fr; }
.grid-container.layout-3x4 { grid-template-columns: 1fr 1fr 1fr; grid-template-rows: repeat(4, 1fr); }
.grid-container.layout-4x4 { grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(4, 1fr); }
```

**Acceptance test:** open 16 shell panels; switch to `4x4` layout; verify all 16 are visible and proportional. Switch to `5x2`; verify 10 are visible.

## Files of interest

- `packages/client/public/index.html` (new `#project-chips` + `#orch-pin-row` elements)
- `packages/client/public/style.css` (chip styles + `.panel--role-orch` + `.panel--exiting` + optional Path A grid templates)
- `packages/client/public/app.js` (auto-discovery from `status_broadcast`; click handlers; `panel_exited` handler; ORCH row routing; optional Path A layout list)
- `packages/client/tests/app.test.js` (if exists; add chip + filter + ORCH + exit tests; otherwise new file)

## Acceptance criteria

For this lane to close (post `### [T1] DONE`):

- Chips auto-discover from `meta.project` and render counts that update on every `status_broadcast`. Click filters grid <100ms.
- localStorage persists filter across reload.
- Panels where `meta.role === 'orchestrator'` render in the pinned ORCH row above the grid, with gold/amber border + ORCH badge.
- Panels auto-remove from grid 3s after PTY exit. Belt-and-suspenders force-remove on 60s stale exited.
- (Optional) Path A 10/12/16-panel layouts render correctly at the new keyboard shortcuts.
- No version bumps, no CHANGELOG edits, no commits.

## Post discipline

`### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING → FIX-PROPOSED → FIX-LANDED → DONE. `### ` prefix on every post.

For 1.4 (Path A fold-in), post a FINDING at boot with your bandwidth estimate. Orchestrator adjudicates within ~10 min. If folded in, ship 1.1-1.4 as one FIX-PROPOSED block; if not, ship 1.1-1.3 only and re-queue 1.4 in BACKLOG.
