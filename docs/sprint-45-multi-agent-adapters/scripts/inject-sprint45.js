#!/usr/bin/env node
/**
 * Sprint 45 four-lane inject — two-stage submit pattern.
 *
 * Stage 1: POST bracketed-paste payload (\x1b[200~ ... \x1b[201~) to each
 *          of T1/T2/T3/T4 with ~250ms gaps. NO trailing \r.
 * Stage 2: Sleep 400ms, then POST \r alone to each panel with ~250ms gaps.
 */

const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const SESSIONS = process.env.SPRINT45_SESSION_IDS
  ? process.env.SPRINT45_SESSION_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!SESSIONS || SESSIONS.length !== 4) {
  console.error('ERROR: must set SPRINT45_SESSION_IDS env var with 4 comma-separated UUIDs');
  process.exit(1);
}

const LANES = [
  { tag: 'T1', file: 'T1-codex-adapter.md',                    project: 'termdeck', topic: 'Codex adapter implementation packages/server/src/agent-adapters/codex.js OPENAI_API_KEY transcript parser ~/.codex/sessions snapshot tests' },
  { tag: 'T2', file: 'T2-gemini-adapter.md',                   project: 'termdeck', topic: 'Gemini adapter implementation lift PATTERNS.gemini from session.js GEMINI_API_KEY transcript parser ~/.gemini/sessions snapshot tests' },
  { tag: 'T3', file: 'T3-grok-adapter.md',                     project: 'termdeck', topic: 'Grok adapter implementation TUI mode SuperGrok Heavy chooseModel taskHint grok-models.js 11-tier model map sub-agents vision' },
  { tag: 'T4', file: 'T4-launcher-refactor-and-shim-removal.md', project: 'termdeck', topic: 'launcher refactor app.js memory hook adapter-pluggable PATTERNS shim removal cross-adapter parity test suite' },
];

function buildPrompt({ tag, file, project, topic }) {
  return `You are ${tag} in TermDeck Sprint 45 (multi-agent adapter implementations: Codex + Gemini + Grok + launcher refactor). Joshua may be orchestrating from his phone via Telegram (the orchestrator session runs with the @JoshTermDeckBot listener active via claude-tg).

Boot sequence:

1. Run \`date\` to time-stamp.
2. memory_recall(project="${project}", query="${topic}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md (multi-agent design rationale + adapter contract)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md (Grok session-context findings + model-selection heuristic — REQUIRED READING especially for T3)
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md (canonical reference, Sprint 44 T4 deliverable — § 6 has a worked example for adding an adapter)
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/PLANNING.md
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/STATUS.md
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/${file} (your full briefing — authoritative)
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/agent-adapters/claude.js (the reference adapter from Sprint 44 T3 — implementation pattern to follow)

Pre-sprint substrate (orchestrator probed at sprint kickoff):
- TermDeck server alive on :3000 with v0.13.0 source running (Sprint 42 T2 PTY reaper + Sprint 43 T2 flashback persistence + Sprint 44 T3 adapter registry)
- All four CLI binaries on PATH: claude, codex, gemini, grok (verified Sprint 44 close)
- API keys loaded: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (if set), GROK_API_KEY (verified 2026-05-01)
- rumen-tick cron */15 * * * * active=true; graph-inference-tick 0 3 * * * active=true (per Sprint 43/44 close)
- Telegram channel live (@JoshTermDeckBot, allowlist policy, paired user 6943410589)
- Sprint 44 baselines: termdeck@0.13.0, mnestra@0.3.3, termdeck-stack@0.4.8, rumen@0.4.4 (all live on npm)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md (append-only, with timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out + side-tasks (DNS-resilience fix, Rumen-tick stale-job investigation, INSTALL-FOR-COLLABORATORS.md refresh).`;
}

function postInput(sessionId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, source: 'sprint-45-inject' });
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/sessions/${sessionId}/input`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: out });
        else reject(new Error(`HTTP ${res.statusCode}: ${out}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postPoke(sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ methods: ['cr-flood'] });
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: 3000,
      path: `/api/sessions/${sessionId}/poke`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getBuffer(sessionId) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}/api/sessions/${sessionId}/buffer`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log(`[inject] Sprint 45 — ${SESSIONS.length} sessions, two-stage submit, started ${new Date().toISOString()}\n`);

  console.log('[stage 1] paste payloads (no submit)\n');
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    const prompt = buildPrompt(lane);
    const payload = `\x1b[200~${prompt}\x1b[201~`;
    try {
      const r = await postInput(sid, payload);
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) paste: ${r.statusCode} ${r.body}`);
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) PASTE FAILED: ${e.message}`);
    }
    if (i < 3) await sleep(250);
  }

  console.log('\n[settle] sleeping 400ms before submit-stage\n');
  await sleep(400);

  console.log('[stage 2] submit \\r alone\n');
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    try {
      const r = await postInput(sid, '\r');
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) submit: ${r.statusCode} ${r.body}`);
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) SUBMIT FAILED: ${e.message}`);
    }
    if (i < 3) await sleep(250);
  }

  console.log('\n[verify] sleeping 8s then checking each panel status\n');
  await sleep(8000);
  let stuck = [];
  for (let i = 0; i < 4; i++) {
    const sid = SESSIONS[i];
    const lane = LANES[i];
    try {
      const buf = await getBuffer(sid);
      const status = buf.status || buf.session?.meta?.status || 'unknown';
      const detail = buf.statusDetail || buf.session?.meta?.statusDetail || '';
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}): status=${status} detail="${detail}"`);
      if (status === 'idle' || (status === 'active' && (!detail || detail === 'Idle'))) stuck.push({ sid, lane });
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) BUFFER CHECK FAILED: ${e.message}`);
    }
  }

  if (stuck.length > 0) {
    console.log(`\n[recovery] ${stuck.length} stuck panel(s) — firing /poke cr-flood\n`);
    for (const { sid, lane } of stuck) {
      try {
        const r = await postPoke(sid);
        console.log(`  ${lane.tag} (${sid.slice(0, 8)}) poke: ${r.statusCode} ${r.body.slice(0, 120)}...`);
      } catch (e) {
        console.error(`  ${lane.tag} (${sid.slice(0, 8)}) POKE FAILED: ${e.message}`);
      }
    }
  } else {
    console.log('\n[verify] all four panels reasoning — inject successful');
  }

  console.log(`\n[done] total wall-clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
