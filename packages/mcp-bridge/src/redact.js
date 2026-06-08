'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Egress redaction — the security keystone of the MCP Bridge (Sprint 71).
//
// THE INVERTED THREAT MODEL. A normal MCP server worries about malicious INPUT.
// The Bridge worries about EGRESS: when a connected consumer chat (Claude.ai /
// ChatGPT / Grok) calls a Bridge tool, the tool RESULT flows back THROUGH that
// provider's cloud to reach the model. So every byte a tool returns — a Mnestra
// memory row, a live terminal buffer — transits Anthropic / OpenAI / xAI infra.
// This module scrubs secrets from tool output BEFORE it leaves the process.
//
// TWO LAYERS, on purpose:
//   1. Built-in generic patterns (below) — provider key formats, JWTs, Supabase
//      project-ref hosts, connection strings, credentialed URLs, and a
//      conservative contextual `key=secret` catch-all. These ship in the
//      (public) repo and are safe to.
//   2. An EXTERNAL literal denylist loaded at runtime from env / a local file —
//      this is where org-specific literals (internal Supabase project name +
//      ref, etc.) live. They are NEVER hardcoded here, because this package sits
//      in a PUBLIC repo and the gitleaks pre-commit hook would (correctly) block
//      them. Operators put those literals in ~/.termdeck/bridge-redact.json or
//      TERMDECK_BRIDGE_REDACT_LITERALS — see loadExternalDenylist().
//
// FALSE-POSITIVE POSTURE. Redaction that mangles benign terminal/memory output
// is itself a defect (it makes the Bridge useless), so every rule below is
// tuned to be SPECIFIC. Two genuinely-ambiguous classes are therefore OPT-IN,
// off by default, and documented at their definitions:
//   - high-entropy base64/hex blobs  → TERMDECK_BRIDGE_REDACT_ENTROPY=1
//   - email addresses (PII, not creds) → TERMDECK_BRIDGE_REDACT_EMAILS=1
// See the per-rule notes for exactly what each catches and what it spares.
//
// Dependency-free on purpose (Node built-ins only) so it is trivially testable
// with `node --test` and cannot be the source of a supply-chain surprise on the
// most security-sensitive path in the package.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

function marker(name) {
  return `‹redacted:${name}›`; // ‹redacted:name›
}
const MARKER_SENTINEL = '‹redacted:';

// A rule is { name, re, replace? }. `re` MUST be global (we use String.replace).
// When `replace` is absent the whole match becomes marker(name) (the fast path,
// identical to the A0 behavior). When present it is a standard String.replace
// callback `(match, ...groups) => string`; rules use it to (a) redact only the
// secret-bearing capture group while preserving surrounding context, or (b)
// decide conditionally (e.g. kv-secret leaves benign dictionary words alone).
// Ordered most-specific → least so the most informative marker wins.
const BUILTIN_RULES = [
  // Provider API keys -------------------------------------------------------
  // The char classes admit `%XX` url-encoded bytes so a key with an encoded
  // byte spliced in (an egress-evasion trick — `sk-ant-AA%61BB`) is matched
  // WHOLE rather than split at the `%`, which would leak the tail (T4-CODEX).
  { name: 'anthropic-key', re: /\bsk-ant-(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2}){20,}/g },
  { name: 'openai-proj-key', re: /\bsk-proj-(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2}){20,}/g },
  { name: 'openai-key', re: /\bsk-(?:[A-Za-z0-9]|%[0-9A-Fa-f]{2}){20,}/g },
  { name: 'xai-key', re: /\bxai-(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2}){20,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: 'github-fine-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  // JWTs (covers Supabase anon / service_role tokens) -----------------------
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // Supabase project-ref host — catches the 20-char ref subdomain GENERICALLY
  // (scheme optional, optional `db.` prefix), so the literal ref never has to
  // appear in this file. Pooler hosts handled separately. A *bare* ref with no
  // `.supabase.` host around it is an org literal → external denylist.
  { name: 'supabase-url', re: /\b(?:https?:\/\/)?(?:db\.)?[a-z0-9]{20}\.supabase\.(?:co|in|net)\b/gi },
  { name: 'supabase-pooler', re: /\baws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com\b/gi },
  // Connection strings — DB/broker URIs carry credentials AND reveal infra
  // topology; neither should egress. Whole-URI redaction. These schemes are
  // never benign-to-egress in tool output, so false-positive risk ≈ 0.
  {
    name: 'conn-string',
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse|cockroachdb|cassandra|couchbase|nats|kafka):\/\/[^\s'"<>()[\]{}|\\^`]+/gi,
  },
  // Credentialed URLs — any scheme with `user:password@host` userinfo. Plain
  // `https://host` (no `:pass@`) is NOT matched, so ordinary links survive.
  {
    name: 'url-userinfo',
    re: /\b(?:https?|ftp|ftps|ssh|sftp):\/\/[^\s:/@'"]+:[^\s:/@'"]+@[^\s'"<>()[\]{}|\\^`]+/gi,
  },
  // Generic bearer / authorization headers ----------------------------------
  { name: 'bearer', re: /\bBearer\s+(?:[A-Za-z0-9._~+/-]|%[0-9A-Fa-f]{2}){16,}=*/g },
  // HTTP Basic auth — base64(user:password). Specific enough (capital "Basic"
  // + a 16+ char base64 run) to be low-false-positive, and it is the common
  // base64-encoded-credential vector that a bare-blob rule would miss.
  { name: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g },
  // Private key blocks ------------------------------------------------------
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Contextual key=secret catch-all (GENERIC, runs last) --------------------
  // Catches a secret in an assignment whose KEY names a credential
  // (`*password`, `*secret`, `*token`, `*api_key`, …) regardless of the
  // value's own shape — the long tail that prefix rules miss. Conservative by
  // construction: only the VALUE is redacted (key + separator preserved as
  // context), and looksSecretish() spares short dictionary words so prose like
  // `the token: refresh it` is left intact while `API_TOKEN=Zx9aQ7kP…` is not.
  {
    name: 'kv-secret',
    re: KV_SECRET_RE(),
    replace: (m, key, sep, q, val) =>
      looksSecretish(val) ? `${key}${sep}${q}${marker('kv-secret')}${q}` : m,
  },
];

// Opt-in rules (appended by activeRules only when their env flag is set). ----
//
// high-entropy: a last-resort net for shape-less random secrets in assignment-
// free contexts. OFF by default and deliberately so — git SHAs, content
// hashes, and base64 data blobs are ALSO high-entropy, and redacting them
// mangles ordinary `git log` / build output. When an operator enables it we
// still spare pure-hex ≤ 40 chars (git SHA / md5 / sha1) and require ≥ 3
// character classes, but the operator accepts residual false positives.
const ENTROPY_RULE = {
  name: 'high-entropy',
  re: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g,
  replace: (m) => (looksHighEntropySecret(m) ? marker('high-entropy') : m),
};
// email: PII, not a credential. OFF by default because emails pervade benign
// output (git author/committer lines, logs, memory rows) and blanket masking
// is lossy. Privacy-sensitive deployments set TERMDECK_BRIDGE_REDACT_EMAILS=1
// and accept that author/committer emails in git-style output get masked too.
const EMAIL_RULE = {
  name: 'email',
  re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
};

// ── Conditional / heuristic helpers ─────────────────────────────────────────

// kv-secret key half: an identifier that CONTAINS a credential word. Surround
// classes are length-bounded ({0,40}) to foreclose catastrophic backtracking
// on hostile (long) egress input.
function KV_SECRET_RE() {
  // The leading identifier fragment is OPTIONAL ({0,40}, not a mandatory char)
  // so an EXACT credential key matches with nothing before it: `API_KEY=…`,
  // `TOKEN=…`, `SECRET=…`, `PASSWORD=…` — not only prefixed forms like
  // `WEBHOOK_TOKEN` (T4-CODEX). The leading `\b` keeps it anchored to a word
  // boundary so we don't match mid-identifier.
  const KEY =
    '[A-Za-z0-9_.\\-]{0,40}' +
    '(?:passwd|password|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|' +
    'access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|' +
    'secret[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|' +
    'refresh[_-]?token|credentials?)' +
    '[A-Za-z0-9_.\\-]{0,40}';
  // (key)(sep)(optional-quote)(value){6,160}(matching-quote)
  return new RegExp(`\\b(${KEY})(\\s*[:=]\\s*)(["']?)([^\\s"',;]{6,160})\\3`, 'gi');
}

// looksSecretish — gate for kv-secret. True for things that look like a secret
// value, false for short dictionary words (so prose survives).
function looksSecretish(v) {
  if (typeof v !== 'string' || v.length < 6) return false;
  if (v.includes(MARKER_SENTINEL)) {
    // A more-specific rule already redacted PART of this credential value. If
    // real residue remains beyond the marker(s) — e.g. a url-encoded tail the
    // provider rule split on at a `%` — redact the WHOLE value so the residue
    // cannot leak. If only the marker remains, leave it (keeps the specific
    // marker and avoids churn).
    const residue = v.replace(/‹redacted:[a-z0-9-]+›/gi, '');
    return residue.replace(/[^A-Za-z0-9%]/g, '').length >= 3;
  }
  if (v.length >= 20) return true; // long opaque token
  if (/[A-Za-z]/.test(v) && /\d/.test(v)) return true; // mixed alnum (Ab12cd…)
  if (/[+/=]/.test(v) && v.length >= 12) return true; // base64-ish
  return false; // short, single-class → treat as benign word
}

function shannon(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// looksHighEntropySecret — gate for the opt-in entropy rule. Conservative even
// when enabled: spares git-SHA/md5/sha1-shaped pure hex and low-diversity runs.
function looksHighEntropySecret(s) {
  if (s.length < 32) return false;
  if (s.includes(MARKER_SENTINEL)) return false;
  if (/^[0-9a-f]+$/.test(s) && s.length <= 40) return false; // git SHA / md5 (lower hex)
  if (/^[0-9A-F]+$/.test(s) && s.length <= 40) return false; // upper hex
  const classes =
    (/[a-z]/.test(s) ? 1 : 0) +
    (/[A-Z]/.test(s) ? 1 : 0) +
    (/\d/.test(s) ? 1 : 0) +
    (/[+/_-]/.test(s) ? 1 : 0);
  if (classes < 3) return false;
  return shannon(s) >= 4.0;
}

function truthy(v) {
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

// ── External denylist (org literals live OUTSIDE the repo) ──────────────────

// Load org-specific literal strings to scrub. Sources (merged, de-duped):
//   - process.env.TERMDECK_BRIDGE_REDACT_LITERALS  (comma-separated)
//   - JSON file at process.env.TERMDECK_BRIDGE_REDACT_FILE, else
//     ~/.termdeck/bridge-redact.json  →  { "literals": ["...", "..."] }
// NOTE: literals are matched case-insensitively as plain substrings (regex-
// escaped), so an operator never needs to think about regex — and a BARE
// project-ref string (not in a URL) is scrubbed simply by listing it here. They
// are loaded from OUTSIDE the repo by design — do not hardcode org literals in
// this file.
function loadExternalDenylist(env = process.env) {
  const out = new Set();
  const fromEnv = (env.TERMDECK_BRIDGE_REDACT_LITERALS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of fromEnv) out.add(s);

  const filePath = env.TERMDECK_BRIDGE_REDACT_FILE
    || path.join(os.homedir(), '.termdeck', 'bridge-redact.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const s of parsed.literals || []) {
      if (typeof s === 'string' && s.trim()) out.add(s.trim());
    }
  } catch {
    /* absent file is fine — env-only (or built-ins-only) operation is valid */
  }
  return [...out];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the active rule set = external literals + built-ins + enabled opt-ins.
// Cached per (denylist + flags) signature so repeated redact() calls are cheap.
let _cache = { sig: null, rules: null };
function activeRules(env = process.env) {
  const literals = loadExternalDenylist(env);
  const entropy = truthy(env.TERMDECK_BRIDGE_REDACT_ENTROPY);
  const email = truthy(env.TERMDECK_BRIDGE_REDACT_EMAILS);
  const sig = `${literals.join(' ')}|${entropy ? 'E' : ''}${email ? 'M' : ''}`;
  if (_cache.sig === sig && _cache.rules) return _cache.rules;
  const literalRules = literals.map((lit, i) => ({
    name: `denylist-${i}`,
    re: new RegExp(escapeRegExp(lit), 'gi'),
  }));
  const optional = [];
  if (email) optional.push(EMAIL_RULE);
  if (entropy) optional.push(ENTROPY_RULE);
  const rules = [...literalRules, ...BUILTIN_RULES, ...optional]; // literals first
  _cache = { sig, rules };
  return rules;
}

// ── Public API ──────────────────────────────────────────────────────────────

// redact(text) → scrubbed string. Returns non-strings unchanged.
function redact(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const rules = opts.rules || activeRules(opts.env);
  let out = text;
  for (const rule of rules) {
    out = rule.replace
      ? out.replace(rule.re, rule.replace)
      : out.replace(rule.re, marker(rule.name));
  }
  return out;
}

// redactDeep(value) → recursively scrub all string values in objects/arrays.
// Use this on tool-result payloads before returning them to the MCP client.
function redactDeep(value, opts = {}) {
  const rules = opts.rules || activeRules(opts.env);
  const o = { ...opts, rules };
  if (typeof value === 'string') return redact(value, o);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, o));
  if (value && typeof value === 'object') {
    const out = {};
    // Redact KEYS as well as values — a secret can hide in an object key (e.g.
    // a payload keyed by a token, or `{ "<api-key>": "..." }`). T4-CODEX
    // reproduced this leak on the value-only A0 version. Colliding redacted
    // keys collapse, which is acceptable: we never want to preserve
    // secret-keyed data, only to stop the secret from egressing.
    for (const [k, v] of Object.entries(value)) {
      out[redact(k, o)] = redactDeep(v, o);
    }
    return out;
  }
  return value;
}

// scan(text) → { clean: boolean, hits: [{name, count}] }. A rule "hits" iff
// applying it would CHANGE the text (i.e. it found something it would redact).
// This is what makes conditional rules honest: a benign `token: refresh` whose
// value kv-secret deliberately leaves alone produces ZERO hits, so the leak-
// gate does not false-fail on prose. The gate uses this to assert that nothing
// secret survives a redact pass (defense-in-depth: redact, then prove clean).
function scan(text, opts = {}) {
  const rules = opts.rules || activeRules(opts.env);
  const hits = [];
  if (typeof text === 'string' && text.length) {
    for (const rule of rules) {
      let n = 0;
      const rep = rule.replace || (() => marker(rule.name));
      text.replace(rule.re, (...a) => {
        const r = rep(...a);
        if (r !== a[0]) n += 1; // only count what would actually be redacted
        return r;
      });
      if (n > 0) hits.push({ name: rule.name, count: n });
    }
  }
  return { clean: hits.length === 0, hits };
}

// scanDeep(value) → like scan() but recurses through objects/arrays and
// aggregates hits by rule name. The leak-gate runs this over each tool's
// sample output (already passed through redactDeep) and fails on any hit.
function scanDeep(value, opts = {}) {
  const rules = opts.rules || activeRules(opts.env);
  const o = { ...opts, rules };
  const agg = new Map();
  (function walk(v) {
    if (typeof v === 'string') {
      for (const h of scan(v, o).hits) agg.set(h.name, (agg.get(h.name) || 0) + h.count);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      // Walk KEYS as well as values so the gate catches a secret hidden in an
      // object key (mirrors redactDeep's key redaction).
      for (const [k, val] of Object.entries(v)) { walk(k); walk(val); }
    }
  })(value);
  const hits = [...agg].map(([name, count]) => ({ name, count }));
  return { clean: hits.length === 0, hits };
}

module.exports = {
  redact,
  redactDeep,
  scan,
  scanDeep,
  loadExternalDenylist,
  activeRules,
  BUILTIN_RULES,
  marker,
  _resetCacheForTests: () => { _cache = { sig: null, rules: null }; },
};
