// Regression tests for the mnestra-bridge project-tag passthrough.
//
// Sprint 39 T3 audit confirmed the bridge correctly forwards the session's
// project tag to the RPC's filter_project parameter for all three modes
// (direct / webhook / mcp). These tests pin that invariant so a future
// instrumentation refactor (T1's flashback-diag work, or any later edit)
// cannot silently mutate the filter shape and re-introduce the
// project-mismatch hypothesis the lane was investigating.
//
// What this test pins:
//   1. session.meta.project='termdeck' → fetch RPC body filter_project='termdeck'
//   2. session.meta.project=null + cwd matching config.projects → bridge resolves
//      to the config tag and forwards it as filter_project
//   3. searchAll=true overrides project and forwards filter_project=null
//
// What this test does NOT do:
//   - No live DB. fetch is stubbed.
//   - No webhook / mcp mode coverage — direct mode is what TermDeck ships
//     with by default and what the Flashback path uses on Joshua's box.
//
// Run: node --test tests/mnestra-bridge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBridge } = require('../packages/server/src/mnestra-bridge');

const TERMDECK_CWD = '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck';
const TERMDECK_CONFIG = {
  rag: {
    mnestraMode: 'direct',
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'test-anon-key',
    openaiApiKey: 'test-openai-key',
  },
  projects: {
    termdeck: { path: TERMDECK_CWD },
  },
};

// Stub fetch and capture the bodies sent to the embedding and RPC endpoints.
// Returns { restore, calls } so each test can teardown cleanly.
function stubFetch() {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    let body = null;
    if (options && options.body) {
      try { body = JSON.parse(options.body); } catch { body = options.body; }
    }
    calls.push({ url: String(url), body });
    if (String(url).includes('/embeddings')) {
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: new Array(1536).fill(0) }] }),
      };
    }
    if (String(url).includes('/rpc/memory_hybrid_search')) {
      return {
        ok: true,
        json: async () => [],
      };
    }
    return { ok: false, status: 500, text: async () => 'unexpected url in stubFetch' };
  };
  return {
    restore: () => { global.fetch = original; },
    calls,
  };
}

function lastRpcCall(calls) {
  return calls.find((c) => c.url.includes('/rpc/memory_hybrid_search'));
}

test('bridge passes session.meta.project through to RPC filter_project', async () => {
  const { restore, calls } = stubFetch();
  try {
    const bridge = createBridge(TERMDECK_CONFIG);
    await bridge.queryMnestra({
      question: 'test',
      project: 'termdeck',
      searchAll: false,
    });
    const rpc = lastRpcCall(calls);
    assert.ok(rpc, 'expected an RPC call to memory_hybrid_search');
    assert.equal(rpc.body.filter_project, 'termdeck', 'project must pass through unchanged');
  } finally {
    restore();
  }
});

test('bridge falls back to resolveProjectName(cwd, config) when project is null', async () => {
  const { restore, calls } = stubFetch();
  try {
    const bridge = createBridge(TERMDECK_CONFIG);
    await bridge.queryMnestra({
      question: 'test',
      project: null,
      searchAll: false,
      cwd: TERMDECK_CWD,
    });
    const rpc = lastRpcCall(calls);
    assert.ok(rpc, 'expected an RPC call to memory_hybrid_search');
    assert.equal(
      rpc.body.filter_project, 'termdeck',
      'cwd-based fallback must resolve through config.projects to the tag'
    );
  } finally {
    restore();
  }
});

test('bridge accepts cwd via sessionContext when top-level cwd is absent', async () => {
  const { restore, calls } = stubFetch();
  try {
    const bridge = createBridge(TERMDECK_CONFIG);
    await bridge.queryMnestra({
      question: 'test',
      project: null,
      searchAll: false,
      sessionContext: { cwd: TERMDECK_CWD },
    });
    const rpc = lastRpcCall(calls);
    assert.ok(rpc, 'expected an RPC call to memory_hybrid_search');
    assert.equal(
      rpc.body.filter_project, 'termdeck',
      'sessionContext.cwd should be the secondary fallback source for cwd resolution'
    );
  } finally {
    restore();
  }
});

test('bridge sends filter_project=null when searchAll is true (overrides explicit project)', async () => {
  const { restore, calls } = stubFetch();
  try {
    const bridge = createBridge(TERMDECK_CONFIG);
    await bridge.queryMnestra({
      question: 'test',
      project: 'termdeck',
      searchAll: true,
    });
    const rpc = lastRpcCall(calls);
    assert.ok(rpc, 'expected an RPC call to memory_hybrid_search');
    assert.equal(
      rpc.body.filter_project, null,
      'searchAll must force filter_project to null regardless of explicit project'
    );
  } finally {
    restore();
  }
});

test('bridge sends filter_project=null when neither project nor cwd is provided', async () => {
  const { restore, calls } = stubFetch();
  try {
    const bridge = createBridge(TERMDECK_CONFIG);
    await bridge.queryMnestra({
      question: 'test',
      project: null,
      searchAll: false,
    });
    const rpc = lastRpcCall(calls);
    assert.ok(rpc, 'expected an RPC call to memory_hybrid_search');
    assert.equal(
      rpc.body.filter_project, null,
      'no project + no cwd means no filter — search across all projects'
    );
  } finally {
    restore();
  }
});
