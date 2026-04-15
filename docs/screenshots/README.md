# TermDeck launch screenshots

Sprint 3 T1.3 reference stills + the hero Flashback-demo GIF procedure.

## What's here

| File | Size | What it is | Who captured | Use in launch |
|---|---:|---|---|---|
| `dashboard-4panel.png` | 175 KB | 2x2 layout, four populated panels (termdeck/mnestra/rumen/portfolio), commands visible in each | Playwright via headless chromium on :3001 (Sprint 3 T1) | README hero fallback if GIF can't embed; Show HN post body; blog post 1 architecture section |
| `drawer-open.png` | 372 KB | Same 2x2 layout, first panel's Commands drawer expanded showing `ls` + `git status` + `git log` history with click-to-copy chips | Playwright, Sprint 3 T1 | Blog post 1 "what it looks like" section; X thread tweet 3 (drawer feature) |
| `switcher.png` | 107 KB | Topbar slice — TermDeck brand + status counts + layout buttons + in-bar terminal switcher tiles (Alt+1..9) + launch buttons + help button | Playwright, Sprint 3 T1 | Blog post 1 tour; tweet 4 (switcher feature) |
| `flashback-demo.gif` | **NOT YET CAPTURED** | 10–14 s screencast of the Flashback hero moment | Josh (manual, QuickTime + ffmpeg) | README hero image; Show HN hero; blog post 1 lede; X thread tweet 1 |

## Why the three stills are Playwright-captured (not manual)

Terminal 1 has no screen access — it's running inside Josh's live TermDeck (PID 32489 on :3000). A headless chromium launched via Playwright against a second TermDeck on :3001 is the only way T1 could produce reference stills without human hands. Josh can always replace any of these with a hand-captured screenshot if the fidelity isn't right — the Playwright shots are good-enough scaffolding for the launch materials, not finals.

## The hero GIF — what's needed

This is **the** single most important launch asset. Every launch surface references it. The storyboard is tight (10–14s) and the timing beats matter because the point of the GIF is to sell the moment "I just broke something in my terminal, and TermDeck showed me how I fixed it last time — before I even asked."

### Setup (5 min)

1. **Close every other app** that might show a notification, badge, or sound during the recording (Slack, Mail, calendars, iMessage, etc.). Turn on Do Not Disturb.
2. **Dark desktop background.** Tokyo Night looks best against the default panel theme.
3. **Restart TermDeck clean** so there are no stale panels:
   ```sh
   pkill -f 'node packages/cli'
   cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
   npm run dev
   ```
   **⚠ WARNING to whoever runs this** — the `pkill` kills TermDeck PID 32489 which is Josh's live instance. It will kill any Claude Code session running inside a TermDeck panel. Do this from an external terminal (iTerm2, Terminal.app), NOT from inside TermDeck.
4. **Hard-reload the browser** (Cmd+Shift+R) on http://localhost:3000 so the dashboard starts clean with no cached tour state.
5. **Layout: click the 2x2 layout button** in the topbar (or press `Ctrl+Shift+4`).
6. **Launch 4 panels using the prompt bar at the bottom:**
   - Panel 1: type `shell` → Enter → a `/bin/zsh` panel opens. Project: no project (or "termdeck" if you pick one from the dropdown)
   - Panel 2: type `claude` → Enter → launches real Claude Code. Project: "termdeck". (Alternatively: `bash -c 'sleep 999999 & htop'` if Claude Code isn't installed.)
   - Panel 3: type `python3 -m http.server 8080` → Enter. Project: "termdeck". The panel should pick up `python_server` type + port 8080.
   - Panel 4: type `htop` → Enter. Fallback if `htop` isn't installed: `top`.
7. Let everything settle for 30 seconds. The metadata strips should show real-looking counts and statuses.

### The shot (10–14 seconds)

1. **Start screen recording with QuickTime.**
   - Open QuickTime Player → File → New Screen Recording.
   - Or press `Cmd+Shift+5`, click "Record Selected Portion".
   - Draw the capture region around the browser window only — **not** the full desktop. Target 1920 × 1080. Dock and menu bar should not be in frame.
   - Press Record.
2. **Focus Panel 1 (the shell panel).** Click inside its xterm area. Wait ~1 second with the cursor settled.
3. **Type the trigger command.** Use one of these — **DO NOT use `cat /nonexistent`**, it does not fire Flashback because `PATTERNS.error` at `packages/server/src/session.js:45` does not include "No such file or directory". Good triggers (all match `PATTERNS.error` as of 2026-04-14):
   - **Recommended (psql migration error, matches the plan's suggestion):**
     ```
     psql "$SUPABASE_URL" -c "ALTER TABLE foo ADD CONSTRAINT fk FOREIGN KEY (bar) REFERENCES nonexistent(id);"
     ```
     (Note: with the current stale creds in Rumen's `.env`, this will actually fail at the *connection* step rather than the constraint step. Both produce "ERROR" in the output, which matches the regex.)
   - **Alternative 1:** `python3 -c 'raise ValueError("cannot find users table")'` → produces a real `Traceback` matching `PATTERNS.error`
   - **Alternative 2:** `gitx status` (typo, deliberately) → produces `zsh: command not found: gitx` which matches
   - **Alternative 3:** `node -e 'throw new Error("redis connection refused")'` → matches `Error` AND `ECONNREFUSED` cleanly
4. **Pause for ~0.8 seconds** after the error prints. This is the critical "about to reach for docs" beat — the pause carries the narrative tension.
5. **The Flashback toast fades in from the right edge of Panel 1.** Real-world latency measured during T1.1 was 5.5 s end-to-end (OpenAI embedding + Supabase RPC). If the GIF's pace is too slow waiting for the toast, re-run with a shorter wait — the post-processing step will trim to the right rhythm.
6. **Move the mouse cursor slowly** toward the toast (don't snap — the drift sells it). Single click on the toast body.
7. **The Memory tab drawer opens on Panel 1.** The full hit renders with content + project tag + source_type + (if/when the Mnestra repo fix lands) similarity score.
8. **Pause for 2 seconds** on the expanded memory so the viewer can read it.
9. **Stop recording.**

### Post-processing (5 min)

1. Open the .mov in QuickTime (or any trimmer).
2. Trim hard — only keep the 10–14 seconds spanning typed-error → toast fade-in → click → memory opens → pause.
3. Export / convert to GIF. Two tools work:

   **Option A — `ffmpeg` (already installed on Josh's machine):**
   ```sh
   # Two-pass for a high-quality GIF with a palette
   ffmpeg -i input.mov -vf "fps=15,scale=1280:-1:flags=lanczos,palettegen" palette.png
   ffmpeg -i input.mov -i palette.png -filter_complex "fps=15,scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse" \
       -loop 0 docs/screenshots/flashback-demo.gif
   ```
   Expected output: ~3–4 MB for a 12-second clip at 1280 × (720-ish) and 15 fps.

   **Option B — `gifski` (nicer gradients, not currently installed):**
   ```sh
   brew install gifski
   ffmpeg -i input.mov -vf "fps=15,scale=1280:-1:flags=lanczos" -c:v png /tmp/frame%04d.png
   gifski -o docs/screenshots/flashback-demo.gif --fps 15 --quality 90 /tmp/frame*.png
   ```

4. **Check the size:** `ls -lh docs/screenshots/flashback-demo.gif`. Target < 4 MB so GitHub's README will embed it. If over 4 MB:
   - Reduce fps from 15 → 12 or 10
   - Reduce width from 1280 → 1000
   - Shorten the trim

### Acceptance

- [ ] `docs/screenshots/flashback-demo.gif` exists
- [ ] File is under 4 MB
- [ ] GIF plays the 10–14 s storyboard without gaps or visible frame drops
- [ ] Toast text is readable at the target width
- [ ] Memory drawer content is readable at the target width
- [ ] No notifications, badges, or other apps are visible in frame
- [ ] Three stills in `docs/screenshots/` still exist and render correctly

## Known non-blocking issues flagged by T1.1

These will affect the GIF's look-and-feel but are not blockers for launch:

- **End-to-end Flashback latency ~5.5 s** — slower than the 2 s target in the plan. The pause-before-toast will feel longer than ideal. Future perf follow-up: cache question embeddings, pre-emit during the output-buffer-flush pause.
- **Similarity score is undefined** on `proactive_memory.hit` payloads — the Mnemos-bridge's `memory_hybrid_search` RPC is not projecting a similarity column. Score will not appear in the drawer. UI still renders content/project/source_type/created_at fine. Fix belongs in the Mnemos repo, `migrations/002_mnestra_search_function.sql`.
- **`PATTERNS.error` miss on "No such file or directory"** — flagged above; use a different trigger command.

## Rename context (Mnestra → Mnemos)

The Mnestra → Mnemos rename lands mid-Sprint-3. Project tags in the screenshots still read "mnestra" because that's what's in `~/.termdeck/config.yaml` at the time of capture. After the main-agent's mechanical rename completes:

- Josh renames his `~/.termdeck/config.yaml` project from `mnestra` → `mnemos`
- Rename the local `/Users/joshuaizzard/Documents/Graciella/mnestra` directory → `mnemos`
- Re-run the Playwright capture (`/tmp/termdeck-t1/playwright-stills.js`) to get updated stills with "mnemos" project tags
- OR Josh hand-captures fresh stills at the same time as the hero GIF
