#!/usr/bin/env node
/**
 * Sprint 44 four-lane inject — two-stage submit pattern.
 *
 * Stage 1: POST bracketed-paste payload (\x1b[200~ ... \x1b[201~) to each
 *          of T1/T2/T3/T4 with ~250ms gaps. NO trailing \r.
 * Stage 2: Sleep 400ms, then POST \r alone to each panel with ~250ms gaps.
 *
 * Why two-stage: when paste-close \x1b[201~ and trailing \r ride in one PTY
 * write, Claude Code's input parser sometimes eats the \r as the last paste
 * byte rather than a submit keystroke. NEVER ACCEPTABLE — Joshua may be
 * orchestrating from Telegram in bed, no laptop nearby to press Enter.
 *
 * Usage:
 *   SPRINT44_SESSION_IDS=<uuid1>,<uuid2>,<uuid3>,<uuid4> \
 *     node docs/sprint-44-multi-agent-foundation/scripts/inject-sprint44.js
 */

const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const SESSIONS = process.env.SPRINT44_SESSION_IDS
  ? process.env.SPRINT44_SESSION_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!SESSIONS || SESSIONS.length !== 4) {
  console.error('ERROR: must set SPRINT44_SESSION_IDS env var with 4 comma-separated UUIDs');
  console.error('  Discover via: curl -s http://127.0.0.1:3000/api/sessions | jq');
  process.exit(1);
}

const LANES = [
  { tag: 'T1', file: 'T1-grok-install.md',           project: 'termdeck', topic: 'Grok CLI install superagent-ai SuperGrok Heavy grok-4.20-multi-agent 16 sub-agents general explore computer verify XAI_API_KEY ~/.grok user-settings.json' },
  { tag: 'T2', file: 'T2-sync-agent-instructions.md', project: 'termdeck', topic: 'sync-agent-instructions.js script CLAUDE.md AGENTS.md GEMINI.md mirror generation auto-generated banner Codex Grok Gemini' },
  { tag: 'T3', file: 'T3-adapter-registry-claude.md', project: 'termdeck', topic: 'agent adapter registry packages/server/src/agent-adapters Claude adapter migration PATTERNS _detectType _updateStatus snapshot tests session.js' },
  { tag: 'T4', file: 'T4-agent-runtimes-doc.md',     project: 'termdeck', topic: 'AGENT-RUNTIMES.md canonical reference doc adapter contract Codex Gemini Grok how to add a new agent TheHarness alignment cost band' },
];

function buildPrompt({ tag, file, project, topic }) {
  return `You are ${tag} in TermDeck Sprint 44 (multi-agent foundation: Grok install + AGENTS.md sync + adapter registry skeleton + AGENT-RUNTIMES.md doc). Joshua may be orchestrating from his phone via Telegram (the orchestrator session runs with the @JoshTermDeckBot listener active). Orchestrator coordinates from another session.

Boot sequence:

1. Run \`date\` to time-stamp.
2. memory_recall(project="${project}", query="${topic}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md (THE design rationale — adapter contract + cross-CLI conventions + SuperGrok Heavy correction)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/STATUS.md
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/${file} (your full briefing — authoritative)

Pre-sprint substrate (orchestrator probed at sprint kickoff):
- TermDeck server alive on :3000 (post-v0.12.0 source restart with Sprint 43 T2 PTY reaper + flashback persistence migration applied)
- rumen-tick cron active (*/15 * * * *) — 304 rumen_insights in store
- graph-inference-tick cron active (0 3 * * * UTC) — 368 cron-inferred edges
- chopin-nashville: 40 (Sprint 41 acceptance held)
- Telegram channel live (@JoshTermDeckBot, allowlist policy active, paired user ID 6943410589)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md (append-only, with timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out.`;
}

function postInput(sessionId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, source: 'sprint-44-inject' });
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
  console.log(`[inject] Sprint 44 — ${SESSIONS.length} sessions, two-stage submit, started ${new Date().toISOString()}\n`);

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
