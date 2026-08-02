# RESTART PROMPT — 2026-08-01 EVENING FINAL — the complete handoff

**Audience: the next orchestrator session. This doc supersedes
`RESTART-PROMPT-2026-08-01-post-sprint-68-redux.md`** (whose §2 publish tail is DONE) and is
the single source for booting. Read fully; §2 is your work queue, §3 is the live-state table
you should trust over any memory.

## 0. Today's complete ledger (2026-08-01, one orchestrator session, 13:31 → ~20:00 ET)

1. **Rumen 0.11.1** — graph-consolidation `category` CHECK fix, shipped end-to-end
   (`fc47885`/`v0.11.1`, function redeployed, live-verified: first 20 `consolidation_summary`
   rows, `written=20, 0 errors`; ~52-community backlog drains nightly 04:00 UTC).
2. **§6 tail of the S84 doc closed** — `RUMEN_SWEEP_DRY_RUN` unset; vault-regen launchd
   loaded; session `cdd8d386` sharded (34 facts).
3. **Sprint 68-REDUX** — standalone-shell capture via PATH shims; 3+1+1 on :3001, inject
   15:29 ET → FINAL-VERDICT GREEN 16:51 ET; gate 1311/1306/0; canaries row-verified
   (grok `85e86311`, codex `74cf2626`, agy `e36b15fb`). **FULLY SHIPPED:** termdeck 1.18.0 +
   stack 1.16.0 on npm; termdeck main + tag `v1.18.0` at **`1d15012`** (amended once —
   GitHub push protection flagged the synthetic Slack-token fixture; all five token-shaped
   fixtures defused via concatenation).
4. **Field bug, same evening:** bare `npm i -g` staged shim files WITHOUT the rc PATH fence
   (Class-N lockstep violation; BACKLOG'd Sprint-69) — Josh's first standalone tests ran
   uncaptured. Fixed: canonical fence appended to `~/.zshrc` (backup
   `~/.zshrc.bak-2026-08-01-shimfence`); `termdeck doctor` **12/12**; field-proven by Josh's
   real codex session → row `f5cdbc97-0397-4c8c-b598-2a5e1f3dcc6b` (his test phrase verbatim,
   envelope + raw transcript + Mnestra row all verified same-second).
5. **Sheets intake ACTIVATED end-to-end:** service account minted + staged
   (`~/.termdeck/credentials/sheets-harvester.json`, 600), sheet shared Editor, env wired
   (`secrets.env` + `supervisor.env`, spreadsheet id `1ThPD_…oRNI`, tab `Intake`), smoke
   green (`proposed=1` then idempotent `already=1`), first real proposal in `memory_inbox`:
   `a2cf2b1e-b99a-45fc-ab52-c93626fb1290` (`gemini-web`/`termdeck`/`pending`). **Interim
   launchd `com.jhizzard.termdeck-sheets-harvest` loaded** — `--once` every 300s, RunAtLoad,
   logs `~/.termdeck/sheets-harvest{,.err}.log` (supervise integration BACKLOG'd, retire the
   plist when it lands).
6. Arc docs current (board + EXECUTION-ARC position → Phase 5 COMPLETE). Wrap email draft
   `r88044231687563217` is the canonical operator summary.

## 1. Boot (fresh session)

1. `memory_recall(project="termdeck", query="Sprint 68 redux fully shipped field bug sheets intake activated")`
2. `memory_recall(query="recent decisions promotion gate harvest launchd fence")`
3. Read `~/.claude/CLAUDE.md`, termdeck `./CLAUDE.md`, then THIS doc (skip the superseded
   post-sprint-68-redux doc except for sprint detail).
4. Then §2 in order.

## 2. First-boot work queue (in order)

1. **Commit the doc drift** (this file + `docs/BACKLOG.md`'s two 2026-08-01 appends):
   `git add docs/BACKLOG.md docs/RESTART-PROMPT-2026-08-01-evening-final.md && git commit -m "docs: 2026-08-01 evening state — shim-fence field bug, sheets-intake activation, final restart package" && git push`
   (If the permission classifier blocks git mutations, hand Josh the same line with `!`.)
2. **DONE 20:15 ET — Gemini row verified end-to-end** (in-sheet Gemini side panel wrote it;
   standalone Gemini-web on the gmail account FAILED — it created an orphan copy sheet, deleted;
   the in-sheet panel is the reliable Gemini writer). Row `c6ccfddf-c6c2-46a1-a65f-663a77c254cf`
   pending. BONUS PROOF: the promoter's judge is LIVE — it rejected the first test capture with
   `rejection_reason='recipe-level'` (kitchen-vs-recipes doctrine enforced on a dated test line —
   correct verdict; expect the same for the Gemini test row). The full loop
   capture→propose→quarantine→judged-review ran tonight. Also new in BACKLOG: Gemini-web READ
   ramp (Mnestra→Google mirror, Josh proposal, concrete SA-reuse design sketched).
3. **Shard session `36a78c3b-a8bd-4759-9e7d-501583d640f9`** (this was a FULL-DAY session —
   the biggest yet) per the standing procedure: verify `~/.claude/session-index/` swept it;
   extract text turns (~700 char cap), shard ≤36K, provenance header, one
   `memory_summarize_session(project="termdeck")` per shard.
4. **Overnight verification** (after 04:40 UTC / 00:40 ET, else defer): via edge-function
   logs + read-only psql — NEVER memory_recall (read-side gap) and NEVER the cron ledger
   alone (dispatch ≠ execution — today's category bug hid exactly there):
   - 04:00 graph-consolidation: `written>0`, `consolidation_summary` count rising toward ~72.
   - 04:40 extract-sweep **first real writes**: `rumen_extraction_sweep` ledger rows,
     entities/mentions counts off zero, `triples_found` density (feeds SR-7).
   - promoter dry-run stats accumulating against the now-real inbox flow.
5. Then idle for Josh's signal (gate prep or Sprint-69 scoping — candidates in BACKLOG §A:
   read-side recency ranking (it hides fresh rows from recall), shim-staging lockstep fix,
   harvest-supervise integration, Gemini read-ramp mirror (now VALIDATED — Gemini-web reads
   live sheets accurately; see the BACKLOG item + `SideHustles/Append Row to Spreadsheet.pdf`),
   5 uncharacterized skips).
   **Context for pacing:** Josh's stated next focus after this session is NON-TermDeck — CIB
   (Chopin in Bohemia), amateur-competition work, Hearth Court / BHHT, and ForeCede — so the
   next TermDeck orchestrator boot may be days out. All state here is durable: crons, launchd
   agents, and the promoter run unattended; nothing decays except the gate date (~08-13).

## 3. Live-state table (trust this over memories)

| Surface | State |
|---|---|
| npm | termdeck **1.18.0**, stack **1.16.0**, mnestra 0.12.0, rumen **0.11.1** |
| termdeck git | main = origin = `1d15012`, tag `v1.18.0` (uncommitted: BACKLOG + this doc) |
| Shims | ACTIVE — fence in `~/.zshrc` (canonical bytes), doctor 12/12; new terminals capture codex/grok/agy; TermDeck panels excluded by design; gemini standalone = out of scope |
| Sheets intake | LIVE + autonomous (launchd 300s); sheet `1ThPD_…oRNI` tab `Intake`; SA editor-shared |
| memory_inbox | Real flow started (first row `a2cf2b1e…` pending); promoter `rumen-inbox-promote` */10 in dry-run |
| Nightly crons (UTC) | 03:00 graph-inference · 04:00 graph-consolidation (writes real, ~52 backlog) · 04:20 inbox-purge · 04:40 extract-sweep (writes real as of tonight) · 03:45 rumen-reinforce |
| launchd (user) | termdeck-supervise · termdeck-watchdog · mnestravault (nightly vault regen → /Volumes/Crucial X6) · **termdeck-sheets-harvest (new)** · gitmirror 03:15 |
| Flags OFF (gate decisions ~08-13) | auto-promote · `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` · `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` |
| Web write paths | Claude/ChatGPT/Grok → bridge `memory_propose` (live, name-inferred provenance until strict-map) · Gemini → the Sheet |

## 4. Operator items (Josh's, no session required)

- **~08-13 gate:** review promotion dry-run stats (`memory_inbox_health` +
  `cron.job_run_details` for `rumen-inbox-promote` + promoter reports) → auto-promote flip,
  strict-map paste (runbook Part B4's 8-client block), session-record flag, SR-7 revisit with
  sweep density.
- Doctrine ratify (S83 leftover).
- Delete old SSD vault at `SideHustles/TermDeck/mnestra-vault/` once the Crucial-X6 vault is
  confirmed opening in Obsidian.
- Brad: two-line Channel-2 activation when he's up; optional note that 1.18.0 adds
  standalone-shell capture (relevant only if he wants shims on his Mac).

## 5. Session-lesson digest (full text in Mnestra, sprint_ref=sprint-68-redux / post-s84-boot)

Dry-run gates skip write-side constraint checks (probe INSERT shapes in acceptance) · cron
ledger proves dispatch, not execution · self-referential shims must identify peers by
content, sentinel before every exec · capture at boundaries you own, not extension surfaces ·
wedge detectors need lane-completion state; quiet monitors are suspects too · acceptance
evidence carries a build-version; re-run after remediation · rulings bind prospectively —
diff post timestamps after every ruling · scanner pattern sets differ (gitleaks ≠ GitHub);
write token-shaped fixtures concatenated · `zsh -l -c` does not read `.zshrc`; probe with
`zsh -i -c` · half-staged lockstep pairs look installed while silently dark — acceptance must
walk the field install path.
