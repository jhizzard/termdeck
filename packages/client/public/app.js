/* Extracted from index.html 2026-04-15 — see git blame on index.html prior to commit UNCOMMITTED for history */
    // ===== TermDeck Client =====
    const API = window.location.origin;
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_BASE = `${WS_PROTOCOL}//${window.location.host}/ws`;

    // ===== Utilities =====
    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // State
    const state = {
      sessions: new Map(),   // id → { session, terminal, ws, fitAddon, el }
      layout: '2x1',
      themes: {},
      config: {},
      // Sprint 45 T4: serializable projection of the multi-agent registry
      // (server's AGENT_ADAPTERS). Populated from GET /api/agent-adapters
      // during init(). The launcher's command-shorthand parser reads this
      // to detect which adapter (if any) a typed command should map to.
      // Fallback list is the pre-Sprint-45 default so the launcher still
      // works if the endpoint 404s on an older server during a rolling
      // upgrade — Claude only, anchored binary match.
      agentAdapters: [{ name: 'claude', sessionType: 'claude-code', binary: 'claude', costBand: 'pay-per-token' }],
      focusedId: null,
      // Sprint 65 T1 — selected project-filter chip ('' = All). Hydrated from
      // localStorage in init(); a TDZ on PROJECT_FILTER_KEY prevents reading
      // it here in the state literal.
      projectFilter: '',
      // Sprint 65 T1 (c) — global terminal font size (xterm.js default 13).
      // Hydrated from localStorage in init() (same TDZ reason as projectFilter).
      fontSize: 13
    };

    // ===== API helpers =====
    async function api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${API}${path}`, opts);
      // Success path: unchanged — return the parsed JSON body verbatim.
      if (res.ok) return res.json();
      // Sprint 65 T1 (1.3b) — non-2xx: many callers gate on `.error` and
      // otherwise treat the body as success. A 4xx/5xx body without an
      // `error` key (e.g. the dead-panel shape 410 {ok:false,code,message})
      // would be misreported as delivered. annotateApiFailure() synthesizes a
      // uniform `error` field and surfaces `_httpStatus` for precise callers.
      let data = null;
      try { data = await res.json(); } catch (err) { /* non-JSON error body */ }
      return annotateApiFailure(data, res.status);
    }

    // ===== Initialize =====
    async function init() {
      // Sprint 65 T1 — hydrate saved client prefs before any panel mounts: the
      // project-filter chip (so a new tile filters right from frame 1) and the
      // terminal font size (so restored panels open at the operator's size).
      state.projectFilter = loadProjectFilter();
      state.fontSize = loadFontSize();
      // Load config
      state.config = await api('GET', '/api/config');
      updateRagIndicator();

      // Sprint 45 T4: fetch the multi-agent adapter registry projection.
      // Drives the launcher's command-shorthand → sessionType resolution
      // below in launchTerminal(). Falls back to the bootstrap default
      // (Claude only) if the endpoint isn't available on this server.
      try {
        const adapters = await api('GET', '/api/agent-adapters');
        if (Array.isArray(adapters) && adapters.length > 0) {
          state.agentAdapters = adapters;
        }
      } catch (_) { /* keep bootstrap fallback */ }

      // Sprint 50 T3 — adapter-driven launcher buttons. Render one button
      // per registered agent in the topbar quick-launch and the empty-state
      // tile group. Replaces the pre-Sprint-50 hardcoded `claude` button
      // that left Codex/Gemini/Grok with no one-click launcher (forcing
      // free-form `codex`/`gemini`/`grok` typing in the prompt bar — a v1.0.0
      // gate-blocker UX gap surfaced during the Sprint 49 mixed-agent
      // dogfood). Static `shell` + `python` entries stay (non-adapter
      // built-ins). HTML fallback shapes are preserved if rendering fails.
      try {
        renderQuickLaunchers();
      } catch (err) {
        console.warn('[client] launcher render failed, keeping HTML fallback:', err);
      }

      // Populate project dropdown
      const sel = document.getElementById('promptProject');
      for (const name of Object.keys(state.config.projects || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }

      // Load themes
      const themeList = await api('GET', '/api/themes');
      for (const t of themeList) {
        state.themes[t.id] = t;
      }

      // Load existing sessions
      const sessions = await api('GET', '/api/sessions');
      for (const s of sessions) {
        if (s.meta.status !== 'exited') {
          createTerminalPanel(s);
        }
      }

      // RAG indicator removed (Sprint 9 T2): redundant with health badge which
      // already surfaces mnestra_reachable / mnestra_has_memories per-check.
      // The #stat-rag HTML stub is hidden by default; T1 can strip it from
      // index.html.

      // Disable AI input bars if Supabase/OpenAI not configured
      if (!state.config.aiQueryAvailable) {
        document.querySelectorAll('.ctrl-input').forEach(el => {
          el.placeholder = 'Configure Supabase in ~/.termdeck/config.yaml to enable';
          el.disabled = true;
        });
      }

      updateEmptyState();

      // Sprint 65 T1 — initial restore complete: subsequent createTerminalPanel
      // calls are user-initiated launches, so arm the born-hidden chip guard.
      _initialLoadComplete = true;
      // Render chips + route the ORCH row now that the restored panels exist.
      refreshDashboardChrome();
      // Sprint 65 T1 (c) — sync the topbar font-size label to the saved size.
      applyFontSizeToAll();

      // Rumen insights badge + briefing (no-op when server reports enabled:false)
      setupRumen();

      // Health badge (Sprint 6 T4) — polls /api/health every 30s
      setupHealthBadge();

      // Transcript recovery UI (Sprint 6 T4) — depends on T3 endpoints
      setupTranscriptUI();

      // First-run onboarding tour. Fires on the first visit only; never again
      // unless the user explicitly clicks "how this works" in the top toolbar.
      try {
        if (!localStorage.getItem('termdeck:tour:seen')) {
          setTimeout(() => { if (!tourState.active) startTour(); }, 1200);
        }
      } catch {}

      // Sprint 19 T2: auto-open setup wizard if /api/setup reports firstRun.
      // Silent-fail if the endpoint isn't available yet (T1 not merged).
      maybeAutoOpenSetupWizard();

      // Sprint 37 T1: orchestrator Guide right-rail. Lazy — fetches the doc
      // on first expand to keep page load light.
      setupGuideRail();

      // 2026-05-08 hotfix: document-level capture-phase image-paste handler.
      // Intercepts Cmd+V image data before xterm-helper-textarea consumes it
      // (xterm reads only text/plain, drops images silently). See comment on
      // setupGlobalImagePaste() near uploadFilesAndType() for details.
      setupGlobalImagePaste();
    }

    // ===== Drag/drop reorder of PTY panels (Sprint 42 T4) =====
    // The grip handle in panel-header-left flips draggable=true on mousedown
    // so an accidental drag inside the xterm region never fires. Drop
    // position is determined by cursor x within the target panel — left half
    // inserts before, right half inserts after — so reordering matches the
    // intent in any grid layout (1x2, 2x2, 2x4, etc.). DOM reorder only;
    // session.creation-order remains canonical for Alt+1…9 and panel-index.
    function setupPanelDragDrop(panel) {
      const handle = panel.querySelector('.panel-drag-handle');
      if (!handle) return;

      handle.addEventListener('mousedown', () => { panel.draggable = true; });
      // Mouse leaves handle without a drag starting → reset
      handle.addEventListener('mouseleave', () => {
        if (!panel.classList.contains('dragging')) panel.draggable = false;
      });

      panel.addEventListener('dragstart', (e) => {
        if (!panel.draggable) { e.preventDefault(); return; }
        try { e.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
        try { e.dataTransfer.setData('text/plain', panel.id); } catch (_e) {}
        panel.classList.add('dragging');
      });

      panel.addEventListener('dragend', () => {
        panel.classList.remove('dragging');
        panel.draggable = false;
        document.querySelectorAll('.term-panel.drag-over').forEach((p) => p.classList.remove('drag-over'));
      });

      panel.addEventListener('dragover', (e) => {
        const dragging = document.querySelector('.term-panel.dragging');
        if (!dragging || dragging === panel) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
        panel.classList.add('drag-over');
      });

      panel.addEventListener('dragleave', (e) => {
        // Only clear when leaving the panel entirely (not entering a child).
        if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over');
      });

      panel.addEventListener('drop', (e) => {
        e.preventDefault();
        panel.classList.remove('drag-over');
        panel.classList.remove('file-drop-active');
        // External file drop (zip / image / any binary) → upload + type @path.
        // Detected when dataTransfer.files has entries and there's no internal panel drag.
        const files = e.dataTransfer && e.dataTransfer.files;
        const hasInternalDrag = !!document.querySelector('.term-panel.dragging');
        if (!hasInternalDrag && files && files.length > 0) {
          uploadFilesAndType(panel, Array.from(files));
          return;
        }
        const draggedId = (() => {
          try { return e.dataTransfer.getData('text/plain'); } catch (_e) { return ''; }
        })();
        const dragged = draggedId
          ? document.getElementById(draggedId)
          : document.querySelector('.term-panel.dragging');
        if (!dragged || dragged === panel) return;
        const rect = panel.getBoundingClientRect();
        const dropAfter = (e.clientX - rect.left) > rect.width / 2;
        panel.parentNode.insertBefore(dragged, dropAfter ? panel.nextSibling : panel);
      });

      // Sprint 59 scope-expansion (Brad's "drop a zip into Codex" question 2026-05-07):
      // file drop and clipboard image paste upload to /api/sessions/:id/upload, then type
      // @<path> via the existing /input endpoint so the agent (Claude/Codex/Gemini/Grok)
      // sees the standard @filepath attachment syntax.
      panel.addEventListener('dragover', (e) => {
        const types = (e.dataTransfer && e.dataTransfer.types) || [];
        const hasFiles = Array.from(types).includes('Files');
        if (!hasFiles) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_e) {}
        panel.classList.add('file-drop-active');
      });

      panel.addEventListener('dragleave', (e) => {
        if (!panel.contains(e.relatedTarget)) panel.classList.remove('file-drop-active');
      });

      panel.addEventListener('paste', (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const blobs = [];
        for (const item of items) {
          if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) blobs.push(blob);
          }
        }
        if (blobs.length === 0) return;
        e.preventDefault();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const named = blobs.map((b, i) => {
          const ext = (b.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
          const name = b.name && b.name.length > 0
            ? b.name
            : `pasted-${ts}${blobs.length > 1 ? '-' + i : ''}.${ext}`;
          return new File([b], name, { type: b.type });
        });
        uploadFilesAndType(panel, named);
      });
    }

    async function uploadFilesAndType(panel, files) {
      const sessionId = panel.id.replace(/^panel-/, '');
      for (const file of files) {
        try {
          const url = `/api/sessions/${sessionId}/upload?name=${encodeURIComponent(file.name)}`;
          const buf = await file.arrayBuffer();
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: buf,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('[upload] failed', res.status, errText);
            continue;
          }
          const data = await res.json();
          // Type "@<path> " into the panel via the existing /input endpoint so the
          // shape matches a manually-typed @filepath. The trailing space lets the
          // user keep typing the rest of their prompt.
          const inputRes = await fetch(`/api/sessions/${sessionId}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ text: `@${data.path} `, source: 'file-drop' }),
          });
          if (!inputRes.ok) {
            const errText = await inputRes.text().catch(() => '');
            console.error('[upload] file uploaded but typing failed', inputRes.status, errText);
          }
        } catch (err) {
          console.error('[upload] exception', err);
        }
      }
    }

    // Document-level capture-phase image paste handler.
    //
    // The Sprint 59 per-panel `paste` listener at line 218 is bubble-phase, but
    // xterm.js@5.5.0's hidden helper-textarea has its own `paste` handler that
    // reads only `clipboardData.getData('text/plain')`. Image data lives in
    // `clipboardData.items` with `kind: 'file'` and never reaches xterm's
    // text path — and the panel-level bubble-phase handler runs after xterm's,
    // by which point xterm has already returned (silently dropping the image).
    // Net: pre-fix, Cmd+V'ing a screenshot into a focused TermDeck panel did
    // nothing. Joshua reported this on 2026-05-08 (post-v1.1.0 upgrade).
    //
    // Fix: document-level listener with `{capture: true}` runs in capture
    // phase BEFORE the event reaches xterm-helper-textarea. If the event
    // target is inside a `.term-panel` AND the clipboard contains image
    // files, we preventDefault + stopPropagation (so xterm + the bubble-phase
    // panel handler don't see it) and route through `uploadFilesAndType`.
    // For text paste (no image files) we let the event continue normally.
    //
    // Idempotent: setupGlobalImagePaste() is called once from init().
    let _globalImagePasteSetup = false;
    function setupGlobalImagePaste() {
      if (_globalImagePasteSetup) return;
      _globalImagePasteSetup = true;
      document.addEventListener('paste', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const panel = target.closest('.term-panel');
        if (!panel) return;
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const blobs = [];
        for (const item of items) {
          if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) blobs.push(blob);
          }
        }
        if (blobs.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const named = blobs.map((b, i) => {
          const ext = (b.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
          const name = b.name && b.name.length > 0
            ? b.name
            : `pasted-${ts}${blobs.length > 1 ? '-' + i : ''}.${ext}`;
          return new File([b], name, { type: b.type });
        });
        uploadFilesAndType(panel, named);
      }, { capture: true });
    }

    // ===== termdeck#12 input guard (Sprint 73 T3) =====
    // Runaway-typed-input defense at the single chokepoint every byte of
    // human browser input flows through (the onData handler registered in
    // createTerminalPanel). xterm@5.5.0 reconstructs composition input from
    // its hidden textarea and can re-emit the accumulated buffer-so-far once
    // per word boundary on IME/mobile/remote keyboards — the #12 cumulative-
    // prefix runaway (~110 typed chars became a 3,042-char PTY stream).
    // Detection logic lives in input-guard.js (UMD, unit-tested from node);
    // these helpers wire it to panel state and the operator surface.
    // Suppression is loud (console.error + panel toast), never silent;
    // oversize chunks can be sent anyway from the toast.
    function shouldSuppressPanelInput(entry, id, data) {
      if (!entry._inputGuard) entry._inputGuard = InputGuard.createGuard();
      const result = InputGuard.check(entry._inputGuard, data, Date.now());
      if (result.verdict === 'pass') return false;
      console.error(
        `[input-guard] suppressed ${result.reason} input on panel ${id} ` +
        `(chunk ${data.length} chars, chain ${result.chainLength}, ` +
        `total suppressed ${result.suppressedCount} chunks / ${result.suppressedChars} chars):`,
        JSON.stringify(data.slice(0, 120))
      );
      showInputGuardToast(entry, id, result, data);
      return true;
    }

    function showInputGuardToast(entry, id, result, data) {
      if (!entry || !entry.el) return;

      // One toast per panel: repeated suppressions update the counter line
      // (a runaway fires per word boundary — stacking toasts would bury the
      // panel) and refresh the held chunk + auto-dismiss timer.
      const existing = entry.el.querySelector('.input-guard-toast');
      if (existing) {
        const counter = existing.querySelector('.t-meta');
        if (counter) counter.textContent = `${result.suppressedCount} chunks (${result.suppressedChars} chars) suppressed so far.`;
        if (result.reason === 'oversize') existing._heldChunk = data;
        clearTimeout(existing._autoTimer);
        existing._autoTimer = setTimeout(() => existing.remove(), 60000);
        return;
      }

      const toast = document.createElement('div');
      toast.className = 'input-guard-toast';
      const why = result.reason === 'oversize'
        ? 'a single typed chunk was implausibly large'
        : 'the keyboard started re-sending the whole buffer-so-far per keystroke (xterm composition runaway — termdeck#12)';
      toast.innerHTML = `
        <button class="t-dismiss" aria-label="Dismiss">×</button>
        <div class="t-title">Input guard — runaway typing suppressed</div>
        <div class="t-body">Blocked because ${why}. Check the terminal's input line before pressing Enter; clear it if it shows repeated text.${result.reason === 'oversize' ? ' If this was intentional, send it below.' : ''}</div>
        <div class="t-meta">${result.suppressedCount} chunks (${result.suppressedChars} chars) suppressed so far.</div>
        ${result.reason === 'oversize' ? '<button class="t-send-anyway">Send anyway</button>' : ''}
      `;
      if (result.reason === 'oversize') toast._heldChunk = data;
      entry.el.appendChild(toast);

      toast.querySelector('.t-dismiss').addEventListener('click', () => {
        clearTimeout(toast._autoTimer);
        toast.remove();
      });
      const sendBtn = toast.querySelector('.t-send-anyway');
      if (sendBtn) {
        sendBtn.addEventListener('click', () => {
          const live = state.sessions.get(id);
          if (toast._heldChunk && live && live.ws && live.ws.readyState === WebSocket.OPEN) {
            live.ws.send(JSON.stringify({ type: 'input', data: toast._heldChunk }));
          }
          clearTimeout(toast._autoTimer);
          toast.remove();
        });
      }
      toast._autoTimer = setTimeout(() => toast.remove(), 60000);
    }

    // ===== Create Terminal Panel =====
    function createTerminalPanel(sessionData) {
      const id = sessionData.id;
      const meta = sessionData.meta;

      // Idempotency guard: multiple code paths can trigger this function for
      // the same session ID in rapid succession — status_broadcast handler
      // (2s interval), external-session poller (3s interval), launchTerminal
      // (immediate after POST), and init() on page load. Without a claim at
      // function entry, two of these can race and create two client panels
      // for the same server session — which means two WebSockets, the second
      // overwrites session.ws on the server, and term.onData output stops
      // reaching the first panel's xterm. Result: terminals spawn but never
      // render a prompt and don't accept input.
      //
      // Fix: reserve the slot in state.sessions immediately on entry. Any
      // subsequent call sees has(id) and early-returns. The full entry gets
      // written later when the xterm + ws + fitAddon are built; that write
      // overwrites this placeholder in place.
      if (state.sessions.has(id)) return;
      state.sessions.set(id, { _mounting: true });

      // Hide empty state
      document.getElementById('emptyState').style.display = 'none';

      // Project CSS class
      const projClass = meta.project
        ? `project-${meta.project.replace(/[^a-z0-9]/gi, '').toLowerCase()}`
        : 'project-default';

      // Build panel HTML
      const panel = document.createElement('div');
      panel.className = 'term-panel';
      panel.id = `panel-${id}`;
      panel.innerHTML = `
        <div class="panel-header">
          <div class="panel-header-left">
            <span class="panel-drag-handle" title="Drag to reorder">⋮⋮</span>
            <span class="status-dot" id="dot-${id}" style="background:${getStatusColor(meta.status)}"></span>
            <span class="panel-type">${getTypeLabel(meta.type)}</span>
            ${meta.project ? `<span class="panel-project ${projClass}">${meta.project}</span>` : ''}
            <span class="panel-index" id="idx-${id}"></span>
            <span class="panel-sid" title="Session ID: ${id}">${id.slice(0, 8)}</span>
            <span class="panel-status" id="status-${id}">${meta.statusDetail || meta.status}</span>
            <!-- Sprint 80 T2 (FR-5) — live context-size counter. Dedicated node,
                 populated by updateContextBadge(); hidden until a Claude panel
                 reports a contextK. Not touched by role logic. -->
            <span class="panel-ctx" id="ctx-${id}" style="display:none"></span>
          </div>
          <div class="panel-header-right">
            <button class="panel-btn" onclick="focusPanel('${id}')" title="Focus this terminal">&#9634;</button>
            <button class="panel-btn" onclick="halfPanel('${id}')" title="Half screen">&#9645;</button>
            <button class="panel-btn danger" onclick="closePanel('${id}')" title="Close terminal">&times;</button>
          </div>
        </div>
        <div class="panel-meta">
          <span class="meta-item"><span class="meta-label">opened</span> ${timeAgo(meta.createdAt)}</span>
          <span class="meta-item"><span class="meta-label">why</span> ${meta.reason}</span>
          <span class="meta-item" id="meta-last-${id}"><span class="meta-label">last</span> ${meta.lastCommands?.length ? meta.lastCommands[meta.lastCommands.length - 1].command : '—'}</span>
          <span class="meta-item" id="meta-port-${id}" style="${meta.detectedPort ? '' : 'display:none'}"><span class="meta-label">port</span> <span class="meta-value">:${meta.detectedPort || ''}</span></span>
          <span class="meta-item" id="meta-reqs-${id}" style="${meta.type === 'python-server' ? '' : 'display:none'}"><span class="meta-label">reqs</span> <span class="meta-value">${meta.requestCount || 0}</span></span>
        </div>
        <div class="panel-terminal" id="term-${id}"></div>
        <div class="panel-drawer" id="drawer-${id}">
          <div class="drawer-tabs" role="tablist">
            <button class="drawer-tab active" data-tab="overview" data-panel-id="${id}">Overview</button>
            <button class="drawer-tab" data-tab="commands" data-panel-id="${id}">Commands<span class="tab-badge" id="badge-commands-${id}">0</span></button>
            <button class="drawer-tab" data-tab="memory" data-panel-id="${id}">Memory<span class="tab-badge" id="badge-memory-${id}">0</span></button>
            <button class="drawer-tab" data-tab="log" data-panel-id="${id}">Status log<span class="tab-badge" id="badge-log-${id}">0</span></button>
          </div>
          <div class="drawer-body">
            <div class="drawer-panel drawer-overview active" data-panel="overview">
              <div class="overview-controls">
                <select class="theme-select" id="theme-${id}" onchange="changeTheme('${id}', this.value)">
                  ${Object.entries(state.themes).map(([tid, t]) =>
                    `<option value="${tid}" ${tid === meta.theme ? 'selected' : ''}>${t.label}</option>`
                  ).join('')}
                </select>
                <a class="theme-reset" id="theme-reset-${id}" href="javascript:void(0)" onclick="resetTheme('${id}')" title="Revert to project / global default from config.yaml" style="font-size:11px;color:#7aa2f7;text-decoration:none;margin-left:4px;opacity:0.7;cursor:pointer">↺ default</a>
                <button class="ctrl-btn" onclick="focusPanel('${id}')">focus</button>
                <button class="ctrl-btn" onclick="halfPanel('${id}')">half</button>
                <button class="ctrl-btn orch-toggle${isOrchestratorRole(meta.role) ? ' is-orch' : ''}" id="orch-toggle-${id}" type="button" onclick="toggleOrchestratorRole('${id}')" title="${isOrchestratorRole(meta.role) ? 'Unmark this panel (remove the orchestrator role)' : 'Mark this panel as the master orchestrator — gold border, ORCH★ badge, pinned row'}">${orchToggleLabel(meta.role)}</button>
                <button class="ctrl-btn reply-toggle" id="reply-btn-${id}" onclick="toggleReplyForm('${id}')" title="Send text to another terminal">reply ▸</button>
                <input type="text" class="ctrl-input" id="ai-${id}" placeholder="Ask about this terminal..." onkeydown="if(event.key==='Enter')askAI('${id}', this.value)">
              </div>
              <div class="reply-form" id="reply-form-${id}">
                <select class="reply-target" id="reply-target-${id}"></select>
                <input type="text" class="reply-text" id="reply-text-${id}" placeholder="Text to send..." onkeydown="if(event.key==='Enter')sendReply('${id}')">
                <button class="reply-send" id="reply-send-${id}" onclick="sendReply('${id}')">send</button>
                <div class="reply-status" id="reply-status-${id}"></div>
              </div>
              <div class="overview-meta" id="ovmeta-${id}"></div>
            </div>
            <div class="drawer-panel drawer-list" data-panel="commands" id="dp-commands-${id}">
              <div class="empty-msg">No commands captured yet.</div>
            </div>
            <div class="drawer-panel drawer-list" data-panel="memory" id="dp-memory-${id}">
              <div class="empty-msg">No memory hits yet. Ask about this terminal or wait for a proactive lookup.</div>
            </div>
            <div class="drawer-panel drawer-list" data-panel="log" id="dp-log-${id}">
              <div class="empty-msg">No status transitions recorded yet.</div>
            </div>
          </div>
        </div>
      `;

      // Sprint 65 T1 (1.2) — orchestrator panels render in the pinned ORCH
      // row above the grid; everything else goes in the grid.
      placePanel(panel, meta);

      // Sprint 42 T4: drag/drop reorder. Inject identifier is the session
      // UUID, so DOM reorder is purely visual — Alt+1…9 (creation-order),
      // /api/sessions/:id/input, and reply-form targets are unaffected.
      setupPanelDragDrop(panel);

      // Sprint 72 T3 — web-chat (Grok) panels render a live screencast canvas +
      // an inject input box instead of an xterm. Branch AFTER the shared chrome
      // (header/meta/drawer) is built, then return; the entire xterm path below
      // stays byte-identical for every other panel type.
      if (meta.type === 'web-chat') {
        return mountWebChatPanel(id, sessionData, panel);
      }

      // Create xterm.js instance
      const terminal = new Terminal({
        fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace",
        fontSize: state.fontSize,
        lineHeight: 1.3,
        cursorBlink: true,
        cursorStyle: 'bar',
        allowProposedApi: true,
        scrollback: 5000,
        theme: getThemeObject(meta.theme)
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon.WebLinksAddon();
      terminal.loadAddon(webLinksAddon);

      const container = document.getElementById(`term-${id}`);
      terminal.open(container);

      // Delay fit to ensure DOM is ready
      requestAnimationFrame(() => {
        fitAddon.fit();
        // Inform server of initial size
        api('POST', `/api/sessions/${id}/resize`, {
          cols: terminal.cols,
          rows: terminal.rows
        });
      });

      // Connect WebSocket
      const ws = new WebSocket(`${WS_BASE}?session=${id}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'output':
              terminal.write(msg.data);
              break;
            case 'meta':
              updatePanelMeta(id, msg.session.meta);
              break;
            case 'proactive_memory':
              showProactiveToast(id, msg.hit, msg.flashback_event_id);
              break;
            case 'exit':
              updatePanelMeta(id, {
                status: 'exited',
                statusDetail: `Exited (${msg.exitCode})`
              });
              // Dim the panel
              const exitPanel = document.getElementById(`panel-${id}`);
              if (exitPanel) exitPanel.classList.add('exited');
              refreshAllReplyFormsFor(id);
              refreshPanelIndices();
              renderSwitcher();
              break;
            case 'panel_exited':
              // Sprint 65 T1 (1.3) — T2 broadcasts this when a PTY exits.
              // Primary path for auto-removing the dead tile from the grid.
              handlePanelExited(msg.sessionId, msg.exitCode);
              break;
            case 'status_broadcast':
              updateGlobalStats(msg.sessions);
              break;
            case 'config_changed':
              // Sprint 36 T3 Deliverable A: server-broadcast on PATCH /api/config.
              // Each open panel WebSocket receives one copy; the handler is
              // idempotent so multiple receipts settle the same state.
              if (msg.config) {
                state.config = { ...state.config, ...msg.config };
                if (typeof renderSettingsPanel === 'function') renderSettingsPanel();
                if (typeof updateRagIndicator === 'function') updateRagIndicator();
              }
              break;
            case 'projects_changed':
              // Sprint 42 T4: server broadcasts on POST/DELETE /api/projects.
              // Sync the in-memory projects map and re-render the dropdown so
              // other open dashboard tabs stay consistent without a refresh.
              if (msg.projects && state.config) {
                state.config.projects = msg.projects;
                if (typeof rebuildProjectDropdown === 'function') rebuildProjectDropdown();
              }
              break;
          }
        } catch (err) { console.error('[client] ws message parse failed:', err); }
      };

      ws.onclose = (event) => {
        console.log(`[ws] Disconnected from session ${id} (code ${event.code})`);
        const entry = state.sessions.get(id);
        if (!entry) return;

        // Don't reconnect if session was explicitly closed or exited
        if (event.code === 4000 || event.code === 4001) return;
        const panel = document.getElementById(`panel-${id}`);
        if (panel && panel.classList.contains('exited')) return;

        // Auto-reconnect with backoff
        const delay = Math.min(1000 * Math.pow(2, (entry._reconnectAttempts || 0)), 10000);
        entry._reconnectAttempts = (entry._reconnectAttempts || 0) + 1;

        if (entry._reconnectAttempts <= 5) {
          console.log(`[ws] Reconnecting session ${id} in ${delay}ms (attempt ${entry._reconnectAttempts})`);
          setTimeout(() => reconnectSession(id), delay);
        } else {
          updatePanelMeta(id, { status: 'errored', statusDetail: 'Connection lost' });
        }
      };

      // Terminal input → WebSocket. Registered ONCE per Terminal instance and
      // never re-registered: xterm's onData ADDS listeners, and the
      // pre-Sprint-73 reconnect path stacked one leaked handler (closed over
      // its dead socket) per reconnect — the termdeck#12 cause-B family. The
      // handler dereferences entry.ws at event time, so reconnectSession just
      // swaps entry.ws and this same registration follows it.
      // shouldSuppressPanelInput is the #12 runaway chokepoint — every byte
      // of human browser input to this PTY flows through this closure.
      terminal.onData((data) => {
        const entry = state.sessions.get(id);
        if (!entry || entry._mounting || !entry.ws) return;
        if (shouldSuppressPanelInput(entry, id, data)) return;
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Track focus
      terminal.textarea?.addEventListener('focus', () => {
        panel.classList.add('active-input');
        state.focusedId = id;
      });
      terminal.textarea?.addEventListener('blur', () => {
        panel.classList.remove('active-input');
      });

      // termdeck#12 (Sprint 73 T3) — two defenses on xterm's hidden textarea:
      //
      // (a) Paste tracking for the input guard: a DOM `paste` event stamps
      //     the guard so the following chunk is exempt — pastes are
      //     deliberate bulk input, and without the stamp a large
      //     un-bracketed paste would false-trip the oversize detector.
      //
      // (b) Idle-clear of the textarea. xterm@5.5.0 clears its helper
      //     textarea only on non-composition Enter/Ctrl+C keydowns
      //     (Terminal.ts:1066-1068); on composition keyboards (every keydown
      //     = keyCode 229: mobile/IME/dictation/remote bridges) that clear
      //     never fires, the textarea accumulates the whole message, and
      //     CompositionHelper's replace/substring reconstruction can re-emit
      //     the accumulated buffer once per word boundary — the #12
      //     cumulative-prefix runaway. Clearing after a short typing lull
      //     (never mid-composition; composition state tracked via the public
      //     compositionstart/end events) bounds what those paths can
      //     reconstruct to a single typing burst. xterm's own deferred
      //     textarea reads are setTimeout(0) — far inside the 250ms debounce
      //     — so the clear cannot race them.
      const guardTa = terminal.textarea;
      if (guardTa) {
        let composing = false;
        let idleClearTimer = null;
        const armIdleClear = () => {
          if (idleClearTimer) clearTimeout(idleClearTimer);
          idleClearTimer = setTimeout(() => {
            idleClearTimer = null;
            if (!composing && guardTa.value) guardTa.value = '';
          }, 250);
        };
        guardTa.addEventListener('compositionstart', () => { composing = true; });
        guardTa.addEventListener('compositionend', () => { composing = false; armIdleClear(); });
        guardTa.addEventListener('keydown', armIdleClear);
        guardTa.addEventListener('input', armIdleClear);
        guardTa.addEventListener('paste', () => {
          const entry = state.sessions.get(id);
          if (!entry) return;
          if (!entry._inputGuard) entry._inputGuard = InputGuard.createGuard();
          InputGuard.notePaste(entry._inputGuard, Date.now());
        });
      }

      // Store reference
      state.sessions.set(id, {
        session: sessionData,
        terminal,
        ws,
        fitAddon,
        el: panel,
        activeTab: 'overview',
        drawerOpen: false,
        commandHistory: [],
        commandsLoaded: false,
        memoryHits: [],
        statusLog: [],
        lastKnownStatus: meta.status,
      });

      // Seed an initial status-log entry so the tab isn't blank
      appendStatusLog(id, meta.status, meta.statusDetail || '');

      // Drawer tab wiring
      setupDrawerListeners(id);
      renderOverviewTab(id);
      renderSwitcher();

      // Reply form: disabled until there's another panel to target
      const replyBtn = document.getElementById(`reply-btn-${id}`);
      if (replyBtn) replyBtn.disabled = state.sessions.size < 2;
      refreshAllReplyFormsFor(id);
      refreshPanelIndices();
      // Sprint 65 T1 — a user-launched panel must never be born hidden behind a
      // stale chip filter (T3 20:10 / T4 20:11): switch the filter to its
      // project first, then refresh chrome so the new tile is visible.
      revealNewPanelIfFiltered(meta);
      refreshDashboardChrome();

      // Handle window resize
      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'resize',
              cols: terminal.cols,
              rows: terminal.rows
            }));
          }
        } catch (err) { console.error('[client] terminal resize failed:', err); }
      });
      resizeObserver.observe(container);

      return { terminal, ws, fitAddon };
    }

    // ===== Sprint 72 T3: web-chat (Grok) canvas panel =====
    // A web-chat panel mirrors a real, logged-in headful grok.com tab: T1's CDP
    // screencast frames paint to a <canvas>; an input box injects a prompt into
    // the live composer (T2 routes {type:'input'} → grok.inject); and canvas
    // mouse/wheel events forward back to the tab ({type:'web-chat-input'} →
    // handle.sendInput) so the human can drive it in-deck. The xterm render path
    // (createTerminalPanel, above) is untouched for every non-web-chat panel.

    function ensureWebChatStyles() {
      if (document.getElementById('wc-styles')) return;
      const style = document.createElement('style');
      style.id = 'wc-styles';
      style.textContent = [
        '.panel-terminal.web-chat-terminal{display:flex;flex-direction:column;height:100%;min-height:0;background:#000;}',
        '.web-chat-stage{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;}',
        '.web-chat-canvas{display:block;max-width:100%;max-height:100%;outline:none;}',
        '.web-chat-input-bar{display:flex;gap:6px;padding:6px;border-top:1px solid #1f2335;background:#16161e;}',
        '.web-chat-input{flex:1;min-width:0;padding:6px 8px;border:1px solid #1f2335;border-radius:6px;background:#1a1b26;color:#c0caf5;font:13px/1.3 inherit;}',
        '.web-chat-input:focus{outline:none;border-color:#7aa2f7;}',
        '.web-chat-send{padding:6px 14px;border:0;border-radius:6px;background:#7aa2f7;color:#0b0b14;font-weight:600;cursor:pointer;}',
        '.web-chat-send:hover{background:#8fb3ff;}',
      ].join('');
      document.head.appendChild(style);
    }

    // Build the two WS frames that drive T2's server-side two-stage assembler
    // (routeWebChatInput): (1) the prompt wrapped in bracketed-paste markers —
    // buffered server-side after the markers are stripped — then (2) a lone CR,
    // the submit signal that fires grok.inject on the accumulated text. The
    // wrapper is what makes a MULTI-LINE prompt safe: the server submits on a
    // TRAILING CR, so a naive `text + '\r'` would submit early on an embedded
    // newline. Same shape as the 4+1 orchestrator inject. Pure (vm-extract tested).
    function webChatSubmitFrames(text) {
      return [
        { type: 'input', data: '\x1b[200~' + String(text) + '\x1b[201~' },
        { type: 'input', data: '\r' },
      ];
    }

    function mountWebChatPanel(id, sessionData, panel) {
      const meta = sessionData.meta;
      ensureWebChatStyles();

      const container = document.getElementById(`term-${id}`);
      container.classList.add('web-chat-terminal');
      container.innerHTML =
        `<div class="web-chat-stage" id="wc-stage-${id}">` +
          `<canvas class="web-chat-canvas" id="wc-canvas-${id}" tabindex="0"></canvas>` +
        `</div>` +
        `<form class="web-chat-input-bar" id="wc-form-${id}" autocomplete="off">` +
          `<input type="text" class="web-chat-input" id="wc-input-${id}" placeholder="Message Grok…  (Enter sends into the live session)">` +
          `<button type="submit" class="web-chat-send" id="wc-send-${id}">send</button>` +
        `</form>`;

      const stage = document.getElementById(`wc-stage-${id}`);
      const canvas = document.getElementById(`wc-canvas-${id}`);
      const ctx = canvas.getContext('2d');
      const inputEl = document.getElementById(`wc-input-${id}`);
      const formEl = document.getElementById(`wc-form-${id}`);

      let lastImg = null, lastDevW = 0, lastDevH = 0, map = null;

      // Paint one screencast frame. T1's frame-channel shape exposes `dataUrl`
      // (drops straight into Image.src) + deviceWidth/deviceHeight (the page
      // viewport in CSS px, needed to map clicks back to page coordinates).
      function paintFrame(frame) {
        if (!frame) return;
        const url = frame.dataUrl || (frame.data ? `data:image/${frame.format || 'jpeg'};base64,${frame.data}` : null);
        if (!url) return;
        const img = new Image();
        img.onload = () => {
          lastImg = img;
          lastDevW = frame.deviceWidth || img.naturalWidth;
          lastDevH = frame.deviceHeight || img.naturalHeight;
          drawLastFrame();
        };
        img.src = url;
      }

      // Letterbox the last frame into the canvas, tracking the transform so
      // pointer events can be mapped back to page coordinates.
      function drawLastFrame() {
        if (!lastImg) return;
        const rect = stage.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round(rect.width)), ch = Math.max(1, Math.round(rect.height));
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
          canvas.width = Math.round(cw * dpr);
          canvas.height = Math.round(ch * dpr);
          canvas.style.width = cw + 'px';
          canvas.style.height = ch + 'px';
        }
        const iw = lastImg.naturalWidth, ih = lastImg.naturalHeight;
        const scale = Math.min(canvas.width / iw, canvas.height / ih);
        const dw = iw * scale, dh = ih * scale;
        const dx = (canvas.width - dw) / 2, dy = (canvas.height - dh) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(lastImg, dx, dy, dw, dh);
        map = { dx, dy, scale, iw, ih, dpr };
      }

      // canvas client px → page CSS px (or null if the click hit the letterbox).
      function mapToPage(clientX, clientY) {
        if (!map || !lastDevW || !lastDevH) return null;
        const rect = canvas.getBoundingClientRect();
        const px = (clientX - rect.left) * map.dpr, py = (clientY - rect.top) * map.dpr;
        const ix = (px - map.dx) / map.scale, iy = (py - map.dy) / map.scale;
        if (ix < 0 || iy < 0 || ix > map.iw || iy > map.ih) return null;
        return { x: Math.round(ix * (lastDevW / map.iw)), y: Math.round(iy * (lastDevH / map.ih)) };
      }

      function liveWs() { const e = state.sessions.get(id); return e && e.ws; }
      // Submit a composer prompt via T2's two-stage assembler (bracketed-paste
      // body buffered, then a lone CR fires grok.inject). NOT a single raw
      // {type:'input',data:text} — that has no submit sentinel and buffers
      // server-side forever (T4 FINDING 13:30).
      function sendComposerSubmit(text) {
        const ws = liveWs();
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        for (const frame of webChatSubmitFrames(text)) ws.send(JSON.stringify(frame));
        return true;
      }
      function sendCdpEvent(event) {
        const ws = liveWs();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'web-chat-input', event }));
      }

      // Input box → submit the prompt into the live composer via the two-stage
      // assembler. Clearing the field is gated on the WS send so a prompt is
      // never silently lost when the socket is down.
      formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputEl.value;
        if (!text.trim()) return;
        if (sendComposerSubmit(text)) inputEl.value = '';
      });
      inputEl.addEventListener('focus', () => { panel.classList.add('active-input'); state.focusedId = id; });
      inputEl.addEventListener('blur', () => { panel.classList.remove('active-input'); });

      // Canvas → forward clicks + wheel to the live tab so the human can drive
      // it in-deck. (Text typing stays in the input box for v1; full keyboard
      // forwarding is a future enhancement to avoid hijacking deck shortcuts.)
      canvas.addEventListener('mousedown', (e) => {
        const pt = mapToPage(e.clientX, e.clientY); if (!pt) return;
        canvas.focus(); state.focusedId = id;
        sendCdpEvent({ kind: 'mouse', type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      });
      canvas.addEventListener('mouseup', (e) => {
        const pt = mapToPage(e.clientX, e.clientY); if (!pt) return;
        sendCdpEvent({ kind: 'mouse', type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      });
      canvas.addEventListener('wheel', (e) => {
        const pt = mapToPage(e.clientX, e.clientY); if (!pt) return;
        e.preventDefault();
        sendCdpEvent({ kind: 'mouse', type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY });
      }, { passive: false });

      const ws = new WebSocket(`${WS_BASE}?session=${id}`);
      ws.onmessage = (event) => handleWebChatWsMessage(id, event, paintFrame);
      ws.onclose = (event) => {
        const e2 = state.sessions.get(id); if (!e2) return;
        if (event.code === 4000 || event.code === 4001) return;
        const p = document.getElementById(`panel-${id}`);
        if (p && p.classList.contains('exited')) return;
        const delay = Math.min(1000 * Math.pow(2, (e2._reconnectAttempts || 0)), 10000);
        e2._reconnectAttempts = (e2._reconnectAttempts || 0) + 1;
        if (e2._reconnectAttempts <= 5) setTimeout(() => reconnectWebChat(id), delay);
        else updatePanelMeta(id, { status: 'errored', statusDetail: 'Connection lost' });
      };

      // Re-letterbox on panel resize (fitAll() also calls our fitAddon.fit()).
      const resizeObserver = new ResizeObserver(() => { try { drawLastFrame(); } catch (err) { /* ignore */ } });
      resizeObserver.observe(stage);

      state.sessions.set(id, {
        session: sessionData,
        ws,
        el: panel,
        isWebChat: true,
        canvas, ctx, inputEl,
        paintFrame, drawLastFrame,
        // No xterm. A no-op-ish fitAddon keeps fitAll()/drawer-resize loops safe
        // AND re-letterboxes the canvas on a global re-fit.
        fitAddon: { fit() { drawLastFrame(); } },
        activeTab: 'overview',
        drawerOpen: false,
        commandHistory: [],
        commandsLoaded: false,
        memoryHits: [],
        statusLog: [],
        webChatLog: [],
        lastKnownStatus: meta.status,
      });

      appendStatusLog(id, meta.status, meta.statusDetail || '');
      setupDrawerListeners(id);
      renderOverviewTab(id);
      renderSwitcher();
      const replyBtn = document.getElementById(`reply-btn-${id}`);
      if (replyBtn) replyBtn.disabled = state.sessions.size < 2;
      refreshAllReplyFormsFor(id);
      refreshPanelIndices();
      revealNewPanelIfFiltered(meta);
      refreshDashboardChrome();
      requestAnimationFrame(() => drawLastFrame());

      return { ws, canvas };
    }

    // Shared WS dispatch for web-chat panels (used by both initial mount and
    // reconnect). Mirrors the xterm handler's non-output cases exactly (same
    // downstream fns) but routes screencast frames → canvas and grok text → an
    // in-memory transcript instead of writing to an xterm.
    function handleWebChatWsMessage(id, event, paintFrame) {
      let msg;
      try { msg = JSON.parse(event.data); }
      catch (err) { console.error('[client] web-chat ws parse failed:', err); return; }
      const entry = state.sessions.get(id);
      switch (msg.type) {
        case 'web-chat-frame':
          if (paintFrame) paintFrame(msg.frame);
          else if (entry && entry.paintFrame) entry.paintFrame(msg.frame);
          break;
        case 'output':
          // Grok response text. The canvas is the visual; keep a transcript for
          // potential future drawer rendering. Never write to a (nonexistent) xterm.
          if (entry) { (entry.webChatLog = entry.webChatLog || []).push(msg.data); }
          break;
        case 'meta':
          updatePanelMeta(id, msg.session.meta);
          break;
        case 'proactive_memory':
          showProactiveToast(id, msg.hit, msg.flashback_event_id);
          break;
        case 'exit': {
          updatePanelMeta(id, { status: 'exited', statusDetail: `Exited (${msg.exitCode})` });
          const p = document.getElementById(`panel-${id}`);
          if (p) p.classList.add('exited');
          refreshAllReplyFormsFor(id);
          refreshPanelIndices();
          renderSwitcher();
          break;
        }
        case 'panel_exited':
          handlePanelExited(msg.sessionId, msg.exitCode);
          break;
        case 'status_broadcast':
          updateGlobalStats(msg.sessions);
          break;
        case 'config_changed':
          if (msg.config) {
            state.config = { ...state.config, ...msg.config };
            if (typeof renderSettingsPanel === 'function') renderSettingsPanel();
            if (typeof updateRagIndicator === 'function') updateRagIndicator();
          }
          break;
        case 'projects_changed':
          if (msg.projects && state.config) {
            state.config.projects = msg.projects;
            if (typeof rebuildProjectDropdown === 'function') rebuildProjectDropdown();
          }
          break;
      }
    }

    function reconnectWebChat(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      const ws = new WebSocket(`${WS_BASE}?session=${id}`);
      ws.onmessage = (event) => handleWebChatWsMessage(id, event, entry.paintFrame);
      ws.onopen = () => {
        entry._reconnectAttempts = 0;
        entry.ws = ws;
        updatePanelMeta(id, { status: 'active', statusDetail: 'Reconnected' });
      };
      ws.onclose = (event) => {
        const p = document.getElementById(`panel-${id}`);
        if (p && p.classList.contains('exited')) return;
        if (event.code === 4001) {
          updatePanelMeta(id, { status: 'exited', statusDetail: 'Session ended' });
          if (p) p.classList.add('exited');
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, (entry._reconnectAttempts || 0)), 10000);
        entry._reconnectAttempts = (entry._reconnectAttempts || 0) + 1;
        if (entry._reconnectAttempts <= 5) setTimeout(() => reconnectWebChat(id), delay);
        else updatePanelMeta(id, { status: 'errored', statusDetail: 'Connection lost' });
      };
    }

    // ===== Sprint 65: project-filter chips + ORCH-panel pin + tile lifecycle =====
    // Brad's 2026-05-13 v2 spec (BACKLOG § D.5) — three dashboard-reliability
    // surfaces sharing one client-side lane:
    //   1.1  project-filter chips — a per-project visibility filter above the grid
    //   1.2  ORCH pin — panels with meta.role==='orchestrator' get a dedicated
    //        always-visible row + gold/amber treatment, outside the chip filter
    //   1.3  tile auto-removal — dead PTY panels leave the grid instead of
    //        lingering as "dead" tiles (Brad's "18 windows, 10 dead codex cli")
    //
    // Design note: TermDeck panels are persistent DOM + live xterm.js + a
    // per-panel WebSocket. They are created once (createTerminalPanel) and
    // never re-rendered per frame — status_broadcast only mutates meta. So the
    // chip row and filter work by toggling classes on existing tiles, never by
    // tearing panels down; ORCH routing is decided at panel-create time and
    // re-checked cheaply on each broadcast.

    const PROJECT_FILTER_KEY = 'termdeck.dashboard.projectFilter';
    // Belt-and-suspenders thresholds for tile reconciliation (reconcileExitedPanels).
    // ORPHAN_GRACE_MS > the tile-exit grace so the primary panel_exited path
    // always wins when the WS frame is delivered.
    const ORPHAN_GRACE_MS = 5000;
    const STALE_EXITED_MS = 60000;
    let _chromeRefreshScheduled = false;
    // false during init()'s panel-restore loop, true afterward. Gates the
    // born-hidden chip guard so a saved filter is honored on reload but a
    // user-launched panel is always revealed.
    let _initialLoadComplete = false;

    // --- Pure helpers (no DOM, no globals — unit-tested in
    //     tests/dashboard-panels-client.test.js via the vm-extract pattern) ---

    // Distinct non-null project tags across the given session-meta list, plus
    // whether any panel carries no project at all. `metas` is an array of
    // session.meta objects. Exited panels are excluded — chips count live work.
    function discoverPanelProjects(metas) {
      const projects = [];
      const seen = Object.create(null);
      let hasNullProject = false;
      for (const m of (metas || [])) {
        if (!m || m.status === 'exited') continue;
        const p = m.project;
        if (p === null || p === undefined || p === '') {
          hasNullProject = true;
          continue;
        }
        if (!seen[p]) {
          seen[p] = true;
          projects.push(p);
        }
      }
      projects.sort();
      return { projects: projects, hasNullProject: hasNullProject };
    }

    // Count of live (non-exited) panels for one chip. The "All" chip passes
    // project==='' and counts every live panel; a project chip counts only its
    // own. Orchestrator panels are counted under their project too — the ORCH
    // pin is a placement, not an exclusion from the totals.
    function countPanelsForProject(metas, project) {
      let n = 0;
      for (const m of (metas || [])) {
        if (!m || m.status === 'exited') continue;
        if (project === '' || project === null || project === undefined) { n++; continue; }
        if (m.project === project) n++;
      }
      return n;
    }

    // Whether a grid tile with the given project should be visible under the
    // current chip selection. The "All" selection ('') shows everything; a
    // project selection shows only exact matches (null-project panels are
    // hidden under any specific-project filter — they surface only under All).
    function isPanelVisibleUnderFilter(panelProject, selectedFilter) {
      if (selectedFilter === '' || selectedFilter === null || selectedFilter === undefined) return true;
      return panelProject === selectedFilter;
    }

    // Sprint 66 T1 (Task 1.1) — the chip row renders whenever there is at
    // least one project bucket, so the project-filter feature is *discoverable*
    // rather than hidden until a second project shows up. Brad's 2026-05-13 v2
    // spec asked for an always-visible rail; his single-live-panel setup sat
    // below the old ≥2 threshold and saw nothing. With one project the row is
    // [ All ] + that one project chip — harmless, and it advertises the filter.
    // `hasNullProject` is retained in the signature for call-site / test
    // compatibility; with ≥1 project the row shows regardless of it, and with
    // zero projects an All-only row carries no filter value so it stays hidden.
    function shouldShowChipRow(projects, hasNullProject) {
      return (projects || []).length >= 1;
    }

    // Approach A (Brad's 2026-05-13 spec): orchestrator identity is the
    // explicit meta.role flag, never inferred from cwd. Sprint 80 FR-2 —
    // isOrchestratorRole is the PIN-FAMILY predicate: BOTH `orchestrator` (silver)
    // and `master-orchestrator` (gold) belong in the ORCH pin row and survive
    // filter-reveal / reconcile. isMasterOrchestratorRole splits the gold top
    // tier out for the border + badge color (Brad's 2026-06-26 fleet-legibility
    // ask — spot the master control panel among many orchestrators at a glance).
    function isOrchestratorRole(role) {
      return role === 'orchestrator' || role === 'master-orchestrator';
    }
    function isMasterOrchestratorRole(role) {
      return role === 'master-orchestrator';
    }

    // Sprint 66 T1 (Task 1.3) / Sprint 80 FR-2 — the one-click "mark / unmark
    // orchestrator" toggle. nextRoleForToggle: an orch-family panel toggles back
    // to unroled (null); anything else promotes to `master-orchestrator` — the
    // solo operator's one primary control surface is the prominent GOLD master.
    // This preserves the pre-FR-2 gold affordance (the toggle never produced a
    // silver panel); plain silver `orchestrator` is the FLEET path, set via
    // `PATCH {role:'orchestrator'}`, not this binary button. The toggle does NOT
    // preserve a prior non-orch role (a binary switch, not a role-history stack).
    // orchToggleLabel: the toggle button's text for a role. Both pure — unit-
    // tested in tests/dashboard-panels-client.test.js.
    // The orch-family check is inlined (not a call to isOrchestratorRole) so each
    // helper stays self-contained — the unit-test harness brace-extracts and evals
    // each pure helper in isolation, where sibling helpers are not in scope.
    function nextRoleForToggle(currentRole) {
      const isOrchFamily = currentRole === 'orchestrator' || currentRole === 'master-orchestrator';
      return isOrchFamily ? null : 'master-orchestrator';
    }
    function orchToggleLabel(role) {
      const isOrchFamily = role === 'orchestrator' || role === 'master-orchestrator';
      return isOrchFamily ? 'unmark orch' : 'mark orch';
    }

    // Belt-and-suspenders for missed panel_exited frames: panel ids the
    // dashboard still has a tile for, but which no longer appear in the
    // server's broadcast session list. Works whether or not T2 filters exited
    // sessions out of status_broadcast.
    function findOrphanedPanelIds(knownPanelIds, broadcastSessionIds) {
      const live = Object.create(null);
      for (const id of (broadcastSessionIds || [])) live[id] = true;
      const orphaned = [];
      for (const id of (knownPanelIds || [])) {
        if (!live[id]) orphaned.push(id);
      }
      return orphaned;
    }

    // 1.3b — give a non-2xx API body a uniform failure signal. Many callers
    // gate on `.error`; a 4xx/5xx body that lacks it (e.g. the Sprint 65
    // dead-panel shape 410 {ok:false,code:'panel_exited',message}) would
    // otherwise be misread as success. Pure: takes the parsed body + status,
    // returns the body annotated with `error` + `_httpStatus`.
    function annotateApiFailure(body, httpStatus) {
      const out = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
      if (out.error === undefined || out.error === null) {
        out.error = out.message || out.code || ('HTTP ' + httpStatus);
      }
      out._httpStatus = httpStatus;
      return out;
    }

    // 1.1 born-hidden guard (T3 20:10 / T4 20:11) — a panel the operator just
    // launched must never be hidden by a stale chip filter. Given the active
    // filter and a newly-created panel, returns the filter value that keeps the
    // panel visible, or null when no switch is needed. Pure.
    function filterValueRevealingPanel(currentFilter, panelProject, isOrchPanel, initialLoadComplete) {
      if (initialLoadComplete !== true) return null;  // initial restore — honor the saved filter
      if (isOrchPanel === true) return null;          // ORCH panels bypass the chip filter
      const proj = panelProject || '';
      if (!currentFilter) return null;                // "All" already shows everything
      if (currentFilter === proj) return null;        // already visible under this filter
      return proj;                                    // switch the filter to the new panel's project
    }

    // --- localStorage-backed filter persistence (origin-scoped, per-tab) ---
    function loadProjectFilter() {
      try {
        const v = localStorage.getItem(PROJECT_FILTER_KEY);
        return typeof v === 'string' ? v : '';
      } catch (err) {
        console.warn('[client] projectFilter load failed:', err);
        return '';
      }
    }
    function saveProjectFilter(value) {
      try {
        localStorage.setItem(PROJECT_FILTER_KEY, value || '');
      } catch (err) {
        console.warn('[client] projectFilter save failed:', err);
      }
    }

    // session.meta for every panel currently mounted on THIS dashboard. Skips
    // the _mounting placeholder createTerminalPanel reserves at function entry
    // before the real entry is written.
    function dashboardPanelMetas() {
      const metas = [];
      for (const entry of state.sessions.values()) {
        if (!entry || entry._mounting || !entry.session || !entry.session.meta) continue;
        metas.push(entry.session.meta);
      }
      return metas;
    }

    // 1.1 — (re)render the project-filter chip row from the live panel set.
    // Chips are built with createElement (not innerHTML) so project names need
    // no attribute escaping and cannot inject markup.
    function renderProjectChips() {
      const row = document.getElementById('project-chips');
      if (!row) return;
      const metas = dashboardPanelMetas();
      const discovered = discoverPanelProjects(metas);
      const projects = discovered.projects;

      if (!shouldShowChipRow(projects, discovered.hasNullProject)) {
        row.replaceChildren();
        return;
      }

      // If the selected project no longer has any live panels, fall back to
      // "All" so the grid never strands empty behind a dead chip.
      if (state.projectFilter && projects.indexOf(state.projectFilter) === -1) {
        state.projectFilter = '';
        saveProjectFilter('');
      }

      const chips = [{ project: '', label: 'All' }];
      for (const p of projects) chips.push({ project: p, label: p });

      const frag = document.createDocumentFragment();
      for (const c of chips) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'project-chip' + (((state.projectFilter || '') === c.project) ? ' active' : '');
        btn.dataset.project = c.project;
        const label = document.createElement('span');
        label.className = 'project-chip-label';
        label.textContent = c.label;
        const count = document.createElement('span');
        count.className = 'project-chip-count';
        count.textContent = '(' + countPanelsForProject(metas, c.project) + ')';
        btn.appendChild(label);
        btn.appendChild(count);
        frag.appendChild(btn);
      }
      row.replaceChildren(frag);
    }

    // 1.1 — apply the current chip selection to the grid by toggling
    // .panel--filtered-out (display:none) on tiles. PTYs are never torn down —
    // a filtered panel keeps running, just hidden. Orchestrator tiles live
    // outside the grid and are never filtered.
    function applyProjectFilter() {
      for (const entry of state.sessions.values()) {
        if (!entry || entry._mounting || !entry.el || !entry.session) continue;
        if (isOrchestratorRole(entry.session.meta && entry.session.meta.role)) {
          entry.el.classList.remove('panel--filtered-out');
          continue;
        }
        const project = entry.session.meta ? entry.session.meta.project : null;
        const visible = isPanelVisibleUnderFilter(project, state.projectFilter || '');
        entry.el.classList.toggle('panel--filtered-out', !visible);
      }
    }

    // 1.1 — chip click: single-select, persist, re-render + re-filter + refit.
    function onProjectChipClick(e) {
      const chip = e.target && e.target.closest ? e.target.closest('.project-chip') : null;
      if (!chip) return;
      const project = chip.getAttribute('data-project') || '';
      state.projectFilter = project;
      saveProjectFilter(project);
      renderProjectChips();
      applyProjectFilter();
      requestAnimationFrame(function () { fitAll(); });
    }

    // 1.1 — born-hidden guard for a freshly-created panel: if an active chip
    // filter would hide it, switch the filter to the panel's project so the
    // operator sees what they just launched. No-op during the initial restore.
    function revealNewPanelIfFiltered(meta) {
      const next = filterValueRevealingPanel(
        state.projectFilter,
        meta && meta.project,
        isOrchestratorRole(meta && meta.role),
        _initialLoadComplete
      );
      if (next === null) return;
      state.projectFilter = next;
      saveProjectFilter(next);
    }

    // 1.2 — route a freshly-built panel into the ORCH pin row or the grid.
    // Sprint 80 FR-2 — the gold master tier carries an extra `panel--role-master`
    // class that overrides the silver `panel--role-orch` default to gold (pure CSS).
    function placePanel(panel, meta) {
      const orchRow = document.getElementById('orch-pin-row');
      if (orchRow && isOrchestratorRole(meta && meta.role)) {
        panel.classList.add('panel--role-orch');
        panel.classList.toggle('panel--role-master', isMasterOrchestratorRole(meta && meta.role));
        orchRow.appendChild(panel);
      } else {
        document.getElementById('termGrid').appendChild(panel);
      }
    }

    // 1.2 — reconcile: keep every tile in the container its role dictates.
    // Re-evaluates isOrchestratorRole() for every panel on each call, so it is
    // the primary mover whenever a role CHANGES — not merely a placement
    // safety net. Sprint 66 T1 (Task 1.2) made meta.role mutable post-spawn
    // (PATCH /api/sessions/:id {role}); a role flip arrives via status_broadcast,
    // updatePanelMeta() merges it into entry.session.meta, scheduleChromeRefresh()
    // runs this, and the panel moves into / out of the ORCH row carrying the
    // panel--role-orch class (the gold border + "ORCH " badge are pure CSS on
    // that class). Returns true if any tile moved.
    function reconcileOrchRow() {
      const orchRow = document.getElementById('orch-pin-row');
      const grid = document.getElementById('termGrid');
      if (!orchRow || !grid) return false;
      let moved = false;
      for (const entry of state.sessions.values()) {
        if (!entry || entry._mounting || !entry.el || !entry.session) continue;
        const role = entry.session.meta && entry.session.meta.role;
        const isOrch = isOrchestratorRole(role);
        const inOrchRow = entry.el.parentElement === orchRow;
        if (isOrch && !inOrchRow) {
          entry.el.classList.add('panel--role-orch');
          entry.el.classList.remove('panel--filtered-out');
          orchRow.appendChild(entry.el);
          moved = true;
        } else if (!isOrch && inOrchRow) {
          entry.el.classList.remove('panel--role-orch');
          entry.el.classList.remove('panel--role-master');
          grid.appendChild(entry.el);
          moved = true;
        }
        // Sprint 80 FR-2 — keep the gold master modifier in sync on EVERY pass,
        // even when the panel does not move: an `orchestrator ⇄ master-orchestrator`
        // flip stays in the ORCH row but must re-skin silver ⇄ gold. (A pure
        // recolor leaves `moved` false — no layout refit needed.)
        if (isOrch) {
          entry.el.classList.toggle('panel--role-master', isMasterOrchestratorRole(role));
        }
      }
      return moved;
    }

    // Single entry point for keeping the dashboard chrome (ORCH row + chips +
    // filter) in sync with the live panel set. Cheap — class toggles and a
    // small chip-row rebuild.
    function refreshDashboardChrome() {
      const moved = reconcileOrchRow();
      renderProjectChips();
      applyProjectFilter();
      if (moved) requestAnimationFrame(function () { fitAll(); });
    }

    // status_broadcast fires once per panel WebSocket; coalesce the resulting
    // chrome refreshes into one per animation frame so an 18-panel dashboard
    // doesn't rebuild the chip row 18× per 2s tick (T4's count-thrash concern).
    function scheduleChromeRefresh() {
      if (_chromeRefreshScheduled) return;
      _chromeRefreshScheduled = true;
      requestAnimationFrame(function () {
        _chromeRefreshScheduled = false;
        refreshDashboardChrome();
      });
    }

    // --- 1.3: tile auto-removal on PTY exit ---

    // Grace window before a dead tile is pulled, so the operator sees the
    // final post-exit lines. Overridable via <body data-tile-exit-grace-ms>
    // for deterministic tests.
    function tileExitGraceMs() {
      try {
        const attr = document.body && document.body.getAttribute('data-tile-exit-grace-ms');
        const n = attr != null ? parseInt(attr, 10) : NaN;
        if (Number.isFinite(n) && n >= 0) return n;
      } catch (err) {
        console.warn('[client] tile-exit-grace read failed:', err);
      }
      return 3000;
    }

    // Tear down a panel's DOM + xterm + WebSocket and drop it from state.
    // Idempotent: a second call for an already-removed id is a no-op. Shared
    // by handlePanelExited (primary) and reconcileExitedPanels (fallback).
    function removePanelTile(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      try { if (entry.terminal) entry.terminal.dispose(); } catch (err) { console.warn('[client] terminal dispose failed:', err); }
      try { if (entry.ws) entry.ws.close(); } catch (err) { console.warn('[client] ws close failed:', err); }
      try { if (entry.el) entry.el.remove(); } catch (err) { console.warn('[client] tile remove failed:', err); }
      state.sessions.delete(id);
      updateEmptyState();
      renderSwitcher();
      refreshAllReplyFormsFor(id);
      refreshPanelIndices();
      refreshDashboardChrome();
    }

    // 1.3 primary path — the server broadcast a panel_exited frame (T2 sub-task
    // 2.4). Dim the tile for a grace window, then remove it. Guarded with
    // _exitScheduled because panel_exited arrives on every panel's WebSocket.
    function handlePanelExited(sessionId, exitCode) {
      const entry = state.sessions.get(sessionId);
      if (!entry || !entry.el) return;
      if (entry._exitScheduled) return;
      entry._exitScheduled = true;
      entry.el.classList.add('panel--exiting');
      const statusEl = document.getElementById('status-' + sessionId);
      if (statusEl && exitCode !== undefined && exitCode !== null) {
        statusEl.textContent = 'Exited (' + exitCode + ')';
      }
      setTimeout(function () { removePanelTile(sessionId); }, tileExitGraceMs());
    }

    // 1.3 belt-and-suspenders — covers a missed panel_exited frame. Two
    // independent checks so the dashboard cannot strand a dead tile forever
    // regardless of how T2 implements exited-session filtering:
    //   (a) orphaned — a tile whose session id has dropped out of the
    //       broadcast entirely (fires when T2 filters exited from the
    //       broadcast); removed after ORPHAN_GRACE_MS.
    //   (b) stale-exited — a tile still in the broadcast with status 'exited'
    //       and lastActivity older than STALE_EXITED_MS (fires when T2 keeps
    //       exited sessions in the broadcast).
    function reconcileExitedPanels(broadcastSessions) {
      const list = Array.isArray(broadcastSessions) ? broadcastSessions : [];
      const broadcastIds = [];
      const metaById = Object.create(null);
      for (const s of list) {
        if (s && s.id) { broadcastIds.push(s.id); metaById[s.id] = s.meta || {}; }
      }
      const knownIds = [];
      for (const [id, entry] of state.sessions) {
        if (entry && !entry._mounting && entry.el) knownIds.push(id);
      }
      const now = Date.now();

      // (a) orphaned-from-broadcast
      const orphaned = findOrphanedPanelIds(knownIds, broadcastIds);
      const orphanSet = Object.create(null);
      for (const id of orphaned) {
        orphanSet[id] = true;
        const entry = state.sessions.get(id);
        if (!entry) continue;
        if (!entry._orphanedSince) entry._orphanedSince = now;
        if (now - entry._orphanedSince >= ORPHAN_GRACE_MS && !entry._exitScheduled) {
          removePanelTile(id);
        }
      }
      // clear the stamp for any panel that is back in the broadcast
      for (const id of knownIds) {
        const entry = state.sessions.get(id);
        if (entry && entry._orphanedSince && !orphanSet[id]) entry._orphanedSince = null;
      }

      // (b) stale-exited still present in the broadcast
      for (const id of knownIds) {
        const meta = metaById[id];
        if (!meta || meta.status !== 'exited') continue;
        const entry = state.sessions.get(id);
        if (!entry || entry._exitScheduled) continue;
        const last = meta.lastActivity ? new Date(meta.lastActivity).getTime() : 0;
        if (last && now - last >= STALE_EXITED_MS) {
          removePanelTile(id);
        }
      }
    }

    // ===== Sprint 65 T1 (Joshua's 2026-05-16 ask c): terminal font size =====
    // A single global xterm.js font size, adjusted from the topbar A-/A+
    // stepper and persisted in localStorage. Applies to every panel (existing
    // + future) — operators running dense CLI output wanted smaller text. The
    // BACKLOG 2026-05-16 entry sanctions "per-panel OR global"; global is the
    // simpler, lower-risk option for this contingent sub-task.

    const FONT_SIZE_KEY = 'termdeck.dashboard.fontSize';

    // Clamp a requested font size to the supported range, coercing non-numbers
    // to the xterm.js default (13). Pure — unit-tested via the vm-extract path.
    function clampFontSize(n) {
      const v = Math.round(Number(n));
      if (!Number.isFinite(v)) return 13;
      if (v < 8) return 8;
      if (v > 22) return 22;
      return v;
    }

    function loadFontSize() {
      try {
        const raw = localStorage.getItem(FONT_SIZE_KEY);
        return raw != null ? clampFontSize(raw) : 13;
      } catch (err) {
        console.warn('[client] fontSize load failed:', err);
        return 13;
      }
    }
    function saveFontSize(n) {
      try {
        localStorage.setItem(FONT_SIZE_KEY, String(n));
      } catch (err) {
        console.warn('[client] fontSize save failed:', err);
      }
    }

    // Apply the global font size to every live terminal. Changing fontSize
    // resizes the character cell but NOT the container, so the per-panel
    // ResizeObserver does not fire — refit + push the new cols/rows explicitly.
    function applyFontSizeToAll() {
      for (const entry of state.sessions.values()) {
        if (!entry || entry._mounting || !entry.terminal) continue;
        try {
          entry.terminal.options.fontSize = state.fontSize;
          if (entry.fitAddon) entry.fitAddon.fit();
          if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({
              type: 'resize',
              cols: entry.terminal.cols,
              rows: entry.terminal.rows,
            }));
          }
        } catch (err) {
          console.warn('[client] fontSize apply failed for a panel:', err);
        }
      }
      const label = document.getElementById('fontSizeLabel');
      if (label) label.textContent = String(state.fontSize);
    }

    // Topbar A-/A+ stepper handler. delta is +1 or -1.
    function stepFontSize(delta) {
      const next = clampFontSize(state.fontSize + delta);
      if (next === state.fontSize) return;
      state.fontSize = next;
      saveFontSize(next);
      applyFontSizeToAll();
    }

    // ===== Control dashboard (T1.6) =====
    async function enterControlMode() {
      // Pre-warm command history for every open session so the feed is dense.
      const loads = [];
      for (const [sid, entry] of state.sessions) {
        if (entry.commandsLoaded) continue;
        loads.push(
          api('GET', `/api/sessions/${sid}/history`).then(resp => {
            const list = Array.isArray(resp) ? resp : (resp.commands || resp.history || []);
            entry.commandHistory = list;
            entry.commandsLoaded = true;
          }).catch(() => { /* silent */ })
        );
      }
      await Promise.allSettled(loads);
      renderControlFeed();
    }

    function renderControlFeed() {
      const grid = document.getElementById('termGrid');
      const rowsEl = document.getElementById('feedRows');
      const countEl = document.getElementById('feedCount');
      if (!grid || !rowsEl) return;
      if (!grid.classList.contains('layout-control')) return;

      const events = [];
      for (const [sid, entry] of state.sessions) {
        const meta = entry.session?.meta || {};
        const label = `${getTypeLabel(meta.type || 'shell')}${meta.project ? '·' + meta.project : ''}`;
        const statusColor = getStatusColor(meta.status || 'idle');

        // Status transitions
        for (const ev of (entry.statusLog || [])) {
          const isErr = ev.status === 'errored';
          events.push({
            at: new Date(ev.at).getTime(),
            sid,
            label,
            statusColor,
            kind: isErr ? 'error' : 'status',
            body: `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`,
          });
        }

        // Recent commands
        for (const c of (entry.commandHistory || []).slice(0, 25)) {
          const t = c.timestamp || c.createdAt || c.created_at;
          if (!t) continue;
          events.push({
            at: new Date(t).getTime(),
            sid,
            label,
            statusColor,
            kind: 'command',
            body: c.command || c.cmd || '',
          });
        }

        // Memory hits cached from askAI / proactive queries
        for (const m of (entry.memoryHits || []).slice(0, 10)) {
          if (!m.cachedAt) continue;
          events.push({
            at: new Date(m.cachedAt).getTime(),
            sid,
            label,
            statusColor,
            kind: 'memory',
            body: (m.content || m.text || '(memory)').slice(0, 220),
          });
        }
      }

      events.sort((a, b) => b.at - a.at);
      const capped = events.slice(0, 200);

      if (countEl) countEl.textContent = `${capped.length} event${capped.length === 1 ? '' : 's'}`;

      if (capped.length === 0) {
        rowsEl.innerHTML = '<div class="feed-empty">No activity yet. Commands, status transitions, and memory hits will appear here.</div>';
        return;
      }

      rowsEl.innerHTML = capped.map(ev => {
        const t = new Date(ev.at);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        return `
          <div class="feed-row" data-session-id="${ev.sid}">
            <span class="feed-time">${hh}:${mm}:${ss}</span>
            <span class="feed-panel-ref"><span class="dot" style="background:${ev.statusColor}"></span>${escapeHtml(ev.label)}</span>
            <span class="feed-kind ${ev.kind}">${ev.kind}</span>
            <span class="feed-body">${escapeHtml(ev.body)}</span>
          </div>
        `;
      }).join('');
    }

    function onFeedRowClick(e) {
      const row = e.target.closest('.feed-row');
      if (!row) return;
      const sid = row.dataset.sessionId;
      if (!sid) return;
      // Return to 2x2 layout and focus the source panel
      setLayout('2x2');
      requestAnimationFrame(() => focusSessionById(sid));
    }

    // ===== Proactive memory toast (T1.4) =====
    const PROACTIVE_COOLDOWN_MS = 30_000;

    async function triggerProactiveMemoryQuery(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      if (!state.config.aiQueryAvailable) return;

      const now = Date.now();
      if (entry._lastProactiveAt && now - entry._lastProactiveAt < PROACTIVE_COOLDOWN_MS) return;
      entry._lastProactiveAt = now;

      const meta = entry.session?.meta || {};
      const lastCmd = meta.lastCommands?.length
        ? meta.lastCommands[meta.lastCommands.length - 1].command
        : '';
      const type = meta.type || 'shell';
      const question = `${type} error ${lastCmd}`.trim();
      if (!question || question === `${type} error`) {
        // No command context — still query using status detail as a last resort
        if (!meta.statusDetail) return;
      }

      try {
        const result = await api('POST', '/api/ai/query', {
          question: question || `${type} error ${meta.statusDetail || ''}`.trim(),
          sessionId: id,
          project: meta.project || null,
        });
        if (result?.error) return;
        if (!Array.isArray(result?.memories) || result.memories.length === 0) return;

        // Cache every hit into the Memory tab so the drawer stays in sync
        if (!entry.memoryHits) entry.memoryHits = [];
        const cachedAt = new Date().toISOString();
        for (const m of result.memories) entry.memoryHits.unshift({ ...m, cachedAt });
        if (entry.memoryHits.length > 60) entry.memoryHits.length = 60;
        setBadge(id, 'memory', entry.memoryHits.length);
        if (entry.drawerOpen && entry.activeTab === 'memory') renderMemoryTab(id);

        showProactiveToast(id, result.memories[0]);
      } catch (err) {
        console.error('[client] proactive memory query failed:', err);
      }
    }

    function showProactiveToast(id, hit, flashbackEventId) {
      const entry = state.sessions.get(id);
      if (!entry || !entry.el) return;

      // Remove any prior toast for this panel
      const prev = entry.el.querySelector('.proactive-toast');
      if (prev) prev.remove();

      const toast = document.createElement('div');
      toast.className = 'proactive-toast';
      const proj = hit.project ? escapeHtml(hit.project) : 'another session';
      const snippet = escapeHtml((hit.content || hit.text || '').slice(0, 220));
      const score = typeof hit.similarity === 'number' ? `${(hit.similarity * 100).toFixed(0)}%` : '';

      toast.innerHTML = `
        <button class="t-dismiss" aria-label="Dismiss">×</button>
        <div class="t-title">Mnestra — possible match</div>
        <div class="t-body">Found a similar error in <b>${proj}</b>${score ? ` · ${score}` : ''} — click to see.</div>
        <div class="t-meta">${snippet}</div>
      `;

      entry.el.appendChild(toast);

      // Sprint 43 T2: track dismiss/click-through against flashback_events.
      // The id is set server-side in the proactive_memory WS frame; if it's
      // missing (server-side INSERT failed, or older server) the POSTs are
      // skipped and the live toast still works — persistence is best-effort.
      const dismiss = () => {
        toast.remove();
        clearTimeout(toast._autoTimer);
        if (flashbackEventId) {
          fetch(`${API}/api/flashback/${flashbackEventId}/dismissed`, { method: 'POST' })
            .catch((err) => console.warn('[flashback] dismiss POST failed:', err.message));
        }
      };
      toast.querySelector('.t-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
      });
      toast.addEventListener('click', () => {
        toast.remove();
        clearTimeout(toast._autoTimer);
        if (flashbackEventId) {
          fetch(`${API}/api/flashback/${flashbackEventId}/clicked`, { method: 'POST' })
            .catch((err) => console.warn('[flashback] clicked POST failed:', err.message));
        }
        showFlashbackModal(hit, id);
      });

      toast._autoTimer = setTimeout(dismiss, 30000);
    }

    // ===== Flashback modal (Sprint 16 T2) =====
    let _flashbackModalEl = null;
    let _flashbackKeyHandler = null;
    let _flashbackPrevFocus = null;

    function closeFlashbackModal() {
      if (!_flashbackModalEl) return;
      _flashbackModalEl.remove();
      _flashbackModalEl = null;
      if (_flashbackKeyHandler) {
        document.removeEventListener('keydown', _flashbackKeyHandler);
        _flashbackKeyHandler = null;
      }
      if (_flashbackPrevFocus && typeof _flashbackPrevFocus.focus === 'function') {
        try { _flashbackPrevFocus.focus(); } catch {}
      }
      _flashbackPrevFocus = null;
    }

    function logFlashbackFeedback(hit, sessionId, verdict) {
      // Fire-and-forget; no dedicated endpoint yet.
      const payload = {
        verdict,
        sessionId: sessionId || null,
        project: hit?.project || null,
        sourceType: hit?.source_type || hit?.sourceType || null,
        similarity: typeof hit?.similarity === 'number' ? hit.similarity : null,
        contentPreview: (hit?.content || hit?.text || '').slice(0, 160),
        at: new Date().toISOString(),
      };
      console.log('[flashback] feedback', payload);
    }

    function showFlashbackModal(hit, sessionId) {
      // Replace any existing modal (new toast wins).
      if (_flashbackModalEl) closeFlashbackModal();

      _flashbackPrevFocus = document.activeElement;

      const content = (hit?.content || hit?.text || '').trim();
      const project = hit?.project || '';
      const sourceType = hit?.source_type || hit?.sourceType || '';
      const createdAt = hit?.created_at || hit?.createdAt || '';
      const scoreNum = typeof hit?.similarity === 'number' ? hit.similarity : null;
      const scorePct = scoreNum !== null ? `${(scoreNum * 100).toFixed(0)}%` : '';

      const overlay = document.createElement('div');
      overlay.className = 'flashback-modal open';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'flashbackTitle');

      const projectChip = project
        ? `<span class="fb-chip fb-chip-project">${escapeHtml(project)}</span>`
        : '';
      const scoreChip = scorePct
        ? `<span class="fb-chip fb-chip-score">${escapeHtml(scorePct)}</span>`
        : '';
      const sourceLine = sourceType
        ? `<span class="fb-meta-item"><span class="fb-meta-label">source</span> ${escapeHtml(sourceType)}</span>`
        : '';
      const timeLine = createdAt
        ? `<span class="fb-meta-item"><span class="fb-meta-label">when</span> ${escapeHtml(timeAgo(createdAt))}</span>`
        : '';
      const projectLine = project
        ? `<span class="fb-meta-item"><span class="fb-meta-label">project</span> ${escapeHtml(project)}</span>`
        : '';

      overlay.innerHTML = `
        <div class="fb-backdrop"></div>
        <div class="fb-card" tabindex="-1">
          <header>
            <h3 id="flashbackTitle">
              <span class="fb-title-text">Flashback — similar issue found</span>
              <span class="fb-title-chips">${projectChip}${scoreChip}</span>
            </h3>
            <button class="fb-x" type="button" aria-label="Close">×</button>
          </header>
          <div class="fb-body">
            <pre class="fb-content">${escapeHtml(content || '(empty memory)')}</pre>
            <div class="fb-meta">
              ${projectLine}
              ${sourceLine}
              ${timeLine}
            </div>
          </div>
          <footer>
            <div class="fb-feedback">
              <button class="fb-btn fb-helped" type="button">This helped</button>
              <button class="fb-btn fb-not-relevant" type="button">Not relevant</button>
            </div>
            <button class="fb-btn fb-dismiss" type="button">Dismiss</button>
          </footer>
        </div>
      `;

      document.body.appendChild(overlay);
      _flashbackModalEl = overlay;

      overlay.querySelector('.fb-backdrop').addEventListener('click', closeFlashbackModal);
      overlay.querySelector('.fb-x').addEventListener('click', closeFlashbackModal);
      overlay.querySelector('.fb-dismiss').addEventListener('click', closeFlashbackModal);
      overlay.querySelector('.fb-helped').addEventListener('click', () => {
        logFlashbackFeedback(hit, sessionId, 'helped');
        closeFlashbackModal();
      });
      overlay.querySelector('.fb-not-relevant').addEventListener('click', () => {
        logFlashbackFeedback(hit, sessionId, 'not_relevant');
        closeFlashbackModal();
      });

      _flashbackKeyHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeFlashbackModal();
        }
      };
      document.addEventListener('keydown', _flashbackKeyHandler);

      setTimeout(() => {
        const card = overlay.querySelector('.fb-card');
        if (card) card.focus();
      }, 30);
    }

    // ===== Reply / send-to-terminal (T1.3) =====
    // Flip this to false to force the local-WS fallback even when the server
    // endpoint is available — handy for debugging.
    const USE_SERVER_INPUT_API = true;

    function toggleReplyForm(fromId) {
      const form = document.getElementById(`reply-form-${fromId}`);
      if (!form) return;
      const willOpen = !form.classList.contains('open');
      form.classList.toggle('open', willOpen);
      if (willOpen) {
        refreshReplyTargets(fromId);
        const input = document.getElementById(`reply-text-${fromId}`);
        setTimeout(() => input?.focus(), 20);
      }
    }

    function refreshReplyTargets(fromId) {
      const select = document.getElementById(`reply-target-${fromId}`);
      if (!select) return;
      const prev = select.value;

      // F1.3: number duplicate labels with `#N` so e.g. two "Claude Code · termdeck"
      // panels become "Claude Code · termdeck #1" / "... #2". Numbering is across
      // ALL live panels with that base label (including the current one) in
      // state.sessions insertion order, so suffixes stay stable as the user opens
      // the reply form from different panels.
      const groupIndex = new Map();  // sid → index-within-group (1-based, only when group.size ≥ 2)
      const groupCount = new Map();  // baseLabel → count so far
      for (const [sid, entry] of state.sessions) {
        const panel = entry.el;
        if (panel && panel.classList.contains('exited')) continue;
        const meta = entry.session?.meta || {};
        const base = `${getTypeLabel(meta.type || 'shell')}${meta.project ? ' · ' + meta.project : ''}`;
        const next = (groupCount.get(base) || 0) + 1;
        groupCount.set(base, next);
        groupIndex.set(sid, { base, n: next });
      }

      const options = [];
      for (const [sid, entry] of state.sessions) {
        if (sid === fromId) continue;
        const panel = entry.el;
        if (panel && panel.classList.contains('exited')) continue;
        const info = groupIndex.get(sid);
        if (!info) continue;
        const needsSuffix = (groupCount.get(info.base) || 0) >= 2;
        const label = needsSuffix ? `${info.base} #${info.n}` : info.base;
        options.push(`<option value="${sid}">${escapeHtml(label)}</option>`);
      }
      if (options.length === 0) {
        select.innerHTML = `<option value="">(no other terminals)</option>`;
      } else {
        select.innerHTML = options.join('');
        if (prev && Array.from(select.options).some(o => o.value === prev)) {
          select.value = prev;
        }
      }
    }

    // Assign #N index suffixes to panels that share (type, project) with another
    // panel. Insertion-order numbering via Map iteration (Map preserves insert order).
    // Groups of size 1 get no suffix — only collisions get numbered.
    function refreshPanelIndices() {
      const groups = new Map(); // key = "type|project" → [sid, ...]
      for (const [sid, entry] of state.sessions) {
        const meta = entry.session?.meta || {};
        const key = `${meta.type || 'shell'}|${meta.project || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(sid);
      }
      for (const [, sids] of groups) {
        const showIndex = sids.length >= 2;
        sids.forEach((sid, i) => {
          const el = document.getElementById(`idx-${sid}`);
          if (!el) return;
          el.textContent = showIndex ? `#${i + 1}` : '';
        });
      }
    }

    function refreshAllReplyFormsFor(changedId) {
      // When a panel is added, removed, or exits, the target list in *other*
      // panels' open reply forms needs refreshing.
      for (const [sid, entry] of state.sessions) {
        if (sid === changedId) continue;
        const form = document.getElementById(`reply-form-${sid}`);
        if (form && form.classList.contains('open')) {
          refreshReplyTargets(sid);
        }
        const btn = document.getElementById(`reply-btn-${sid}`);
        if (btn) btn.disabled = state.sessions.size < 2;
      }
    }

    async function sendReply(fromId) {
      const select = document.getElementById(`reply-target-${fromId}`);
      const input = document.getElementById(`reply-text-${fromId}`);
      const statusEl = document.getElementById(`reply-status-${fromId}`);
      if (!select || !input) return;
      const targetId = select.value;
      let text = input.value;
      if (!targetId) {
        showReplyStatus(statusEl, 'No target selected.', 'error');
        return;
      }
      if (!text) return;

      const targetEntry = state.sessions.get(targetId);
      if (!targetEntry) {
        showReplyStatus(statusEl, 'Target not found.', 'error');
        return;
      }

      // zsh and most shells want CR. Normalize \n → \r and strip \r\n pairs.
      const normalized = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
      // Ensure the line actually submits at the target prompt.
      const payload = normalized.endsWith('\r') ? normalized : normalized + '\r';

      let delivered = false;
      let errMsg = '';

      if (USE_SERVER_INPUT_API) {
        try {
          const result = await api('POST', `/api/sessions/${targetId}/input`, {
            text: payload,
            source: 'reply',
            fromSessionId: fromId,
          });
          if (result && !result.error) {
            delivered = true;
          } else {
            errMsg = result?.error || 'server returned an error';
          }
        } catch (err) {
          errMsg = err.message || String(err);
        }
      }

      if (!delivered) {
        // Local-WS fallback. Used when USE_SERVER_INPUT_API is false, or when
        // the server endpoint is missing / failing.
        const ws = targetEntry.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'input', data: payload }));
            delivered = true;
          } catch (err) {
            errMsg = err.message || String(err);
          }
        } else {
          if (!errMsg) errMsg = 'target websocket not open';
        }
      }

      if (delivered) {
        input.value = '';
        showReplyStatus(statusEl, `Sent ${payload.length} bytes →`, 'ok');
      } else {
        showReplyStatus(statusEl, `Send failed: ${errMsg}`, 'error');
      }
    }

    function showReplyStatus(el, msg, kind) {
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('error', 'ok');
      if (kind) el.classList.add(kind);
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.textContent = ''; el.classList.remove('error', 'ok'); }, 3500);
    }

    // ===== Terminal switcher (T1.2) =====
    function renderSwitcher() {
      const wrap = document.getElementById('termSwitcher');
      const grid = document.getElementById('switcherGrid');
      if (!wrap || !grid) return;

      const ids = Array.from(state.sessions.keys());
      if (ids.length < 2) {
        wrap.classList.remove('visible');
        grid.innerHTML = '';
        return;
      }

      wrap.classList.add('visible');
      grid.innerHTML = '';

      ids.forEach((id, idx) => {
        const entry = state.sessions.get(id);
        if (!entry) return;
        const meta = entry.session?.meta || {};
        const tile = document.createElement('button');
        tile.className = 'switcher-tile';
        tile.type = 'button';
        tile.dataset.sessionId = id;
        tile.title = `${getTypeLabel(meta.type || 'shell')}${meta.project ? ' · ' + meta.project : ''} — ${meta.status || ''}`;
        tile.textContent = String(idx + 1);
        if (state.focusedId === id) tile.classList.add('active');
        if (entry.el && entry.el.classList.contains('exited')) tile.classList.add('exited');

        const dot = document.createElement('span');
        dot.className = 'switcher-dot';
        dot.style.background = getStatusColor(meta.status || 'idle');
        tile.appendChild(dot);

        if (meta.project) {
          const bar = document.createElement('span');
          bar.className = 'switcher-bar';
          bar.style.background = getProjectBarColor(meta.project);
          tile.appendChild(bar);
        }

        tile.addEventListener('click', (e) => {
          e.preventDefault();
          focusSessionById(id);
        });

        grid.appendChild(tile);
      });
    }

    // Pull the CSS-var color for a project tag, falling back to gray
    function getProjectBarColor(project) {
      const cls = `project-${project.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
      const probe = document.createElement('span');
      probe.className = cls;
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      document.body.removeChild(probe);
      return color || '#6b7089';
    }

    function focusSessionById(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;

      // If we're in focus-mode, swap which panel is the focused one
      const grid = document.getElementById('termGrid');
      if (grid.classList.contains('layout-focus')) {
        document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('focused'));
        entry.el.classList.add('focused');
      } else if (grid.classList.contains('layout-half')) {
        document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('primary'));
        entry.el.classList.add('primary');
      }

      // Focus the xterm textarea (without stealing pointer); web-chat panels
      // focus their inject input instead.
      if (entry.terminal) { try { entry.terminal.focus(); } catch (err) { /* ignore */ } }
      else if (entry.inputEl) { try { entry.inputEl.focus(); } catch (err) { /* ignore */ } }
      state.focusedId = id;

      // Flash the panel border briefly
      entry.el.classList.remove('focus-flash');
      // Force reflow so the animation restarts on rapid switches
      void entry.el.offsetWidth;
      entry.el.classList.add('focus-flash');
      clearTimeout(entry._focusFlashTimer);
      entry._focusFlashTimer = setTimeout(() => {
        entry.el.classList.remove('focus-flash');
      }, 600);

      // Refit if layout changed (focus / half swap)
      requestAnimationFrame(() => fitAll());
      renderSwitcher();
    }

    function focusNthSession(n) {
      const ids = Array.from(state.sessions.keys());
      if (ids.length === 0) return;
      if (n < 1 || n > ids.length) return;
      focusSessionById(ids[n - 1]);
    }

    function cycleSessionFocus() {
      const ids = Array.from(state.sessions.keys());
      if (ids.length === 0) return;
      const curIdx = ids.indexOf(state.focusedId);
      const next = curIdx < 0 ? 0 : (curIdx + 1) % ids.length;
      focusSessionById(ids[next]);
    }

    // ===== Panel info drawer (T1.1) =====
    function setupDrawerListeners(id) {
      const drawer = document.getElementById(`drawer-${id}`);
      if (!drawer) return;

      // Tab clicks
      drawer.querySelectorAll('.drawer-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleDrawerTab(id, tab.dataset.tab);
        });
      });

      // Commands tab — click a row to copy
      const cmdContainer = drawer.querySelector('[data-panel="commands"]');
      cmdContainer.addEventListener('click', (e) => {
        const row = e.target.closest('.drawer-row');
        if (!row || !row.dataset.command) return;
        copyRowText(row, row.dataset.command);
      });

      // Memory tab — click a row to expand inline
      const memContainer = drawer.querySelector('[data-panel="memory"]');
      memContainer.addEventListener('click', (e) => {
        const row = e.target.closest('.drawer-row');
        if (!row) return;
        row.classList.toggle('expanded');
      });
    }

    function toggleDrawerTab(id, tabName) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      const drawer = document.getElementById(`drawer-${id}`);
      if (!drawer) return;

      const wasOpen = !!entry.drawerOpen;
      const prevTab = entry.activeTab || 'overview';

      // Clicking the same active tab while the drawer is open collapses it
      if (wasOpen && prevTab === tabName) {
        entry.drawerOpen = false;
        drawer.classList.remove('open');
      } else {
        entry.activeTab = tabName;
        entry.drawerOpen = true;
        drawer.classList.add('open');
        drawer.querySelectorAll('.drawer-tab').forEach(t => {
          t.classList.toggle('active', t.dataset.tab === tabName);
        });
        drawer.querySelectorAll('.drawer-panel').forEach(p => {
          p.classList.toggle('active', p.dataset.panel === tabName);
        });
        renderDrawerTab(id, tabName);
      }

      // Re-fit the terminal after the drawer transitions
      requestAnimationFrame(() => {
        setTimeout(() => {
          try { entry.fitAddon.fit(); } catch (err) { /* ignore */ }
          const ws = entry.ws;
          if (ws && ws.readyState === WebSocket.OPEN && entry.terminal) {  // PTY resize only; web-chat has no cols/rows
            ws.send(JSON.stringify({
              type: 'resize',
              cols: entry.terminal.cols,
              rows: entry.terminal.rows,
            }));
          }
        }, 190);
      });
    }

    function renderDrawerTab(id, tabName) {
      if (tabName === 'overview') renderOverviewTab(id);
      else if (tabName === 'commands') renderCommandsTab(id);
      else if (tabName === 'memory') renderMemoryTab(id);
      else if (tabName === 'log') renderStatusLogTab(id);
    }

    function renderOverviewTab(id) {
      const entry = state.sessions.get(id);
      const ov = document.getElementById(`ovmeta-${id}`);
      if (!entry || !ov) return;
      const meta = entry.session?.meta || {};
      const last = meta.lastCommands?.length
        ? meta.lastCommands[meta.lastCommands.length - 1].command
        : '—';
      const parts = [
        ['type', getTypeLabel(meta.type || 'shell')],
        ['project', meta.project || '—'],
        ['status', meta.statusDetail || meta.status || '—'],
        ['opened', meta.createdAt ? timeAgo(meta.createdAt) : '—'],
        ['last', last],
      ];
      if (meta.detectedPort) parts.push(['port', ':' + meta.detectedPort]);
      if (typeof meta.requestCount === 'number' && meta.requestCount > 0) {
        parts.push(['requests', String(meta.requestCount)]);
      }
      ov.innerHTML = parts.map(([k, v]) =>
        `<span><span class="ov-label">${k}</span><span class="ov-value">${escapeHtml(String(v))}</span></span>`
      ).join('');
    }

    async function renderCommandsTab(id) {
      const entry = state.sessions.get(id);
      const container = document.getElementById(`dp-commands-${id}`);
      if (!entry || !container) return;

      try {
        const resp = await api('GET', `/api/sessions/${id}/history`);
        const list = Array.isArray(resp) ? resp : (resp.commands || resp.history || []);
        entry.commandHistory = list;
        entry.commandsLoaded = true;
      } catch (err) {
        console.error('[client] failed to load command history:', err);
        if (!entry.commandsLoaded) {
          container.innerHTML = '<div class="empty-msg">Failed to load history.</div>';
          return;
        }
      }

      // server returns command_history rows ordered DESC (newest first)
      const rows = (entry.commandHistory || []).slice(0, 60);
      if (rows.length === 0) {
        container.innerHTML = '<div class="empty-msg">No commands captured yet.</div>';
      } else {
        container.innerHTML = rows.map(r => {
          const cmd = r.command || r.cmd || '';
          const ts = r.timestamp || r.createdAt || r.created_at || null;
          const src = r.source ? ` · ${escapeHtml(r.source)}` : '';
          return `
            <div class="drawer-row" data-command="${escapeAttr(cmd)}">
              <div class="row-meta"><span>${escapeHtml(ts ? timeAgo(ts) : 'recent')}${src}</span></div>
              <div class="row-cmd">${escapeHtml(cmd)}</div>
            </div>
          `;
        }).join('');
      }
      container.scrollTop = 0;
      setBadge(id, 'commands', entry.commandHistory.length);
    }

    // Sprint 81 T4 — source_type chip with a distinct doctrine highlight (📜).
    // Elevated doctrine memories get a purple accent so a doctrine reinjection
    // is visible at a glance; every other type renders as a plain dim span.
    function sourceTypeChip(type) {
      const t = escapeHtml(type || 'memory');
      if (type === 'doctrine') {
        return `<span class="chip-doctrine" title="Elevated doctrine">📜 ${t}</span>`;
      }
      return `<span>${t}</span>`;
    }

    function renderMemoryHitRow(m) {
      const score = typeof m.similarity === 'number' ? `${(m.similarity * 100).toFixed(0)}%` : '';
      const proj = m.project ? escapeHtml(m.project) : '';
      const type = m.source_type || m.sourceType || 'memory';
      const ts = m.cachedAt ? timeAgo(m.cachedAt) : '';
      return `
          <div class="drawer-row">
            <div class="row-meta">
              ${sourceTypeChip(type)}
              ${proj ? `<span>${proj}</span>` : ''}
              ${score ? `<span>${score}</span>` : ''}
              ${ts ? `<span>${ts}</span>` : ''}
            </div>
            <div class="row-content">${escapeHtml(m.content || m.text || '(empty)')}</div>
          </div>
        `;
    }

    function renderMemoryTab(id) {
      const entry = state.sessions.get(id);
      const container = document.getElementById(`dp-memory-${id}`);
      if (!entry || !container) return;

      const hits = entry.memoryHits || [];
      const liveHtml = hits.length === 0
        ? '<div class="empty-msg">No live memory hits yet. Ask about this terminal or wait for a proactive lookup.</div>'
        : hits.slice(0, 40).map(renderMemoryHitRow).join('');

      // Live per-panel hits (proactive WS frames) + the durable reinjection-event
      // log (Sprint 81 T4 memory-proof surface), filled async + fail-soft below.
      container.innerHTML =
        `<div class="mem-live">${liveHtml}</div>` +
        `<div class="mem-reinject" id="dp-reinject-${id}"></div>`;

      setBadge(id, 'memory', hits.length);
      loadReinjectionEvents(id);
    }

    // Sprint 81 T4 — the memory-proof surface. Fetch THIS panel's durable
    // reinjection events (one recall_group_id = one recall call = the K hits
    // reinjected together) from GET /api/recall-events/:sessionId and render
    // them under the live hits. Fully FAIL-SOFT: any error / empty result / DB
    // not configured leaves the section blank and never disturbs the live hits.
    // Cached on the session entry with a 10s TTL so WS-driven re-renders don't
    // spam the endpoint.
    function loadReinjectionEvents(id) {
      const target = document.getElementById(`dp-reinject-${id}`);
      const entry = state.sessions.get(id);
      if (!target || !entry) return;

      const now = Date.now();
      const fresh = entry._reinjectAt && (now - entry._reinjectAt < 10000);
      if (entry.reinjectionEvents && fresh) {
        renderReinjectionEvents(target, entry.reinjectionEvents);
        return;
      }
      if (entry._reinjectLoading) {
        if (entry.reinjectionEvents) renderReinjectionEvents(target, entry.reinjectionEvents);
        return;
      }

      entry._reinjectLoading = true;
      fetch(`/api/recall-events/${encodeURIComponent(id)}?limit=200`)
        .then((r) => (r && r.ok) ? r.json() : null)
        .then((data) => {
          entry._reinjectLoading = false;
          entry._reinjectAt = Date.now();
          entry.reinjectionEvents = (data && Array.isArray(data.events)) ? data.events : [];
          const t2 = document.getElementById(`dp-reinject-${id}`);
          if (t2) renderReinjectionEvents(t2, entry.reinjectionEvents);
        })
        .catch(() => { entry._reinjectLoading = false; /* fail-soft: leave blank */ });
    }

    function renderReinjectionEvents(target, events) {
      if (!target) return;
      if (!Array.isArray(events) || events.length === 0) {
        target.innerHTML = ''; // fail-soft: nothing durable yet (or DB not wired)
        return;
      }
      const head = `<div class="reinject-head">Reinjection events — durable recall log (${events.length})</div>`;
      const body = events.map((ev) => {
        const when = ev.createdAt ? timeAgo(ev.createdAt) : '';
        const agent = ev.sourceAgent ? escapeHtml(ev.sourceAgent) : 'unknown';
        const budget = (typeof ev.tokenBudget === 'number') ? `${ev.tokenBudget} tok` : '';
        const surface = ev.surface ? escapeHtml(ev.surface) : '';
        const sid = ev.sourceSessionId ? escapeHtml(String(ev.sourceSessionId).slice(0, 8)) : '';
        const mix = Object.keys(ev.sourceTypeMix || {})
          .map((t) => `${sourceTypeChip(t)}<span class="reinject-x">×${ev.sourceTypeMix[t]}</span>`).join(' ');
        const query = ev.queryPreview ? `<div class="reinject-query">“${escapeHtml(ev.queryPreview)}”</div>` : '';
        const hits = (ev.hits || []).map((h) => {
          const rank = (typeof h.rank === 'number') ? `#${h.rank}` : '';
          const sc = (typeof h.score === 'number') ? h.score.toFixed(3) : '';
          const proj = h.project ? escapeHtml(h.project) : '';
          const prev = h.preview ? escapeHtml(h.preview)
            : (h.memoryId ? escapeHtml(String(h.memoryId).slice(0, 8)) : '(memory)');
          return `<div class="reinject-hit">
              <span class="reinject-rank">${rank}</span>
              ${sourceTypeChip(h.sourceType || 'memory')}
              ${proj ? `<span class="reinject-proj">${proj}</span>` : ''}
              ${sc ? `<span class="reinject-score" title="RRF score">${sc}</span>` : ''}
              <span class="reinject-prev">${prev}</span>
            </div>`;
        }).join('');
        return `<div class="reinject-event${ev.hasDoctrine ? ' has-doctrine' : ''}">
            <div class="reinject-meta">
              <span class="reinject-agent" title="consuming panel${sid ? ' ' + sid : ''}">${agent}</span>
              <span>${ev.hitCount} hit${ev.hitCount === 1 ? '' : 's'}</span>
              ${surface ? `<span>${surface}</span>` : ''}
              ${budget ? `<span>${budget}</span>` : ''}
              ${when ? `<span>${when}</span>` : ''}
            </div>
            ${mix ? `<div class="reinject-mix">${mix}</div>` : ''}
            ${query}
            ${hits}
          </div>`;
      }).join('');
      target.innerHTML = head + body;
    }

    function renderStatusLogTab(id) {
      const entry = state.sessions.get(id);
      const container = document.getElementById(`dp-log-${id}`);
      if (!entry || !container) return;

      const log = entry.statusLog || [];
      if (log.length === 0) {
        container.innerHTML = '<div class="empty-msg">No status transitions recorded yet.</div>';
        setBadge(id, 'log', 0);
        return;
      }

      const rows = log.slice().reverse();
      container.innerHTML = rows.map(ev => {
        const color = getStatusColor(ev.status);
        const t = new Date(ev.at);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        return `
          <div class="status-log-row">
            <span class="ts">${hh}:${mm}:${ss}</span>
            <span class="chip" style="color:${color}">${escapeHtml(ev.status)}</span>
            ${ev.detail ? `<span class="detail">${escapeHtml(ev.detail)}</span>` : ''}
          </div>
        `;
      }).join('');
      container.scrollTop = 0;
      setBadge(id, 'log', log.length);
    }

    function appendStatusLog(id, status, detail) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      if (!entry.statusLog) entry.statusLog = [];
      entry.statusLog.push({ at: new Date().toISOString(), status, detail: detail || '' });
      if (entry.statusLog.length > 500) entry.statusLog.splice(0, entry.statusLog.length - 500);
      setBadge(id, 'log', entry.statusLog.length);
      if (entry.drawerOpen && entry.activeTab === 'log') {
        renderStatusLogTab(id);
      }
    }

    function setBadge(id, tab, count) {
      const el = document.getElementById(`badge-${tab}-${id}`);
      if (el) el.textContent = String(count);
    }

    function copyRowText(row, text) {
      const done = () => {
        row.classList.add('copied');
        setTimeout(() => row.classList.remove('copied'), 700);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(err => {
          console.error('[client] clipboard write failed:', err);
        });
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (err) { console.error('[client] fallback copy failed:', err); }
      }
    }

    function escapeAttr(str) {
      return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===== Panel actions =====
    function focusPanel(id) {
      const grid = document.getElementById('termGrid');
      const isAlreadyFocused = grid.classList.contains('layout-focus') && state.focusedId === id;

      if (isAlreadyFocused) {
        // Restore previous layout
        setLayout(state.layout);
        document.querySelectorAll('.term-panel').forEach(p => {
          p.classList.remove('focused');
          p.style.display = '';
        });
      } else {
        grid.className = 'grid-container layout-focus';
        document.querySelectorAll('.term-panel').forEach(p => {
          p.classList.remove('focused');
        });
        const panel = document.getElementById(`panel-${id}`);
        if (panel) panel.classList.add('focused');
        state.focusedId = id;
      }

      // Transfer xterm keyboard focus to the focused panel — without this,
      // the CSS class is the only thing that changed and keystrokes still
      // go to whichever element had DOM focus before (often the launcher
      // input, which submits a NEW terminal on Enter, or the previously
      // focused panel — leading to "easy to put wrong response into a
      // chat" reports). Mirrors the focus transfer in focusSessionById.
      const entry = state.sessions.get(id);
      if (entry && entry.terminal) {
        try { entry.terminal.focus(); } catch (err) { /* ignore */ }
      } else if (entry && entry.inputEl) {
        try { entry.inputEl.focus(); } catch (err) { /* ignore */ }  // web-chat inject box
      }

      // Re-fit all visible terminals
      requestAnimationFrame(() => fitAll());
    }

    function reconnectSession(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;

      const ws = new WebSocket(`${WS_BASE}?session=${id}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'output':
              entry.terminal.write(msg.data);
              break;
            case 'meta':
              updatePanelMeta(id, msg.session.meta);
              break;
            case 'proactive_memory':
              showProactiveToast(id, msg.hit, msg.flashback_event_id);
              break;
            case 'exit':
              updatePanelMeta(id, { status: 'exited', statusDetail: `Exited (${msg.exitCode})` });
              const p = document.getElementById(`panel-${id}`);
              if (p) p.classList.add('exited');
              break;
            case 'panel_exited':
              // Sprint 65 T1 (1.3) — parity with the main WS handler so the
              // dead-tile removal still fires for reconnected panels.
              handlePanelExited(msg.sessionId, msg.exitCode);
              break;
            case 'status_broadcast':
              updateGlobalStats(msg.sessions);
              break;
            case 'config_changed':
              // Sprint 40 T1: parity with the main panel WS handler. The
              // server broadcasts config_changed to ALL ws clients, including
              // reconnected sessions; previously the reconnect path silently
              // dropped these. Idempotent — safe to re-receive.
              if (msg.config) {
                state.config = { ...state.config, ...msg.config };
                if (typeof renderSettingsPanel === 'function') renderSettingsPanel();
                if (typeof updateRagIndicator === 'function') updateRagIndicator();
              }
              break;
            case 'projects_changed':
              // Sprint 42 T4: parity with main WS handler. Project add/remove
              // broadcasts arrive on every ws client; idempotent.
              if (msg.projects && state.config) {
                state.config.projects = msg.projects;
                if (typeof rebuildProjectDropdown === 'function') rebuildProjectDropdown();
              }
              break;
          }
        } catch (err) { console.error('[client] reconnect ws message failed:', err); }
      };

      ws.onopen = () => {
        console.log(`[ws] Reconnected session ${id}`);
        entry._reconnectAttempts = 0;
        entry.ws = ws;
        updatePanelMeta(id, { status: 'active', statusDetail: 'Reconnected' });
      };

      ws.onclose = (event) => {
        const panel = document.getElementById(`panel-${id}`);
        if (panel && panel.classList.contains('exited')) return;
        if (event.code === 4001) {
          // Session no longer exists on server
          updatePanelMeta(id, { status: 'exited', statusDetail: 'Session ended' });
          if (panel) panel.classList.add('exited');
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, (entry._reconnectAttempts || 0)), 10000);
        entry._reconnectAttempts = (entry._reconnectAttempts || 0) + 1;
        if (entry._reconnectAttempts <= 5) {
          setTimeout(() => reconnectSession(id), delay);
        } else {
          updatePanelMeta(id, { status: 'errored', statusDetail: 'Connection lost' });
        }
      };

      // No input re-wiring (Sprint 73 T3, termdeck#12): the single onData
      // handler registered at panel creation dereferences entry.ws at event
      // time, so the `entry.ws = ws` assignment in onopen above is all a
      // reconnect needs. Pre-Sprint-73 this function re-ran terminal.onData()
      // here, leaking one handler (closed over its dead socket) per reconnect.
    }

    function halfPanel(id) {
      const grid = document.getElementById('termGrid');
      grid.className = 'grid-container layout-half';
      document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('primary'));
      const panel = document.getElementById(`panel-${id}`);
      if (panel) panel.classList.add('primary');
      requestAnimationFrame(() => fitAll());
    }

    async function closePanel(id) {
      if (!confirm('Close this terminal? The process will be killed.')) return;

      await api('DELETE', `/api/sessions/${id}`);

      const entry = state.sessions.get(id);
      if (entry) {
        if (entry.terminal) entry.terminal.dispose();  // web-chat panels have no xterm
        if (entry.ws) entry.ws.close();
        if (entry.el) entry.el.remove();
        state.sessions.delete(id);
      }

      updateEmptyState();
      renderSwitcher();
      refreshAllReplyFormsFor(id);
      refreshPanelIndices();
      // Sprint 65 T1 — closing a panel changes chip counts / may empty a chip.
      refreshDashboardChrome();
    }

    function changeTheme(id, themeId) {
      const entry = state.sessions.get(id);
      if (!entry) return;

      const themeObj = getThemeObject(themeId);
      if (entry.terminal) entry.terminal.options.theme = themeObj;  // no xterm on web-chat panels

      // Persist to server (writes to sessions.theme_override server-side)
      api('PATCH', `/api/sessions/${id}`, { theme: themeId });
    }

    // v0.7.0: clear sessions.theme_override server-side and snap the panel back
    // to whatever the resolver currently picks (project default → global default
    // → tokyo-night). Server returns the resolved value in the PATCH response so
    // the dropdown + xterm theme update without waiting for the 2s broadcast.
    async function resetTheme(id) {
      const entry = state.sessions.get(id);
      if (!entry) return;
      const updated = await api('PATCH', '/api/sessions/' + id, { theme: null });
      const resolved = updated && updated.meta && updated.meta.theme;
      if (!resolved) return;
      if (entry.terminal) entry.terminal.options.theme = getThemeObject(resolved);
      const sel = document.getElementById('theme-' + id);
      if (sel && sel.value !== resolved) sel.value = resolved;
    }

    // Sprint 66 T1 (Task 1.3) — mark / unmark a LIVE panel as the orchestrator
    // in place. Brad's existing orchestrator panel was spawned with no role and
    // there was no way to set one short of destroy+recreate via the raw API.
    // This PATCHes meta.role (the Task 1.2 endpoint); on success the panel
    // moves into the pinned ORCH row and gains the gold border + "ORCH " badge
    // with no reload — reconcileOrchRow() (via refreshDashboardChrome) moves it.
    // Multi-orchestrator is allowed: marking panel B does not unmark panel A
    // (the ORCH row holds more than one; the operator explicitly unmarks). A
    // global function — invoked from the Overview-tab button's inline onclick.
    async function toggleOrchestratorRole(id) {
      const entry = state.sessions.get(id);
      if (!entry || entry._mounting || !entry.session) return;
      const current = entry.session.meta ? entry.session.meta.role : null;
      const next = nextRoleForToggle(current);
      const btn = document.getElementById(`orch-toggle-${id}`);
      if (btn) btn.disabled = true;
      try {
        const updated = await api('PATCH', `/api/sessions/${id}`, { role: next });
        // api() returns the parsed body; a non-2xx body is annotated with
        // `.error` (annotateApiFailure). The toggle only ever sends a
        // whitelisted value so a 400 should not occur — but a 404 (panel gone)
        // or a network failure can, and must not be applied as success.
        if (updated && updated.error) {
          console.error('[client] orchestrator-role toggle failed:', updated.error);
          return;
        }
        // Apply the authoritative server role from the PATCH response, then
        // re-route + re-skin the panel. The 2s status_broadcast converges to
        // the same value (eventually-consistent — same model as changeTheme).
        if (entry.session.meta) {
          entry.session.meta.role = (updated && updated.meta) ? updated.meta.role : next;
        }
        refreshDashboardChrome();
      } catch (err) {
        console.error('[client] orchestrator-role toggle error:', err);
      } finally {
        if (btn) btn.disabled = false;
        syncOrchToggle(id);
      }
    }

    // Sprint 66 T1 (Task 1.3) — keep a panel's orch-toggle button in sync with
    // its current meta.role (label, active class, tooltip). Called after a
    // toggle and on every status_broadcast (updatePanelMeta), so the button is
    // correct even when the role is changed from another dashboard tab.
    function syncOrchToggle(id) {
      const entry = state.sessions.get(id);
      const btn = document.getElementById(`orch-toggle-${id}`);
      if (!entry || entry._mounting || !entry.session || !btn) return;
      const role = entry.session.meta ? entry.session.meta.role : null;
      const isOrch = isOrchestratorRole(role);
      btn.textContent = orchToggleLabel(role);
      btn.classList.toggle('is-orch', isOrch);
      btn.title = isOrch
        ? 'Unmark this panel (remove the orchestrator role)'
        : 'Mark this panel as the master orchestrator — gold border, ORCH★ badge, pinned row';
    }

    async function askAI(id, question) {
      if (!question.trim()) return;
      const entry = state.sessions.get(id);
      if (!entry) return;

      // Sprint 72 T3 — web-chat panels have no xterm; route mnestra output to a
      // no-op writer so askAI still caches Memory-tab hits without crashing on a
      // missing terminal. (xterm panels render inline exactly as before.)
      const tw = (s) => { if (entry.terminal) { try { entry.terminal.write(s); } catch (e) { /* ignore */ } } };

      // Early return if AI queries are not available
      if (!state.config.aiQueryAvailable) {
        tw(
          '\r\n\x1b[33m[mnestra] AI queries are not available.\x1b[0m\r\n' +
          '\x1b[33mTo enable, add the following to ~/.termdeck/config.yaml:\x1b[0m\r\n' +
          '\x1b[90m  rag:\r\n' +
          '    supabaseUrl: https://your-project.supabase.co\r\n' +
          '    supabaseKey: your-anon-key\r\n' +
          '    openaiApiKey: sk-...\x1b[0m\r\n'
        );
        return;
      }

      const inputEl = document.getElementById(`ai-${id}`);
      inputEl.value = 'Searching memories...';
      inputEl.disabled = true;

      try {
        const result = await api('POST', '/api/ai/query', {
          question,
          sessionId: id,
          project: entry.session?.meta?.project || null
        });

        if (result.error) {
          tw(`\r\n\x1b[33m[mnestra] ${result.error}\x1b[0m\r\n`);
        } else if (result.memories && result.memories.length > 0) {
          // Cache hits for the Memory tab
          if (!entry.memoryHits) entry.memoryHits = [];
          const cachedAt = new Date().toISOString();
          for (const m of result.memories) {
            entry.memoryHits.unshift({ ...m, cachedAt });
          }
          if (entry.memoryHits.length > 60) {
            entry.memoryHits.length = 60;
          }
          setBadge(id, 'memory', entry.memoryHits.length);
          if (entry.drawerOpen && entry.activeTab === 'memory') {
            renderMemoryTab(id);
          }
          const cols = (entry.terminal && entry.terminal.cols) || 80;
          const wrap = (text, indent) => {
            const maxW = cols - indent - 2;
            const words = text.split(/\s+/);
            const lines = [];
            let line = '';
            for (const w of words) {
              if (line.length + w.length + 1 > maxW && line.length > 0) {
                lines.push(' '.repeat(indent) + line);
                line = w;
              } else {
                line = line ? line + ' ' + w : w;
              }
            }
            if (line) lines.push(' '.repeat(indent) + line);
            return lines;
          };

          tw(`\r\n\x1b[36m━━━ Mnestra: ${result.total} memories found ━━━\x1b[0m\r\n`);
          for (const m of result.memories) {
            const score = m.similarity ? `${(m.similarity * 100).toFixed(0)}%` : '';
            const proj = m.project ? m.project : '';
            tw(`\r\n\x1b[35m● ${m.source_type}\x1b[0m \x1b[90m${proj} ${score}\x1b[0m\r\n`);
            const contentLines = wrap(m.content || '(empty)', 2);
            for (const cl of contentLines) {
              tw(`${cl}\r\n`);
            }
          }
          tw(`\r\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\r\n\r\n`);
        } else {
          tw(`\r\n\x1b[33m[mnestra] No relevant memories found.\x1b[0m\r\n`);
        }
      } catch (err) {
        console.error('[client] AI query failed:', err);
        tw(`\r\n\x1b[31m[mnestra] Query failed: ${err.message}\x1b[0m\r\n`);
      }

      inputEl.value = '';
      inputEl.disabled = false;
      inputEl.placeholder = 'Ask about this terminal...';
    }

    // ===== Quick launch from empty state =====
    function quickLaunch(cmd) {
      document.getElementById('promptInput').value = cmd;
      launchTerminal();
    }

    // ===== Adapter-driven launcher buttons (Sprint 50 T3) =====
    //
    // Built-in non-adapter entries that flank the adapter list. `shell` is
    // the always-on fallback panel; `python` is the HTTP-server convenience
    // launcher that long predates the multi-agent registry.
    const BUILTIN_LAUNCHERS = {
      pre: [
        { command: 'zsh', label: 'shell', title: 'Open a zsh shell' },
      ],
      post: [
        {
          command: 'python3 -m http.server 8080',
          label: 'python',
          title: 'Open a Python HTTP server on :8080',
        },
      ],
    };

    // One launcher button. Reuses the same `quickLaunch(cmd)` path the
    // hardcoded HTML buttons used so command resolution (LauncherResolver
    // + /api/sessions) is unchanged.
    function makeLauncherButton(cmd, label, title, className) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = label;
      if (title) btn.title = title;
      btn.dataset.command = cmd;
      btn.addEventListener('click', () => quickLaunch(cmd));
      return btn;
    }

    function adapterLauncherEntries() {
      const adapters = Array.isArray(state.agentAdapters) ? state.agentAdapters : [];
      return adapters.map((a) => ({
        command: a.binary || a.name,
        label: (a.displayName || a.name || a.binary || '').toLowerCase(),
        // Title text gets the canonical displayName so the tooltip preserves
        // the proper-cased "Claude Code" / "Codex CLI" form even when the
        // button face renders lowercase to match TermDeck's chrome style.
        title: `Open ${a.displayName || a.name || a.binary}`,
      }));
    }

    function renderQuickLaunchers() {
      const adapters = adapterLauncherEntries();
      const ordered = [
        ...BUILTIN_LAUNCHERS.pre,
        ...adapters,
        ...BUILTIN_LAUNCHERS.post,
      ];

      // Topbar — compact buttons.
      const topbar = document.getElementById('topbarQuickLaunch');
      if (topbar) {
        topbar.replaceChildren();
        for (const entry of ordered) {
          topbar.appendChild(
            makeLauncherButton(entry.command, entry.label, entry.title, 'topbar-ql-btn'),
          );
        }
      }

      // Empty state — taller tiles with the raw command rendered as a
      // secondary line. Mirrors the pre-Sprint-50 markup so existing CSS
      // classes (`quick-launch-btn`, `ql-cmd`, `ql-desc`) keep their styling.
      const emptyGroup = document.querySelector('#emptyState .quick-launch-group');
      if (emptyGroup) {
        emptyGroup.replaceChildren();
        for (const entry of ordered) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'quick-launch-btn';
          btn.title = entry.title;
          btn.dataset.command = entry.command;

          const cmd = document.createElement('span');
          cmd.className = 'ql-cmd';
          cmd.textContent = entry.command;

          const desc = document.createElement('span');
          desc.className = 'ql-desc';
          desc.textContent = entry.title;

          btn.appendChild(cmd);
          btn.appendChild(desc);
          btn.addEventListener('click', () => quickLaunch(entry.command));
          emptyGroup.appendChild(btn);
        }
      }
    }

    // ===== Add Project modal =====
    function rebuildProjectDropdown(selectName) {
      const sel = document.getElementById('promptProject');
      if (!sel) return;
      const prev = selectName || sel.value;
      sel.innerHTML = '<option value="">no project</option>';
      for (const name of Object.keys(state.config.projects || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      if (prev && state.config.projects && state.config.projects[prev]) {
        sel.value = prev;
      }
      syncPreviewButton();
    }

    function openAddProjectModal() {
      const modal = document.getElementById('addProjectModal');
      // Populate theme dropdown from loaded themes
      const themeSel = document.getElementById('apmTheme');
      themeSel.innerHTML = '<option value="">— pick a theme —</option>';
      for (const [tid, t] of Object.entries(state.themes || {})) {
        const opt = document.createElement('option');
        opt.value = tid;
        opt.textContent = t.label || tid;
        themeSel.appendChild(opt);
      }
      // Clear fields
      document.getElementById('apmName').value = '';
      document.getElementById('apmPath').value = '';
      document.getElementById('apmCommand').value = '';
      document.getElementById('apmTheme').value = '';
      setApmStatus('', null);
      modal.classList.add('open');
      setTimeout(() => document.getElementById('apmName').focus(), 50);
    }

    function closeAddProjectModal() {
      document.getElementById('addProjectModal').classList.remove('open');
    }

    function setApmStatus(msg, kind) {
      const el = document.getElementById('apmStatus');
      el.textContent = msg || '';
      el.classList.remove('error', 'ok');
      if (kind) el.classList.add(kind);
    }

    async function submitAddProject() {
      const name = document.getElementById('apmName').value.trim();
      const projectPath = document.getElementById('apmPath').value.trim();
      const defaultCommand = document.getElementById('apmCommand').value.trim();
      const defaultTheme = document.getElementById('apmTheme').value;

      if (!name) { setApmStatus('Name is required.', 'error'); return; }
      if (!projectPath) { setApmStatus('Path is required.', 'error'); return; }

      const saveBtn = document.getElementById('apmSave');
      saveBtn.disabled = true;
      setApmStatus('Saving…', null);

      try {
        const result = await api('POST', '/api/projects', {
          name,
          path: projectPath,
          defaultCommand: defaultCommand || undefined,
          defaultTheme: defaultTheme || undefined,
        });
        if (result && result.error) {
          setApmStatus(result.error, 'error');
          saveBtn.disabled = false;
          return;
        }
        // Merge the updated projects into in-memory state.config so subsequent
        // launches can immediately use the new project.
        state.config.projects = result.projects || {};
        rebuildProjectDropdown(name);
        setApmStatus(`Added "${name}" ✓`, 'ok');
        setTimeout(() => { closeAddProjectModal(); saveBtn.disabled = false; }, 700);
      } catch (err) {
        setApmStatus(`Failed: ${err.message || err}`, 'error');
        saveBtn.disabled = false;
      }
    }

    // ===== Remove Project modal (Sprint 42 T4) =====
    // Removes a project from ~/.termdeck/config.yaml. Files on disk at the
    // project's `path` are NEVER touched — the modal copy makes that explicit
    // so users don't fear data loss. 409 from the server (live PTY sessions
    // for that project) prompts the user with a force-override.
    function openRemoveProjectModal() {
      const modal = document.getElementById('removeProjectModal');
      const sel = document.getElementById('rpmSelect');
      sel.innerHTML = '<option value="">— pick a project —</option>';
      for (const name of Object.keys(state.config.projects || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      sel.value = '';
      document.getElementById('rpmConfirm').disabled = true;
      document.getElementById('rpmConfirm').dataset.force = '';
      document.getElementById('rpmConfirm').textContent = 'remove project';
      const warn = document.getElementById('rpmWarning');
      warn.hidden = true;
      warn.textContent = '';
      setRpmStatus('', null);
      modal.classList.add('open');
      setTimeout(() => sel.focus(), 50);
    }

    function closeRemoveProjectModal() {
      document.getElementById('removeProjectModal').classList.remove('open');
    }

    function setRpmStatus(msg, kind) {
      const el = document.getElementById('rpmStatus');
      if (!el) return;
      el.textContent = msg || '';
      el.classList.remove('error', 'ok');
      if (kind) el.classList.add(kind);
    }

    function onRpmSelectChange() {
      const name = document.getElementById('rpmSelect').value;
      const btn = document.getElementById('rpmConfirm');
      btn.disabled = !name;
      btn.dataset.force = '';
      btn.textContent = name ? `remove "${name}"` : 'remove project';
      const warn = document.getElementById('rpmWarning');
      warn.hidden = true;
      warn.textContent = '';
      setRpmStatus('', null);
    }

    async function submitRemoveProject() {
      const name = document.getElementById('rpmSelect').value;
      if (!name) return;
      const btn = document.getElementById('rpmConfirm');
      const force = btn.dataset.force === 'true';
      btn.disabled = true;
      setRpmStatus(force ? 'Removing (with force)…' : 'Removing…', null);

      try {
        const url = `${API}/api/projects/${encodeURIComponent(name)}${force ? '?force=true' : ''}`;
        const res = await fetch(url, { method: 'DELETE' });
        const text = await res.text();
        let body = {};
        try { body = JSON.parse(text); } catch { body = { error: text }; }

        if (res.status === 409) {
          const live = body.liveSessions || 0;
          const warn = document.getElementById('rpmWarning');
          warn.hidden = false;
          warn.innerHTML =
            `<strong>"${name}" has ${live} live PTY session${live === 1 ? '' : 's'}.</strong> ` +
            `Closing those terminals first is recommended. ` +
            `Or click <em>remove anyway</em> to force removal — terminals stay open but lose their project tag in config.yaml.`;
          btn.dataset.force = 'true';
          btn.textContent = 'remove anyway';
          btn.disabled = false;
          setRpmStatus('', null);
          return;
        }

        if (!res.ok) {
          setRpmStatus(`Failed: ${body.error || res.statusText}`, 'error');
          btn.disabled = false;
          return;
        }

        // Success — sync in-memory config + dropdown.
        state.config.projects = body.projects || {};
        rebuildProjectDropdown();
        setRpmStatus(`Removed "${name}" ✓ (files on disk untouched)`, 'ok');
        setTimeout(() => { closeRemoveProjectModal(); }, 900);
      } catch (err) {
        setRpmStatus(`Failed: ${err.message || err}`, 'error');
        btn.disabled = false;
      }
    }

    // ===== Orchestration preview modal (Sprint 37 T3) =====
    // The preview button next to the project select shows what
    // `termdeck init --project <name>` would create for the currently
    // selected project. Disabled when no project is selected.
    function previewState() {
      if (!state.preview) state.preview = { current: null, busy: false };
      return state.preview;
    }

    function syncPreviewButton() {
      const btn = document.getElementById('btnPreviewProject');
      if (!btn) return;
      const name = (document.getElementById('promptProject') || {}).value || '';
      btn.disabled = !name;
      btn.title = name
        ? `Preview orchestration scaffolding for "${name}"`
        : 'Select a project to preview its orchestration scaffolding';
    }

    function setPpmStatus(msg, kind) {
      const el = document.getElementById('ppmStatus');
      if (!el) return;
      el.textContent = msg || '';
      el.classList.remove('error', 'ok');
      if (kind) el.classList.add(kind);
    }

    function escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderPreviewMeta(payload) {
      const el = document.getElementById('ppmMeta');
      if (!el) return;
      const tag = payload.exists
        ? '<span class="ppm-meta-tag exists">exists</span>'
        : '<span class="ppm-meta-tag fresh">fresh</span>';
      el.innerHTML =
        `<b>${escHtml(payload.projectName)}</b>${tag}<br>` +
        `→ ${escHtml(payload.targetPath)}`;
    }

    function renderPreviewTree(payload) {
      const tree = document.getElementById('ppmTree');
      if (!tree) return;
      const total = (payload.wouldCreate || []).length + (payload.wouldSkip || []).length;
      if (total === 0) {
        tree.innerHTML = '<div class="ppm-empty">No templates returned. Check that the orchestration scaffolding is available on this server.</div>';
        return;
      }

      const sections = [];
      if (payload.wouldCreate && payload.wouldCreate.length > 0) {
        sections.push(buildSection('Would create', 'create', payload.wouldCreate));
      }
      if (payload.created && payload.created.length > 0) {
        sections.push(buildSection('Created', 'create', payload.created));
      }
      if (payload.wouldSkip && payload.wouldSkip.length > 0) {
        sections.push(buildSection('Would skip', 'skip', payload.wouldSkip));
      }
      tree.innerHTML = sections.join('');

      // Wire expand/collapse on row headers (event delegation).
      tree.querySelectorAll('.ppm-row-header').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.ppm-row');
          if (row) row.classList.toggle('expanded');
        });
      });
    }

    function buildSection(label, kind, entries) {
      const rows = entries.map((e) => buildRow(kind, e)).join('');
      return `<div class="ppm-section">
        <div class="ppm-section-label">${escHtml(label)} (${entries.length})</div>
        ${rows}
      </div>`;
    }

    function buildRow(kind, entry) {
      const truncated = entry.totalLines > (entry.contentPreview || '').split('\n').length;
      const moreLines = truncated
        ? entry.totalLines - entry.contentPreview.split('\n').length
        : 0;
      const reason = entry.reason
        ? `<div class="ppm-row-skip-reason">${escHtml(entry.reason)}</div>`
        : '';
      const truncatedNote = moreLines > 0
        ? `<div class="ppm-row-truncated">… ${moreLines} more line${moreLines === 1 ? '' : 's'} (preview truncated)</div>`
        : '';
      return `<div class="ppm-row ${escHtml(kind)}">
        <button type="button" class="ppm-row-header" aria-label="Toggle preview">
          <span class="ppm-row-icon">▸</span>
          <span class="ppm-row-path">${escHtml(entry.path)}</span>
          <span class="ppm-row-meta">${entry.totalLines} ${entry.totalLines === 1 ? 'line' : 'lines'}</span>
          <span class="ppm-row-tag ${escHtml(kind)}">${escHtml(kind === 'skip' ? 'skip' : 'new')}</span>
        </button>
        <div class="ppm-row-body">
          ${reason}
          <pre>${escHtml(entry.contentPreview || '')}</pre>
          ${truncatedNote}
        </div>
      </div>`;
    }

    async function loadPreview(name) {
      const ps = previewState();
      ps.current = name;
      setPpmStatus('Loading…', null);
      const tree = document.getElementById('ppmTree');
      if (tree) tree.innerHTML = '<div class="ppm-empty">Loading…</div>';
      const meta = document.getElementById('ppmMeta');
      if (meta) meta.textContent = '';
      const genBtn = document.getElementById('ppmGenerate');
      const forceCb = document.getElementById('ppmForce');
      if (genBtn) genBtn.disabled = true;
      if (forceCb) forceCb.checked = false;

      try {
        const payload = await api('GET', `/api/projects/${encodeURIComponent(name)}/orchestration-preview`);
        if (!payload || payload.error) {
          setPpmStatus(payload && payload.error ? payload.error : 'Failed to load preview', 'error');
          return;
        }
        if (ps.current !== name) return; // user closed/changed before fetch returned
        renderPreviewMeta(payload);
        renderPreviewTree(payload);
        setPpmStatus('', null);
        if (genBtn) {
          // Enable Generate when there is at least one wouldCreate entry, OR
          // when the target dir exists (force overwrites preserved by checkbox).
          const hasNew = (payload.wouldCreate || []).length > 0;
          genBtn.disabled = !hasNew && !payload.exists;
        }
      } catch (err) {
        setPpmStatus(`Failed: ${(err && err.message) || err}`, 'error');
      }
    }

    function openPreviewModal() {
      const sel = document.getElementById('promptProject');
      const name = sel && sel.value;
      if (!name) return;
      const modal = document.getElementById('previewProjectModal');
      if (!modal) return;
      modal.classList.add('open');
      loadPreview(name);
    }

    function closePreviewModal() {
      const modal = document.getElementById('previewProjectModal');
      if (modal) modal.classList.remove('open');
      previewState().current = null;
    }

    async function submitGenerate() {
      const ps = previewState();
      if (ps.busy || !ps.current) return;
      const force = !!document.getElementById('ppmForce').checked;
      const confirmMsg = force
        ? `Overwrite scaffolding files in "${ps.current}"? Existing files will be replaced.`
        : `Generate orchestration scaffolding for "${ps.current}"?`;
      if (!window.confirm(confirmMsg)) return;

      const genBtn = document.getElementById('ppmGenerate');
      ps.busy = true;
      if (genBtn) genBtn.disabled = true;
      setPpmStatus('Generating…', null);
      try {
        const result = await api('POST',
          `/api/projects/${encodeURIComponent(ps.current)}/orchestration-preview/generate`,
          { force });
        if (!result || result.error) {
          setPpmStatus(result && result.error ? result.error : 'Generate failed', 'error');
          ps.busy = false;
          if (genBtn) genBtn.disabled = false;
          return;
        }
        renderPreviewMeta(result);
        renderPreviewTree(result);
        const count = (result.created || []).length;
        setPpmStatus(`Generated ${count} file${count === 1 ? '' : 's'} ✓`, 'ok');
        // Refresh the preview so the user sees the post-write state (every
        // file is now wouldSkip). Small delay so the success message reads.
        setTimeout(() => { if (ps.current) loadPreview(ps.current); }, 800);
      } catch (err) {
        setPpmStatus(`Failed: ${(err && err.message) || err}`, 'error');
      } finally {
        ps.busy = false;
        if (genBtn) genBtn.disabled = false;
      }
    }

    // ===== Sprint runner modal (Sprint 37 T4) =====
    // Lets the user define a 4+1 sprint (name, version, goal, T1-T4 lanes,
    // worktree opt-in), POST /api/sprints to scaffold + spawn + inject, then
    // tail STATUS.md while lanes work.
    function sprintState() {
      if (!state.sprint) {
        state.sprint = { pollTimer: null, currentSprintName: null, currentProject: null };
      }
      return state.sprint;
    }

    function setSprintStatus(msg, kind) {
      const el = document.getElementById('sprintStatusMsg');
      if (!el) return;
      el.textContent = msg || '';
      el.classList.remove('error', 'ok');
      if (kind) el.classList.add(kind);
    }

    function openSprintModal() {
      const modal = document.getElementById('sprintModal');
      // Populate project dropdown from loaded config.
      const sel = document.getElementById('sprintProject');
      sel.innerHTML = '';
      const projects = Object.keys(state.config.projects || {});
      if (projects.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— add a project first —';
        sel.appendChild(opt);
        sel.disabled = true;
      } else {
        sel.disabled = false;
        for (const name of projects) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
      }
      // Reset form.
      document.getElementById('sprintName').value = '';
      document.getElementById('sprintTargetVersion').value = '';
      document.getElementById('sprintGoal').value = '';
      document.querySelectorAll('#sprintModal .sprint-lane-name').forEach((el) => { el.value = ''; });
      document.querySelectorAll('#sprintModal .sprint-lane-goal').forEach((el) => { el.value = ''; });
      document.getElementById('sprintWorktree').checked = true;
      document.getElementById('sprintAutoInject').checked = true;
      document.getElementById('sprintFormBody').style.display = '';
      document.getElementById('sprintResultPanel').style.display = 'none';
      setSprintStatus('', null);
      modal.classList.add('open');
      setTimeout(() => document.getElementById('sprintName').focus(), 50);
    }

    function closeSprintModal() {
      const s = sprintState();
      if (s.pollTimer) {
        clearInterval(s.pollTimer);
        s.pollTimer = null;
      }
      document.getElementById('sprintModal').classList.remove('open');
    }

    function readSprintLanes() {
      const lanes = [];
      const nameInputs = document.querySelectorAll('#sprintModal .sprint-lane-name');
      const goalInputs = document.querySelectorAll('#sprintModal .sprint-lane-goal');
      for (let i = 0; i < 4; i++) {
        lanes.push({
          name: (nameInputs[i] && nameInputs[i].value || '').trim(),
          goal: (goalInputs[i] && goalInputs[i].value || '').trim(),
        });
      }
      return lanes;
    }

    async function submitSprint() {
      const project = document.getElementById('sprintProject').value;
      const name = document.getElementById('sprintName').value.trim();
      const targetVersion = document.getElementById('sprintTargetVersion').value.trim();
      const goal = document.getElementById('sprintGoal').value.trim();
      const worktree = document.getElementById('sprintWorktree').checked;
      const autoInject = document.getElementById('sprintAutoInject').checked;
      const lanes = readSprintLanes();

      if (!project) { setSprintStatus('Pick a project.', 'error'); return; }
      if (!name) { setSprintStatus('Sprint name is required.', 'error'); return; }
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
        setSprintStatus('Name must be a slug (lowercase a-z0-9 + hyphens, ≤40 chars).', 'error');
        return;
      }
      for (let i = 0; i < 4; i++) {
        if (!lanes[i].name) {
          setSprintStatus(`T${i + 1} lane name is required.`, 'error');
          return;
        }
      }

      const btn = document.getElementById('sprintKickoff');
      btn.disabled = true;
      setSprintStatus('Scaffolding sprint, spawning panels, injecting boot prompts…', null);

      try {
        const result = await api('POST', '/api/sprints', {
          project, name, targetVersion, goal, lanes, worktree, autoInject,
        });
        if (result && result.error) {
          setSprintStatus(result.error, 'error');
          btn.disabled = false;
          return;
        }
        renderSprintResult(result, project);
        // Reload sessions in the dashboard so the four new panels appear.
        try {
          const liveSessions = await api('GET', '/api/sessions');
          for (const s of liveSessions) {
            if (s.meta.status !== 'exited' && !state.sessions.has(s.id)) {
              createTerminalPanel(s);
            }
          }
        } catch {
          // Non-fatal — user can refresh.
        }
        startSprintStatusPoll(project, name);
      } catch (err) {
        setSprintStatus(`Failed: ${err && err.message || err}`, 'error');
        btn.disabled = false;
      }
    }

    function renderSprintResult(result, project) {
      document.getElementById('sprintFormBody').style.display = 'none';
      const panel = document.getElementById('sprintResultPanel');
      panel.style.display = '';
      const meta = document.getElementById('sprintResultMeta');
      const sids = result.sessionIds || {};
      const wt = result.worktree ? 'on' : 'off';
      const inject = result.inject || {};
      const verifiedCount = Array.isArray(inject.lanes) ? inject.lanes.filter((l) => l.verified).length : 0;
      const pokedCount = Array.isArray(inject.lanes) ? inject.lanes.filter((l) => l.poked).length : 0;
      meta.innerHTML = [
        `<div>sprint dir: <code>${result.sprintDir}</code></div>`,
        `<div>worktree isolation: ${wt}</div>`,
        `<div>panels spawned: T1=${sids.T1 || '—'} · T2=${sids.T2 || '—'} · T3=${sids.T3 || '—'} · T4=${sids.T4 || '—'}</div>`,
        `<div>boot inject: verified ${verifiedCount}/4 · auto-poked ${pokedCount}</div>`,
      ].join('');
      // Reset lane status tiles to a "polling…" state.
      ['T1', 'T2', 'T3', 'T4'].forEach((laneId) => {
        const tile = panel.querySelector(`.sprint-lane-status[data-lane="${laneId}"]`);
        if (!tile) return;
        tile.querySelector('.counts').textContent = '—';
        tile.querySelector('.last-entry').textContent = 'polling…';
      });
      document.getElementById('sprintTail').textContent = '(tail loads after first STATUS.md write)';
    }

    async function pollSprintStatus(project, sprintName) {
      try {
        const [statusRes, tailRes] = await Promise.all([
          fetch(`${API}/api/sprints/${encodeURIComponent(sprintName)}/status?project=${encodeURIComponent(project)}`),
          fetch(`${API}/api/sprints/${encodeURIComponent(sprintName)}/tail?project=${encodeURIComponent(project)}&lines=80`),
        ]);
        if (statusRes.ok) {
          const status = await statusRes.json();
          renderSprintLaneCounts(status);
        }
        if (tailRes.ok) {
          const tail = await tailRes.json();
          if (tail && typeof tail.tail === 'string') {
            document.getElementById('sprintTail').textContent = tail.tail;
          }
        }
      } catch {
        // Silently ignore poll errors; next tick retries.
      }
    }

    function renderSprintLaneCounts(status) {
      const panel = document.getElementById('sprintResultPanel');
      if (!panel) return;
      ['T1', 'T2', 'T3', 'T4'].forEach((laneId) => {
        const tile = panel.querySelector(`.sprint-lane-status[data-lane="${laneId}"]`);
        if (!tile) return;
        const lane = status && status.lanes && status.lanes[laneId];
        if (!lane) {
          tile.querySelector('.counts').textContent = '—';
          tile.querySelector('.last-entry').textContent = 'awaiting first entry';
          return;
        }
        tile.querySelector('.counts').textContent =
          `${lane.finding} finding · ${lane.fixProposed} fix · ${lane.done} done`;
        tile.querySelector('.last-entry').textContent =
          lane.lastEntryAt ? `last: ${lane.lastEntryAt}` : 'awaiting first entry';
      });
    }

    function startSprintStatusPoll(project, sprintName) {
      const s = sprintState();
      if (s.pollTimer) clearInterval(s.pollTimer);
      s.currentProject = project;
      s.currentSprintName = sprintName;
      pollSprintStatus(project, sprintName);
      s.pollTimer = setInterval(() => pollSprintStatus(project, sprintName), 3000);
    }

    // ===== Rumen insights badge + briefing modal =====
    function rumenState() {
      if (!state.rumen) {
        state.rumen = {
          enabled: false,
          status: null,
          insights: [],
          total: 0,
          unseen: 0,
          filters: { project: '', sort: 'newest', unseen: false },
          pollTimer: null,
          modalOpen: false,
          prevFocus: null,
        };
      }
      return state.rumen;
    }

    function rumenRelTime(iso) {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return '—';
      const delta = Math.max(0, Date.now() - t);
      const s = Math.floor(delta / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      return `${d}d ago`;
    }

    function rumenEscape(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderRumenBadge() {
      const r = rumenState();
      const badge = document.getElementById('rumenBadge');
      const label = document.getElementById('rumenBadgeLabel');
      if (!badge || !label) return;
      if (!r.enabled) {
        badge.classList.remove('visible', 'has-unseen');
        return;
      }
      badge.classList.add('visible');
      const unseen = r.unseen | 0;
      const total = r.total | 0;
      if (unseen > 0) {
        badge.classList.add('has-unseen');
        label.textContent = `${unseen} new insight${unseen === 1 ? '' : 's'}`;
      } else {
        badge.classList.remove('has-unseen');
        label.textContent = `${total} insight${total === 1 ? '' : 's'}`;
      }
    }

    async function fetchRumenStatus() {
      try {
        const data = await api('GET', '/api/rumen/status');
        const r = rumenState();
        if (data && data.enabled === true) {
          r.enabled = true;
          r.status = data;
          r.total = data.total_insights | 0;
          r.unseen = data.unseen_insights | 0;
        } else {
          r.enabled = false;
          r.status = data || { enabled: false };
        }
        renderRumenBadge();
        if (r.modalOpen) renderRumenSummary();
      } catch (err) {
        console.warn('[rumen] status fetch failed', err);
      }
    }

    function buildRumenQuery() {
      const r = rumenState();
      const qs = new URLSearchParams();
      qs.set('limit', '50');
      if (r.filters.project) qs.set('project', r.filters.project);
      if (r.filters.unseen) qs.set('unseen', 'true');
      return qs.toString();
    }

    async function fetchRumenInsights() {
      const r = rumenState();
      try {
        const data = await api('GET', `/api/rumen/insights?${buildRumenQuery()}`);
        if (data && data.enabled === false) {
          r.enabled = false;
          r.insights = [];
          r.total = 0;
          renderRumenBadge();
          renderRumenList();
          return;
        }
        let list = Array.isArray(data?.insights) ? data.insights : [];
        if (r.filters.sort === 'confidence') {
          list = list.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        }
        r.insights = list;
        renderRumenList();
        renderRumenSummary();
      } catch (err) {
        console.warn('[rumen] insights fetch failed', err);
        const list = document.getElementById('rumenList');
        if (list) list.innerHTML = '<div class="rumen-empty">Could not load insights. Try again.</div>';
      }
    }

    function renderRumenSummary() {
      const r = rumenState();
      const summary = document.getElementById('rumenSummary');
      const title = document.getElementById('rumenTitle');
      if (!summary || !title) return;
      const total = r.total | 0;
      const unseen = r.unseen | 0;
      title.textContent = `Rumen Insights — ${total} total · ${unseen} new`;
      const s = r.status || {};
      if (s.last_job_completed_at) {
        summary.textContent =
          `Last processed: ${s.last_job_sessions_processed | 0} sessions → ` +
          `${s.last_job_insights_generated | 0} insights · ${rumenRelTime(s.last_job_completed_at)}`;
      } else if (s.last_job_status) {
        summary.textContent = `Last job: ${s.last_job_status}`;
      } else {
        summary.textContent = 'No jobs have run yet.';
      }
    }

    function renderRumenList() {
      const r = rumenState();
      const list = document.getElementById('rumenList');
      if (!list) return;
      if (!r.insights.length) {
        list.innerHTML = '<div class="rumen-empty">No insights match the current filter.</div>';
        return;
      }
      const rows = r.insights.map((ins) => {
        const chips = (ins.projects || []).map((p) => `<span class="ri-chip">${rumenEscape(p)}</span>`).join('');
        const conf = typeof ins.confidence === 'number' ? `conf ${ins.confidence.toFixed(2)}` : 'conf —';
        const seen = ins.acted_upon === true;
        const btnLabel = seen ? 'seen ✓' : 'mark seen';
        const btnClass = seen ? 'ri-mark seen' : 'ri-mark';
        const btnDisabled = seen ? 'disabled' : '';
        return (
          `<div class="rumen-item" role="listitem" data-id="${rumenEscape(ins.id)}">` +
            `<div class="ri-text">${rumenEscape(ins.insight_text)}</div>` +
            `<div class="ri-meta">` +
              `<span class="ri-conf">${conf}</span>` +
              chips +
              `<span class="ri-time">${rumenRelTime(ins.created_at)}</span>` +
              `<button type="button" class="${btnClass}" data-seen-id="${rumenEscape(ins.id)}" ${btnDisabled}>${btnLabel}</button>` +
            `</div>` +
          `</div>`
        );
      });
      list.innerHTML = rows.join('');
    }

    function populateRumenProjectFilter() {
      const r = rumenState();
      const sel = document.getElementById('rumenFilterProject');
      if (!sel) return;
      const prev = sel.value;
      const projects = new Set();
      for (const ins of r.insights) {
        for (const p of (ins.projects || [])) projects.add(p);
      }
      for (const name of Object.keys(state.config?.projects || {})) projects.add(name);
      const opts = Array.from(projects).sort();
      sel.innerHTML = '<option value="">all</option>' +
        opts.map((p) => `<option value="${rumenEscape(p)}">${rumenEscape(p)}</option>`).join('');
      if (prev && opts.includes(prev)) sel.value = prev;
    }

    async function markRumenInsightSeen(id) {
      const r = rumenState();
      const sel = (attr) => `[${attr}="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;
      const item = document.querySelector(`.rumen-item${sel('data-id')}`);
      const btn = document.querySelector(`.ri-mark${sel('data-seen-id')}`);
      if (btn) btn.disabled = true;
      const insight = r.insights.find((i) => i.id === id);
      const wasUnseen = insight && insight.acted_upon === false;
      if (insight) insight.acted_upon = true;
      if (wasUnseen && r.unseen > 0) r.unseen -= 1;
      renderRumenBadge();
      if (item) item.classList.add('fading');
      try {
        const resp = await fetch(`${API}/api/rumen/insights/${encodeURIComponent(id)}/seen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setTimeout(() => {
          if (r.filters.unseen) {
            r.insights = r.insights.filter((i) => i.id !== id);
            renderRumenList();
          } else if (item) {
            item.classList.remove('fading');
            const b = item.querySelector('.ri-mark');
            if (b) { b.classList.add('seen'); b.textContent = 'seen ✓'; b.disabled = true; }
          }
        }, 360);
      } catch (err) {
        console.warn('[rumen] mark-seen failed', err);
        if (insight) insight.acted_upon = false;
        if (wasUnseen) r.unseen += 1;
        renderRumenBadge();
        if (item) item.classList.remove('fading');
        if (btn) { btn.disabled = false; btn.textContent = 'retry'; }
      }
    }

    function openRumenModal() {
      const r = rumenState();
      if (!r.enabled) return;
      r.modalOpen = true;
      r.prevFocus = document.activeElement;
      document.getElementById('rumenModal').classList.add('open');
      populateRumenProjectFilter();
      renderRumenSummary();
      fetchRumenInsights();
      setTimeout(() => {
        const close = document.getElementById('rumenClose');
        if (close) close.focus();
      }, 30);
    }

    function closeRumenModal() {
      const r = rumenState();
      r.modalOpen = false;
      document.getElementById('rumenModal').classList.remove('open');
      if (r.prevFocus && typeof r.prevFocus.focus === 'function') {
        try { r.prevFocus.focus(); } catch {}
      }
    }

    function setupRumen() {
      const r = rumenState();
      document.getElementById('rumenBadge').addEventListener('click', openRumenModal);
      document.getElementById('rumenClose').addEventListener('click', closeRumenModal);
      document.getElementById('rumenBackdrop').addEventListener('click', closeRumenModal);
      document.getElementById('rumenModal').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeRumenModal(); }
      });
      document.getElementById('rumenFilterProject').addEventListener('change', (e) => {
        r.filters.project = e.target.value || '';
        fetchRumenInsights();
      });
      document.getElementById('rumenFilterSort').addEventListener('change', (e) => {
        r.filters.sort = e.target.value || 'newest';
        if (r.filters.sort === 'confidence') {
          r.insights = r.insights.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        } else {
          r.insights = r.insights.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        renderRumenList();
      });
      document.getElementById('rumenFilterUnseen').addEventListener('change', (e) => {
        r.filters.unseen = !!e.target.checked;
        fetchRumenInsights();
      });
      document.getElementById('rumenList').addEventListener('click', (e) => {
        const btn = e.target.closest('.ri-mark');
        if (!btn || btn.disabled) return;
        const id = btn.getAttribute('data-seen-id');
        if (id) markRumenInsightSeen(id);
      });
      fetchRumenStatus();
      r.pollTimer = setInterval(fetchRumenStatus, 60000);
    }

    // ===== Launch terminal =====
    async function launchTerminal() {
      const input = document.getElementById('promptInput');
      const project = document.getElementById('promptProject').value;
      let command = input.value.trim();

      // If the input is empty but the selected project has a defaultCommand,
      // use it. That way "select project + click launch" actually runs the
      // project's declared default (e.g. `claude`) instead of silently falling
      // through to the global shell.
      if (!command && project) {
        const projectCfg = state.config.projects?.[project];
        if (projectCfg?.defaultCommand) {
          command = projectCfg.defaultCommand;
        }
      }

      if (!command) {
        // Still nothing to run — launch a plain shell in the project's cwd
        const session = await api('POST', '/api/sessions', {
          project: project || undefined,
          reason: 'manual launch'
        });
        createTerminalPanel(session);
        input.value = '';
        updateEmptyState();
        return;
      }

      // Sprint 45 T4 + Sprint 46 T4: resolver extracted to
      // packages/client/public/launcher-resolver.js so the same routing
      // logic runs in the browser AND under `node --test` (see
      // tests/launcher-resolver.test.js for the contract pin). Sprint 46
      // T4 also extended the python-server preemptive regex to recognize
      // `http.server` so the python topbar quick-launch button is typed
      // correctly from the first frame.
      const { resolvedCommand, resolvedType, resolvedCwd, resolvedProject } =
        LauncherResolver.resolve(
          command,
          project,
          state.agentAdapters,
          state.config.projects
        );

      const session = await api('POST', '/api/sessions', {
        command: resolvedCommand,
        cwd: resolvedCwd,
        project: resolvedProject,
        type: resolvedType,
        reason: `launched: ${command}`
      });

      createTerminalPanel(session);
      input.value = '';
      updateEmptyState();
    }

    // ===== Layout =====
    function setLayout(layout) {
      // Sprint 67 T3: legacy `orch` layout retired (superseded by the role-tagged
      // ORCH-pin row from Sprint 65). Redirect any stale callers to `4x2` so the
      // grid still renders cleanly if `orch` arrives from older code paths.
      if (layout === 'orch') {
        layout = '4x2';
      }
      const wasControl = state.layout === 'control';
      // Only persist "real" grid layouts as state.layout; the control view is
      // an overlay, not a target to restore to when the user hits Escape.
      if (layout !== 'control') {
        state.layout = layout;
      }
      const grid = document.getElementById('termGrid');
      grid.className = `grid-container layout-${layout}`;
      grid.removeAttribute('data-orch-cols');

      // Remove focus/half states
      document.querySelectorAll('.term-panel').forEach(p => {
        p.classList.remove('focused', 'primary');
        p.style.display = '';
      });

      // Update buttons
      document.querySelectorAll('.layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === layout);
      });

      // Control-mode side effects (T1.6)
      if (layout === 'control') {
        enterControlMode();
      } else if (wasControl) {
        // Leaving control — nothing to clean up; feed stays hidden via CSS
      }

      requestAnimationFrame(() => fitAll());
    }

    // ===== Helpers =====
    function getStatusColor(status) {
      const colors = {
        starting: '#7aa2f7',
        active: '#9ece6a',
        idle: '#6b7089',
        thinking: '#bb9af7',
        editing: '#e0af68',
        listening: '#7dcfff',
        errored: '#f7768e',
        exited: '#414868'
      };
      return colors[status] || '#6b7089';
    }

    function getTypeLabel(type) {
      // Sprint 50 T3 — adapter-driven panel header labels. Consult
      // state.agentAdapters first so a freshly-launched Codex/Gemini/Grok
      // panel reads its agent's displayName (rather than the raw
      // sessionType string or — worse — falling through to "Shell" when
      // the type label map didn't have an entry). Adding a new agent now
      // requires only an adapter file with `displayName`; no client-side
      // edit. Built-in non-adapter types (shell / python-server / etc.)
      // keep their static labels.
      const adapters = Array.isArray(state.agentAdapters) ? state.agentAdapters : [];
      const adapter = adapters.find((a) => a && a.sessionType === type);
      if (adapter && adapter.displayName) return adapter.displayName;
      const labels = {
        'shell': 'Shell',
        'claude-code': 'Claude Code',
        'codex': 'Codex CLI',
        'gemini': 'Gemini CLI',
        'grok': 'Grok CLI',
        'web-chat': 'Grok (web)',
        'python-server': 'Python Server',
        'one-shot': 'One-shot'
      };
      return labels[type] || type;
    }

    function getThemeObject(themeId) {
      // Fetch full theme from server cache or use fallback
      const known = state.themes[themeId];
      if (known?.theme) return known.theme;
      // Minimal fallback
      return { background: '#1a1b26', foreground: '#c0caf5' };
    }

    function timeAgo(isoString) {
      const diff = Date.now() - new Date(isoString).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    }

    // Sprint 80 T2 (FR-5) — render the per-panel context-size counter into its
    // Pure band classifier — the client mirror of the server's classifyContext
    // (context-meter.js). Used ONLY as the fallback when the server didn't ship
    // a contextLevel: the PATCH-only path (Brad's external watchdog writes
    // meta.contextK on a non-Claude panel; contextLevel isn't PATCH-mutable and
    // only the server's JSONL compute sets it — T4 AUDIT-FAIL 21:27). Thresholds
    // arrive via state.config.contextThresholds; defaults match config defaults.
    function classifyContextLevel(k, warnK, overK) {
      if (typeof k !== 'number' || !isFinite(k)) return 'unknown';
      const over = (typeof overK === 'number' && isFinite(overK)) ? overK : 400;
      const warn = (typeof warnK === 'number' && isFinite(warnK)) ? warnK : 350;
      if (k >= over) return 'over';
      if (k >= warn) return 'warn';
      return 'ok';
    }

    // dedicated header node. Dedicated function + dedicated DOM node per the
    // land-order boundary rule (role logic is T3's; this never touches it).
    // Renders whenever meta.contextK is a number — server-computed (Claude) OR
    // externally PATCHed (Brad's watchdog, non-Claude). Absent/non-numeric =
    // unknown → hide (no header noise). Colour band = meta.contextLevel when the
    // server set it (authoritative — "server-computed wins"), else derived
    // client-side from shipped thresholds so PATCH-only values still band. An
    // active enforcement (meta.contextAlert) adds an ⚡ marker + tooltip.
    function updateContextBadge(id, meta) {
      const el = document.getElementById(`ctx-${id}`);
      if (!el) return;
      const k = meta.contextK;
      if (typeof k !== 'number' || !isFinite(k)) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      const thresholds = (state.config && state.config.contextThresholds) || {};
      const level = (meta.contextLevel && meta.contextLevel !== 'unknown')
        ? meta.contextLevel
        : classifyContextLevel(k, thresholds.warnK, thresholds.overK);
      const icon = level === 'over' ? '⛔' : (level === 'warn' ? '⚠' : '');
      const alert = meta.contextAlert;
      const bolt = alert && alert.action ? ' ⚡' : '';
      el.textContent = `${icon ? icon + ' ' : ''}${k}K ctx${bolt}`;
      el.className = `panel-ctx panel-ctx--${level}`;
      el.title = alert && alert.action
        ? `Context ${k}K — ${alert.action} fired at ${alert.maxContextK}K ceiling`
        : `Context size: ${k}K tokens`;
      el.style.display = '';
    }

    function updatePanelMeta(id, meta) {
      // Track status transitions into the per-panel status log
      const entry = state.sessions.get(id);
      if (entry && meta.status && meta.status !== entry.lastKnownStatus) {
        appendStatusLog(id, meta.status, meta.statusDetail || '');
        // Proactive memory lookup on entering the errored state (T1.4)
        if (meta.status === 'errored') {
          // Fire-and-forget; own rate limiting lives inside the function.
          triggerProactiveMemoryQuery(id);
        }
        entry.lastKnownStatus = meta.status;
      }
      // Keep the cached session.meta fresh so the overview tab renders current data
      if (entry && entry.session) {
        entry.session.meta = { ...entry.session.meta, ...meta };
      }

      // Sprint 66 T1 (Task 1.3) — re-sync the orch-toggle button from the just-
      // merged role, so a role changed from another dashboard tab is reflected
      // here too (the per-tab toggle path syncs in its own finally block).
      syncOrchToggle(id);

      // Sprint 80 T2 (FR-5) — additive: refresh the context counter from the
      // merged meta (rides the 2s status_broadcast). Own DOM node + function.
      updateContextBadge(id, meta);

      const dot = document.getElementById(`dot-${id}`);
      const status = document.getElementById(`status-${id}`);
      const metaLast = document.getElementById(`meta-last-${id}`);
      const metaPort = document.getElementById(`meta-port-${id}`);
      const metaReqs = document.getElementById(`meta-reqs-${id}`);

      if (dot) {
        dot.style.background = getStatusColor(meta.status);
        // Sprint 50 T3 — pulse the status dot for ALL in-flight states
        // (thinking, editing, active), not just thinking. Pre-Sprint-50 the
        // dot only pulsed on `thinking`; during a long agent task the
        // status fluctuated through editing/active as different regex
        // patterns matched the live PTY stream, removing the pulsing class
        // each time and making the visual cue feel "frozen" between thinking
        // hits. Pulsing across all work-in-progress states keeps the
        // animation alive end-to-end. Idle / exited / errored stay solid.
        const inflight = meta.status === 'thinking'
          || meta.status === 'editing'
          || meta.status === 'active';
        dot.classList.toggle('pulsing', inflight);
      }
      if (status) status.textContent = meta.statusDetail || meta.status;
      if (metaLast && meta.lastCommands?.length) {
        metaLast.innerHTML = `<span class="meta-label">last</span> ${escapeHtml(meta.lastCommands[meta.lastCommands.length - 1].command)}`;
      }
      if (metaPort) {
        if (meta.detectedPort) {
          metaPort.style.display = '';
          metaPort.querySelector('.meta-value').textContent = ':' + meta.detectedPort;
        }
      }
      if (metaReqs) {
        if (meta.type === 'python-server' || meta.requestCount > 0) {
          metaReqs.style.display = '';
          metaReqs.querySelector('.meta-value').textContent = meta.requestCount || 0;
        }
      }

      // If the drawer is showing the overview tab, refresh its metadata block
      if (entry && entry.drawerOpen && entry.activeTab === 'overview') {
        renderOverviewTab(id);
      }

      // Sync theme dropdown if server-side theme changed
      if (meta.theme) {
        const themeSelect = document.getElementById(`theme-${id}`);
        if (themeSelect && themeSelect.value !== meta.theme) {
          themeSelect.value = meta.theme;
          const entry = state.sessions.get(id);
          if (entry && entry.terminal) {  // web-chat panels have no xterm to theme
            entry.terminal.options.theme = getThemeObject(meta.theme);
          }
        }
      }
    }

    function updateGlobalStats(sessions) {
      let active = 0, thinking = 0, idle = 0;
      for (const s of sessions) {
        if (s.meta.status === 'active' || s.meta.status === 'listening') active++;
        else if (s.meta.status === 'thinking') thinking++;
        else if (s.meta.status === 'idle') idle++;

        // Update existing panels from broadcast. NOTE: we deliberately do NOT
        // createTerminalPanel for sessions that aren't in state.sessions —
        // that creates a race between the immediate createTerminalPanel call
        // from launchTerminal and the 2s status_broadcast cycle, producing
        // duplicate WebSockets per session and breaking terminal input
        // rendering. External-session auto-discover is parked for Sprint 3.
        if (state.sessions.has(s.id)) {
          updatePanelMeta(s.id, s.meta);
        }
      }
      document.getElementById('stat-active').textContent = active;
      document.getElementById('stat-thinking').textContent = thinking;
      document.getElementById('stat-idle').textContent = idle;
      renderSwitcher();
      // Sprint 65 T1 — reconcile dead tiles against this broadcast, then
      // refresh chips + ORCH-row chrome (coalesced to one rebuild per frame).
      reconcileExitedPanels(sessions);
      scheduleChromeRefresh();
    }

    function updateEmptyState() {
      const empty = document.getElementById('emptyState');
      empty.style.display = state.sessions.size === 0 ? '' : 'none';
    }

    function fitAll() {
      for (const [, entry] of state.sessions) {
        try { entry.fitAddon.fit(); } catch (err) { if (!entry._fitWarned) { console.error('[client] fitAddon.fit failed for session:', err); entry._fitWarned = true; } }
      }
    }

    // Sprint 57 T2 — post-resize layout-health assertion + forced reflow.
    // Sprint 55 T2 saw rapid Playwright resize chains crush #termGrid into
    // the corner with no manual recovery. Codex T4-SWEEP-CELLS audit was
    // explicit: the right shape is a health check + forced reflow at the
    // tail of the existing debounced fitAll(), not a second window-resize
    // listener. Reentrancy guarded so a degenerate state can't loop.
    function verifyLayoutHealth() {
      const grid = document.getElementById('termGrid');
      if (!grid) return;
      if (verifyLayoutHealth._inFlight) return;
      const rect = grid.getBoundingClientRect();
      // The grid spans the viewport horizontally (topbar is above it; the
      // guide-rail is fixed-position overlay reserved by 38px right padding,
      // not a flex sibling). A healthy grid's getBoundingClientRect().width
      // tracks window.innerWidth modulo body margins. Flag if it shrinks
      // below 90% of the usable viewport (briefed threshold; T4-CODEX
      // 14:12 ET audit confirms 90% is the spec, not the looser 85%).
      const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
      const gridUnderwidth = viewportW > 0 && rect.width < viewportW * 0.90;
      // Each visible terminal panel must have positive width AND height.
      // Skip panels intentionally hidden by layout (control mode CSS-hides
      // .term-panel via `display:none`; layout-focus hides non-focused).
      let panelDegenerate = false;
      let panelDegenerateId = null;
      for (const [sid, entry] of state.sessions) {
        if (!entry || !entry.el) continue;
        const style = window.getComputedStyle(entry.el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = entry.el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
          panelDegenerate = true;
          panelDegenerateId = sid;
          break;
        }
      }
      if (!gridUnderwidth && !panelDegenerate) return;
      verifyLayoutHealth._inFlight = true;
      console.warn(
        '[client] layout health check failed (gridUnderwidth=' + gridUnderwidth
        + ', panelDegenerate=' + panelDegenerate
        + (panelDegenerateId ? ', sid=' + panelDegenerateId : '')
        + ') — forcing recovery'
      );
      // Recovery: detach + reapply the current layout class to force the
      // CSS Grid templates to recompute, then refit all panels. Two RAFs so
      // the browser commits the className=''→className=cls round-trip.
      requestAnimationFrame(() => {
        const cls = grid.className;
        grid.className = '';
        void grid.offsetHeight; // force synchronous reflow
        grid.className = cls;
        requestAnimationFrame(() => {
          try { fitAll(); } finally { verifyLayoutHealth._inFlight = false; }
        });
      });
    }

    // Debounce: collapse a burst of calls (e.g. a window-resize drag firing
    // dozens of events/sec) into a single invocation after `wait` ms of quiet.
    function debounce(fn, wait) {
      let timer = null;
      return function debounced(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
      };
    }

    const fitAllDebounced = debounce(() => {
      requestAnimationFrame(() => {
        fitAll();
        // Sprint 57 T2 — post-fit layout-health probe (~250 ms after fit so
        // the browser has committed the resize). Extends the existing window
        // resize listener (no second listener added).
        setTimeout(verifyLayoutHealth, 250);
      });
    }, 100);

    // ===== ONBOARDING TOUR =====
    // Spotlight + tooltip walkthrough of every TermDeck surface. Runs once on
    // first visit (localStorage gate) and replays on demand via the "how this
    // works" button. Zero dependencies — vanilla DOM, same philosophy as the
    // rest of this client.
    const TOUR_STEPS = [
      {
        target: null,
        title: 'Welcome to TermDeck',
        body: `TermDeck is a browser-based terminal multiplexer with a persistent memory layer. It lets you run many real terminals side by side, each with rich metadata and automatic recall of similar past errors. This walkthrough takes about 90 seconds and covers every button on the screen. Press <kbd>Esc</kbd> any time to exit.`,
      },
      {
        target: '#topbarQuickLaunch',
        title: 'Quick launch',
        body: `These three buttons instantly spawn a new terminal. <strong>shell</strong> opens zsh, <strong>claude</strong> opens Claude Code, <strong>python</strong> starts a Python HTTP server on port 8080. One click — no typing required.`,
      },
      {
        target: '.topbar-center',
        title: 'Layout modes',
        body: `Preset grid layouts — <kbd>1x1</kbd> through <kbd>4x4</kbd> — plus <strong>control</strong> (aggregate activity feed). Click any layout to switch instantly; all terminals re-fit to the new grid. Keyboard shortcuts <kbd>Cmd+Shift+1</kbd>–<kbd>Cmd+Shift+9</kbd> (or <kbd>Ctrl+Shift+1</kbd>–<kbd>9</kbd>) cycle through them. Orchestrator panels are pinned to a dedicated row above the grid via <strong>meta.role</strong>; no special "orch" layout needed.`,
      },
      {
        target: '#termSwitcher',
        title: 'Terminal switcher',
        body: `When you have 2+ terminals open, this overlay shows numbered tiles. Click a tile to focus that panel, or press <kbd>Alt+1</kbd> through <kbd>Alt+9</kbd>. Color-coded by project, status-dot updates live. Watch — a second shell is spawning right now so you can see it appear.`,
        onEnter: async () => { await ensureSecondShellForTour(); },
      },
      {
        targets: ['#btn-status', '#btn-config'],
        title: 'Status and config',
        body: `<strong>status</strong> opens a global-metrics modal (session counts by state, RAG mode, memory bridge). <strong>config</strong> shows your loaded project list and theme defaults — plus a live RAG-mode toggle (Sprint 36) that flips Flashback on/off without a server restart.`,
      },
      {
        targets: ['#btn-sprint', '#btn-graph'],
        title: 'Sprint runner and knowledge graph',
        body: `<strong>sprint</strong> opens the in-dashboard 4+1 sprint runner (Sprint 37): name the sprint, define T1–T4 lane goals, click kick off — TermDeck spawns four panels and injects boot prompts via the two-stage submit pattern automatically. Optional <strong>--isolation=worktree</strong> creates a git worktree per lane so concurrent edits can't stomp. <strong>graph</strong> opens the D3.js force-directed knowledge graph (Sprint 38) of your memory_items + memory_relationships in a new tab — click any node to open its memory in a drawer, filter by relationship type, search, zoom/pan.`,
      },
      {
        targets: ['#btn-how', '#btn-help'],
        title: 'How this works and help',
        body: `Click <strong>how this works</strong> any time to replay this tour. <strong>help</strong> opens the full TermDeck documentation in a new tab. The <strong>📖 Guide</strong> tab on the right edge of the screen — also opens with the <kbd>g</kbd> keyboard shortcut — is the always-on Orchestrator Guide (Sprint 37): nine sections covering the 4+1 sprint pattern, inject mandate, CLAUDE.md hierarchy, memory-first discipline, sprint discipline, restart-prompt rituals, scaffolding files, channel inject patterns. Search built in.`,
      },
      {
        target: '#guideRail',
        title: 'Right-rail Orchestrator Guide',
        body: `The <strong>📖 Guide</strong> rail is your orchestration cheat-sheet — collapsed by default, one click (or <kbd>g</kbd>) to expand. It auto-scrolls to the relevant section based on what you're focused on: clicking a terminal panel jumps the Guide to the 4+1 pattern; opening the project drawer jumps to CLAUDE.md hierarchy. Useful when you forget exactly how the two-stage submit pattern works at 2 AM in the middle of a sprint inject.`,
        fallback: '#btn-how',
      },
      {
        target: '#btnPreviewProject',
        title: 'Orchestration preview',
        body: `The <strong>preview</strong> button next to the project + button (Sprint 37) shows you exactly what <code>termdeck init --project &lt;name&gt;</code> would create for the selected project — file tree, contents per file, expand-on-click. Read-only by default; optional generate button writes the scaffolding (CLAUDE.md, CONTRADICTIONS.md, project_facts.md, .claude/settings.json, docs/orchestration/, RESTART-PROMPT.md template). Lets you see-before-commit instead of running the CLI blind.`,
        fallback: '#btn-how',
      },
      {
        target: '.panel-header',
        title: 'Panel header',
        body: `Every terminal has a header showing a <strong>status dot</strong> (active · thinking · idle · errored · exited), the detected <strong>type</strong> (shell · Claude Code · Python server · etc.), a colored <strong>project tag</strong>, and a <strong>#N index</strong> when multiple panels share the same (type, project). The right side has focus, half-screen, and close buttons.`,
        fallback: '#topbarQuickLaunch',
      },
      {
        target: '.drawer-tabs',
        title: 'Info tabs',
        body: `Below every terminal is a drawer with four tabs. <strong>Overview</strong> — live metadata + "Ask about this terminal" input + reply button. <strong>Commands</strong> — scrollable command history (click to copy). <strong>Memory</strong> — every Flashback hit this panel has collected. <strong>Status log</strong> — chronological status transitions with detail chips.`,
        onEnter: async () => { await openFirstPanelDrawer('overview'); },
        fallback: '#topbarQuickLaunch',
      },
      {
        target: '.reply-toggle',
        title: 'Reply — send text to another panel',
        body: `Click <strong>reply ▸</strong> on any panel to route text to another open terminal. Pick the target from the dropdown (labels use <kbd>#N</kbd> suffixes to disambiguate same-project duplicates), type your message, hit send. Useful for handing off work to a Claude Code panel, broadcasting a command, or piping errors into a debug agent.`,
        onEnter: async () => { await openFirstPanelDrawer('overview'); },
        fallback: '#topbarQuickLaunch',
      },
      {
        target: '.ctrl-input',
        title: 'Ask about this terminal',
        body: `Type a question here and TermDeck queries your <strong>Mnestra memory store</strong> for relevant context — scoped to the current panel's project. Prefix with <kbd>all:</kbd> to search every project. Results render inline in the terminal with similarity scores.`,
        onEnter: async () => { await openFirstPanelDrawer('overview'); },
        fallback: '#topbarQuickLaunch',
      },
      {
        target: null,
        title: 'Flashback — proactive recall',
        body: `When a panel errors out, TermDeck <strong>automatically</strong> queries Mnestra for similar past errors and surfaces the top match as a toast. You don't have to ask. Rate-limited to one per 30 seconds per panel. Click the toast to open the Memory tab with the full hit expanded.`,
      },
      {
        target: '.prompt-bar',
        title: 'Prompt bar',
        body: `Type any command here to launch it as a new terminal — <kbd>claude code ~/myproject</kbd>, <kbd>python3 manage.py runserver</kbd>, <kbd>npm run dev</kbd>. Pick a project from the dropdown to auto-cd into its path and apply its default theme. <kbd>Ctrl+Shift+N</kbd> focuses this bar from anywhere.`,
      },
      {
        target: null,
        title: 'Knowledge graph + memory inference',
        body: `Sprint 38 brought your <strong>memory_relationships</strong> table to life. The <strong>graph</strong> button (top toolbar) renders your memories as a force-directed network — supersedes / relates_to / contradicts / elaborates / caused_by / blocks / inspired_by / cross_project_link edges, color-coded, filterable. The Mnestra MCP server now exposes four new tools: <code>memory_link</code>, <code>memory_unlink</code>, <code>memory_related</code>, and <code>memory_recall_graph</code> — Claude Code can connect related memories explicitly, traverse N-hop neighborhoods, and recall via graph-aware re-ranking (vector_score × edge_weight × recency). Edges populate automatically from Joshua's private rag-system classifier; a nightly cron in Sprint 39+ will surface cross-project connections.`,
      },
      {
        target: null,
        title: 'You are ready.',
        body: `That's every major surface. Click <strong>how this works</strong> in the top toolbar to replay this walkthrough. <strong>help</strong> opens the full docs. Press <kbd>g</kbd> any time to crack open the Orchestrator Guide. Questions, bugs, feedback: <a href="https://github.com/jhizzard/termdeck/issues" target="_blank" style="color:var(--tg-accent)">github.com/jhizzard/termdeck/issues</a>. Now launch something.`,
      },
    ];

    // Tour setup helpers — manipulate DOM so target selectors resolve to
    // visible, sized elements before the spotlight positions itself.
    async function ensureSecondShellForTour() {
      if (state.sessions.size >= 2) return;
      try {
        const session = await api('POST', '/api/sessions', {
          command: 'zsh',
          type: 'shell',
          reason: 'onboarding tour (switcher demo)',
        });
        createTerminalPanel(session);
        updateEmptyState();
        await new Promise((r) => setTimeout(r, 450));
      } catch (err) {
        console.error('[tour] failed to auto-launch second shell:', err);
      }
    }

    async function openFirstPanelDrawer(tabName = 'overview') {
      const firstId = state.sessions.keys().next().value;
      if (!firstId) return;
      const entry = state.sessions.get(firstId);
      if (!entry) return;
      // Only toggle if not already open on the requested tab — avoid bouncing
      // the drawer shut mid-tour.
      if (entry.drawerOpen && entry.activeTab === tabName) return;
      // Force-open by setting state first so toggleDrawerTab expands it.
      entry.drawerOpen = false;
      toggleDrawerTab(firstId, tabName);
      // Let the CSS transition settle so bounding rects stabilize.
      await new Promise((r) => setTimeout(r, 280));
    }

    const tourState = { active: false, idx: 0 };

    // Resolve a step's target(s) to a bounding rect. Supports single `target`
    // selector, a `targets` array (union rect across multiple elements), and
    // `fallback` as a last resort. Elements with 0×0 rects are treated as
    // invisible and ignored so collapsed drawer content doesn't produce
    // phantom spotlights in the top-left corner.
    function tourResolveRect(step) {
      const visibleRect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return r;
      };

      if (step.targets && Array.isArray(step.targets)) {
        const rects = step.targets.map(visibleRect).filter(Boolean);
        if (rects.length > 0) {
          const left = Math.min(...rects.map((r) => r.left));
          const top = Math.min(...rects.map((r) => r.top));
          const right = Math.max(...rects.map((r) => r.right));
          const bottom = Math.max(...rects.map((r) => r.bottom));
          return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
      }

      if (step.target) {
        const r = visibleRect(step.target);
        if (r) return r;
      }

      if (step.fallback) {
        const r = visibleRect(step.fallback);
        if (r) return r;
      }

      return null;
    }

    function positionTourElements(step) {
      const backdrop = document.getElementById('tourBackdrop');
      const spotlight = document.getElementById('tourSpotlight');
      const tooltip = document.getElementById('tourTooltip');
      backdrop.classList.add('active');
      tooltip.style.display = 'block';

      const rect = tourResolveRect(step);
      if (!rect) {
        // Centered step — no spotlight target, or resolved element was invisible
        spotlight.classList.add('centered');
        tooltip.classList.add('centered');
        tooltip.style.top = '';
        tooltip.style.left = '';
        return;
      }
      spotlight.classList.remove('centered');
      tooltip.classList.remove('centered');

      const padding = 8;
      spotlight.style.top = `${rect.top - padding}px`;
      spotlight.style.left = `${rect.left - padding}px`;
      spotlight.style.width = `${rect.width + padding * 2}px`;
      spotlight.style.height = `${rect.height + padding * 2}px`;

      // Place tooltip below the target by default; flip to above if it would
      // overflow the viewport. Clamp horizontally to avoid right-edge clipping.
      const tooltipRect = tooltip.getBoundingClientRect();
      let top = rect.bottom + 16;
      let left = Math.max(12, rect.left);
      if (top + tooltipRect.height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - tooltipRect.height - 16);
      }
      if (left + tooltipRect.width > window.innerWidth - 12) {
        left = window.innerWidth - tooltipRect.width - 12;
      }
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
    }

    async function renderTourStep() {
      const step = TOUR_STEPS[tourState.idx];
      if (!step) { endTour(); return; }

      // Optional setup hook — launches a panel, opens a drawer, etc.
      if (typeof step.onEnter === 'function') {
        try { await step.onEnter(); } catch (err) { console.error('[tour] onEnter failed:', err); }
      }

      document.getElementById('tourTitle').innerHTML = step.title;
      document.getElementById('tourBody').innerHTML = step.body;
      document.getElementById('tourCounter').textContent =
        `Step ${tourState.idx + 1} of ${TOUR_STEPS.length}`;
      document.getElementById('tourPrevBtn').disabled = tourState.idx === 0;
      document.getElementById('tourNextBtn').textContent =
        tourState.idx === TOUR_STEPS.length - 1 ? 'done' : 'next';
      positionTourElements(step);
    }

    // Auto-launch a shell panel so the tour's panel-targeting steps
    // (header, drawer tabs, reply, ctrl-input) have a real DOM target.
    // Only fires when no panels exist yet. Replays of the tour against
    // an already-populated dashboard skip this — their existing panels
    // serve as the tour targets.
    async function ensurePanelForTour() {
      if (state.sessions.size > 0) return;
      try {
        const session = await api('POST', '/api/sessions', {
          command: 'zsh',
          type: 'shell',
          reason: 'onboarding tour',
        });
        createTerminalPanel(session);
        updateEmptyState();
        // Let xterm.js mount and .panel-* selectors settle before rendering.
        await new Promise((r) => setTimeout(r, 450));
      } catch (err) {
        console.error('[tour] failed to auto-launch shell:', err);
      }
    }

    async function startTour() {
      tourState.active = true;
      tourState.idx = 0;
      // Explicitly show the spotlight. CSS default is `display:none` so the
      // 9999px box-shadow doesn't darken the page before/after a tour runs.
      document.getElementById('tourSpotlight').style.display = 'block';
      // Defensive cleanup: if ensurePanelForTour or renderTourStep throws
      // after the spotlight is shown, the 9999px box-shadow stays up with no
      // tooltip on top — that's the "dark veil" symptom users hit with no
      // visible way out. Roll back to a clean state on any failure.
      try {
        await ensurePanelForTour();
        renderTourStep();
      } catch (err) {
        console.error('[tour] start failed, rolling back:', err);
        endTour();
      }
    }

    function nextTourStep() {
      if (tourState.idx >= TOUR_STEPS.length - 1) { endTour(); return; }
      tourState.idx += 1;
      renderTourStep();
    }

    function prevTourStep() {
      if (tourState.idx <= 0) return;
      tourState.idx -= 1;
      renderTourStep();
    }

    function endTour() {
      tourState.active = false;
      document.getElementById('tourBackdrop').classList.remove('active');
      document.getElementById('tourTooltip').style.display = 'none';
      // CRITICAL: hide the spotlight element too. Its 9999px box-shadow
      // creates the dark overlay effect independently of the backdrop, so
      // leaving display:block here means the dashboard looks "stuck in tour"
      // even after the tooltip is gone.
      const spotlight = document.getElementById('tourSpotlight');
      spotlight.style.display = 'none';
      spotlight.classList.remove('centered');
      const tooltip = document.getElementById('tourTooltip');
      tooltip.classList.remove('centered');
      tooltip.style.top = '';
      tooltip.style.left = '';
      try { localStorage.setItem('termdeck:tour:seen', '1'); } catch {}
    }

    // ===== Status / Config dropdowns (Sprint 9 T2) =====
    // Generic toolbar-button → dropdown factory. Opens below the button,
    // click-outside closes, re-fetches every open so the data isn't stale.
    function setupInfoDropdown({ btnId, dropdownId, fetch, render }) {
      const btn = document.getElementById(btnId);
      if (!btn) return;

      const dropdown = document.createElement('div');
      dropdown.className = 'health-dropdown info-dropdown';
      dropdown.id = dropdownId;
      dropdown.innerHTML = '<div class="hd-loading">Loading…</div>';
      document.body.appendChild(dropdown);

      let open = false;

      const close = () => {
        dropdown.classList.remove('open');
        open = false;
      };

      const openDropdown = async () => {
        const rect = btn.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;
        // Right-align under the button; clamp to viewport
        const desiredLeft = Math.min(
          window.innerWidth - 320,
          Math.max(8, rect.right - 300)
        );
        dropdown.style.left = `${desiredLeft}px`;
        dropdown.innerHTML = '<div class="hd-loading">Loading…</div>';
        dropdown.classList.add('open');
        open = true;
        try {
          const data = await fetch();
          // If user closed it while we were fetching, abort
          if (!open) return;
          dropdown.innerHTML = render(data);
        } catch (err) {
          dropdown.innerHTML = `<div class="hd-empty">Failed to load: ${escapeHtml(err.message || String(err))}</div>`;
        }
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (open) close(); else openDropdown();
      });
      document.addEventListener('click', (e) => {
        if (open && !dropdown.contains(e.target) && e.target !== btn) close();
      });
      document.addEventListener('keydown', (e) => {
        if (open && e.key === 'Escape') close();
      });
    }

    function renderStatusDropdown(data) {
      const total = data.totalSessions || 0;
      const byStatus = data.byStatus || {};
      const byProject = data.byProject || {};
      const byType = data.byType || {};
      const uptime = fmtUptime(data.uptime || 0);
      const heapMB = data.memory && data.memory.heapUsed
        ? (data.memory.heapUsed / 1024 / 1024).toFixed(1) + ' MB'
        : '—';
      const rag = data.ragEnabled ? 'on' : 'off';

      const row = (label, value) => `<div class="hd-check">
        <span class="hd-icon">·</span>
        <span class="hd-name">${escapeHtml(label)}</span>
        <span class="hd-dots"></span>
        <span class="hd-status">${escapeHtml(String(value))}</span>
      </div>`;

      const kvBlock = (title, obj) => {
        const keys = Object.keys(obj);
        if (keys.length === 0) return '';
        const lines = keys.map(k => row(k, obj[k])).join('');
        return `<div class="hd-detail" style="grid-column:1/-1;margin-top:6px;color:var(--tg-text-dim);font-size:10px">${escapeHtml(title)}</div>${lines}`;
      };

      return row('sessions', total)
        + row('uptime', uptime)
        + row('heap', heapMB)
        + row('rag sync', rag)
        + kvBlock('by status', byStatus)
        + kvBlock('by project', byProject)
        + kvBlock('by type', byType);
    }

    function renderConfigDropdown(data) {
      const projects = data.projects || {};
      const projectCount = Object.keys(projects).length;
      const defaultTheme = data.defaultTheme || '—';
      const rag = data.ragEnabled ? 'enabled' : 'disabled';
      const aiQuery = data.aiQueryAvailable ? 'yes' : 'no';

      const row = (label, value, ok) => {
        const icon = ok == null ? '·' : (ok ? '✓' : '✗');
        const cls = ok == null ? '' : (ok ? 'hd-ok' : 'hd-fail');
        return `<div class="hd-check ${cls}">
          <span class="hd-icon">${icon}</span>
          <span class="hd-name">${escapeHtml(label)}</span>
          <span class="hd-dots"></span>
          <span class="hd-status">${escapeHtml(String(value))}</span>
        </div>`;
      };

      let html = ''
        + row('projects', projectCount)
        + row('default theme', defaultTheme)
        + row('RAG sync', rag, data.ragEnabled)
        + row('AI query', aiQuery, data.aiQueryAvailable);

      if (projectCount > 0) {
        html += `<div class="hd-detail" style="grid-column:1/-1;margin-top:6px;color:var(--tg-text-dim);font-size:10px">projects</div>`;
        for (const [name, cfg] of Object.entries(projects)) {
          const path = (cfg && cfg.path) || '';
          html += `<div class="hd-check">
            <span class="hd-icon">·</span>
            <span class="hd-name">${escapeHtml(name)}</span>
            <span class="hd-dots"></span>
            <span class="hd-status" style="font-size:10px;color:var(--tg-text-dim)">${escapeHtml(path)}</span>
          </div>`;
        }
      }

      html += `<div class="hd-detail" style="grid-column:1/-1;margin-top:8px;color:var(--tg-text-dim);font-size:10px">edit <code>~/.termdeck/config.yaml</code> and restart to apply</div>`;
      return html;
    }

    // ===== Setup Wizard (Sprint 19 T2) =====
    // Progressive-disclosure modal that shows TermDeck's 4 configuration tiers
    // and their live status. Detection only — does not write config files.
    const SETUP_TIERS = [
      {
        id: '1',
        name: 'Tier 1 — TermDeck core',
        desc: 'Local terminal multiplexer running in your browser.',
        commands: []
      },
      {
        id: '2',
        name: 'Tier 2 — Mnestra RAG',
        desc: 'Persistent cross-session memory backed by Postgres + pgvector.',
        commands: ['termdeck init --mnestra']
      },
      {
        id: '3',
        name: 'Tier 3 — Rumen learning loop',
        desc: 'Async insight extraction and morning briefings (Supabase Edge Function).',
        commands: ['termdeck init --rumen']
      },
      {
        id: '4',
        name: 'Tier 4 — Projects',
        desc: 'Named project roots so you can launch with "cc <name>" shorthand.',
        commands: ['Click the + button in the prompt bar, or edit ~/.termdeck/config.yaml']
      }
    ];

    let setupModalOpen = false;

    // Sprint 25 T3 — Supabase MCP auto-flow state. Closure-scoped to this module
    // so a re-render of the tier list (refreshSetupStatus) doesn't lose an
    // in-flight picker step. The PAT lives here only between /connect success
    // and /select success; we null `supabaseAutoState` after /select returns ok.
    // Never log .pat. Never assign it to a property of `state` or `window`.
    let supabaseAutoState = null;
    // Cache of the last /api/setup payload so we can re-render the tier list
    // (e.g. PAT entry → project picker) without forcing another HTTP fetch.
    let lastSetupData = null;

    function ensureSetupModal() {
      if (document.getElementById('setupModal')) return;
      const modal = document.createElement('div');
      modal.className = 'setup-modal';
      modal.id = 'setupModal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'setupTitle');
      modal.innerHTML = `
        <div class="setup-backdrop" id="setupBackdrop"></div>
        <div class="setup-card">
          <header class="setup-header">
            <div>
              <h3 id="setupTitle">Setup wizard</h3>
              <p class="setup-subtitle" id="setupSubtitle">Checking status…</p>
            </div>
            <button type="button" class="setup-close" id="setupClose" aria-label="Close">×</button>
          </header>
          <div class="setup-body">
            <div class="setup-settings" id="setupSettings"></div>
            <div class="setup-tiers" id="setupTiers">
              <div class="setup-loading">Checking tier status…</div>
            </div>
          </div>
          <footer class="setup-footer">
            <div class="setup-hint">
              Edit <code>~/.termdeck/config.yaml</code> and <code>~/.termdeck/secrets.env</code>, then re-check.
            </div>
            <div class="setup-actions">
              <button type="button" class="setup-recheck" id="setupRecheck">re-check</button>
              <button type="button" class="setup-done" id="setupDone">done</button>
            </div>
          </footer>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('setupBackdrop').addEventListener('click', closeSetupModal);
      document.getElementById('setupClose').addEventListener('click', closeSetupModal);
      document.getElementById('setupDone').addEventListener('click', closeSetupModal);
      document.getElementById('setupRecheck').addEventListener('click', refreshSetupStatus);
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeSetupModal(); }
      });
    }

    async function openSetupModal() {
      ensureSetupModal();
      document.getElementById('setupModal').classList.add('open');
      setupModalOpen = true;
      renderSettingsPanel();
      await refreshSetupStatus();
    }

    function closeSetupModal() {
      const m = document.getElementById('setupModal');
      if (m) m.classList.remove('open');
      setupModalOpen = false;
    }

    // ===== Settings panel inside the setup modal (Sprint 36 T3 Deliverable A) =====
    // Renders the writable subset of /api/config — currently just the RAG toggle.
    // Body is mutated in place; the panel is idempotent so config_changed WS
    // events can call it without reflow flicker.
    function renderSettingsPanel() {
      const el = document.getElementById('setupSettings');
      if (!el) return;
      const cfg = state.config || {};
      const intent = !!cfg.ragConfigEnabled;
      const effective = !!cfg.ragEnabled;
      const supabaseConfigured = !!cfg.ragSupabaseConfigured;

      // Mismatch: user enabled RAG in config but Supabase isn't wired → show
      // a hint so the toggle's "ON but not pushing" state is explainable.
      const mismatch = intent && !effective && !supabaseConfigured;

      const offCopy = 'MCP-only mode. Memory tools available through Claude Code; the in-CLI <code>termdeck flashback</code> command and the hybrid search are disabled. Faster boot, slimmer surface.';
      const onCopy = 'Enables <code>termdeck flashback</code> and the in-CLI hybrid search. Requires a Mnestra connection at boot — adds a few hundred ms to startup.';

      el.innerHTML = `
        <div class="settings-section">
          <h4 class="settings-heading">RAG mode</h4>
          <div class="settings-row">
            <label class="toggle" for="settingsRagToggle">
              <input type="checkbox" id="settingsRagToggle" ${intent ? 'checked' : ''}>
              <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${intent ? 'On' : 'Off'}</span>
            </label>
            <p class="settings-copy">${intent ? onCopy : offCopy}</p>
          </div>
          ${mismatch ? `
            <div class="settings-warn">
              RAG is enabled in <code>config.yaml</code> but Supabase isn't configured yet, so it isn't actually pushing.
              Configure Tier 2 below or run <code>npx @jhizzard/termdeck-stack</code>.
            </div>
          ` : ''}
        </div>
      `;

      const toggle = document.getElementById('settingsRagToggle');
      if (toggle) {
        toggle.addEventListener('change', async (e) => {
          const desired = !!e.target.checked;
          // Optimistic UI: lock the toggle while the round-trip is in flight.
          toggle.disabled = true;
          try {
            const updated = await api('PATCH', '/api/config', { rag: { enabled: desired } });
            state.config = { ...state.config, ...updated };
            renderSettingsPanel();
            updateRagIndicator();
          } catch (err) {
            console.error('[settings] PATCH /api/config failed:', err);
            // Revert: refetch and re-render.
            try {
              state.config = await api('GET', '/api/config');
              renderSettingsPanel();
            } catch {}
          } finally {
            const t = document.getElementById('settingsRagToggle');
            if (t) t.disabled = false;
          }
        });
      }
    }

    // Topbar RAG indicator. The #stat-rag stub in index.html was hidden by
    // Sprint 9 T2; re-purpose it as a live state line so users can see, at a
    // glance, what the toggle is doing without opening Settings each time.
    //
    // Sprint 57 T2 (F-T2-2 + F-T2-6) — consumes the server-derived `ragMode`
    // enum directly instead of re-deriving from `ragEnabled` + `ragConfigEnabled`
    // booleans. The single source of truth lives in `packages/server/src/rag-mode.js`.
    // Falls back to legacy boolean derivation for older servers (pre-Sprint-57)
    // during a rolling upgrade.
    function updateRagIndicator() {
      const el = document.getElementById('stat-rag');
      if (!el) return;
      const cfg = state.config || {};
      let mode = cfg.ragMode;
      if (!mode) {
        // Pre-Sprint-57 server fallback — replicate the legacy derivation.
        const intent = !!cfg.ragConfigEnabled;
        const effective = !!cfg.ragEnabled;
        mode = effective ? 'active' : (intent ? 'pending' : 'off');
      }
      el.style.display = '';
      if (mode === 'active') {
        el.textContent = 'RAG · on';
        el.className = 'topbar-stat rag-on';
        el.title = 'Mnestra hybrid search + termdeck flashback enabled';
      } else if (mode === 'pending') {
        el.textContent = 'RAG · pending';
        el.className = 'topbar-stat rag-pending';
        el.title = 'RAG enabled in config.yaml but Supabase not wired — see Settings';
      } else {
        el.textContent = 'RAG · mcp-only';
        el.className = 'topbar-stat rag-off';
        el.title = 'MCP-only mode; toggle in Settings to enable';
      }
    }

    async function refreshSetupStatus() {
      const tiersEl = document.getElementById('setupTiers');
      const subtitle = document.getElementById('setupSubtitle');
      const recheckBtn = document.getElementById('setupRecheck');
      if (!tiersEl) return;
      tiersEl.innerHTML = '<div class="setup-loading">Checking tier status…</div>';
      if (subtitle) subtitle.textContent = 'Checking status…';
      if (recheckBtn) { recheckBtn.disabled = true; recheckBtn.textContent = 're-checking…'; }
      try {
        const data = await api('GET', '/api/setup');
        lastSetupData = data;
        renderSetupTiers(data);
        const cur = Number(data.tier) || 1;
        if (subtitle) {
          subtitle.textContent = cur >= 4
            ? 'All tiers configured — you are good to go.'
            : `Current tier: ${cur} of 4. Install the next tier below to unlock more features.`;
        }
      } catch (err) {
        tiersEl.innerHTML = `<div class="setup-error">
          Failed to load setup status: ${escapeHtml(err && err.message ? err.message : String(err))}.<br>
          Make sure the server is reachable and supports <code>GET /api/setup</code>.
        </div>`;
        if (subtitle) subtitle.textContent = 'Error checking status.';
      } finally {
        if (recheckBtn) { recheckBtn.disabled = false; recheckBtn.textContent = 're-check'; }
      }
    }

    function renderSetupTiers(data) {
      const tiersEl = document.getElementById('setupTiers');
      if (!tiersEl) return;
      const tiers = (data && data.tiers) || {};
      const currentTier = Number(data && data.tier) || 1;

      const html = SETUP_TIERS.map((tier, idx) => {
        const info = tiers[tier.id] || { status: 'not_configured', detail: 'Unknown' };
        const status = info.status || 'not_configured';
        const detail = info.detail || '';
        const badgeLabel = status === 'active'
          ? 'active'
          : status === 'partial' ? 'partial' : 'not configured';
        const isCurrent = Number(tier.id) === currentTier + 1 && status !== 'active';

        // Sprint 23 T2: tier 2 renders a credential form instead of CLI commands
        // when not active, so users can paste URL/keys directly in the browser.
        const isCredentialForm = tier.id === '2' && status !== 'active';
        // Sprint 25 T3: above the manual paste form, offer the Supabase MCP
        // auto-flow. Only render for tier 2 when status is not_configured or
        // partial — once active there is nothing to configure.
        const showSupabaseAutoFlow = tier.id === '2' && (status === 'not_configured' || status === 'partial');
        const autoFlowHtml = showSupabaseAutoFlow ? renderSupabaseAutoFlow() : '';
        const cmds = isCredentialForm
          ? `${autoFlowHtml}${renderSetupCredentialForm()}`
          : (status === 'active' || tier.commands.length === 0)
            ? ''
            : `<div class="setup-cmds">${tier.commands.map((c) => {
                const copyable = /^termdeck\s/.test(c);
                return `<div class="setup-cmd">
                  <code>${escapeHtml(c)}</code>
                  ${copyable ? `<button type="button" class="setup-copy" data-copy="${escapeHtml(c)}">copy</button>` : ''}
                </div>`;
              }).join('')}</div>`;

        return `
          <div class="setup-tier setup-tier-${status}${isCurrent ? ' setup-tier-next' : ''}">
            <div class="setup-tier-rail" aria-hidden="true">
              <span class="setup-tier-dot"></span>
              ${idx < SETUP_TIERS.length - 1 ? '<span class="setup-tier-line"></span>' : ''}
            </div>
            <div class="setup-tier-body">
              <div class="setup-tier-head">
                <span class="setup-tier-name">${escapeHtml(tier.name)}</span>
                <span class="setup-tier-status setup-tier-status-${status}">${escapeHtml(badgeLabel)}</span>
              </div>
              <div class="setup-tier-desc">${escapeHtml(tier.desc)}</div>
              ${detail ? `<div class="setup-tier-detail">${escapeHtml(detail)}</div>` : ''}
              ${cmds}
            </div>
          </div>
        `;
      }).join('');

      tiersEl.innerHTML = html;

      tiersEl.querySelectorAll('.setup-copy').forEach((btn) => {
        btn.addEventListener('click', () => {
          const txt = btn.getAttribute('data-copy') || '';
          navigator.clipboard.writeText(txt).then(() => {
            const original = btn.textContent;
            btn.textContent = 'copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = original;
              btn.classList.remove('copied');
            }, 1500);
          }).catch(() => {});
        });
      });

      const credSaveBtn = tiersEl.querySelector('#setupCredSave');
      if (credSaveBtn) {
        credSaveBtn.addEventListener('click', submitSetupCredentials);
      }
      const credForm = tiersEl.querySelector('#setupCredForm');
      if (credForm) {
        credForm.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitSetupCredentials();
          }
        });
      }

      // Sprint 25 T3 — Supabase MCP auto-flow handlers. The form is only in the
      // DOM when showSupabaseAutoFlow was true above; querying for missing nodes
      // is a no-op and keeps this branch defensive against re-render order.
      const autoConnectBtn = tiersEl.querySelector('#supabaseAutoConnect');
      if (autoConnectBtn) {
        autoConnectBtn.addEventListener('click', handleSupabaseAutoConnect);
      }
      const autoPatInput = tiersEl.querySelector('#supabaseAutoPat');
      if (autoPatInput) {
        autoPatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSupabaseAutoConnect();
          }
        });
      }
      const autoSelectBtn = tiersEl.querySelector('#supabaseAutoSelect');
      if (autoSelectBtn) {
        autoSelectBtn.addEventListener('click', handleSupabaseAutoSelect);
      }
      const autoBackBtn = tiersEl.querySelector('#supabaseAutoBack');
      if (autoBackBtn) {
        autoBackBtn.addEventListener('click', handleSupabaseAutoBack);
      }
    }

    // Sprint 25 T3 — Supabase MCP auto-flow renderer.
    // Inline-styled (Sprint 23 T1 owns style.css). Renders one of two states
    // driven by `supabaseAutoState`: the PAT entry form (default), or the
    // project picker (when state.picking is true). Errors render inline; the
    // manual credential form is always still visible below as a fallback.
    function renderSupabaseAutoFlow() {
      const s = supabaseAutoState || {};
      const wrapStyle = 'margin-top:10px;padding:12px;background:rgba(0,0,0,0.18);border:1px solid var(--border, #2a2c3a);border-radius:6px;';
      const titleStyle = 'font-size:11px;font-weight:600;color:var(--text, #e2e3e8);margin-bottom:4px;';
      const helpStyle = 'font-size:10px;color:var(--text-dim, #8a8d9a);margin-bottom:10px;line-height:1.4;';
      const inputStyle = 'flex:1;padding:6px 8px;background:var(--bg, #0f1017);color:var(--text, #e2e3e8);border:1px solid var(--border, #2a2c3a);border-radius:4px;font-family:monospace;font-size:12px;box-sizing:border-box;';
      const btnStyle = 'padding:6px 14px;background:var(--accent, #7aa2f7);color:#000;border:none;border-radius:4px;font-weight:600;cursor:pointer;font-size:11px;';
      const ghostBtnStyle = 'padding:6px 14px;background:transparent;color:var(--text-dim, #8a8d9a);border:1px solid var(--border, #2a2c3a);border-radius:4px;cursor:pointer;font-size:11px;';
      const dividerStyle = 'text-align:center;font-size:10px;color:var(--text-dim, #8a8d9a);margin:10px 0 0;text-transform:uppercase;letter-spacing:0.05em;';
      const errStyle = 'font-size:11px;color:var(--red, #f7768e);margin-top:8px;min-height:14px;line-height:1.4;';
      const linkStyle = 'color:var(--accent, #7aa2f7);text-decoration:underline;';

      let body;
      if (s.picking && Array.isArray(s.projects)) {
        if (s.projects.length === 0) {
          body = `
            <div style="${errStyle}">
              Token accepted, but no projects were found on this account.
              Create one at <a href="https://supabase.com/dashboard" target="_blank" rel="noopener" style="${linkStyle}">supabase.com/dashboard</a> and try again.
            </div>
            <button type="button" id="supabaseAutoBack" style="margin-top:10px;${ghostBtnStyle}">Use a different token</button>
          `;
        } else {
          const opts = s.projects.map((p) => {
            const id = escapeHtml(String((p && p.id) || ''));
            const name = (p && p.name) || 'unnamed';
            const region = p && p.region ? ` — ${p.region}` : '';
            return `<option value="${id}">${escapeHtml(name + region)}</option>`;
          }).join('');
          body = `
            <label style="display:block;font-size:11px;color:var(--text-dim, #8a8d9a);margin-bottom:4px;">Project</label>
            <select id="supabaseAutoProject" style="${inputStyle}width:100%;font-family:inherit;">${opts}</select>
            <div style="display:flex;gap:8px;margin-top:10px;">
              <button type="button" id="supabaseAutoSelect" style="${btnStyle}">Use this project</button>
              <button type="button" id="supabaseAutoBack" style="${ghostBtnStyle}">Use a different token</button>
            </div>
            <div id="supabaseAutoError" style="${errStyle}">${s.error ? escapeHtml(s.error) : ''}</div>
          `;
        }
      } else {
        body = `
          <div style="display:flex;gap:8px;align-items:stretch;">
            <input type="password" id="supabaseAutoPat" name="supabase_pat_one_time"
                   autocomplete="new-password" spellcheck="false"
                   autocapitalize="off" autocorrect="off"
                   placeholder="sbp_..." aria-label="Supabase Personal Access Token"
                   style="${inputStyle}">
            <button type="button" id="supabaseAutoConnect" style="${btnStyle}">Connect</button>
          </div>
          <div id="supabaseAutoError" style="${errStyle}">${s.error ? escapeHtml(s.error) : ''}</div>
        `;
      }

      return `
        <div style="${wrapStyle}">
          <div style="${titleStyle}">Faster: connect Supabase automatically</div>
          <div style="${helpStyle}">
            Paste a Supabase Personal Access Token and pick your project from a list — we'll fetch the credentials for you.
            Mint a PAT at <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener" style="${linkStyle}">supabase.com/dashboard/account/tokens</a>.
          </div>
          ${body}
        </div>
        <div style="${dividerStyle}">— or paste credentials manually below —</div>
      `;
    }

    function rerenderSetupTiersFromCache() {
      if (lastSetupData) renderSetupTiers(lastSetupData);
    }

    async function handleSupabaseAutoConnect() {
      const input = document.getElementById('supabaseAutoPat');
      const errEl = document.getElementById('supabaseAutoError');
      const btn = document.getElementById('supabaseAutoConnect');
      const pat = ((input && input.value) || '').trim();
      if (!pat) {
        if (errEl) errEl.textContent = 'Paste a Personal Access Token to continue.';
        return;
      }
      if (errEl) errEl.textContent = '';
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      try {
        const res = await fetch(`${API}/api/setup/supabase/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pat })
        });
        let data = {};
        try { data = await res.json(); } catch { data = {}; }
        if (res.ok && data && data.ok) {
          const projects = Array.isArray(data.projects) ? data.projects : [];
          // Hold the PAT in module-scope state only; never on `state`/`window`.
          supabaseAutoState = { pat, projects, picking: true, error: null };
          rerenderSetupTiersFromCache();
          return;
        }
        const code = data && data.code;
        let msg;
        if (code === 'mcp_not_installed') {
          msg = "The Supabase MCP isn't installed on this machine. Run `npx @jhizzard/termdeck-stack --tier 4` to install it, or paste credentials manually below.";
        } else if (code === 'pat_invalid') {
          const detail = (data && data.detail) || 'token rejected';
          msg = `Token rejected: ${detail}. Mint a fresh PAT and try again.`;
        } else if (code === 'mcp_timeout') {
          msg = "Supabase didn't respond in time. Try again or paste credentials manually below.";
        } else {
          msg = (data && (data.error || data.detail)) || `Connect failed (HTTP ${res.status}). Paste credentials manually below.`;
        }
        if (errEl) errEl.textContent = msg;
      } catch (err) {
        if (errEl) errEl.textContent = `Request failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      }
    }

    async function handleSupabaseAutoSelect() {
      if (!supabaseAutoState || !supabaseAutoState.pat) return;
      const sel = document.getElementById('supabaseAutoProject');
      const errEl = document.getElementById('supabaseAutoError');
      const btn = document.getElementById('supabaseAutoSelect');
      const projectId = sel ? sel.value : '';
      if (!projectId) {
        if (errEl) errEl.textContent = 'Pick a project first.';
        return;
      }
      if (errEl) errEl.textContent = '';
      if (btn) { btn.disabled = true; btn.textContent = 'Configuring…'; }
      // Snapshot the PAT locally so we can null out module state before the
      // network call resolves; the snapshot only lives for the duration of
      // this async function.
      const patSnapshot = supabaseAutoState.pat;
      try {
        const res = await fetch(`${API}/api/setup/supabase/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pat: patSnapshot, projectId })
        });
        let data = {};
        try { data = await res.json(); } catch { data = {}; }
        if (res.ok && data && data.ok) {
          // Null out the PAT before doing anything else with the response.
          supabaseAutoState = null;
          await refreshSetupStatus();
          return;
        }
        const detail = (data && (data.error || data.detail)) || `HTTP ${res.status}`;
        if (errEl) {
          errEl.textContent = `Couldn't finish setup: ${detail}. Paste credentials manually below if this keeps failing.`;
        }
      } catch (err) {
        if (errEl) errEl.textContent = `Request failed: ${err && err.message ? err.message : String(err)}`;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Use this project'; }
      }
    }

    function handleSupabaseAutoBack() {
      // Drop the PAT and any cached project list and re-render from scratch.
      supabaseAutoState = null;
      rerenderSetupTiersFromCache();
    }

    // Sprint 23 T2 — credential form for Tier 2.
    // Uses inline styles because wizard CSS is owned by T1 this sprint; these
    // stubs fall back to CSS vars already defined in style.css so they inherit
    // theme colours automatically.
    function renderSetupCredentialForm() {
      const inputStyle = 'width:100%;padding:6px 8px;background:var(--bg, #0f1017);color:var(--text, #e2e3e8);border:1px solid var(--border, #2a2c3a);border-radius:4px;font-family:monospace;font-size:12px;margin-top:4px;box-sizing:border-box;';
      const labelStyle = 'display:block;font-size:11px;color:var(--text-dim, #8a8d9a);margin-top:10px;';
      const helpStyle = 'font-size:10px;color:var(--text-dim, #8a8d9a);margin-top:3px;min-height:12px;';
      const btnStyle = 'margin-top:14px;padding:8px 18px;background:var(--accent, #7aa2f7);color:#000;border:none;border-radius:4px;font-weight:600;cursor:pointer;font-size:12px;';
      return `
        <form class="setup-credentials" id="setupCredForm" autocomplete="off" style="margin-top:10px;padding:12px;background:rgba(0,0,0,0.2);border-radius:6px;border:1px solid var(--border, #2a2c3a);">
          <div style="font-size:11px;color:var(--text-dim, #8a8d9a);margin-bottom:4px;">
            Paste your Supabase + OpenAI credentials. They are written to <code>~/.termdeck/secrets.env</code> (chmod 600) and never leave this machine.
          </div>
          <label style="${labelStyle}">
            Supabase URL
            <input type="text" name="supabaseUrl" placeholder="https://xxxxxx.supabase.co" spellcheck="false" autocapitalize="off" autocorrect="off" style="${inputStyle}">
          </label>
          <div class="setup-cred-status" data-field="supabase" style="${helpStyle}"></div>
          <label style="${labelStyle}">
            Service Role Key
            <input type="password" name="supabaseServiceRoleKey" placeholder="sb_secret_..." spellcheck="false" autocomplete="new-password" style="${inputStyle}">
          </label>
          <label style="${labelStyle}">
            OpenAI API Key
            <input type="password" name="openaiApiKey" placeholder="sk-proj-..." spellcheck="false" autocomplete="new-password" style="${inputStyle}">
          </label>
          <div class="setup-cred-status" data-field="openai" style="${helpStyle}"></div>
          <label style="${labelStyle}">
            Database URL
            <input type="password" name="databaseUrl" placeholder="postgresql://postgres:...@...pooler.supabase.com:6543/postgres" spellcheck="false" autocomplete="new-password" style="${inputStyle}">
          </label>
          <div class="setup-cred-status" data-field="database" style="${helpStyle}"></div>
          <label style="${labelStyle}">
            Anthropic API Key <span style="opacity:0.6;">(optional — powers session-log summaries)</span>
            <input type="password" name="anthropicApiKey" placeholder="sk-ant-..." spellcheck="false" autocomplete="new-password" style="${inputStyle}">
          </label>
          <div class="setup-cred-error" id="setupCredError" style="font-size:11px;margin-top:10px;min-height:14px;"></div>
          <button type="button" class="setup-cred-save" id="setupCredSave" style="${btnStyle}">Save &amp; Connect</button>
        </form>
      `;
    }

    async function submitSetupCredentials() {
      const form = document.getElementById('setupCredForm');
      if (!form) return;
      const btn = document.getElementById('setupCredSave');
      const errorEl = document.getElementById('setupCredError');
      const statuses = form.querySelectorAll('.setup-cred-status');

      // Reset state
      if (errorEl) { errorEl.textContent = ''; errorEl.style.color = ''; }
      statuses.forEach((el) => { el.textContent = ''; el.style.color = ''; });

      const body = {
        supabaseUrl: (form.supabaseUrl.value || '').trim(),
        supabaseServiceRoleKey: (form.supabaseServiceRoleKey.value || '').trim(),
        openaiApiKey: (form.openaiApiKey.value || '').trim(),
        anthropicApiKey: (form.anthropicApiKey.value || '').trim(),
        databaseUrl: (form.databaseUrl.value || '').trim()
      };

      const missing = [];
      if (!body.supabaseUrl) missing.push('Supabase URL');
      if (!body.supabaseServiceRoleKey) missing.push('Service Role Key');
      if (!body.openaiApiKey) missing.push('OpenAI API Key');
      if (!body.databaseUrl) missing.push('Database URL');
      if (missing.length) {
        if (errorEl) {
          errorEl.textContent = `Please fill in: ${missing.join(', ')} (Anthropic is optional).`;
          errorEl.style.color = 'var(--red, #f7768e)';
        }
        return;
      }

      if (btn) { btn.disabled = true; btn.textContent = 'Validating…'; }
      try {
        const res = await fetch(`${API}/api/setup/configure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        let data = {};
        try { data = await res.json(); } catch { data = {}; }

        if (data && data.validation) {
          for (const field of ['supabase', 'openai', 'database']) {
            const result = data.validation[field];
            if (!result) continue;
            const el = form.querySelector(`.setup-cred-status[data-field="${field}"]`);
            if (el) {
              el.textContent = (result.ok ? '✓ ' : '✗ ') + (result.detail || '');
              el.style.color = result.ok ? 'var(--green, #9ece6a)' : 'var(--red, #f7768e)';
            }
          }
        }

        if (res.ok && data && data.success) {
          if (errorEl) {
            errorEl.textContent = (data.detail || 'Credentials saved.') + ' Running migrations…';
            errorEl.style.color = 'var(--green, #9ece6a)';
          }
          if (btn) btn.textContent = 'Migrating…';
          await runSetupMigrations(errorEl);
          setTimeout(() => { refreshSetupStatus(); }, 600);
        } else {
          if (errorEl) {
            errorEl.textContent = (data && data.error) || `Configuration failed (HTTP ${res.status})`;
            errorEl.style.color = 'var(--red, #f7768e)';
          }
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = `Request failed: ${err && err.message ? err.message : String(err)}`;
          errorEl.style.color = 'var(--red, #f7768e)';
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save & Connect'; }
      }
    }

    // Sprint 23 audit fix: chain /api/setup/migrate after credentials save so
    // the wizard fulfills the sprint mission ("write config AND run migrations")
    // in a single click instead of leaving the user to run `termdeck init`.
    async function runSetupMigrations(statusEl) {
      try {
        const res = await fetch(`${API}/api/setup/migrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        let data = {};
        try { data = await res.json(); } catch { data = {}; }
        if (statusEl) {
          if (res.ok && data && data.ok) {
            statusEl.textContent = `Migrations applied (${data.applied}/${data.total}). Tier 2 active.`;
            statusEl.style.color = 'var(--green, #9ece6a)';
          } else {
            const applied = (data && data.applied != null) ? `${data.applied}/${data.total} applied` : '';
            const detail = (data && data.error) ? data.error : `HTTP ${res.status}`;
            statusEl.textContent = `Migrations failed: ${detail}${applied ? ` (${applied})` : ''}`;
            statusEl.style.color = 'var(--red, #f7768e)';
          }
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `Migration request failed: ${err && err.message ? err.message : String(err)}`;
          statusEl.style.color = 'var(--red, #f7768e)';
        }
      }
    }

    async function maybeAutoOpenSetupWizard() {
      // First-run users get the full wizard; returning users with at least
      // tier 1 configured get a brief welcome-back toast (Sprint 23 T4).
      // Silent-fail if the endpoint doesn't exist (server predates Sprint 19 T1).
      try {
        const res = await fetch(`${API}/api/setup`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || tourState.active) return;
        if (data.firstRun) {
          setTimeout(() => {
            if (!tourState.active && !setupModalOpen) openSetupModal();
          }, 800);
        } else if (Number(data.tier) >= 1) {
          setTimeout(() => {
            if (!tourState.active && !setupModalOpen) showWelcomeBackToast(data);
          }, 800);
        }
      } catch {
        // API not available — skip silently
      }
    }

    // Sprint 23 T4: returning-user welcome-back toast. Non-blocking, dismisses
    // on click or after 5s. Inline-styled so we don't touch style.css (T1's
    // ownership). The config button still opens the full wizard.
    function showWelcomeBackToast(data) {
      const existing = document.getElementById('welcomeBackToast');
      if (existing) existing.remove();

      const tier = Number(data.tier) || 1;
      const tierNames = {
        1: 'TermDeck core',
        2: 'TermDeck + Mnestra',
        3: 'TermDeck + Mnestra + Rumen',
        4: 'Full stack + projects'
      };
      const stackLabel = tierNames[tier] || 'TermDeck';

      const tiers = data.tiers || {};
      const mnestraDetail = (tiers[2] && tiers[2].detail) || '';
      const rumenDetail = (tiers[3] && tiers[3].detail) || '';

      const memMatch = mnestraDetail.match(/([\d,]+)\s*memories/i);
      const memoryCount = memMatch ? memMatch[1] : null;
      const rumenMatch = rumenDetail.match(/last job\s+([^,]+?)(?:\s+ago|,|$)/i);
      const rumenAgo = rumenMatch ? rumenMatch[1].trim() : null;

      const parts = [`Stack: ${stackLabel}.`];
      if (memoryCount) parts.push(`${memoryCount} memories.`);
      if (rumenAgo) parts.push(`Last Rumen job: ${rumenAgo} ago.`);

      const toast = document.createElement('div');
      toast.id = 'welcomeBackToast';
      toast.setAttribute('role', 'status');
      toast.style.cssText = [
        'position:fixed',
        'top:64px',
        'right:16px',
        'z-index:9999',
        'max-width:360px',
        'padding:10px 14px',
        'background:rgba(20,22,28,0.95)',
        'color:#cdd6f4',
        'border:1px solid rgba(137,180,250,0.35)',
        'border-radius:6px',
        'box-shadow:0 4px 18px rgba(0,0,0,0.4)',
        'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
        'cursor:pointer',
        'opacity:0',
        'transition:opacity 180ms ease'
      ].join(';');
      toast.innerHTML = `
        <div style="font-weight:600;color:#89b4fa;margin-bottom:2px">Welcome back</div>
        <div>${parts.map(p => escapeHtml(p)).join(' ')}</div>
      `;

      document.body.appendChild(toast);
      requestAnimationFrame(() => { toast.style.opacity = '1'; });

      const dismiss = () => {
        clearTimeout(timer);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 200);
      };
      toast.addEventListener('click', dismiss);
      const timer = setTimeout(dismiss, 5000);
    }

    function fmtUptime(sec) {
      const s = Math.floor(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const rs = s % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${rs}s`;
      return `${rs}s`;
    }

    // ===== Event Listeners =====
    document.querySelectorAll('.layout-btn').forEach(btn => {
      btn.addEventListener('click', () => setLayout(btn.dataset.layout));
    });

    // Sprint 65 T1 (1.1) — project-filter chip clicks (delegated; chips are
    // rebuilt on every status_broadcast so a per-chip listener would go stale).
    const projectChipsRow = document.getElementById('project-chips');
    if (projectChipsRow) projectChipsRow.addEventListener('click', onProjectChipClick);

    // Sprint 65 T1 (c) — topbar terminal font-size stepper.
    const fontDecBtn = document.getElementById('btn-font-dec');
    const fontIncBtn = document.getElementById('btn-font-inc');
    if (fontDecBtn) fontDecBtn.addEventListener('click', () => stepFontSize(-1));
    if (fontIncBtn) fontIncBtn.addEventListener('click', () => stepFontSize(1));

    document.getElementById('promptLaunch').addEventListener('click', launchTerminal);
    document.getElementById('promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') launchTerminal();
    });

    // Add-project modal wiring
    document.getElementById('btnAddProject').addEventListener('click', openAddProjectModal);
    document.getElementById('apmCancel').addEventListener('click', closeAddProjectModal);
    document.getElementById('apmSave').addEventListener('click', submitAddProject);
    document.querySelector('#addProjectModal .add-project-backdrop').addEventListener('click', closeAddProjectModal);
    // Enter in any input inside the modal submits; Escape closes
    document.getElementById('addProjectModal').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAddProject(); }
      if (e.key === 'Escape') { e.preventDefault(); closeAddProjectModal(); }
    });

    // Remove-project modal wiring (Sprint 42 T4)
    document.getElementById('btnRemoveProject').addEventListener('click', openRemoveProjectModal);
    document.getElementById('rpmCancel').addEventListener('click', closeRemoveProjectModal);
    document.getElementById('rpmConfirm').addEventListener('click', submitRemoveProject);
    document.getElementById('rpmSelect').addEventListener('change', onRpmSelectChange);
    document.querySelector('#removeProjectModal .remove-project-backdrop').addEventListener('click', closeRemoveProjectModal);
    document.getElementById('removeProjectModal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRemoveProjectModal(); }
    });

    // Orchestration preview modal wiring (Sprint 37 T3)
    document.getElementById('btnPreviewProject').addEventListener('click', openPreviewModal);
    document.getElementById('promptProject').addEventListener('change', syncPreviewButton);
    document.getElementById('ppmClose').addEventListener('click', closePreviewModal);
    document.getElementById('ppmCancel').addEventListener('click', closePreviewModal);
    document.querySelector('#previewProjectModal .preview-project-backdrop').addEventListener('click', closePreviewModal);
    document.getElementById('ppmGenerate').addEventListener('click', submitGenerate);
    document.getElementById('previewProjectModal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePreviewModal(); }
    });
    syncPreviewButton();

    // Status + config dropdowns (Sprint 9 T2): btn-status/btn-config were
    // stubs with no listeners. Each now opens a dropdown with live data
    // fetched from /api/status and /api/config. Reuses .health-dropdown
    // styling (from T1's style.css) for visual consistency.
    setupInfoDropdown({
      btnId: 'btn-status',
      dropdownId: 'statusDropdown',
      fetch: () => api('GET', '/api/status'),
      render: renderStatusDropdown
    });
    // Sprint 19 T2: config button now opens the setup wizard instead of the
    // legacy config dropdown (renderConfigDropdown is kept as dead code).
    document.getElementById('btn-config').addEventListener('click', openSetupModal);

    // Sprint runner modal wiring (Sprint 37 T4)
    document.getElementById('btn-sprint').addEventListener('click', openSprintModal);
    document.getElementById('sprintCancel').addEventListener('click', closeSprintModal);
    document.getElementById('sprintResultClose').addEventListener('click', closeSprintModal);
    document.getElementById('sprintBackdrop').addEventListener('click', closeSprintModal);
    document.getElementById('sprintKickoff').addEventListener('click', submitSprint);
    document.getElementById('sprintModal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSprintModal(); }
    });

    // Onboarding tour wiring
    document.getElementById('btn-how').addEventListener('click', startTour);
    document.getElementById('tourNextBtn').addEventListener('click', nextTourStep);
    document.getElementById('tourPrevBtn').addEventListener('click', prevTourStep);
    document.getElementById('tourSkipBtn').addEventListener('click', endTour);
    // Clicking the backdrop (but not the spotlight/tooltip) also skips
    document.getElementById('tourBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'tourBackdrop') endTour();
    });

    // Resize handler — debounced so a resize drag doesn't re-fit every frame.
    window.addEventListener('resize', fitAllDebounced);

    // Re-render the tour on viewport changes so the spotlight tracks resizes
    window.addEventListener('resize', () => {
      if (tourState.active) renderTourStep();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Tour has priority: Esc exits, ArrowRight/Enter advances, ArrowLeft back.
      // BUT: never swallow Enter/Arrow keys when the user is typing into a
      // terminal panel or any input/textarea — otherwise terminal Enter
      // (Claude Code / shell submit) gets eaten by the tour and the user
      // ends up advancing tour steps when they meant to send a message.
      // Brad's 2026-04-28 panel-UX report: "Hitting enter from full screen
      // goes to matrix again" matched this pathway when the v0.10.0 tour
      // re-fired post-upgrade.
      if (tourState.active) {
        const tgt = e.target;
        const tag = tgt?.tagName || '';
        const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable;
        const inTerminal = tgt?.closest && tgt.closest('.term-panel');
        if (!inEditable && !inTerminal) {
          if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
          if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); nextTourStep(); return; }
          if (e.key === 'ArrowLeft') { e.preventDefault(); prevTourStep(); return; }
        }
      }
      // Ctrl+Shift+N → new terminal
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        document.getElementById('promptInput').focus();
      }
      // "/" → focus prompt bar (first-run hint, ignored when typing in any input/textarea)
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        const tag = target?.tagName || '';
        const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
        if (!inEditable) {
          e.preventDefault();
          document.getElementById('promptInput').focus();
        }
      }
      // Ctrl+Shift+1-9,0 OR Cmd+Shift+1-9,0 → layout switch (Mac friendly).
      // Sprint 65 T1 (1.4) — keys 1-9 map to indices 0-8, key 0 maps to index
      // 9. Keys 1-7 keep their pre-Sprint-65 layouts (muscle memory); 8/9/0 are
      // the new dense presets. Topbar buttons cover every preset incl. 2x5/5x2/3x4.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        // Sprint 67 T3: index 6 (was `orch`, key 7) is now null — the legacy
        // orch layout is retired in favor of the role-tagged ORCH-pin row.
        // Keep the slot to preserve muscle memory on keys 8/9/0.
        const layouts = ['1x1', '2x1', '2x2', '3x2', '2x4', '4x2', null, '1x2', '4x3', '4x4'];
        const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        if (layouts[idx]) setLayout(layouts[idx]);
      }
      // Ctrl+Shift+] / [ → cycle between terminals
      if (e.ctrlKey && e.shiftKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        const ids = Array.from(state.sessions.keys());
        if (ids.length > 0) {
          const curIdx = ids.indexOf(state.focusedId);
          const next = e.key === ']'
            ? (curIdx + 1) % ids.length
            : (curIdx - 1 + ids.length) % ids.length;
          const entry = state.sessions.get(ids[next]);
          if (entry) {
            if (entry.terminal) entry.terminal.focus();
            else if (entry.inputEl) entry.inputEl.focus();  // web-chat: focus the inject box
            state.focusedId = ids[next];
          }
        }
      }
      // Escape → exit focus mode
      if (e.key === 'Escape') {
        const grid = document.getElementById('termGrid');
        if (grid.classList.contains('layout-focus') || grid.classList.contains('layout-half')) {
          setLayout(state.layout);
          document.querySelectorAll('.term-panel').forEach(p => {
            p.classList.remove('focused', 'primary');
            p.style.display = '';
          });
          fitAll();
        }
      }
    });

    // Control feed click (T1.6) — delegated at the feed container
    document.getElementById('feedRows').addEventListener('click', onFeedRowClick);

    // Live refresh while in control mode
    setInterval(() => {
      const grid = document.getElementById('termGrid');
      if (grid && grid.classList.contains('layout-control')) {
        renderControlFeed();
      }
    }, 2000);

    // Alt+1..9 → focus panel N, Alt+0 → cycle focus (T1.2)
    // Use capture-phase so xterm.js never sees the key as a Meta sequence.
    // Match on e.code, not e.key: on macOS, Option+1 produces "¡", not "1".
    document.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code && e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 9) {
          e.preventDefault();
          e.stopPropagation();
          focusNthSession(n);
        } else if (n === 0) {
          e.preventDefault();
          e.stopPropagation();
          cycleSessionFocus();
        }
      }
    }, { capture: true });

    // External-session auto-discover disabled. The poller raced with the
    // immediate createTerminalPanel call in launchTerminal and caused
    // duplicate WebSocket connections per session, which broke terminal
    // input rendering (session.ws on the server got overwritten by the
    // second connect and term.onData output stopped reaching the visible
    // panel). Parked for Sprint 3 — needs an idempotent creation path
    // AND a way to suppress the race window during POST → createPanel.

    // Refresh "opened X ago" timestamps every 30s
    setInterval(() => {
      for (const [id, entry] of state.sessions) {
        const metaOpened = document.querySelector(`#panel-${id} .panel-meta .meta-item:first-child`);
        if (metaOpened && entry.session?.meta?.createdAt) {
          metaOpened.innerHTML = `<span class="meta-label">opened</span> ${timeAgo(entry.session.meta.createdAt)}`;
        }
      }
    }, 30000);

    // ===== Health Badge (Sprint 6 T4) =====
    const healthState = {
      available: false,    // false until first successful /api/health response
      pollTimer: null,
      dropdownOpen: false,
      lastResult: null
    };

    function setupHealthBadge() {
      // Inject badge into topbar-stats, after the rumen badge
      const statsDiv = document.getElementById('globalStats');
      if (!statsDiv) return;

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'health-badge';
      badge.id = 'healthBadge';
      badge.title = 'Stack health';
      badge.setAttribute('aria-haspopup', 'true');
      badge.innerHTML = `<span class="hb-icon" aria-hidden="true">&#x1F6E1;</span> <span id="healthBadgeLabel">checking…</span>`;
      badge.style.display = 'none'; // hidden until first successful poll
      statsDiv.appendChild(badge);

      // Dropdown
      const dropdown = document.createElement('div');
      dropdown.className = 'health-dropdown';
      dropdown.id = 'healthDropdown';
      dropdown.innerHTML = '<div class="hd-loading">Loading…</div>';
      document.body.appendChild(dropdown);

      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHealthDropdown();
      });
      document.addEventListener('click', (e) => {
        if (healthState.dropdownOpen && !dropdown.contains(e.target) && e.target !== badge) {
          closeHealthDropdown();
        }
      });

      // Initial fetch + poll
      fetchHealth();
      healthState.pollTimer = setInterval(fetchHealth, 30000);
    }

    async function fetchHealth() {
      try {
        const res = await fetch(`${API}/api/health`);
        if (res.status === 404) {
          // Server doesn't have health endpoint — hide badge entirely
          hideHealthBadge();
          return;
        }
        if (!res.ok) {
          showHealthOffline();
          return;
        }
        const data = await res.json();
        healthState.available = true;
        healthState.lastResult = data;
        renderHealthBadge(data);
      } catch {
        showHealthOffline();
      }
    }

    function hideHealthBadge() {
      healthState.available = false;
      const badge = document.getElementById('healthBadge');
      if (badge) badge.style.display = 'none';
      if (healthState.pollTimer) {
        clearInterval(healthState.pollTimer);
        healthState.pollTimer = null;
      }
    }

    function showHealthOffline() {
      healthState.available = true;
      healthState.lastResult = null;
      const badge = document.getElementById('healthBadge');
      if (!badge) return;
      badge.style.display = '';
      badge.className = 'health-badge hb-red';
      document.getElementById('healthBadgeLabel').textContent = 'Health: offline';
    }

    // Tier 2/3 checks only shown when the user has configured those tiers.
    // Without DATABASE_URL, mnestra/rumen/database checks are irrelevant noise.
    const TIER1_CHECKS = new Set(['project_paths', 'shell_sanity']);
    const TIER23_CHECKS = new Set(['mnestra_reachable', 'mnestra_has_memories', 'rumen_recent', 'database_url']);

    function filterChecksByTier(checks) {
      // Show Tier 2/3 checks if DATABASE_URL was ATTEMPTED (exists in results),
      // regardless of pass/fail. Only hide higher-tier checks when the user
      // has no DATABASE_URL at all (detail says "not set").
      const dbCheck = checks.find(c => c.name === 'database_url');
      const dbConfigured = dbCheck && !/not set/i.test(dbCheck.detail || '');
      if (dbConfigured) return checks; // full stack configured — show everything
      // No DATABASE_URL configured: only show Tier 1 checks
      return checks.filter(c => TIER1_CHECKS.has(c.name));
    }

    function renderHealthBadge(data) {
      const badge = document.getElementById('healthBadge');
      if (!badge) return;
      badge.style.display = '';

      const allChecks = data.checks || [];
      const checks = filterChecksByTier(allChecks);
      const total = checks.length;
      const passed = checks.filter(c => c.passed).length;
      const allOk = passed === total && total > 0;
      const tierLabel = total < allChecks.length ? 'Tier 1' : 'Stack';

      if (allOk) {
        badge.className = 'health-badge hb-green';
        document.getElementById('healthBadgeLabel').textContent = `${tierLabel}: OK`;
      } else if (total === 0) {
        badge.className = 'health-badge hb-amber';
        document.getElementById('healthBadgeLabel').textContent = 'Stack: ?';
      } else {
        badge.className = 'health-badge hb-red';
        document.getElementById('healthBadgeLabel').textContent = `${tierLabel}: ${passed}/${total}`;
      }

      // Update dropdown content — pass filtered checks
      renderHealthDropdown({ ...data, checks });
    }

    function renderHealthDropdown(data) {
      const dropdown = document.getElementById('healthDropdown');
      if (!dropdown) return;
      const checks = data.checks || [];
      if (checks.length === 0) {
        dropdown.innerHTML = '<div class="hd-empty">No health checks reported</div>';
        return;
      }

      let html = '';
      for (const check of checks) {
        const icon = check.passed ? '✓' : '✗';
        const cls = check.passed ? 'hd-ok' : 'hd-fail';
        const name = check.name || 'Unknown';
        const detail = check.detail || '';
        const remediation = check.passed ? '' : (check.remediation ? `<div class="hd-remediation">${escapeHtml(check.remediation)}</div>` : '');
        html += `<div class="hd-check ${cls}">
          <span class="hd-icon">${icon}</span>
          <span class="hd-name">${escapeHtml(name)}</span>
          <span class="hd-dots"></span>
          <span class="hd-status">${check.passed ? 'OK' : 'FAIL'}</span>
          <span class="hd-detail">${escapeHtml(detail)}</span>
          ${remediation}
        </div>`;
      }
      dropdown.innerHTML = html;
    }

    function toggleHealthDropdown() {
      if (healthState.dropdownOpen) {
        closeHealthDropdown();
      } else {
        openHealthDropdown();
      }
    }

    function openHealthDropdown() {
      const badge = document.getElementById('healthBadge');
      const dropdown = document.getElementById('healthDropdown');
      if (!badge || !dropdown) return;

      const rect = badge.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom + 4}px`;
      dropdown.style.left = `${Math.max(8, rect.left - 100)}px`;
      dropdown.classList.add('open');
      healthState.dropdownOpen = true;
    }

    function closeHealthDropdown() {
      const dropdown = document.getElementById('healthDropdown');
      if (dropdown) dropdown.classList.remove('open');
      healthState.dropdownOpen = false;
    }

    // ===== Transcript Recovery UI (Sprint 6 T4) =====
    // Sprint 80 FR-1 (Brad's transcript-order ask) — per-user newest-first toggle
    // for the full-transcript Replay view, persisted in localStorage. Default is
    // false = oldest-first (unchanged chronological reading). Pure-client; no
    // server change. The helpers are function DECLARATIONS so they're hoisted and
    // callable from the transcriptState literal below.
    const TRANSCRIPT_ORDER_KEY = 'termdeck.transcripts.newestFirst';
    function loadTranscriptNewestFirst() {
      try {
        return localStorage.getItem(TRANSCRIPT_ORDER_KEY) === 'true';
      } catch (_e) {
        // localStorage can throw in private-mode / sandboxed contexts — default off.
        return false;
      }
    }
    function saveTranscriptNewestFirst(value) {
      try {
        localStorage.setItem(TRANSCRIPT_ORDER_KEY, value ? 'true' : 'false');
      } catch (_e) { /* non-persistent this session — the in-memory flag still works */ }
    }

    const transcriptState = {
      available: false,
      modalOpen: false,
      view: 'recent',   // 'recent' | 'search' | 'replay'
      recentData: null,
      searchResults: null,
      replaySession: null,
      replayData: null,
      newestFirst: loadTranscriptNewestFirst()   // FR-1 — replay line order
    };

    function setupTranscriptUI() {
      // Inject "Transcripts" button into topbar-right, before the "status" button
      const topbarRight = document.querySelector('.topbar-right');
      const btnStatus = document.getElementById('btn-status');
      if (!topbarRight || !btnStatus) return;

      const btn = document.createElement('button');
      btn.id = 'btn-transcripts';
      btn.textContent = 'transcripts';
      btn.title = 'Session transcript recovery';
      btn.style.display = 'none'; // hidden until we confirm endpoints exist
      topbarRight.insertBefore(btn, btnStatus);

      // Create the modal
      const modal = document.createElement('div');
      modal.className = 'transcript-modal';
      modal.id = 'transcriptModal';
      modal.innerHTML = `
        <div class="transcript-backdrop" id="transcriptBackdrop"></div>
        <div class="transcript-card">
          <header>
            <h3>Session Transcripts</h3>
            <div class="transcript-tabs">
              <button class="transcript-tab active" data-view="recent">Recent</button>
              <button class="transcript-tab" data-view="search">Search</button>
            </div>
          </header>
          <div class="transcript-search-bar" id="transcriptSearchBar" style="display:none">
            <input type="text" id="transcriptSearchInput" placeholder="Search transcript content…" class="ctrl-input" />
          </div>
          <div class="transcript-body" id="transcriptBody">
            <div class="transcript-loading">Checking transcript endpoints…</div>
          </div>
          <footer>
            <button class="transcript-back" id="transcriptBack" style="display:none">← Back</button>
            <button class="rm-close" id="transcriptClose">Close</button>
          </footer>
        </div>
      `;
      document.body.appendChild(modal);

      // Events
      btn.addEventListener('click', openTranscriptModal);
      document.getElementById('transcriptBackdrop').addEventListener('click', closeTranscriptModal);
      document.getElementById('transcriptClose').addEventListener('click', closeTranscriptModal);
      document.getElementById('transcriptBack').addEventListener('click', transcriptGoBack);

      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeTranscriptModal(); }
      });

      // Tab switching
      modal.querySelectorAll('.transcript-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const view = tab.dataset.view;
          transcriptSwitchView(view);
        });
      });

      // Search input
      let searchDebounce = null;
      document.getElementById('transcriptSearchInput').addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          const q = e.target.value.trim();
          if (q.length >= 2) transcriptSearch(q);
        }, 400);
      });

      // Probe for endpoint availability
      probeTranscriptEndpoints();
    }

    async function probeTranscriptEndpoints() {
      try {
        const res = await fetch(`${API}/api/transcripts/recent?minutes=1`);
        if (res.status === 404) {
          // Endpoints not available — keep button hidden
          transcriptState.available = false;
          return;
        }
        // Endpoint exists (even if empty)
        transcriptState.available = true;
        const btn = document.getElementById('btn-transcripts');
        if (btn) btn.style.display = '';
      } catch {
        transcriptState.available = false;
      }
    }

    function openTranscriptModal() {
      if (!transcriptState.available) return;
      transcriptState.modalOpen = true;
      document.getElementById('transcriptModal').classList.add('open');
      transcriptSwitchView('recent');
      fetchRecentTranscripts();
    }

    function closeTranscriptModal() {
      transcriptState.modalOpen = false;
      document.getElementById('transcriptModal').classList.remove('open');
    }

    function transcriptGoBack() {
      if (transcriptState.view === 'replay') {
        transcriptState.replaySession = null;
        transcriptState.replayData = null;
        // Go back to whichever list view was active
        transcriptSwitchView(transcriptState.searchResults ? 'search' : 'recent');
        if (transcriptState.view === 'recent') renderRecentTranscripts();
        else renderSearchResults();
      }
    }

    function transcriptSwitchView(view) {
      transcriptState.view = view;
      const tabs = document.querySelectorAll('.transcript-tab');
      tabs.forEach(t => t.classList.toggle('active', t.dataset.view === view));
      const searchBar = document.getElementById('transcriptSearchBar');
      const backBtn = document.getElementById('transcriptBack');
      searchBar.style.display = view === 'search' ? '' : 'none';
      backBtn.style.display = view === 'replay' ? '' : 'none';

      if (view === 'recent') fetchRecentTranscripts();
      if (view === 'search') {
        const input = document.getElementById('transcriptSearchInput');
        input.focus();
        if (transcriptState.searchResults) renderSearchResults();
        else document.getElementById('transcriptBody').innerHTML = '<div class="transcript-empty">Type to search transcript content</div>';
      }
    }

    async function fetchRecentTranscripts() {
      const body = document.getElementById('transcriptBody');
      body.innerHTML = '<div class="transcript-loading">Loading recent transcripts…</div>';
      try {
        const res = await fetch(`${API}/api/transcripts/recent?minutes=60`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        transcriptState.recentData = data;
        renderRecentTranscripts();
      } catch {
        body.innerHTML = '<div class="transcript-empty">Failed to load transcripts</div>';
      }
    }

    function renderRecentTranscripts() {
      const body = document.getElementById('transcriptBody');
      const data = transcriptState.recentData;
      if (!data || !data.sessions || data.sessions.length === 0) {
        body.innerHTML = '<div class="transcript-empty">No recent transcript activity</div>';
        return;
      }
      let html = '';
      for (const sess of data.sessions) {
        const id = sess.sessionId || sess.session_id || 'unknown';
        const shortId = id.slice(0, 8);
        // Server (/api/transcripts/recent) returns { sessions: [{ session_id, chunks: [...] }] }
        // with chunks already grouped per session in DESC created_at order. Type/project
        // metadata isn't on the transcripts table — fall back to optional fields if any
        // future server enrichment ships them.
        const chunks = Array.isArray(sess.chunks) ? sess.chunks : [];
        const type = sess.type || (chunks.length ? 'session' : 'shell');
        const project = sess.project || '';
        const totalChunks = sess.totalLines || chunks.length;
        // Build preview from the most-recent chunks. Server returns DESC order, so
        // the first 6 entries are the newest — reverse for natural top-down reading.
        const previewChunks = chunks.slice(0, 6).reverse();
        const previewText = sess.preview
          ? (Array.isArray(sess.preview) ? sess.preview.join('\n') : String(sess.preview))
          : previewChunks.map(c => (c && typeof c.content === 'string') ? c.content : '').join('');
        html += `<div class="transcript-session" data-session-id="${escapeHtml(id)}">
          <div class="ts-header">
            <span class="ts-id">${escapeHtml(shortId)}</span>
            <span class="ts-type">${escapeHtml(type)}</span>
            ${project ? `<span class="ts-project">${escapeHtml(project)}</span>` : ''}
            <span class="ts-lines">${totalChunks} chunks</span>
          </div>
          <pre class="ts-preview">${escapeHtml(previewText)}</pre>
        </div>`;
      }
      body.innerHTML = html;

      // Click to replay
      body.querySelectorAll('.transcript-session').forEach(el => {
        el.addEventListener('click', () => {
          const sid = el.dataset.sessionId;
          loadTranscriptReplay(sid);
        });
      });
    }

    async function transcriptSearch(query) {
      const body = document.getElementById('transcriptBody');
      body.innerHTML = '<div class="transcript-loading">Searching…</div>';
      try {
        const res = await fetch(`${API}/api/transcripts/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        transcriptState.searchResults = data;
        renderSearchResults();
      } catch {
        body.innerHTML = '<div class="transcript-empty">Search failed</div>';
      }
    }

    function renderSearchResults() {
      const body = document.getElementById('transcriptBody');
      const data = transcriptState.searchResults;
      if (!data || !data.results || data.results.length === 0) {
        body.innerHTML = '<div class="transcript-empty">No matches found</div>';
        return;
      }
      let html = '';
      for (const result of data.results) {
        const id = result.sessionId || result.session_id || 'unknown';
        const shortId = id.slice(0, 8);
        const line = result.line || result.content || '';
        // Server (/api/transcripts/search) sends `created_at`; legacy `timestamp` kept
        // as a fallback in case a future enrichment swaps the field name.
        const tsSource = result.timestamp || result.created_at || '';
        const tsDate = tsSource ? new Date(tsSource) : null;
        const ts = (tsDate && !isNaN(tsDate.getTime())) ? tsDate.toLocaleTimeString() : '';
        html += `<div class="transcript-result" data-session-id="${escapeHtml(id)}">
          <div class="tr-meta">
            <span class="tr-session">${escapeHtml(shortId)}</span>
            ${ts ? `<span class="tr-time">${escapeHtml(ts)}</span>` : ''}
          </div>
          <pre class="tr-line">${highlightMatch(escapeHtml(line), escapeHtml(document.getElementById('transcriptSearchInput').value))}</pre>
        </div>`;
      }
      body.innerHTML = html;

      // Click to replay
      body.querySelectorAll('.transcript-result').forEach(el => {
        el.addEventListener('click', () => {
          const sid = el.dataset.sessionId;
          loadTranscriptReplay(sid);
        });
      });
    }

    function highlightMatch(text, query) {
      if (!query) return text;
      try {
        const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(re, '<mark class="tr-highlight">$1</mark>');
      } catch {
        return text;
      }
    }

    async function loadTranscriptReplay(sessionId) {
      transcriptState.view = 'replay';
      transcriptState.replaySession = sessionId;
      const body = document.getElementById('transcriptBody');
      const backBtn = document.getElementById('transcriptBack');
      const searchBar = document.getElementById('transcriptSearchBar');
      backBtn.style.display = '';
      searchBar.style.display = 'none';
      body.innerHTML = '<div class="transcript-loading">Loading full transcript…</div>';

      try {
        const res = await fetch(`${API}/api/transcripts/${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        transcriptState.replayData = data;
        renderTranscriptReplay(data);
      } catch {
        body.innerHTML = '<div class="transcript-empty">Failed to load transcript</div>';
      }
    }

    // Sprint 80 FR-1 — reorder a transcript's lines for the newest-first toggle.
    // Pure (unit-tested): oldest-first returns the content unchanged; newest-first
    // splits on newline, drops a single trailing empty element (from a final
    // newline, so the reversed view doesn't open with a blank line), reverses,
    // and rejoins. Line-level reversal is the pragmatic "newest-first" semantic
    // for a line-oriented terminal log.
    function orderTranscriptContent(content, newestFirst) {
      if (!newestFirst || !content) return content || '';
      const lines = String(content).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines.reverse().join('\n');
    }

    function renderTranscriptReplay(data) {
      const body = document.getElementById('transcriptBody');
      const rawContent = data.content || data.lines?.join('\n') || '';
      const sessionId = transcriptState.replaySession || 'unknown';
      const newestFirst = transcriptState.newestFirst;
      // Copy reflects the on-screen order (WYSIWYG — the button sits next to the
      // visible content). Toggle back to oldest-first for a canonical export.
      const displayContent = orderTranscriptContent(rawContent, newestFirst);
      body.innerHTML = `
        <div class="transcript-replay-header">
          <span class="tr-replay-id">Session: ${escapeHtml(sessionId.slice(0, 12))}</span>
          <div class="tr-replay-actions">
            <button class="transcript-order-toggle" id="transcriptOrderBtn" type="button"
              title="Toggle transcript line order — newest-first or oldest-first (remembered across sessions)"
              aria-pressed="${newestFirst ? 'true' : 'false'}">${newestFirst ? 'newest first ▲' : 'oldest first ▼'}</button>
            <button class="transcript-copy" id="transcriptCopyBtn">Copy to clipboard</button>
          </div>
        </div>
        <pre class="transcript-replay-content">${escapeHtml(displayContent)}</pre>
      `;
      const orderBtn = document.getElementById('transcriptOrderBtn');
      if (orderBtn) {
        orderBtn.addEventListener('click', () => {
          transcriptState.newestFirst = !transcriptState.newestFirst;
          saveTranscriptNewestFirst(transcriptState.newestFirst);
          // Re-render the same replay payload in the new order (persisted flag).
          renderTranscriptReplay(transcriptState.replayData || data);
        });
      }
      document.getElementById('transcriptCopyBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(displayContent).then(() => {
          const btn = document.getElementById('transcriptCopyBtn');
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy to clipboard';
            btn.classList.remove('copied');
          }, 2000);
        }).catch(() => {});
      });
    }

    // ===== Orchestrator Guide right-rail (Sprint 37 T1) =====
    // Lazy-load docs/orchestrator-guide.md on first expand, render with a
    // small purpose-built markdown converter, build TOC from H2 headings,
    // wire search + contextual auto-expand. No external markdown library —
    // the no-build-step ethos rules out webpack/parcel pulls.
    const guideRailState = {
      loaded: false,
      loading: false,
      sections: [],     // [{id, title, el, text}]
      activeSection: null,
    };

    function setupGuideRail() {
      const rail = document.getElementById('guideRail');
      const toggle = document.getElementById('guideRailToggle');
      const closeBtn = document.getElementById('guideRailClose');
      const search = document.getElementById('guideSearch');
      if (!rail || !toggle) return;

      toggle.addEventListener('click', () => toggleGuideRail());
      if (closeBtn) closeBtn.addEventListener('click', () => setGuideRailCollapsed(true));
      if (search) search.addEventListener('input', () => filterGuideSections(search.value));

      // Keyboard: 'g' opens/closes the Guide when not in an input. Skip when
      // a modifier is held to avoid stomping browser shortcuts.
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key !== 'g' && e.key !== 'G') return;
        const tgt = e.target;
        const tag = (tgt && tgt.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return;
        // xterm.js attaches a hidden textarea inside .term-panel; skip when
        // the focus is inside a terminal panel.
        if (tgt && typeof tgt.closest === 'function' && tgt.closest('.term-panel')) return;
        e.preventDefault();
        toggleGuideRail();
      });

      // Contextual auto-expand on terminal focus. Reuses the existing
      // focusSessionById path: when a panel is focused, scroll the right-rail
      // to the "4+1 pattern" section so its content is one glance away.
      document.addEventListener('click', (e) => {
        if (rail.dataset.collapsed === 'true') return;
        const panel = e.target && typeof e.target.closest === 'function' && e.target.closest('.term-panel');
        if (panel) scrollGuideToSection('the-4-1-pattern');
      }, true);
    }

    function toggleGuideRail() {
      const rail = document.getElementById('guideRail');
      if (!rail) return;
      const collapsed = rail.dataset.collapsed !== 'false';
      setGuideRailCollapsed(!collapsed);
    }

    function setGuideRailCollapsed(collapsed) {
      const rail = document.getElementById('guideRail');
      const toggle = document.getElementById('guideRailToggle');
      if (!rail) return;
      rail.dataset.collapsed = collapsed ? 'true' : 'false';
      if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      if (!collapsed && !guideRailState.loaded && !guideRailState.loading) {
        loadGuideDoc();
      }
    }

    async function loadGuideDoc() {
      const content = document.getElementById('guideContent');
      const toc = document.getElementById('guideToc');
      if (!content) return;
      guideRailState.loading = true;
      try {
        const res = await fetch('/docs/orchestrator-guide.md');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const md = await res.text();
        const html = renderGuideMarkdown(md);
        content.innerHTML = html;
        wrapGuideSections(content);
        if (toc) toc.innerHTML = buildGuideToc(content);
        bindGuideTocClicks(toc);
        observeGuideScroll(content);
        guideRailState.loaded = true;
      } catch (err) {
        content.innerHTML = '<div class="guide-loading">Couldn\'t load Guide: ' + escapeHtml(String(err && err.message || err)) + '</div>';
      } finally {
        guideRailState.loading = false;
      }
    }

    // Wrap each H2 + its trailing siblings (until next H2) in a <section>
    // element, so search/filtering can hide/show whole sections at once.
    function wrapGuideSections(root) {
      const nodes = Array.from(root.children);
      const sections = [];
      let current = null;
      for (const node of nodes) {
        if (node.tagName === 'H2') {
          if (current) sections.push(current);
          current = { heading: node, els: [node] };
        } else if (current) {
          current.els.push(node);
        }
      }
      if (current) sections.push(current);

      // Replace flat children with <section> wrappers
      guideRailState.sections = [];
      for (const sec of sections) {
        const wrapper = document.createElement('section');
        wrapper.className = 'guide-section';
        const slug = (sec.heading.id) || slugify(sec.heading.textContent);
        wrapper.id = 'guide-sec-' + slug;
        sec.heading.id = slug; // anchor for TOC links
        sec.heading.parentNode.insertBefore(wrapper, sec.heading);
        for (const el of sec.els) wrapper.appendChild(el);
        guideRailState.sections.push({
          id: slug,
          title: sec.heading.textContent,
          el: wrapper,
          text: wrapper.textContent.toLowerCase(),
        });
      }
    }

    function buildGuideToc(root) {
      const headings = root.querySelectorAll('section.guide-section > h2');
      const links = [];
      headings.forEach(h => {
        links.push('<a href="#' + escapeAttr(h.id) + '" data-section="' + escapeAttr(h.id) + '">' + escapeHtml(h.textContent) + '</a>');
      });
      return links.join('');
    }

    function bindGuideTocClicks(toc) {
      if (!toc) return;
      toc.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[data-section]');
        if (!a) return;
        e.preventDefault();
        scrollGuideToSection(a.dataset.section);
      });
    }

    function scrollGuideToSection(sectionId) {
      const content = document.getElementById('guideContent');
      if (!content) return;
      const target = document.getElementById(sectionId);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const containerRect = content.getBoundingClientRect();
      content.scrollTop += (rect.top - containerRect.top) - 8;
      markActiveSection(sectionId);
    }

    function markActiveSection(sectionId) {
      const toc = document.getElementById('guideToc');
      if (!toc) return;
      toc.querySelectorAll('a[data-section]').forEach(a => {
        a.classList.toggle('active', a.dataset.section === sectionId);
      });
      guideRailState.activeSection = sectionId;
    }

    function observeGuideScroll(content) {
      // Lightweight scroll-spy — on every scroll, find the topmost visible
      // H2 and mark its TOC entry active.
      let raf = 0;
      content.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const rect = content.getBoundingClientRect();
          const headings = content.querySelectorAll('section.guide-section > h2');
          let topId = null;
          for (const h of headings) {
            const hRect = h.getBoundingClientRect();
            if (hRect.top - rect.top <= 24) topId = h.id;
            else break;
          }
          if (topId) markActiveSection(topId);
        });
      });
    }

    function filterGuideSections(query) {
      const content = document.getElementById('guideContent');
      const toc = document.getElementById('guideToc');
      if (!content) return;
      const q = (query || '').trim().toLowerCase();
      content.classList.toggle('has-filter', !!q);
      let anyMatch = false;
      const matchedIds = new Set();
      for (const sec of guideRailState.sections) {
        const match = !q || sec.text.includes(q) || sec.title.toLowerCase().includes(q);
        sec.el.classList.toggle('hidden', !match);
        if (match) { anyMatch = true; matchedIds.add(sec.id); }
      }
      // Sync TOC visibility with section matches
      if (toc) {
        toc.querySelectorAll('a[data-section]').forEach(a => {
          const id = a.dataset.section;
          a.classList.toggle('hidden', !!q && !matchedIds.has(id));
        });
      }
      // Show "no matches" hint if needed
      let hint = content.querySelector('em.no-match');
      if (q && !anyMatch) {
        if (!hint) {
          hint = document.createElement('em');
          hint.className = 'no-match';
          content.appendChild(hint);
        }
        hint.textContent = 'No Guide section matches "' + query + '".';
      } else if (hint) {
        hint.remove();
      }
    }

    function slugify(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    }

    // Tiny markdown converter — handles only what orchestrator-guide.md uses:
    // ATX headings, paragraphs, blockquotes, fenced code, bullet/numbered
    // lists, hr, tables (header + separator), bold, italic, inline code,
    // links. Resilient enough for our authored Guide; not a general renderer.
    function renderGuideMarkdown(md) {
      const lines = md.replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // Fenced code block
        if (/^```/.test(line)) {
          const lang = line.replace(/^```/, '').trim();
          const buf = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
          i++; // skip closing fence
          out.push('<pre><code' + (lang ? ' class="lang-' + escapeAttr(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
          continue;
        }
        // Horizontal rule
        if (/^---\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
        // ATX headings
        const h = line.match(/^(#{1,6})\s+(.+)$/);
        if (h) {
          const level = h[1].length;
          out.push('<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>');
          i++;
          continue;
        }
        // Blockquote (collect consecutive > lines)
        if (/^>\s?/.test(line)) {
          const buf = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^>\s?/, ''));
            i++;
          }
          out.push('<blockquote>' + renderInline(buf.join(' ')) + '</blockquote>');
          continue;
        }
        // Table: header line then separator line then body until blank
        if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/.test(lines[i + 1])) {
          const header = splitTableRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
            rows.push(splitTableRow(lines[i]));
            i++;
          }
          let html = '<table><thead><tr>';
          for (const cell of header) html += '<th>' + renderInline(cell) + '</th>';
          html += '</tr></thead><tbody>';
          for (const row of rows) {
            html += '<tr>';
            for (const cell of row) html += '<td>' + renderInline(cell) + '</td>';
            html += '</tr>';
          }
          html += '</tbody></table>';
          out.push(html);
          continue;
        }
        // Bullet list
        if (/^\s*[-*]\s+/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*[-*]\s+/, ''));
            i++;
          }
          out.push('<ul>' + buf.map(x => '<li>' + renderInline(x) + '</li>').join('') + '</ul>');
          continue;
        }
        // Numbered list
        if (/^\s*\d+\.\s+/.test(line)) {
          const buf = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
            i++;
          }
          out.push('<ol>' + buf.map(x => '<li>' + renderInline(x) + '</li>').join('') + '</ol>');
          continue;
        }
        // Blank line
        if (line.trim() === '') { i++; continue; }
        // Paragraph (collect consecutive non-special lines)
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' &&
               !/^(#{1,6}\s|>\s?|```|---\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
               !(/\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?/.test(lines[i + 1]))) {
          buf.push(lines[i]);
          i++;
        }
        out.push('<p>' + renderInline(buf.join(' ')) + '</p>');
      }
      return out.join('\n');
    }

    function splitTableRow(line) {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(c => c.trim());
    }

    // Inline markdown: code, bold, italic, links. Run on already-escaped HTML
    // so we don't expose injection paths via the source markdown — the Guide
    // is repo-controlled, but defense-in-depth is cheap.
    function renderInline(text) {
      let s = escapeHtml(text);
      // Inline code first (so its contents aren't re-processed for bold/italic)
      s = s.replace(/`([^`]+)`/g, (_, code) => '<code>' + code + '</code>');
      // Links [text](url)
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
        return '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + label + '</a>';
      });
      // Bold **text**
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Italic *text* (avoid matching bold leftovers)
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      return s;
    }

    // Boot
    init();
