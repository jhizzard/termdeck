#!/usr/bin/env node
/**
 * Sprint 47 four-lane inject — two-stage submit pattern with per-lane
 * agent dispatch (Sprint 47 T3 mixed-agent infrastructure).
 *
 * Stage 1: per-lane payload — bracketed-paste OR chunked-stdin fallback,
 *          selected from the adapter registry's `acceptsPaste` field.
 *          Lanes whose adapter accepts paste get one PTY write
 *          (`\x1b[200~ ... \x1b[201~`); chunked lanes get N writes
 *          (line + `\r` per chunk) with a small inter-chunk delay.
 *          ~250ms gap between lanes either way.
 * Stage 2: Sleep 400ms, then POST `\r` alone to each paste-mode panel
 *          with ~250ms gaps. Chunked-mode panels self-submitted on
 *          their last line — skipped to avoid a duplicate empty submit.
 *
 * Sprint 47's own lanes all run on Claude (lane briefs assume Claude),
 * so every payload here is bracketed-paste. The mixed-agent dispatch
 * structure is what Sprint 48+ clones to declare e.g. `agent: 'codex'`
 * on a lane and have the payload shape route correctly.
 *
 * Canonical clone target — copy this file when starting a new sprint.
 */

const http = require('http');
const path = require('path');

// Source-of-truth adapter registry from the server package. Keeps the
// standalone script's dispatch logic in lock-step with the in-server
// `injectSprintPrompts` helper — both consult the same `acceptsPaste`
// boolean per agent.
const { AGENT_ADAPTERS } = require(path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'server',
  'src',
  'agent-adapters',
));

const BASE = 'http://127.0.0.1:3000';
const SESSIONS = process.env.SPRINT47_SESSION_IDS
  ? process.env.SPRINT47_SESSION_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

if (!SESSIONS || SESSIONS.length !== 4) {
  console.error('ERROR: must set SPRINT47_SESSION_IDS env var with 4 comma-separated UUIDs');
  process.exit(1);
}

// LANES: declare per-lane agent assignment. Sprint 47 itself runs all
// lanes on Claude (lane briefs assume Claude); Sprint 48+ may set e.g.
// `agent: 'codex'` to have a Codex CLI panel pick up that lane.
//
// Valid agent names: 'claude' | 'codex' | 'gemini' | 'grok' (must match a
// key in AGENT_ADAPTERS).
const LANES = [
  { tag: 'T1', agent: 'claude', file: 'T1-frontmatter-parser.md',     project: 'termdeck', topic: 'Sprint 47 frontmatter parser PLANNING.md YAML lane agent validation adapter registry getLaneAgent mixed 4+1 infrastructure' },
  { tag: 'T2', agent: 'claude', file: 'T2-boot-prompt-templates.md',  project: 'termdeck', topic: 'Sprint 47 per-agent boot-prompt templates docs/multi-agent-substrate/boot-prompts Mustache placeholders resolveBootPrompt CLAUDE.md AGENTS.md GEMINI.md per-agent memory tool framing' },
  { tag: 'T3', agent: 'claude', file: 'T3-inject-mixed-agent.md',     project: 'termdeck', topic: 'Sprint 47 sprint-inject extension mixed-agent dispatch acceptsPaste adapter contract chunkedFallback bracketed paste two-stage submit' },
  { tag: 'T4', agent: 'claude', file: 'T4-status-merger.md',          project: 'termdeck', topic: 'Sprint 47 cross-agent STATUS merger normalize FINDING FIX-PROPOSED DONE Claude Codex Gemini Grok emoji bullet free-form prose status-merger.js' },
];

function buildPrompt({ tag, file, project, topic }) {
  return `You are ${tag} in TermDeck Sprint 47 (mixed 4+1 infrastructure — per-lane agent assignment so Sprint 48+ can run with mixed Claude / Codex / Gemini / Grok lanes). Joshua may be orchestrating from his phone via Telegram (@JoshTermDeckBot listener active via claude-tg).

Boot sequence:

1. Run \`date\` to time-stamp.
2. memory_recall(project="${project}", query="${topic}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/${file} (your full briefing — authoritative; includes lane-specific extra reads in its Boot section)

Pre-sprint substrate (orchestrator probed at sprint kickoff):
- @jhizzard/termdeck@0.15.0 + @jhizzard/termdeck-stack@0.4.10 live on npm (Sprint 46 close 2026-05-01)
- TermDeck server alive on :3000; /api/agent-adapters returns 4 adapters (claude/codex/gemini/grok)
- All four CLI binaries on PATH: claude, codex, gemini, grok
- rumen-tick + graph-inference-tick crons active

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md (append-only, with timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out + side-tasks (Sprint 46 deferral pickups, INSTALL refresh, mixed-agent smoke test, v1.0.0 decision).`;
}

// Resolve per-lane inject shape from the adapter registry. Mirrors
// `buildPayload` in packages/server/src/sprint-inject.js — keep them in
// sync (the in-server helper is the source of truth for in-dashboard
// inject; this is the same logic for the orchestrator-CLI path).
function buildPayload(prompt, agent) {
  const adapter = agent ? AGENT_ADAPTERS[agent] : null;
  const acceptsPaste = adapter ? adapter.acceptsPaste !== false : true;
  if (acceptsPaste) {
    return { kind: 'paste', bytes: `\x1b[200~${prompt}\x1b[201~` };
  }
  return { kind: 'chunked', lines: prompt.split('\n') };
}

function postInput(sessionId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, source: 'sprint-47-inject' });
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
  console.log(`[inject] Sprint 47 — ${SESSIONS.length} sessions, two-stage submit, started ${new Date().toISOString()}\n`);

  // Pre-resolve per-lane dispatch so the verify pass knows which lanes
  // self-submitted (chunked) vs. need a stage-2 lone CR (paste).
  const dispatched = LANES.map((lane, i) => ({
    sid: SESSIONS[i],
    lane,
    prompt: buildPrompt(lane),
    payload: buildPayload(buildPrompt(lane), lane.agent),
  }));

  console.log('[stage 1] per-lane payload (paste / chunked fallback)\n');
  for (let i = 0; i < dispatched.length; i++) {
    const { sid, lane, payload } = dispatched[i];
    if (payload.kind === 'paste') {
      try {
        const r = await postInput(sid, payload.bytes);
        console.log(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/paste]: ${r.statusCode} ${r.body}`);
      } catch (e) {
        console.error(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/paste] FAILED: ${e.message}`);
      }
    } else {
      // chunked: write each line + \r with a 20ms inter-chunk delay
      let totalChunks = 0;
      for (let j = 0; j < payload.lines.length; j++) {
        try {
          await postInput(sid, payload.lines[j] + '\r');
          totalChunks += 1;
        } catch (e) {
          console.error(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/chunked] line ${j + 1} FAILED: ${e.message}`);
          break;
        }
        if (j < payload.lines.length - 1) await sleep(20);
      }
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/chunked]: ${totalChunks}/${payload.lines.length} chunks`);
    }
    if (i < dispatched.length - 1) await sleep(250);
  }

  console.log('\n[settle] sleeping 400ms before submit-stage\n');
  await sleep(400);

  console.log('[stage 2] submit \\r alone (paste-mode lanes only)\n');
  for (let i = 0; i < dispatched.length; i++) {
    const { sid, lane, payload } = dispatched[i];
    if (payload.kind === 'chunked') {
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/chunked]: skipped (already submitted on last chunk)`);
      if (i < dispatched.length - 1) await sleep(250);
      continue;
    }
    try {
      const r = await postInput(sid, '\r');
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/paste] submit: ${r.statusCode} ${r.body}`);
    } catch (e) {
      console.error(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}/paste] SUBMIT FAILED: ${e.message}`);
    }
    if (i < dispatched.length - 1) await sleep(250);
  }

  console.log('\n[verify] sleeping 8s then checking each panel status\n');
  await sleep(8000);
  let stuck = [];
  for (let i = 0; i < dispatched.length; i++) {
    const { sid, lane } = dispatched[i];
    try {
      const buf = await getBuffer(sid);
      const status = buf.status || buf.session?.meta?.status || 'unknown';
      const detail = buf.statusDetail || buf.session?.meta?.statusDetail || '';
      console.log(`  ${lane.tag} (${sid.slice(0, 8)}) [${lane.agent}]: status=${status} detail="${detail}"`);
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
