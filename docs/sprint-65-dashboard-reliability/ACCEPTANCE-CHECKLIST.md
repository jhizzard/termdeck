# Sprint 65 — acceptance checklist (dashboard reliability + orch-panel awareness)

Operator-runnable verification for the `@jhizzard/termdeck@1.4.0` wave: project-filter
chips, the orchestrator-panel pin, panel tile auto-removal, `meta.role`, exited-session
filtering, `410 Gone` on dead-panel input, and per-adapter idle/parked detection.

Run top to bottom. Each `[ ]` is a discrete check; the **Expect** line is the pass
condition. Sections 4–6 + 10 are also covered automatically by
`node --test packages/server/tests/sprint-65-acceptance.test.js` (11/11) — the manual
steps here additionally exercise the **client/DOM** half a headless test cannot reach.

---

## How to run

| Mode | Command | Dashboard |
|---|---|---|
| **Post-ship** (verify the published wave) | `npm i -g @jhizzard/termdeck@latest && termdeck` | `http://127.0.0.1:3000` |
| **Pre-ship WIP** (verify the local tree) | `node packages/cli/src/index.js --port 3003 --no-open` | `http://127.0.0.1:3003` |

> ⚠ Do **not** run these against `:3001` (the live Sprint 65 host) or `:3000` if another
> TermDeck instance owns it. Pre-ship, always launch a fresh instance **from the local
> repo tree** (`node packages/cli/src/index.js`), never the possibly-stale global
> `termdeck` binary. Substitute your chosen port for `:3000` in the `curl` commands below.

`curl` steps assume the dashboard port is `3000`. They print the HTTP status on the last
line via `-w`. `jq` is optional — without it, eyeball the JSON.

---

## 0 — Pre-flight

- [ ] `npm view @jhizzard/termdeck version` returns `1.4.0` or higher (post-ship only).
- [ ] Dashboard loads; no console errors on first paint.
- [ ] A `#project-chips` row is present directly above the panel grid.
- [ ] A `#orch-pin-row` element exists and, with no orchestrator panel yet, collapses to
      zero height (no empty band above the grid).

## 1 — Project-filter chips (T1 1.1)

- [ ] Spawn 3 panels with `project=alpha` and 2 with `project=beta`.
      **Expect** chips render: `[ All (5) ] [ alpha (3) ] [ beta (2) ]`.
- [ ] Click the `alpha` chip. **Expect** only the 3 `alpha` panels visible; counts stay live.
- [ ] Switch from `alpha` to `beta`. **Expect** the visible set flips with no perceptible
      lag (target <100 ms — it is a CSS class toggle, not a re-render).
- [ ] Reload the tab. **Expect** the filter persists as `beta` (localStorage key
      `termdeck.dashboard.projectFilter`).
- [ ] Click `All`. **Expect** all 5 panels visible again.
- [ ] Spawn a 6th panel `project=gamma`. **Expect** a `[ gamma (1) ]` chip appears live.

## 2 — Orchestrator pin (T1 1.2)

- [ ] Spawn a panel with `role=orchestrator` (e.g.
      `curl -s -XPOST 127.0.0.1:3000/api/sessions -H 'content-type: application/json' -d '{"command":"sh","role":"orchestrator","label":"orch"}'`).
      **Expect** it renders in `#orch-pin-row` above the grid, with a gold/amber border and
      an `ORCH` badge in the title bar.
- [ ] Click the `alpha` chip. **Expect** the ORCH panel stays pinned and visible above the
      filtered grid regardless of chip selection.
- [ ] Exit the orchestrator panel. **Expect** `#orch-pin-row` collapses back to zero height.

## 3 — Tile auto-removal on PTY exit (T1 1.3 + T2 2.4)

- [ ] Spawn a panel running `sh -c 'sleep 2; exit 0'`. **Expect** after ~2 s + a ~3 s grace
      the tile dims (`panel--exiting`) then vanishes from the grid.
- [ ] Spawn a panel; `DELETE` it via the API. **Expect** the tile is removed after the grace
      period (not left as a dead tile).
- [ ] Belt-and-suspenders: simulate a missed `panel_exited` frame (force `meta.status`
      to `exited` server-side without the broadcast, or kill the underlying PID directly).
      **Expect** the dashboard's reconciliation removes/​collapses the tile within ~60 s —
      a dashboard that misses the exit frame must not keep a dead tile forever.

## 4 — `meta.role` contract (T2 2.1)

- [ ] `curl -s -XPOST 127.0.0.1:3000/api/sessions -H 'content-type: application/json' -d '{"command":"sh","role":"worker"}' -w '\n%{http_code}\n'`
      **Expect** `201`; response `.meta.role == "worker"`. (Repeat for `orchestrator`,
      `reviewer`, `auditor` — all `201`, all round-trip.)
- [ ] Same POST with `"role":"supervisor"`. **Expect** `400`; body `.code == "invalid_role"`
      and `.allowed` lists the whitelist.
- [ ] Same POST with no `role` field. **Expect** `201`; `.meta.role == null` (explicit null,
      not absent — the ORCH-pin routing depends on it).

## 5 — Exited-session filtering (T2 2.2)

- [ ] Spawn 3 panels; let 1 exit (PTY-exit, e.g. `sh -c 'exit 0'`).
- [ ] `curl -s '127.0.0.1:3000/api/sessions' | jq length` → **Expect** `2` (exited excluded).
- [ ] `curl -s '127.0.0.1:3000/api/sessions?includeExited=true' | jq length` → **Expect** `3`
      (legacy shape; the exited session is still queryable for `doctor`/debug tooling).

## 6 — `410 Gone` on dead-panel input (T2 2.3) — both layers

- [ ] Spawn a panel; capture its id; let it PTY-exit (or `DELETE` then re-`GET` an exited one).
- [ ] `curl -s -XPOST 127.0.0.1:3000/api/sessions/<id>/input -H 'content-type: application/json' -d '{"text":"hi"}' -w '\n%{http_code}\n'`
      **Expect** `410`; body has `code: "panel_exited"` **and** an `error` field (the dual-410
      decision — `error` keeps the legacy client compatible).
- [ ] **Reply-UI step (do not skip — curl alone is insufficient):** in the browser, with a
      dead panel still tiled, type into that panel's reply/input box and send. **Expect** the
      dashboard surfaces a *failure* (not a false "delivered") — verifies T1's status-aware
      `api()` treats the 410 as an error.
- [ ] Send input to a *live* panel. **Expect** `200` — the 410 is strictly exit-scoped.

## 7 — Idle / parked detection (T2 2.5)

The canonical idle shape (ORCH SCOPE 2026-05-16 ruling C): a parked panel
(`status ∈ {thinking, editing}`, `lastActivity` > 30 s old) serializes to
`status: "idle"`, `statusDetail: ""`.

- [ ] Spawn a Codex panel; let it finish a turn so its output ends with the
      `─ Worked for Xm Ys ─` terminator. Within ~2 s,
      `curl -s 127.0.0.1:3000/api/sessions/<id> | jq '.meta.status,.meta.statusDetail'`
      → **Expect** `"idle"`, `""`.
- [ ] Spawn a Claude panel; let it park at its idle prompt. **Expect** the same idle shape.
- [ ] Leave any panel parked >30 s after a `thinking` status. **Expect** `GET` reports
      `status:"idle"` — the orchestrator must never see a parked panel as still `thinking`.

## 8 — Spawn under an active filter (Hypothesis B / bug 2a regression guard)

The chip filter must not turn into a fresh "opens invisible" bug — see
`2A-OPENS-INVISIBLE-ANALYSIS.md` § Hypothesis B.

- [ ] Select the `alpha` chip. Spawn a new panel with `project=beta`.
      **Expect** the new panel is **not** silently hidden — per T1's chosen mitigation the
      view either auto-switches to `beta`, or the `beta` chip flashes / its count bumps
      unmistakably. The operator must always be able to see or reach a panel they spawned.
- [ ] Leave a non-`All` filter selected, reload the tab, spawn a panel whose project differs
      from the filter. **Expect** the same — no born-hidden panel.

## 9 — Path A layouts (T1 1.4, if folded in)

- [ ] Cycle the layout switcher through the new presets (`1x2`, and the 10/12/16-panel
      grids). **Expect** each renders proportionally; keyboard shortcuts switch layouts.
- [ ] Open 16 panels, switch to the 16-cell layout. **Expect** all 16 visible at once.

## 10 — Brad's 18-panel-2-project synthetic run (3.2)

- [ ] `node --test packages/server/tests/sprint-65-acceptance.test.js`
      → **Expect** `11 pass / 0 fail / 0 skipped`. This reproduces Brad's
      "18 windows, 10 dead codex cli" shape (10 codex + 8 grok + 1 orchestrator; the 10
      codex PTY-exit) and fences the server contract end-to-end.
- [ ] Optional live mirror: on a fresh `--port 3003` instance, spawn 10 codex + 8 grok + 1
      orchestrator panel, let the 10 codex exit, and walk sections 1/2/5/6 against that grid
      — chip switch flips the visible set, the ORCH panel stays pinned, the default session
      list shows 9 live, dead-panel input returns `410`.

## 11 — Regression + sign-off

- [ ] `npm test` (repo root) is green — no regressions in adjacent suites.
- [ ] `gitleaks` pre-commit clean on the wave's diff.
- [ ] Brad's bug 2a ("opens invisible") adjudicated — fixed in-sprint OR deferred with the
      BACKLOG entry from `2A-OPENS-INVISIBLE-ANALYSIS.md`.

| Field | Value |
|---|---|
| Verified by | |
| Date | |
| termdeck version | |
| Result | PASS / FAIL |
| Notes | |
