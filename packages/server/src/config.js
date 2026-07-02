// TermDeck config loader with secrets.env support (F2.2).
//
// Secrets live in ~/.termdeck/secrets.env (dotenv format) so that
// ~/.termdeck/config.yaml can be committed / shared / reviewed without
// carrying plaintext API keys. Precedence (highest wins):
//
//   1. process.env (as it was at launch)
//   2. ~/.termdeck/secrets.env (loaded here, merged INTO process.env)
//   3. ${VAR} substitutions inside config.yaml
//   4. Inline values in config.yaml (legacy, triggers a deprecation warning)
//   5. Built-in defaults
//
// Never print secret values. The deprecation warning must not echo the leaked
// key — it just names the config.yaml field that still holds an inline secret.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.termdeck');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');
const SECRETS_PATH = path.join(CONFIG_DIR, 'secrets.env');

// Fields in config.yaml that historically held plaintext secrets. Used to
// emit the one-time deprecation warning on startup.
const LEGACY_SECRET_PATHS = [
  ['rag', 'supabaseKey'],
  ['rag', 'openaiApiKey'],
  ['rag', 'anthropicApiKey']
];

// Very small dotenv parser so we don't take on a dependency for 40 lines of code.
// Supports: KEY=value, KEY="quoted value", KEY='single', blank lines, #comments.
// Does NOT support variable expansion inside values (not needed here).
function parseDotenv(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadSecretsEnv() {
  if (!fs.existsSync(SECRETS_PATH)) return { loaded: false, keys: [] };
  try {
    const raw = fs.readFileSync(SECRETS_PATH, 'utf-8');
    const parsed = parseDotenv(raw);
    const keys = [];
    for (const [k, v] of Object.entries(parsed)) {
      // Do not clobber pre-set process env; shell wins. Sprint 59 T4-CODEX residual
      // fix: also fill when parent env is empty string (Brad's actual failure shape
      // includes DATABASE_URL= in the parent service environment, not only missing).
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
      }
      keys.push(k);
    }
    return { loaded: true, keys };
  } catch (err) {
    console.warn('[config] Failed to read secrets.env:', err.message);
    return { loaded: false, keys: [] };
  }
}

// Walk a parsed YAML tree and replace ${VAR} / ${VAR:-default} tokens in any
// string leaf using process.env. Unknown vars → empty string (matches dotenv
// conventions), unless a default is supplied via :-.
function substituteEnv(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, key, def) => {
      const v = process.env[key];
      if (v !== undefined && v !== '') return v;
      return def !== undefined ? def : '';
    });
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnv(v);
    return out;
  }
  return value;
}

function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

// A "secret-shaped" inline value is a non-empty string that is NOT an ${ENV}
// reference. We treat `${FOO}` and `${FOO:-bar}` as safe (just a template).
function looksLikeInlineSecret(v) {
  if (typeof v !== 'string') return false;
  if (!v) return false;
  if (/^\$\{[A-Z0-9_]+(?::-[^}]*)?\}$/i.test(v.trim())) return false;
  return true;
}

function warnIfLegacyInlineSecrets(parsed, secretsLoaded) {
  if (secretsLoaded) return; // secrets.env exists — user has migrated, don't nag.
  const hits = [];
  for (const segs of LEGACY_SECRET_PATHS) {
    const v = getPath(parsed, segs);
    if (looksLikeInlineSecret(v)) hits.push(segs.join('.'));
  }
  if (hits.length > 0) {
    console.warn(
      `[config] WARNING: secrets in config.yaml are deprecated — move them to ~/.termdeck/secrets.env ` +
      `(see config/secrets.env.example). Fields still inline: ${hits.join(', ')}`
    );
  }
}

function defaultConfig() {
  return {
    port: 3000,
    host: '127.0.0.1',
    shell: process.env.SHELL || '/bin/bash',
    defaultTheme: 'tokyo-night',
    // Sprint 80 T3 (FR-3) — optional cap on concurrent LIVE panels. `null`
    // (also 0 / negative / non-numeric) means UNLIMITED, which is the exact
    // pre-FR-3 behavior (TermDeck imposed no cap), so the default never
    // regresses. Set a positive integer to make POST /api/sessions return a
    // clear 429 once that many live panels exist — a guarded ceiling instead of
    // the silent host/PTY exhaustion Brad hit at ~30-40 panels (2026-06-26).
    // Override precedence: TERMDECK_MAX_PANELS env > config.yaml > this default.
    maxPanels: null,
    projects: {},
    rag: {
      enabled: false,
      supabaseUrl: null,
      supabaseKey: null,
      openaiApiKey: null,
      anthropicApiKey: null,
      developerId: os.userInfo().username,
      syncIntervalMs: 10000,
      mnestraMode: 'direct',
      mnestraWebhookUrl: 'http://localhost:37778/mnestra',
      tables: {
        session: 'mnestra_session_memory',
        project: 'mnestra_project_memory',
        developer: 'mnestra_developer_memory',
        commands: 'mnestra_commands'
      }
    },
    sessionLogs: {
      enabled: false,
      summaryModel: 'claude-haiku-4-5'
    },
    // Sprint 80 T2 (FR-5 + FR-6) — per-panel context-size telemetry + ceiling
    // enforcement. Defaults chosen from Brad's 2026-06-26 crash: orchs rode to
    // 356K–999K unseen, so WARN at 350K / OVER at 400K surfaces the danger band
    // well before the ~1M wall. Enforcement (maxContextK) is OFF by default —
    // TermDeck never intervenes on a panel until the operator opts in — and even
    // when on, the default action is the non-destructive `notify` (PLANNING §3.3).
    context: {
      warnK: 350,          // header turns ⚠ amber at/above this
      overK: 400,          // header turns ⛔ red at/above this
      maxContextK: null,   // FR-6 enforcement ceiling; null/0 = disabled
      contextAction: 'notify',   // notify | inject | kill  (inject/kill are opt-in)
      // Force-rotate message pasted (two-stage) into the panel when action=inject.
      contextInjectText:
        'You are approaching the context limit. Persist critical state to memory now '
        + '(memory_remember / STATUS.md), then rotate: summarize your handoff and end this session so a fresh panel can resume.',
      respawnOnKill: false,      // action=kill: respawn a fresh panel with the same command/cwd
      killGraceMs: 15000,        // re-check delay when a kill is deferred mid-tool-use
      killMaxDeferrals: 3,       // after this many mid-tool-use deferrals, kill anyway
      webhookUrl: null           // optional POST target fired on every enforcement action
    }
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const secrets = loadSecretsEnv();
  if (secrets.loaded) {
    console.log(`[config] Loaded secrets from ${SECRETS_PATH} (${secrets.keys.length} key${secrets.keys.length === 1 ? '' : 's'})`);
  }

  const defaults = defaultConfig();

  // Auto-create default config.yaml on first run (unchanged behavior).
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultYaml = `# TermDeck Configuration
# Secrets belong in ~/.termdeck/secrets.env, not here.

port: 3000
host: 127.0.0.1

shell: ${process.env.SHELL || '/bin/bash'}
defaultTheme: tokyo-night

# Cap on concurrent LIVE panels (FR-3). Omitted / null / 0 = UNLIMITED (default).
# Set a positive integer to get a clear 429 once that many live panels exist,
# instead of letting a busy host run out of PTYs / RAM. Pick a value your host
# can actually drive — see the README "Panel cap" section for per-OS PTY notes.
# The TERMDECK_MAX_PANELS env var overrides this at launch.
# maxPanels: 24

# projects:
#   my-project:
#     path: ~/code/my-project
#     defaultTheme: catppuccin-mocha
#     defaultCommand: claude

rag:
  enabled: false
  # supabaseUrl and secrets come from ~/.termdeck/secrets.env
  supabaseUrl: \${SUPABASE_URL}
  supabaseKey: \${SUPABASE_SERVICE_ROLE_KEY}
  openaiApiKey: \${OPENAI_API_KEY}
  anthropicApiKey: \${ANTHROPIC_API_KEY}
  syncIntervalMs: 10000
  mnestraMode: direct
  mnestraWebhookUrl: http://localhost:37778/mnestra

sessionLogs:
  enabled: false
  summaryModel: claude-haiku-4-5

# Per-panel context-size telemetry (FR-5) + ceiling enforcement (FR-6).
# The panel header shows live "NNK ctx" for Claude panels, read from the
# session transcript on disk (no CLI involvement). Enforcement is OFF until
# you set maxContextK; the default action is the non-destructive "notify".
context:
  warnK: 350            # header shows an amber warning at/above this many K tokens
  overK: 400            # header shows a red over-limit marker at/above this
  # maxContextK: 400    # uncomment to enforce a ceiling; null/omitted = disabled
  contextAction: notify # notify | inject | kill  (inject and kill are opt-in)
  # contextInjectText: "..."   # message pasted into the panel when action: inject
  respawnOnKill: false  # action: kill — respawn a fresh panel with the same command/cwd
  killGraceMs: 15000    # when a kill is deferred mid-tool-use, re-check after this
  killMaxDeferrals: 3   # after this many mid-tool-use deferrals, kill anyway
  # webhookUrl: "https://..."  # optional POST fired on every enforcement action
`;
    fs.writeFileSync(CONFIG_PATH, defaultYaml, 'utf-8');
    console.log('[config] Created default config at', CONFIG_PATH);
  }

  let parsed = {};
  try {
    const yaml = require('yaml');
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    parsed = yaml.parse(raw) || {};
    console.log('[config] Loaded from', CONFIG_PATH);
  } catch (err) {
    console.warn('[config] Could not load config.yaml, using defaults:', err.message);
    parsed = {};
  }

  // Warn about inline secrets BEFORE substitution so the diagnostic matches
  // what the user actually has on disk.
  warnIfLegacyInlineSecrets(parsed, secrets.loaded);

  const substituted = substituteEnv(parsed);

  // Sprint 80 T3 (FR-3) — panel-cap resolution order: TERMDECK_MAX_PANELS env >
  // config.yaml > default (null = unlimited). Resolved explicitly (rather than
  // relying on the `...substituted` spread alone) so the env var can raise or
  // lower the ceiling at launch without editing the file. Left as-is here (no
  // clamping) — effectivePanelCap() in index.js normalizes null/0/negative to
  // "unlimited" at the enforcement point.
  let maxPanels = (substituted && substituted.maxPanels !== undefined)
    ? substituted.maxPanels
    : defaults.maxPanels;
  const envCap = process.env.TERMDECK_MAX_PANELS;
  if (envCap !== undefined && envCap !== '') {
    const n = Number(envCap);
    if (Number.isFinite(n)) maxPanels = n;
  }

  return {
    ...defaults,
    ...substituted,
    maxPanels,
    rag: { ...defaults.rag, ...(substituted?.rag || {}) },
    sessionLogs: { ...defaults.sessionLogs, ...(substituted?.sessionLogs || {}) },
    context: { ...defaults.context, ...(substituted?.context || {}) }
  };
}

// Add a project to ~/.termdeck/config.yaml and return the updated projects map.
// Writes a timestamped .bak of the existing file before overwriting so the
// user can always recover manually. Comments in the original yaml WILL be lost
// on rewrite — yaml.stringify does not round-trip comments. That's acceptable
// for a v0.2 convenience feature; permanent editing still belongs in a text
// editor for users who care about file comments.
function addProject({ name, path: projectPath, defaultTheme, defaultCommand }) {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Project name must be non-empty and contain only letters, digits, . _ or -');
  }
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Project path is required');
  }

  // Expand ~ for validation but keep tilde form in the stored config so it
  // remains portable across machines.
  const expanded = projectPath.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }

  const yaml = require('yaml');
  let parsed = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    try {
      parsed = yaml.parse(raw) || {};
    } catch (err) {
      throw new Error(`config.yaml is not valid YAML — cannot safely rewrite: ${err.message}`);
    }
  }

  if (!parsed.projects || typeof parsed.projects !== 'object') {
    parsed.projects = {};
  }
  if (parsed.projects[name]) {
    throw new Error(`Project "${name}" already exists`);
  }

  parsed.projects[name] = {
    path: projectPath,
    ...(defaultTheme ? { defaultTheme } : {}),
    ...(defaultCommand ? { defaultCommand } : {})
  };

  // Backup before overwrite.
  if (fs.existsSync(CONFIG_PATH)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${CONFIG_PATH}.${ts}.bak`;
    try {
      fs.copyFileSync(CONFIG_PATH, bak);
    } catch (err) {
      console.warn('[config] Could not write backup before adding project:', err.message);
    }
  }

  const out = yaml.stringify(parsed);
  fs.writeFileSync(CONFIG_PATH, out, 'utf-8');
  console.log(`[config] Added project "${name}" → ${projectPath}`);

  return parsed.projects;
}

// Remove a project from ~/.termdeck/config.yaml and return the updated projects
// map. Mirrors addProject for the inverse operation. Throws ENOENT-shaped
// errors with `code` set so callers can map cleanly to HTTP status. Files on
// disk at the project's `path` are NEVER touched — this only edits the YAML
// entry. The user retains all source code.
function removeProject(name, configPath = CONFIG_PATH) {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    const err = new Error('Project name must be non-empty and contain only letters, digits, . _ or -');
    err.code = 'BAD_NAME';
    throw err;
  }

  const yaml = require('yaml');
  let parsed = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      parsed = yaml.parse(raw) || {};
    } catch (err) {
      throw new Error(`config.yaml is not valid YAML — cannot safely rewrite: ${err.message}`);
    }
  }

  if (!parsed.projects || typeof parsed.projects !== 'object' || !parsed.projects[name]) {
    const err = new Error(`Project "${name}" not found in config.yaml`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  delete parsed.projects[name];

  if (fs.existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${configPath}.${ts}.bak`;
    try {
      fs.copyFileSync(configPath, bak);
    } catch (err) {
      console.warn('[config] Could not write backup before removing project:', err.message);
    }
  }

  const out = yaml.stringify(parsed);
  fs.writeFileSync(configPath, out, 'utf-8');
  console.log(`[config] Removed project "${name}" (files on disk untouched)`);

  return parsed.projects;
}

// Apply a structural patch to ~/.termdeck/config.yaml. Sprint 36 introduces
// this for the dashboard RAG toggle (PATCH /api/config) but the helper is
// generic — pass a deep partial of the config tree, every leaf in `patch` that
// matches the whitelist gets written through. Returns the parsed-from-disk
// post-write tree (NOT post-substitution; we only persist user-authored values
// here, never substituted secrets).
//
// Whitelist deliberately tight. Only fields a UI can safely flip live belong
// here. Adding a new field is an explicit one-line edit (vs. a freeform writer
// that would let a buggy/malicious client change `port`, `shell`, or projects).
//
// Comments and formatting in config.yaml are NOT preserved — same trade-off
// as `addProject`. The yaml package's parseDocument API can preserve comments
// but we'd need to migrate addProject too for consistency; that's a follow-up.
const UPDATABLE_PATHS = new Set([
  'rag.enabled'
]);

function flattenPatch(obj, prefix = '') {
  const out = [];
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenPatch(v, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

function setPath(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
}

function updateConfig(patch, configPath = CONFIG_PATH) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('updateConfig: patch must be a plain object');
  }

  const flat = flattenPatch(patch);
  if (flat.length === 0) {
    throw new Error('updateConfig: patch is empty');
  }

  for (const [key, val] of flat) {
    if (!UPDATABLE_PATHS.has(key)) {
      throw new Error(`updateConfig: ${key} is not in the updatable whitelist`);
    }
    if (key === 'rag.enabled' && typeof val !== 'boolean') {
      throw new Error('updateConfig: rag.enabled must be a boolean');
    }
  }

  const yaml = require('yaml');
  let parsed = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      parsed = yaml.parse(raw) || {};
    } catch (err) {
      throw new Error(`config.yaml is not valid YAML — refusing to overwrite: ${err.message}`);
    }
  }

  for (const [key, val] of flat) {
    setPath(parsed, key.split('.'), val);
  }

  if (fs.existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${configPath}.${ts}.bak`;
    try {
      fs.copyFileSync(configPath, bak);
    } catch (err) {
      console.warn('[config] Could not write backup before updateConfig:', err.message);
    }
  }

  const out = yaml.stringify(parsed);
  fs.writeFileSync(configPath, out, 'utf-8');
  console.log(`[config] updateConfig wrote ${flat.map(([k]) => k).join(', ')}`);

  return parsed;
}

module.exports = {
  loadConfig,
  addProject,
  removeProject,
  updateConfig,
  // exported for tests / introspection
  _parseDotenv: parseDotenv,
  _substituteEnv: substituteEnv,
  _flattenPatch: flattenPatch,
  _UPDATABLE_PATHS: UPDATABLE_PATHS,
  _paths: { CONFIG_DIR, CONFIG_PATH, SECRETS_PATH }
};
