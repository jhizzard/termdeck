const test = require('node:test');
const assert = require('node:assert/strict');
const { detectParked } = require('../src/parked-detection');

test('detectParked returns false if session is missing or malformed', () => {
  assert.equal(detectParked(null), false);
  assert.equal(detectParked({}), false);
  assert.equal(detectParked({ meta: {} }), false);
});

test('detectParked returns false if status is not active', () => {
  const session = {
    meta: {
      status: 'thinking',
      lastActivity: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    _outputBuffer: 'Cogitated for 1m 2s'
  };
  assert.equal(detectParked(session), false);
});

test('detectParked returns false if lastActivity is recent', () => {
  const session = {
    meta: {
      status: 'active',
      lastActivity: new Date(Date.now() - 2 * 60 * 1000).toISOString()
    },
    _outputBuffer: 'Cogitated for 1m 2s'
  };
  assert.equal(detectParked(session), false);
});

test('detectParked returns false if no banner in buffer', () => {
  const session = {
    meta: {
      status: 'active',
      lastActivity: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    _outputBuffer: 'some other output'
  };
  assert.equal(detectParked(session), false);
});

test('detectParked returns true for Claude Code banners (Cogitated, Churned, Brewed, Cooked, Mused, Pondered, Wandered, Crafted)', () => {
  const verbs = ['Cogitated', 'Churned', 'Brewed', 'Cooked', 'Mused', 'Pondered', 'Wandered', 'Crafted'];
  const now = Date.now();
  const oldActivity = new Date(now - 10 * 60 * 1000).toISOString();

  verbs.forEach(verb => {
    const session = {
      meta: {
        status: 'active',
        lastActivity: oldActivity
      },
      _outputBuffer: `some text before\r\n${verb} for 5m 10s\r\n`
    };
    assert.equal(detectParked(session), true, `Should detect ${verb} as parked`);
  });
});

test('detectParked handles ANSI codes in buffer', () => {
  const session = {
    meta: {
      status: 'active',
      lastActivity: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    _outputBuffer: '\x1b[32mCogitated for 1m 2s\x1b[0m'
  };
  assert.equal(detectParked(session), true);
});

test('detectParked only looks at the tail of the buffer', () => {
  const session = {
    meta: {
      status: 'active',
      lastActivity: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    _outputBuffer: 'Cogitated for 1m 2s\r\n' + 'x'.repeat(2000)
  };
  // Banner is too far from tail
  assert.equal(detectParked(session), false);
});
