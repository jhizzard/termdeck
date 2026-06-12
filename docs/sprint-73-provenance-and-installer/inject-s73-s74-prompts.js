#!/usr/bin/env node
// Sprint 73+74 double-deck inject — two-stage submit pattern (paste-all, settle, submit-all).
// Staged 2026-06-10 by ORCH (session 4b85a761). Run when 8 panels are open:
//   Deck A (Sprint 73): 4 panels cwd=termdeck repo — T1,T2,T3 Claude + T4 Codex (open T4 LAST in its group)
//   Deck B (Sprint 74): 4 panels cwd=~/Documents/Graciella/engram — T1,T2,T3 Claude + T4 Grok (open T4 LAST)
// Mapping is by cwd group, then meta.createdAt order within the group → T1..T4.
//   node /tmp/inject-s73-s74-prompts.js            # live
//   node /tmp/inject-s73-s74-prompts.js --dry-run  # print mapping + prompts, send nothing

const BASE = process.env.TERMDECK_API_BASE || 'http://127.0.0.1:3000';
const TERMDECK_REPO = '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck';
const S73 = `${TERMDECK_REPO}/docs/sprint-73-provenance-and-installer`;
const S74 = `${TERMDECK_REPO}/docs/sprint-74-mnestra-provenance-and-db-integrity`;
const DRY = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootPrompt({ sprint, name, lane, brief, planning, status, recall1, recall2, extra }) {
  return `You are ${lane} in Sprint ${sprint} (${name}). Boot sequence:
1. memory_recall(project="termdeck", query="${recall1}")  [skip if memory tools unavailable]
2. memory_recall(query="${recall2}")  [skip if unavailable]
3. Read ~/.claude/CLAUDE.md and ./CLAUDE.md (if present)
4. Read ${planning}
5. Read ${status}
6. Read ${brief} (your full briefing)
${extra ? '\n' + extra + '\n' : ''}
Then begin. Stay in your lane. Post \`### [${lane}] FINDING / FIX-PROPOSED / FIX-LANDED / DONE 2026-MM-DD HH:MM ET — <gist>\` in the STATUS.md above. Don't bump versions, don't touch CHANGELOG, don't commit.`;
}

const DECK_A = [
  bootPrompt({ sprint: 73, name: 'Provenance + Installer', lane: 'T1', brief: `${S73}/T1-grok-web-provenance.md`, planning: `${S73}/PLANNING.md`, status: `${S73}/STATUS.md`,
    recall1: 'grok-web provenance source_agent bundled hooks byte floor Sprint 70',
    recall2: 'installer pitfalls bundled hooks release sensitive',
    extra: 'Pre-sprint intel: ALLOWED_SOURCE_AGENTS is at packages/stack-installer/assets/hooks/memory-session-end.js:656; the antigravity byte-floor exemption precedent at :828-834; the adapter.sourceAgent pattern at packages/server/src/index.js:324-330. Your atomic partner is Sprint 74 T1 (mnestra enum) — coordinate via their STATUS.md, never edit engram.' }),
  bootPrompt({ sprint: 73, name: 'Provenance + Installer', lane: 'T2', brief: `${S73}/T2-init-bridge-wizard.md`, planning: `${S73}/PLANNING.md`, status: `${S73}/STATUS.md`,
    recall1: 'Tier 5 bridge named tunnel supervisor install PR 23',
    recall2: 'installer wizard init-mnestra idioms pitfalls',
    extra: 'Pre-sprint intel: the manual flow you are automating shipped today in PR #23 (docs/GETTING-STARTED.md Tier 5). The supervisor contract is scripts/termdeck-supervise.sh header. Never exec launchctl/systemctl/cloudflared-login from the wizard — print operator steps.' }),
  bootPrompt({ sprint: 73, name: 'Provenance + Installer', lane: 'T3', brief: `${S73}/T3-input-accumulation-audit.md`, planning: `${S73}/PLANNING.md`, status: `${S73}/STATUS.md`,
    recall1: 'input accumulation xterm issue 12 v1.6.1 focus mode hotfix',
    recall2: 'body-parser input route hardening Sprint 63',
    extra: 'Pre-sprint intel: termdeck#12 is OPEN; the focus-mode half was fixed in v1.6.1 — your target is the input-box-accumulates-buffer-per-keystroke half. Audit before fixing; it may already be fixed on main (then the deliverable is the evidence chain + regression test).' }),
  bootPrompt({ sprint: 73, name: 'Provenance + Installer', lane: 'T4-CODEX', brief: `${S73}/T4-codex-auditor.md`, planning: `${S73}/PLANNING.md`, status: `${S73}/STATUS.md`,
    recall1: 'Sprint 73 audit grok-web provenance installer wizard',
    recall2: '3+1+1 auditor checkpoint discipline adversarial',
    extra: 'You are the ADVERSARIAL auditor. Audit in flight, reproduce independently, post CHECKPOINT every phase boundary / 15 min. Your companion deck Sprint 74 STATUS is at ' + S74 + '/STATUS.md (read it for the T1 atomicity cross-check).' }),
];

const DECK_B = [
  bootPrompt({ sprint: 74, name: 'Mnestra Provenance + DB Integrity', lane: 'T1', brief: `${S74}/T1-grok-web-enum.md`, planning: `${S74}/PLANNING.md`, status: `${S74}/STATUS.md`,
    recall1: 'source_agent enum migration 015 022 recall filter',
    recall2: 'Supabase RLS hygiene gates migration function search_path',
    extra: 'Work repo: ~/Documents/Graciella/engram (you are already there). Next migration slot: 024. Your atomic partner is Sprint 73 T1 (termdeck hooks) — coordinate via their STATUS.md at ' + S73 + '/STATUS.md, never edit the termdeck repo. ORCH SCOPE-EXPANSION (2026-06-11, binding — full text at the end of your brief): the enum migration adds ALL FOUR web-surface values (claude-web, chatgpt-web, grok-web, gemini-web) in ONE migration; only grok-web has a live producer today, the other three are forward-declarations for the queued memory-inbox sprint.' }),
  bootPrompt({ sprint: 74, name: 'Mnestra Provenance + DB Integrity', lane: 'T2', brief: `${S74}/T2-ipv4-pooler-audit.md`, planning: `${S74}/PLANNING.md`, status: `${S74}/STATUS.md`,
    recall1: 'IPv4 pooler PoolTimeout direct endpoint Brad R730',
    recall2: 'Supabase connect modal IPv6 dedicated pooler gotcha',
    extra: 'Work repo: ~/Documents/Graciella/engram. Brad field report: db.<ref>.supabase.co is IPv6-only; IPv4-only hosts need aws-1-<region>.pooler.supabase.com with user postgres.<ref>. Inventory EVERY endpoint-resolution site before fixing. Use <project-ref> placeholders only.' }),
  bootPrompt({ sprint: 74, name: 'Mnestra Provenance + DB Integrity', lane: 'T3', brief: `${S74}/T3-flush-before-recall.md`, planning: `${S74}/PLANNING.md`, status: `${S74}/STATUS.md`,
    recall1: 'webhook serve embedding write path recall staleness',
    recall2: 'bridge memory tools MNESTRA_WEBHOOK_URL recall path',
    extra: 'Work repo: ~/Documents/Graciella/engram. The question (Brad, gates his cutover): is auto-captured memory recallable IMMEDIATELY via the bridge, or a sync-cycle behind? Trace write path + read path, then prove the verdict with a test. Note Rumen 15-min insights are by-design lag — separate that in your answer.' }),
  bootPrompt({ sprint: 74, name: 'Mnestra Provenance + DB Integrity', lane: 'T4-GROK', brief: `${S74}/T4-grok-auditor.md`, planning: `${S74}/PLANNING.md`, status: `${S74}/STATUS.md`,
    recall1: 'Sprint 74 audit enum pooler flush recall',
    recall2: '3+1+1 auditor checkpoint discipline adversarial',
    extra: 'You are the ADVERSARIAL auditor for Deck B. Reproduce findings independently (run your own greps FIRST), audit fixes in flight, post CHECKPOINT every phase boundary / 15 min. T3 flush-before-recall is the highest-stakes verdict — re-trace it yourself.' }),
];

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function post(id, text) {
  return api(`/api/sessions/${id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, source: 'orchestrator' }),
  });
}

(async () => {
  const sessions = await api('/api/sessions');
  const byCreated = (a, b) => new Date(a.meta?.createdAt || 0) - new Date(b.meta?.createdAt || 0);
  const cwdOf = (s) => s.meta?.cwd || s.cwd || '';
  const deckA = sessions.filter((s) => cwdOf(s).includes('TermDeck/termdeck')).sort(byCreated);
  const deckB = sessions.filter((s) => cwdOf(s).includes('engram')).sort(byCreated);

  if (deckA.length !== 4 || deckB.length !== 4) {
    console.error(`PANEL COUNT MISMATCH: deckA(termdeck)=${deckA.length} deckB(engram)=${deckB.length} — need 4+4.`);
    console.error('All sessions:', sessions.map((s) => ({ id: s.id, cwd: cwdOf(s), createdAt: s.meta?.createdAt })));
    process.exit(1);
  }

  const plan = [
    ...deckA.map((s, i) => ({ id: s.id, label: `S73-${['T1','T2','T3','T4-CODEX'][i]}`, prompt: DECK_A[i] })),
    ...deckB.map((s, i) => ({ id: s.id, label: `S74-${['T1','T2','T3','T4-GROK'][i]}`, prompt: DECK_B[i] })),
  ];
  console.log('Mapping:'); plan.forEach((p) => console.log(`  ${p.label} -> ${p.id}`));
  if (DRY) { console.log('\n--dry-run: prompts not sent. First prompt preview:\n' + plan[0].prompt); process.exit(0); }

  // Stage 1 — paste bodies (bracketed paste, NO trailing \r), 250ms gaps.
  for (const p of plan) {
    const r = await post(p.id, `\x1b[200~${p.prompt}\x1b[201~`);
    console.log(`paste ${p.label}: ${JSON.stringify(r)}`);
    await sleep(250);
  }
  await sleep(400); // settle — let PTYs flush pastes to the input handlers
  // Stage 2 — submit (\r alone as its own PTY write), 250ms gaps.
  for (const p of plan) {
    const r = await post(p.id, '\r');
    console.log(`submit ${p.label}: ${JSON.stringify(r)}`);
    await sleep(250);
  }
  console.log('\nAll injected. Verify in ~8s: GET /api/sessions/:id/buffer -> status "thinking" + fresh lastActivity.');
  console.log('Any panel still idle: POST /api/sessions/:id/poke {"methods":["cr-flood"]}');
})().catch((e) => { console.error(e); process.exit(1); });
