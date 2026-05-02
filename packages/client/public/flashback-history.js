// flashback-history.js — Sprint 43 T2 audit dashboard.
//
// Renders the durable flashback_events table (SQLite-backed) plus the
// click-through funnel aggregate. Reads from GET /api/flashback/history.
// Filter: time-window selector (1d / 7d / 30d / all). One round-trip per
// view; the server returns events + funnel in one response.
//
// Zero-state handling is intentional and prominent: an empty table after
// 7+ days of normal use IS the diagnostic signal Joshua needs (he's been
// flashback-blind in past sprints; "0 fires" tells him to investigate the
// PTY → analyzer → bridge → emit pipeline, not silently degrade).
//
// Vanilla JS, no framework — matches the rest of public/.

(() => {
const API = window.location.origin;
const PAGE_SIZE = 25;

let _allEvents = [];
let _currentPage = 1;

const els = {    windowSel: document.getElementById('fbWindow'),
    refreshBtn: document.getElementById('fbRefresh'),
    errorBanner: document.getElementById('fbErrorBanner'),
    content: document.getElementById('fbContent'),
    barFires: document.getElementById('fbBarFires'),
    barDismissed: document.getElementById('fbBarDismissed'),
    barClicked: document.getElementById('fbBarClicked'),
    countFires: document.getElementById('fbCountFires'),
    countDismissed: document.getElementById('fbCountDismissed'),
    countClicked: document.getElementById('fbCountClicked'),
    pctDismissed: document.getElementById('fbPctDismissed'),
    pctClicked: document.getElementById('fbPctClicked'),
  };

  // URL state: ?window=7d persists across reload.
  function loadStateFromUrl() {
    const qs = new URLSearchParams(window.location.search);
    const win = qs.get('window');
    if (win && ['1d', '7d', '30d', 'all'].includes(win)) {
      els.windowSel.value = win;
    }
  }
  function writeStateToUrl() {
    const qs = new URLSearchParams(window.location.search);
    qs.set('window', els.windowSel.value);
    const next = `${window.location.pathname}?${qs.toString()}`;
    window.history.replaceState(null, '', next);
  }

  // Compute ISO timestamp for the "since" filter from the window selector.
  // Returns null for "all time" (no filter).
  function sinceFromWindow(key) {
    const now = Date.now();
    const ms = {
      '1d': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }[key];
    if (!ms) return null;
    return new Date(now - ms).toISOString();
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diffMs = now - d.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 7) return `${diffDay}d ago`;
      // Older than a week: show the date.
      return d.toISOString().slice(0, 10);
    } catch {
      return iso;
    }
  }

  function fmtScore(score) {
    if (score == null || !Number.isFinite(score)) return '—';
    return `${(score * 100).toFixed(0)}%`;
  }

  function renderFunnel(funnel) {
    const fires = Number(funnel?.fires || 0);
    const dismissed = Number(funnel?.dismissed || 0);
    const clicked = Number(funnel?.clicked_through || 0);

    els.countFires.textContent = String(fires);
    els.countDismissed.textContent = String(dismissed);
    els.countClicked.textContent = String(clicked);

    // Bar widths: fires is always 100% (the cohort baseline); dismissed and
    // clicked are proportions of fires. Ratio out of fires (not out of
    // dismissed) keeps the funnel-shape visual intuitive.
    els.barFires.style.width = fires > 0 ? '100%' : '0%';
    if (fires > 0) {
      els.barDismissed.style.width = `${(dismissed / fires) * 100}%`;
      els.barClicked.style.width = `${(clicked / fires) * 100}%`;
      els.pctDismissed.textContent = ` · ${Math.round((dismissed / fires) * 100)}%`;
      els.pctClicked.textContent = ` · ${Math.round((clicked / fires) * 100)}%`;
    } else {
      els.barDismissed.style.width = '0%';
      els.barClicked.style.width = '0%';
      els.pctDismissed.textContent = '';
      els.pctClicked.textContent = '';
    }
  }

  function renderZeroState(windowKey) {
    const windowLabel = {
      '1d': 'the last 24 hours',
      '7d': 'the last 7 days',
      '30d': 'the last 30 days',
      'all': 'recorded history',
    }[windowKey] || 'the selected window';

    els.content.innerHTML = `
      <div class="fb-zero">
        <h3>0 fires in ${escapeHtml(windowLabel)}</h3>
        <p>Flashback might not be firing at all — or the underlying RAG isn't returning hits. Investigate the pipeline:</p>
        <p>
          <code>GET /api/flashback/diag?eventType=pattern_match</code> —
          are PTY errors being detected?
        </p>
        <p>
          <code>GET /api/flashback/diag?eventType=bridge_query</code> —
          are queries reaching Mnestra?
        </p>
        <p>
          <code>GET /api/flashback/diag?eventType=proactive_memory_emit</code> —
          are emits being attempted, and what's the outcome?
        </p>
        <p>
          A populated <code>diag</code> ring with no <code>flashback_events</code>
          rows means the WS send is failing or the toast is being dropped on
          the client side. An empty <code>diag</code> ring means the
          analyzer never even matched.
        </p>
      </div>
    `;
  }

  function renderTable(events, page = 1) {
    const totalPages = Math.ceil(events.length / PAGE_SIZE) || 1;
    const start = (page - 1) * PAGE_SIZE;
    const slice = events.slice(start, start + PAGE_SIZE);

    const rows = slice.map((e) => {
      const projectCell = e.project
        ? `<span class="fb-cell-project">${escapeHtml(e.project)}</span>`
        : `<span class="fb-cell-project" style="color:var(--tg-text-dim)">—</span>`;

      const statusPills = [];
      if (e.clicked_through) {
        statusPills.push(`<span class="fb-pill fb-pill-clicked">clicked</span>`);
      } else if (e.dismissed_at) {
        statusPills.push(`<span class="fb-pill fb-pill-dismissed">dismissed</span>`);
      } else {
        statusPills.push(`<span class="fb-pill fb-pill-pending">pending</span>`);
      }

      const errorPreview = (e.error_text || '').slice(0, 200);

      return `
        <tr>
          <td class="fb-cell-time" title="${escapeHtml(e.fired_at || '')}">${escapeHtml(fmtTime(e.fired_at))}</td>
          <td>${projectCell}</td>
          <td class="fb-cell-error" title="${escapeHtml(e.error_text || '')}">${escapeHtml(errorPreview)}</td>
          <td class="fb-cell-hits">${escapeHtml(String(e.hits_count ?? 0))}</td>
          <td class="fb-cell-score">${escapeHtml(fmtScore(e.top_hit_score))}</td>
          <td class="fb-cell-status">${statusPills.join('')}</td>
        </tr>
      `;
    }).join('');

    let html = `
      <div class="fb-table-wrap">
        <table class="fb-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Project</th>
              <th>Search context</th>
              <th style="text-align:right">Hits</th>
              <th style="text-align:right">Score</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    if (events.length > PAGE_SIZE) {
      html += `
        <div class="fb-pagination">
          <button type="button" class="fb-pag-btn" id="fbPrev" ${page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
          <span class="fb-pag-info">Page ${page} of ${totalPages}</span>
          <button type="button" class="fb-pag-btn" id="fbNext" ${page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
        </div>
      `;
    }

    els.content.innerHTML = html;

    // Wire pagination buttons
    const prevBtn = document.getElementById('fbPrev');
    const nextBtn = document.getElementById('fbNext');
    if (prevBtn) {
      prevBtn.onclick = () => {
        _currentPage--;
        localStorage.setItem('fbHistoryPage', String(_currentPage));
        renderTable(_allEvents, _currentPage);
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        _currentPage++;
        localStorage.setItem('fbHistoryPage', String(_currentPage));
        renderTable(_allEvents, _currentPage);
      };
    }
  }

  function showError(msg) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = msg;
  }
  function clearError() {
    els.errorBanner.hidden = true;
    els.errorBanner.textContent = '';
  }

  async function refresh(resetPage = true) {
    clearError();
    els.content.innerHTML = `<div class="fb-loading">Loading flashback history…</div>`;

    const winKey = els.windowSel.value || '7d';
    const since = sinceFromWindow(winKey);
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    qs.set('limit', '500'); // Sprint 49: raised from 200 for better pagination scale

    let data;
    try {
      const res = await fetch(`${API}/api/flashback/history?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      data = await res.json();
    } catch (err) {
      showError(`Failed to load flashback history: ${err.message}`);
      els.content.innerHTML = '';
      renderFunnel({ fires: 0, dismissed: 0, clicked_through: 0 });
      return;
    }

    _allEvents = data.events || [];
    renderFunnel(data.funnel || { fires: 0, dismissed: 0, clicked_through: 0 });

    if (_allEvents.length === 0) {
      renderZeroState(winKey);
      return;
    }

    if (resetPage) {
      _currentPage = 1;
      localStorage.setItem('fbHistoryPage', '1');
    } else {
      _currentPage = parseInt(localStorage.getItem('fbHistoryPage') || '1', 10);
      const maxPage = Math.ceil(_allEvents.length / PAGE_SIZE) || 1;
      if (_currentPage > maxPage) _currentPage = 1;
    }

    renderTable(_allEvents, _currentPage);
  }

  // Wire controls
  els.windowSel.addEventListener('change', () => {
    writeStateToUrl();
    refresh(true);
  });
  els.refreshBtn.addEventListener('click', () => refresh(true));

  // Boot
  loadStateFromUrl();
  refresh(false);
})();
