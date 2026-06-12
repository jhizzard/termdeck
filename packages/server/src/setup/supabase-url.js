// Parse + validate Supabase URLs and derive what we can from them without the
// database password. Useful for both init wizards:
//
//   - init-mnestra needs the project ref to show in status output and also
//     needs a full DATABASE_URL to apply migrations; since the DB password
//     cannot be derived from the project URL alone, the wizard prompts for
//     the direct connection string separately.
//
//   - init-rumen needs the project ref to run `supabase link --project-ref`
//     and to substitute into the pg_cron schedule SQL.

// Brad #2 (Sprint 59) — strip ONE pair of matched surrounding single OR
// double quotes from a string. Idempotent: a value with no quotes returns
// unchanged, mismatched quotes (`"foo'`, `bar"`) return unchanged. The
// dotenv parsers in config.js / dotenv-io.js / launcher.js already strip
// at file-read time, but Brad's reproducer ships the literal-quoted value
// through process.env (shell `export DATABASE_URL="\"$URL\""`), bypassing
// the file parsers entirely. Adding the strip here defends the validator
// boundary so any caller that hands us a quoted env-var value gets the
// same handling as a quoted secrets.env line.
function stripSurroundingQuotes(value) {
  if (typeof value !== 'string') return value;
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

// A Supabase project URL looks like:
//   https://<project-ref>.supabase.co
// The ref is 20 characters of lowercase alphanumerics, but we accept anything
// that matches `[a-z0-9-]+` to avoid being stricter than Supabase itself.
function parseProjectUrl(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'empty url' };
  }
  const trimmed = stripSurroundingQuotes(url.trim()).replace(/\/+$/, '');
  let u;
  try {
    u = new URL(trimmed);
  } catch (_err) {
    return { ok: false, error: 'not a valid URL' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'must be https://' };
  }
  const m = u.hostname.match(/^([a-z0-9-]+)\.supabase\.(co|in)$/i);
  if (!m) {
    return { ok: false, error: 'hostname must end in .supabase.co' };
  }
  return {
    ok: true,
    url: `https://${u.hostname}`,
    projectRef: m[1].toLowerCase(),
    hostname: u.hostname
  };
}

// Validate that a string has the shape of a Supabase service role key.
// Supabase now ships two formats:
//   (1) legacy JWT: `eyJ...` (header.payload.signature), usually ~200 chars
//   (2) prefixed v2: `sb_secret_...` or `sb_publishable_...`
// We accept both shapes and reject anything else with an explicit hint.
function looksLikeServiceRole(key) {
  if (!key || typeof key !== 'string') return 'empty';
  const trimmed = key.trim();
  if (trimmed.startsWith('sb_secret_')) return null;
  if (trimmed.startsWith('sb_publishable_')) {
    return 'that looks like a publishable (anon) key, not the service_role key';
  }
  if (trimmed.startsWith('eyJ')) {
    // Rough JWT shape check — 3 dot-separated base64url chunks.
    const parts = trimmed.split('.');
    if (parts.length === 3) return null;
    return 'JWT-looking string but not 3 segments';
  }
  return 'does not look like a Supabase service_role key (expected sb_secret_… or eyJ…)';
}

// Shape-check an OpenAI API key. Both classic `sk-` and project `sk-proj-`
// formats are accepted.
function looksLikeOpenAiKey(key) {
  if (!key || typeof key !== 'string') return 'empty';
  const trimmed = key.trim();
  if (trimmed.startsWith('sk-') && trimmed.length >= 20) return null;
  return 'OpenAI keys start with sk-';
}

// Shape-check an Anthropic API key.
function looksLikeAnthropicKey(key) {
  if (!key || typeof key !== 'string') return 'empty';
  const trimmed = key.trim();
  if (trimmed.startsWith('sk-ant-') && trimmed.length >= 30) return null;
  return 'Anthropic keys start with sk-ant-';
}

// Shape-check a Postgres connection string. Accepts both Supabase pooler URLs
// (`postgres://postgres.<ref>:...@aws-0-<region>.pooler.supabase.com:<port>/postgres`)
// and direct connection URLs (`postgres://postgres:...@db.<ref>.supabase.co:5432/postgres`).
function looksLikePostgresUrl(url) {
  if (!url || typeof url !== 'string') return 'empty';
  const stripped = stripSurroundingQuotes(url.trim());
  let u;
  try {
    u = new URL(stripped);
  } catch (_err) {
    return 'not a valid URL';
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return 'must start with postgres:// or postgresql://';
  }
  if (!u.username || !u.password) {
    return 'missing username or password — paste the full Connection String from Supabase';
  }
  return null;
}

// Detect a Supabase Shared Pooler URL in TRANSACTION mode. Pattern:
//   postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
// Session mode (port 5432 on the pooler) and direct connections
// (db.<ref>.supabase.co:5432) do NOT need pgbouncer params and must be
// left alone. Returns true only for the transaction-pooler shape.
function isTransactionPoolerUrl(parsedUrl) {
  if (!parsedUrl) return false;
  const host = (parsedUrl.hostname || '').toLowerCase();
  // pooler hosts end in `.pooler.supabase.com`. Be lenient on the regional
  // prefix — Supabase has used `aws-0-` historically and may add others.
  if (!host.endsWith('.pooler.supabase.com')) return false;
  // Transaction mode is port 6543. Session mode on the same host is 5432
  // and doesn't want pgbouncer flags.
  return parsedUrl.port === '6543';
}

// Normalize a DATABASE_URL by appending the pgbouncer transaction-mode
// params Supabase requires when connecting through a transaction pooler.
//
// Brad's Rumen logs (2026-04-26) warned:
//   "DATABASE_URL is a Shared Pooler URL but does not have ?pgbouncer=true.
//    Append ?pgbouncer=true&connection_limit=1 for transaction-mode
//    compatibility."
//
// The warning is harmless on its own — Rumen's runtime didn't fail because
// of it — but missing the params can manifest as prepared-statement errors
// or stuck connections under load with PgBouncer in transaction mode. The
// safest path is for the wizard to add them on the user's behalf when the
// URL shape clearly indicates they're needed.
//
// Returns `{ url, modified }`. `modified` is true when params were added.
// Idempotent: a URL that already has pgbouncer=true is returned unchanged.
// Only touches transaction-pooler URLs (port 6543 on *.pooler.supabase.com).
// Direct connections (port 5432, db.* hostname) and session-pooler URLs
// (port 5432 on pooler hostname) are returned unchanged.
//
// Errors are swallowed — a malformed URL returns `{ url: original, modified: false }`
// because validation is the caller's job (looksLikePostgresUrl handles that).
function normalizeDatabaseUrl(url) {
  if (!url || typeof url !== 'string') return { url, modified: false };
  // Brad #2: strip surrounding quotes silently — `modified` stays scoped
  // to "appended pgbouncer params" so the caller's user-facing message
  // ("Detected transaction pooler URL — appending ...") doesn't fire for
  // a no-op quote strip. The strip itself is reflected in the returned
  // `url` so downstream `new URL(normalized.url)` / pg.Pool consumers
  // don't re-throw.
  const stripped = stripSurroundingQuotes(url.trim());
  let u;
  try {
    u = new URL(stripped);
  } catch (_err) {
    return { url: stripped, modified: false };
  }
  if (!isTransactionPoolerUrl(u)) return { url: stripped, modified: false };

  // Already has pgbouncer set? Don't touch — but still return the stripped URL,
  // not the original (Sprint 59 T4-CODEX residual fix: pre-fix returned `url`,
  // which would re-leak surrounding quotes from a quoted-pgbouncer-URL secrets.env).
  if (u.searchParams.has('pgbouncer')) return { url: stripped, modified: false };

  u.searchParams.set('pgbouncer', 'true');
  // Set connection_limit only if not already set — preserve user intent.
  if (!u.searchParams.has('connection_limit')) {
    u.searchParams.set('connection_limit', '1');
  }
  return { url: u.toString(), modified: true };
}

// ── DATABASE_URL endpoint-shape classification (Sprint 75 T2) ──────────────
//
// Ported from engram src/db-endpoint.ts (Sprint 74 T2 — Brad's Dell R730
// field report, 2026-06-09). Supabase's direct endpoint
// `db.<project-ref>.supabase.co` — which also hosts the Dedicated Pooler on
// :6543 — publishes ONLY an AAAA record. On a host without IPv6 (many CI
// runners and VPSes) pg clients don't fail fast; they hang until a pool
// timeout. The IPv4-compatible alternative is the Shared Pooler:
//
//   postgres://postgres.<project-ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:6543/postgres
//
// This classifier lets every DATABASE_URL ingress warn BEFORE the first
// hang. It never rewrites or rejects anything — `looksLikePostgresUrl`
// stays the blocking validator; direct URLs remain accepted because
// IPv6-capable hosts use them legitimately. Warn ≠ reject.

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// Classify a raw DATABASE_URL string by endpoint family. Returns
// { kind, host?, port?, username?, poolerUserMismatch? } where kind is one of:
//   'absent'        — nothing usable provided
//   'invalid'       — set but not parseable as postgres:// / postgresql://
//   'direct'        — db.<project-ref>.supabase.co|in (IPv6-only: AAAA, no A
//                     record; covers BOTH :5432 direct and :6543 Dedicated
//                     Pooler — same hostname, same IPv4 unreachability)
//   'shared-pooler' — *.pooler.supabase.com (IPv4-compatible)
//   'local'         — loopback/local Postgres
//   'other'         — self-hosted, RDS, IPv6 literal, … (no Supabase concerns)
// poolerUserMismatch is true when the host is the Shared Pooler but the
// username lacks the mandatory `.<project-ref>` suffix — the documented
// "Tenant or user not found" failure.
function classifyDbEndpoint(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'string') {
    return { kind: 'absent' };
  }
  const trimmed = stripSurroundingQuotes(raw.trim());
  if (trimmed === '') return { kind: 'absent' };

  let u;
  try {
    u = new URL(trimmed);
  } catch (_err) {
    return { kind: 'invalid' };
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return { kind: 'invalid' };
  }

  // Normalize: lowercase, drop a trailing FQDN dot.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  let username = '';
  try {
    username = decodeURIComponent(u.username);
  } catch (_err) {
    username = u.username;
  }
  const base = { host, port: u.port, username };

  if (LOCAL_DB_HOSTS.has(host)) return { kind: 'local', ...base };

  if (/^db\.[a-z0-9-]+\.supabase\.(co|in)$/.test(host)) {
    return { kind: 'direct', ...base };
  }

  if (host.endsWith('.pooler.supabase.com')) {
    // Shared Pooler logins are `postgres.<project-ref>` — a dotless
    // username means the URL was hand-assembled from direct-connection
    // parts and will fail with "Tenant or user not found".
    const poolerUserMismatch = username !== '' && !username.includes('.');
    return { kind: 'shared-pooler', ...base, poolerUserMismatch };
  }

  return { kind: 'other', ...base };
}

// Warning lines for a classification — [] when there is nothing to say.
// Wording kept byte-similar to engram's doctor probe messages so grep /
// troubleshooting stays consistent across the stack. Print-only: callers
// write these to stdout after a PASSING validation and never change exit
// codes on their account.
function directEndpointWarningLines(classification) {
  if (!classification || typeof classification !== 'object') return [];
  if (classification.kind === 'direct') {
    return [
      '⚠ this is the IPv6-only endpoint (db.<project-ref>.supabase.co — AAAA-only DNS, no IPv4)',
      'on IPv4-only hosts pg clients hang until a pool/connect timeout',
      'IPv4-safe: Connect modal → Transaction pooler → toggle ON "Use IPv4 connection (Shared Pooler)"',
      'postgres://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres'
    ];
  }
  if (classification.kind === 'shared-pooler' && classification.poolerUserMismatch) {
    return [
      `⚠ Shared Pooler host but username "${classification.username}" — pooler logins must be postgres.<project-ref>; fails with "Tenant or user not found"`
    ];
  }
  return [];
}

// Mask all but the last 4 chars of a secret for logging.
function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

module.exports = {
  parseProjectUrl,
  looksLikeServiceRole,
  looksLikeOpenAiKey,
  looksLikeAnthropicKey,
  looksLikePostgresUrl,
  isTransactionPoolerUrl,
  normalizeDatabaseUrl,
  maskSecret,
  stripSurroundingQuotes,
  classifyDbEndpoint,
  directEndpointWarningLines
};
