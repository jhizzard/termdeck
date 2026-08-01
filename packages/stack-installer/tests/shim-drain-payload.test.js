'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — DRAIN PAYLOAD + THE sessionType TRAP
//
// The drain is the seam where a raw PTY transcript becomes something the
// UNMODIFIED bundled hook can ingest. Two classes of thing can go wrong:
//
//   1. Shape — the stdin JSON the hook receives, and the env handed alongside.
//      Get `source_agent` wrong and every standalone session mis-tags as
//      `claude` (the failure that produced the historical 1,126-row cleanup).
//
//   2. The sessionType trap — `sessionType` MUST be 'auto', NOT the CLI's name.
//      Declaring 'codex'/'grok' selects their JSONL parsers, which return ZERO
//      messages against the envelope the drain writes. It is counter-intuitive
//      enough that a future tidy-up ("surely the codex shim should say codex")
//      is a live risk, and it would fail SILENTLY — a dark cell reporting as
//      covered. T1 asked for an explicit negative test on exactly this
//      (STATUS 2026-08-01 15:37 ET); this file is it.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeWorld, fixture, waitFor, REPO_ROOT, DRAIN_JS } = require('./_shim-harness');

const HOOK = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js',
);
const hook = require(HOOK);
const drain = require(DRAIN_JS);

// ── The sessionType trap ──────────────────────────────────────────────────────

function envelopeFromFixture(name) {
  const messages = drain._cleanAndSegment(fixture(name));
  return { messages: messages.map((m) => ({ type: m.role, content: m.content })) };
}

function writeTmpEnvelope(envelope) {
  const p = path.join(os.tmpdir(), `s68r-env-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(envelope), 'utf8');
  return p;
}

test("sessionType 'auto' parses the drain's envelope; the CLI's own name parses to ZERO", (t) => {
  const envelope = envelopeFromFixture('raw-pty-lf.log');
  assert.ok(envelope.messages.length > 0, 'fixture must produce a non-empty envelope');

  const p = writeTmpEnvelope(envelope);
  t.after(() => { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } });

  const viaAuto = hook.parseAutoDetect(fs.readFileSync(p, 'utf8'));
  assert.ok(
    viaAuto.length > 0,
    "the drain's envelope must parse under 'auto' — this is the shipped path",
  );

  // The trap. These are the values a well-meaning future edit would reach for.
  for (const wrong of ['codex', 'grok']) {
    const parser = hook.TRANSCRIPT_PARSERS[wrong];
    assert.equal(typeof parser, 'function', `hook must expose a '${wrong}' parser to make this test meaningful`);
    assert.equal(
      parser(fs.readFileSync(p, 'utf8')).length, 0,
      `sessionType '${wrong}' parses the drain envelope to ZERO messages — `
      + "the drain must declare 'auto'. Do not 'fix' this to match the CLI name.",
    );
  }
});

test('the drain hard-codes the safe sessionType, not the agent name', () => {
  // Belt-and-suspenders on the test above: assert the shipped source actually
  // says 'auto', so the trap can't be reintroduced without this file going red
  // even if the parser tables change shape.
  const src = fs.readFileSync(DRAIN_JS, 'utf8');
  assert.match(src, /sessionType:\s*'auto'/, "drain must send sessionType 'auto'");
  assert.ok(
    !/sessionType:\s*sourceAgent/.test(src) && !/sessionType:\s*AGENT/.test(src),
    'drain must not derive sessionType from the agent name',
  );
});

test('binary name → canonical source_agent mapping matches what the hook will accept', () => {
  assert.deepEqual(drain.SOURCE_AGENT_BY_BINARY, {
    codex: 'codex', grok: 'grok', agy: 'antigravity',
  });
  // The mapping is only useful if the hook's allow-list agrees; a silent
  // normalisation to 'claude' is the mis-tagging failure this guards.
  for (const canonical of Object.values(drain.SOURCE_AGENT_BY_BINARY)) {
    assert.equal(
      hook.normalizeSourceAgent(canonical), canonical,
      `hook.normalizeSourceAgent must round-trip '${canonical}' rather than folding it to claude`,
    );
  }
});

// ── End-to-end: shim → drain → hook stdin ─────────────────────────────────────

// ⚠ Run the SANDBOX COPY of drain.js, never the repo original.
//
// `resolveHook()`'s last-resort candidate is `<drain dir>/../hooks/
// memory-session-end.js`. Run from the repo, that resolves to the REAL bundled
// hook — so a case meant to exercise "no hook installed" instead executed the
// production hook against the developer's machine. It exited 0 only because the
// sandbox HOME happened to carry no credentials; with a populated HOME it would
// have attempted a live write. The sandbox copy makes the fall-through land
// inside the tmp world, where there is genuinely nothing.
function runDrainDirect(w, { agent = 'codex', transcript, hookPath }) {
  const env = {
    HOME: w.home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TERMDECK_SHIM_AGENT: agent,
    TERMDECK_SHIM_TRANSCRIPT: transcript,
    TERMDECK_SHIM_CWD: '/some/project/dir',
  };
  if (hookPath) env.TERMDECK_SESSION_END_HOOK = hookPath;
  return spawnSync(process.execPath, [path.join(w.shimDir, 'drain.js')], {
    env, encoding: 'utf8', timeout: 30000,
  });
}

test('drain hands the hook a well-formed payload with the right agent and event', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();

  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  const r = runDrainDirect(w, { agent: 'codex', transcript, hookPath });
  assert.equal(r.status, 0, 'the drain must always exit 0 — fail-soft contract');

  assert.ok(waitFor(() => w.hookPayload() !== null), `hook was never invoked; drain said: ${r.stdout}`);
  const got = w.hookPayload();
  const payload = JSON.parse(got.stdin);

  assert.equal(payload.hook_event_name, 'SessionEnd');
  assert.equal(payload.source_agent, 'codex');
  assert.equal(payload.sessionType, 'auto');
  assert.equal(payload.cwd, '/some/project/dir', 'cwd must be the shell cwd, not the drain cwd');
  assert.match(
    payload.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'session_id must be a real UUID',
  );

  // The envelope the payload points at must carry the canary, or the hook would
  // be handed a valid-looking payload over an empty transcript. Read the
  // snapshot the fake hook took while it was still the live consumer — the
  // drain unlinks the envelope the moment the hook closes.
  assert.ok(got.envelope, 'the fake hook must have been able to read transcript_path');
  const envelope = JSON.parse(got.envelope);
  assert.ok(
    envelope.messages.some((m) => m.content.includes('s68r-canary-fixture-2026-08-01')),
    'the envelope handed to the hook must contain the session content',
  );
});

test('agy drains as source_agent=antigravity, not agy and not claude', (t) => {
  const w = makeWorld({ agent: 'agy' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  runDrainDirect(w, { agent: 'agy', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null));

  const payload = JSON.parse(w.hookPayload().stdin);
  assert.equal(payload.source_agent, 'antigravity');
});

test('the byte-floor override is scoped to the hook child and mirrors the payload fields', (t) => {
  const w = makeWorld({ agent: 'grok' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  runDrainDirect(w, { agent: 'grok', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null));

  const { env } = w.hookPayload();
  // A cleaned envelope for a short-but-real session is hundreds of bytes; the
  // hook's 5 KB floor is calibrated for verbose on-disk JSONL and would drop it
  // as a false zero-row. The drain replaces it with a parsed-content gate.
  assert.equal(env.TERMDECK_HOOK_MIN_BYTES, '0');
  assert.equal(env.TERMDECK_SOURCE_AGENT, 'grok');
  assert.equal(env.TERMDECK_SESSION_TYPE, 'auto');

  // ...and it must not have leaked into the caller's environment.
  assert.equal(
    process.env.TERMDECK_HOOK_MIN_BYTES, undefined,
    'the override must never escape the drain child',
  );
});

test('a transcript with no substantive content is skipped, not written as an empty session', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  // Chrome and spinner only — a session where the user opened and closed the CLI.
  fs.writeFileSync(transcript, '\x1b[?1049h────────────\n⣾⣷⣯\n\x1b[?1049l');

  const r = runDrainDirect(w, { agent: 'codex', transcript, hookPath });

  assert.equal(r.status, 0);
  assert.equal(w.hookPayload(), null, 'the hook must not be invoked for a contentless session');
  assert.match(r.stdout, /no-parsed-messages|no-assistant-turn/);
});

test('a missing hook degrades to a logged skip and still exits 0', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  // No hookPath at all: resolveHook() falls through HOME/.claude/hooks (absent
  // in the sandbox) then <drain dir>/../hooks (absent in the sandbox copy).
  const r = runDrainDirect(w, { agent: 'codex', transcript, hookPath: null });

  assert.equal(r.status, 0, 'fail-soft: a missing hook is not a crash');
  assert.match(r.stdout, /no-session-end-hook-found/);
});

test('drain failure cannot change the exit code the user sees from their CLI', (t) => {
  // The whole reason the drain is detached: capture must never influence the
  // real CLI's status. Point the shim at a drain that does not exist and assert
  // a non-zero CLI status still arrives verbatim.
  const w = makeWorld({ agent: 'codex', realExit: 3 });
  t.after(() => w.cleanup());

  const r = w.runPty([], { TERMDECK_SHIM_DRAIN: path.join(w.root, 'no-such-drain.js') });

  assert.equal(r.status, 3, "the real binary's exit status must survive a broken drain");
  assert.deepEqual(w.ranTags(), ['primary']);
});

// ── ORCH RULING 2026-08-01 16:09 ET, T3 queue: durable path + redaction ──────

test('the transcript_path handed to the hook still EXISTS when the hook is reading it', (t) => {
  // The drain unlinks its temp envelope on hook-close. If the payload's
  // transcript_path is that temp file, anything downstream that stores the path
  // (a memory_sessions row, a later re-parse, a human debugging a bad capture)
  // is left holding a dangling reference to a file that no longer exists.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  runDrainDirect(w, { agent: 'codex', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null));

  const payload = JSON.parse(w.hookPayload().stdin);
  assert.ok(
    w.hookPayload().envelope,
    'transcript_path must be readable AT hook time (the fake hook snapshots it live)',
  );
  assert.ok(
    fs.existsSync(payload.transcript_path),
    `transcript_path points at a file that no longer exists: ${payload.transcript_path} — `
    + 'a stored dangling path is worse than no path',
  );
});

test('secrets in the raw terminal capture never reach the hook (redaction is before the boundary)', (t) => {
  // `script(1)` captures the RAW TERMINAL: a `export DATABASE_URL=...` typed
  // mid-session, an `env` dump, an auth screen. All of it would otherwise be
  // embedded and written to a cloud DB. This asserts the envelope the hook
  // receives is already clean — redaction must happen before anything leaves
  // the machine, not at some later layer.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();

  const SECRETS = [
    'postgresql://someuser:hunter2SuperSecret@db.example.com:5432/postgres',
    'sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
    'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'xoxb-' + '1234567890-abcdefghijklmnop',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'export SUPABASE_SERVICE_ROLE_KEY=' + 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ];
  const raw = ['> show me the env', ...SECRETS, 'done.', ''].join('\n');
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, raw);

  runDrainDirect(w, { agent: 'codex', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null), 'the drain must still capture the session');

  const envelope = w.hookPayload().envelope || '';
  assert.ok(envelope.length > 0, 'precondition: something was captured to redact');
  for (const secret of SECRETS) {
    const bare = secret.replace(/^export [A-Z_]+=/, '');
    assert.ok(
      !envelope.includes(bare),
      `SECRET REACHED THE HOOK: ${bare.slice(0, 24)}… — redaction must run before the boundary`,
    );
  }
  assert.match(envelope, /‹redacted:/, 'redaction must leave a visible marker, not silently drop text');
  // Non-secret content must survive: a redactor that nukes everything is not a
  // redactor, and the whole point of capture is the surrounding conversation.
  assert.ok(envelope.includes('show me the env'), 'ordinary content must survive redaction');
});

test('a redactor that throws fails CLOSED — never raw text', (t) => {
  // The drain's fallback is `‹redacted:redaction-failed›` rather than passing
  // the original through. Pin it: the one thing worse than losing a session is
  // shipping the terminal contents unredacted because a rule threw.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();

  // Break the vendored redactor in the sandbox copy only.
  fs.writeFileSync(
    path.join(w.shimDir, 'redact.js'),
    'module.exports = { redact() { throw new Error("boom"); } };\n',
  );

  const secret = 'postgresql://u:pw_do_not_leak@h:5432/db';
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, `> hi\n${secret}\nbye\n`);

  runDrainDirect(w, { agent: 'codex', transcript, hookPath });

  const got = w.hookPayload();
  if (got && got.envelope) {
    assert.ok(!got.envelope.includes('pw_do_not_leak'), 'a throwing redactor must not pass raw text through');
  }
});

test('the envelope carries raw_transcript_path, and BOTH artifacts are durable and 0600', (t) => {
  // ORCH RULING 2026-08-01 16:25 ET (R-A): a shim session leaves TWO durable
  // files and the split is deliberate —
  //   memory_sessions.transcript_path  → the cleaned envelope (what the hook
  //                                      parsed; a re-parse must read this, not
  //                                      the raw log, which parses to zero)
  //   envelope.raw_transcript_path     → the raw script(1) PTY log (forensic
  //                                      original, for when cleaning lost
  //                                      something)
  // Neither may be a temp file, and neither may be world-readable: the raw log
  // is a verbatim terminal capture.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'), { mode: 0o600 });

  runDrainDirect(w, { agent: 'codex', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null));

  const got = w.hookPayload();
  const envelope = JSON.parse(got.envelope);

  assert.ok(envelope.raw_transcript_path, 'the envelope must record the raw PTY log path');
  assert.ok(
    path.isAbsolute(envelope.raw_transcript_path),
    'raw_transcript_path must be ABSOLUTE — a relative path is unresolvable from anywhere '
    + 'the consumer might later run',
  );
  assert.ok(
    fs.existsSync(envelope.raw_transcript_path),
    'raw_transcript_path must point at a file that still exists — the whole point is durability',
  );

  // Round-trip: the forensic original must actually be the session, not a stub.
  const rawBack = fs.readFileSync(envelope.raw_transcript_path, 'utf8');
  assert.ok(
    rawBack.includes('s68r-canary-fixture-2026-08-01'),
    'the raw log must contain the session content it claims to preserve',
  );

  // The cleaned envelope is what the hook parsed; prove it is the parseable one
  // of the two, so nobody "simplifies" transcript_path to the raw log later.
  const drainMod = require(path.join(w.shimDir, 'drain.js'));
  assert.ok(envelope.messages.length > 0, 'the envelope must carry parsed messages');
  assert.equal(
    hook.parseAutoDetect(rawBack).length, 0,
    'the RAW log parses to zero under the hook — this is why transcript_path points at the '
    + 'envelope and not at the raw file',
  );
  assert.ok(drainMod._cleanAndSegment(rawBack).length > 0, 'the raw log is cleanable, just not hook-parseable');

  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  assert.equal(mode(envelope.raw_transcript_path), '600', 'the raw terminal capture must not be group/world readable');
});

// ──────────────────────────────────────────────────────────────────────────────
// ORCH RULING 2026-08-01 16:25 ET (R-A) — added by T1 at ORCH's direction.
// T3, this is your file: adjust or fold it in freely.
//
// T3's `raw_transcript_path` case above already covers the field's presence,
// absoluteness, existence, durability and 0600 mode — deliberately NOT repeated
// here. This asserts the one property that case does not: that adding a
// top-level key to the envelope is INERT to the hook's parsers.
//
// Why it earns its place: the parsers read only `.messages`, so the field is
// free today. But the failure mode if that ever stops being true is the worst
// one this sprint has — the envelope still looks valid, the drain still exits 0,
// and capture silently drops to zero rows. The same shape as the D2′ defect that
// opened the sprint. Cheap assertion against an expensive silent failure.
// ──────────────────────────────────────────────────────────────────────────────

test('raw_transcript_path is inert to the hook parsers (extra keys must not perturb parsing)', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const hookPath = w.installFakeHook();
  const transcript = path.join(w.root, 'raw.log');
  fs.writeFileSync(transcript, fixture('raw-pty-lf.log'));

  runDrainDirect(w, { agent: 'codex', transcript, hookPath });
  assert.ok(waitFor(() => w.hookPayload() !== null));
  const envelope = JSON.parse(w.hookPayload().envelope);

  const withField = hook.selectTranscriptParser('auto').parser(JSON.stringify(envelope));
  const withoutField = hook.selectTranscriptParser('auto').parser(
    JSON.stringify({ messages: envelope.messages }),
  );

  assert.ok(withField.length > 0, 'the envelope must parse to real messages');
  assert.deepEqual(
    withField, withoutField,
    'raw_transcript_path must not change what the hook parses — if this ever fails, standalone '
    + 'capture is silently writing zero rows while every other signal looks healthy',
  );
});
