'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Bridge server — Streamable HTTP transport + OAuth gate  (Sprint 71 / A1, T1)
//
// A read-only remote MCP server. Consumer chats (Claude.ai / ChatGPT / Grok)
// connect via their own connector feature over Streamable HTTP behind OAuth 2.1.
//
// The ONE invariant (A0): every tool RESULT passes through redactDeep() before it
// is returned — because the result transits the provider's cloud (inverted threat
// model: don't EGRESS secrets). `withEgressRedaction` centralizes that and is a
// FROZEN contract: T3's tool handlers are registered pre-wrapped through it.
//
// Lane split this file integrates:
//   • T1 (here): transport, OAuth router + bearer gate, tunnels, mounting.
//   • T2 (./policy): assertReadOnly / requiresApproval / visiblePanels.
//   • T3 (./tools, ./clients): the actual read-only tools + data-source clients.
//
// Fail-closed: a tool is NEVER registered unless policy.assertReadOnly has run.
// ─────────────────────────────────────────────────────────────────────────────

const { randomUUID } = require('node:crypto');
const express = require('express');
const cors = require('cors');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');

const { redactDeep } = require('./redact');
const { createBridgeAuth } = require('./auth');

// zod's namespace (v3/v4 expose it slightly differently); passed to T3's inputSchema factories.
const _zodMod = (() => {
  try {
    return require('zod');
  } catch {
    return {};
  }
})();
const z = _zodMod.z || _zodMod;

// ── egress invariant (A0, FROZEN) ────────────────────────────────────────────
// Every tool handler is registered through this. Centralizes redaction so no
// individual tool can forget it. T3 imports this from here.
function withEgressRedaction(handler) {
  return async (args, extra) => {
    const result = await handler(args, extra);
    return redactDeep(result); // scrub before it leaves the process
  };
}

// Vestigial A0 export — the real registry now comes from ./tools (T3). Kept so
// anything importing the A0 shape still resolves.
const READ_ONLY_TOOLS = [];

// ── safe structured logging ──────────────────────────────────────────────────
// NEVER logs request bodies or tool output (may contain pre-redaction data).
// Only whitelisted, non-sensitive fields ever reach this by construction.
function logEvent(obj) {
  try {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* logging must never throw */
  }
}

// ── tiny fixed-window rate limiter (no dep) ──────────────────────────────────
function createRateLimiter({ windowMs = 60_000, limit = 120 } = {}) {
  const hits = new Map(); // key -> { count, reset }
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'global';
    let rec = hits.get(key);
    if (!rec || now >= rec.reset) {
      rec = { count: 0, reset: now + windowMs };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
    }
    return next();
  };
}

// ── resolve T3's inputSchema (a (z)=>rawShape factory, a raw shape, or none) ──
// v1.29 registerTool expects a Zod RAW SHAPE for inputSchema (it wraps it in
// z.object internally). T3 exports a factory so its tool modules stay zero-dep.
function resolveInputSchema(schema) {
  if (!schema) return undefined;
  const shape = typeof schema === 'function' ? schema(z) : schema;
  return shape;
}

// ── register T3's tools through the T2 policy gate (FAIL-CLOSED) ─────────────
function registerTools(mcpServer, { tools = [], policy = null } = {}) {
  let registered = 0;
  for (const t of tools) {
    if (!policy || typeof policy.assertReadOnly !== 'function') {
      // Never expose a tool without the read-only assertion having run.
      throw new Error(
        `refusing to register tool "${t.name}": policy.assertReadOnly unavailable (fail-closed)`,
      );
    }
    policy.assertReadOnly(t); // throws if the tool declares a write/delete/exec capability

    const annotations = Object.assign({ destructiveHint: false }, t.annotations || {});
    annotations.readOnlyHint = true; // this server is read-only, full stop

    const requiresApproval =
      typeof policy.requiresApproval === 'function' ? policy.requiresApproval(t.name) : !!t.approval;

    const config = { description: t.description, annotations };
    if (t.title) config.title = t.title;
    const inputSchema = resolveInputSchema(t.inputSchema);
    if (inputSchema) config.inputSchema = inputSchema;
    // MCP has no first-class "requires approval" annotation; surface it in _meta
    // (advisory to the client). Real enforcement is the handler-side policy gate.
    if (requiresApproval) config._meta = { 'termdeck/requiresApproval': true };

    mcpServer.registerTool(t.name, config, t.handler);
    registered++;
  }
  return registered;
}

// ── build the express app + transport + auth ─────────────────────────────────
function createBridgeServer({ tools = [], policy = null, auth, options = {} } = {}) {
  if (!auth) throw new Error('createBridgeServer requires an `auth` instance (createBridgeAuth result)');
  const { provider, consentRouter, issuerUrl, resourceUrl, scopesSupported } = auth;
  const name = options.name || 'termdeck-mcp-bridge';
  const version = options.version || safeVersion();
  // Stateful by default (matches Anthropic's reference connector server).
  const stateful =
    options.stateful != null ? options.stateful : process.env.TERMDECK_BRIDGE_STATEFUL !== '0';
  const allowedHosts =
    options.allowedHosts ||
    (process.env.TERMDECK_BRIDGE_ALLOWED_HOSTS
      ? process.env.TERMDECK_BRIDGE_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
      : null);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // reflect X-Forwarded-For when behind a tunnel

  // request logging (method/path/status/ms only — never bodies/output)
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () =>
      logEvent({ evt: 'http', method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t }),
    );
    next();
  });

  // optional Host-header allowlist (tunnel hostnames). Off by default — the SDK's
  // localhost Host-validation would REJECT tunnel-forwarded Host headers, and
  // OAuth bearer is the real gate. Opt in via TERMDECK_BRIDGE_ALLOWED_HOSTS.
  if (allowedHosts && allowedHosts.length) {
    app.use((req, res, next) => {
      const host = String(req.headers.host || '').split(':')[0];
      if (!allowedHosts.includes(host)) return res.status(421).json({ error: 'misdirected_request' });
      return next();
    });
  }

  // CORS — metadata discovery + token/register may be fetched cross-origin by a
  // provider client. Expose the headers MCP clients read.
  app.use(
    cors({
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID', 'mcp-protocol-version'],
    }),
  );

  // health — public, no secrets.
  app.get('/healthz', (req, res) =>
    res.json({
      ok: true,
      name,
      version,
      tools: tools.length,
      auth: auth.info && auth.info.staticBearerEnabled ? 'oauth+static' : 'oauth',
      resource: resourceUrl.href,
      ts: new Date().toISOString(),
    }),
  );

  // operator consent gate, then the OAuth AS (authorize/token/register/revoke +
  // PRM /.well-known/oauth-protected-resource + AS metadata). These routers parse
  // their OWN bodies — do NOT add global body parsers or they double-parse.
  app.use(consentRouter);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported,
      resourceName: 'TermDeck MCP Bridge',
      resourceServerUrl: resourceUrl,
    }),
  );

  // bearer gate for /mcp — on 401 sets WWW-Authenticate pointing at the PRM URL.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [], resourceMetadataUrl });
  const mcpLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: Number(process.env.TERMDECK_BRIDGE_MCP_RATELIMIT) || 120,
  });
  const mcpJson = express.json({ limit: '4mb' }); // route-scoped body parser for /mcp

  function buildMcpServer() {
    const server = new McpServer({ name, version });
    registerTools(server, { tools, policy });
    return server;
  }

  if (stateful) wireStateful(app, { bearer, mcpLimiter, mcpJson, buildMcpServer });
  else wireStateless(app, { bearer, mcpLimiter, mcpJson, buildMcpServer });

  // 404 + safe error handler (never leak internals)
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logEvent({ evt: 'error', path: req.path, msg: err && err.message });
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'server_error' });
  });

  return {
    app,
    name,
    version,
    issuerUrl,
    resourceUrl,
    resourceMetadataUrl,
    info: auth.info,
    toolCount: tools.length,
    stateful,
    listen(port, host, cb) {
      return app.listen(port, host, cb);
    },
  };
}

// ── stateful Streamable HTTP (session-id map) ────────────────────────────────
function wireStateful(app, { bearer, mcpLimiter, mcpJson, buildMcpServer }) {
  const transports = Object.create(null); // sessionId -> transport

  const postHandler = async (req, res) => {
    try {
      const sid = req.headers['mcp-session-id'];
      let transport;
      if (sid && transports[sid]) {
        transport = transports[sid];
      } else if (isInitializeRequest(req.body)) {
        // Accept an initialize even if the client carried a stale/unknown session
        // id (e.g. it cached one from before a Bridge restart) — just start fresh.
        // Requiring `!sid` here would 400 a re-init and strand such clients.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            logEvent({ evt: 'mcp_session_open', sid: id });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && transports[id]) {
            delete transports[id];
            logEvent({ evt: 'mcp_session_close', sid: id });
          }
        };
        const server = buildMcpServer();
        await server.connect(transport);
      } else if (sid) {
        // Non-initialize request bearing an unknown/expired session id. Per the
        // MCP Streamable-HTTP spec the server MUST answer 404 (not 400) so the
        // client starts a NEW session via initialize. This is precisely what lets
        // a connector auto-recover after the Bridge restarts or an ephemeral
        // tunnel cycles — returning 400 strands the client replaying a dead sid.
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
      } else {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session ID, or not an initialize request' },
          id: null,
        });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logEvent({ evt: 'mcp_post_error', msg: e && e.message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      }
    }
  };

  const sessionHandler = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    if (!sid || !transports[sid]) return res.status(400).send('Invalid or missing session ID');
    return transports[sid].handleRequest(req, res);
  };

  app.post('/mcp', mcpLimiter, bearer, mcpJson, postHandler);
  app.get('/mcp', mcpLimiter, bearer, sessionHandler); // SSE stream
  app.delete('/mcp', mcpLimiter, bearer, sessionHandler); // terminate session
}

// ── stateless Streamable HTTP (fresh transport per request) ──────────────────
function wireStateless(app, { bearer, mcpLimiter, mcpJson, buildMcpServer }) {
  const postHandler = async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logEvent({ evt: 'mcp_post_error', msg: e && e.message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      }
    }
  };
  const notAllowed = (req, res) =>
    res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed', mode: 'stateless' });

  app.post('/mcp', mcpLimiter, bearer, mcpJson, postHandler);
  app.get('/mcp', mcpLimiter, bearer, notAllowed);
  app.delete('/mcp', mcpLimiter, bearer, notAllowed);
}

// ── module loaders (tolerant of T2/T3 not having landed yet) ─────────────────
function safeRequire(mod) {
  try {
    return require(mod);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(mod)) return null;
    throw e; // a real error inside an existing module should surface
  }
}
function safeVersion() {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
function loadPolicy() {
  return safeRequire('./policy');
}
function loadClients(config) {
  const mod = safeRequire('./clients');
  if (!mod) return null;
  return typeof mod.createClients === 'function' ? mod.createClients(config) : mod;
}
function loadTools({ policy, clients }) {
  const mod = safeRequire('./tools');
  if (!mod || typeof mod.buildTools !== 'function') return [];
  return mod.buildTools({ withEgressRedaction, policy, clients });
}

// ── bootstrap: wire real (or injected) deps and build the server ─────────────
function bootstrap(options = {}) {
  const auth = options.auth || createBridgeAuth(options.authOptions || {});
  const policy = options.policy !== undefined ? options.policy : loadPolicy();
  const clients =
    options.clients !== undefined
      ? options.clients
      : loadClients({
          // Pass env through if set, else `undefined` so the T3 client applies its
          // OWN documented default (single source of truth — do NOT hardcode the
          // localhost default here, or it overrides T3's env fallback). Accept both
          // TERMDECK_API_BASE and TERMDECK_BASE_URL (the latter is what the
          // connect-*.md docs reference).
          mnestraWebhookUrl: process.env.MNESTRA_WEBHOOK_URL,
          termdeckApiBase: process.env.TERMDECK_API_BASE || process.env.TERMDECK_BASE_URL,
        });

  let tools = options.tools;
  if (tools === undefined) {
    try {
      tools = loadTools({ policy, clients });
    } catch (e) {
      logEvent({ evt: 'tools_load_error', msg: e && e.message });
      tools = [];
    }
  }

  // Operational fail-closed: tools loaded but policy not yet present → withhold
  // them (run transport+auth only) rather than crash. The factory itself stays
  // strict (registerTools throws if asked to mount a tool with no policy).
  if (tools && tools.length && !policy) {
    logEvent({ evt: 'WARN', msg: `policy module not loaded; withholding ${tools.length} tool(s) (fail-closed)` });
    tools = [];
  }

  return createBridgeServer({ tools, policy, auth, options: options.serverOptions || {} });
}

function printBootBanner(server) {
  const lines = [
    '',
    '  TermDeck MCP Bridge — listening',
    `    issuer / base : ${server.issuerUrl.href}`,
    `    resource (mcp): ${server.resourceUrl.href}`,
    `    PRM metadata  : ${server.resourceMetadataUrl}`,
    `    tools mounted : ${server.toolCount}   transport: ${server.stateful ? 'stateful' : 'stateless'}`,
  ];
  if (server.info && server.info.ephemeralOperator) {
    lines.push(
      '    ──────────────────────────────────────────────────────────',
      '    No operator secret was configured. Generated one for this run:',
      `        OPERATOR SECRET: ${server.info.ephemeralOperatorSecret}`,
      '    Enter it on the consent page when a chat client connects.',
      '    Set TERMDECK_BRIDGE_OPERATOR_SECRET to make it stable.',
    );
  }
  lines.push('');
  process.stderr.write(lines.join('\n') + '\n');
}

async function main() {
  const port = Number(process.env.PORT) || 8870;
  const host = process.env.TERMDECK_BRIDGE_HOST || '127.0.0.1';
  const server = bootstrap({ authOptions: { port } });
  const httpServer = server.listen(port, host, () => {
    logEvent({ evt: 'listen', host, port, resource: server.resourceUrl.href, tools: server.toolCount });
    printBootBanner(server);
  });
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    logEvent({ evt: 'fatal', msg: err && err.message });
    process.exit(1);
  });
}

module.exports = {
  withEgressRedaction,
  READ_ONLY_TOOLS,
  createBridgeServer,
  bootstrap,
  registerTools,
  createRateLimiter,
  resolveInputSchema,
  logEvent,
};
