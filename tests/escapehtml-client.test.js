const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = join(__dirname, '..', 'packages', 'client', 'public', 'app.js');
const source = readFileSync(appPath, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should be defined`);

  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${name} should have a body`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`${name} body was not closed`);
}

function makeDocumentStub() {
  return {
    createElement(tag) {
      assert.equal(tag, 'div');
      let value = '';
      return {
        set textContent(next) {
          value = next == null ? '' : String(next);
        },
        get innerHTML() {
          return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        }
      };
    }
  };
}

test('app.js has one canonical escapeHtml definition', () => {
  const definitions = source.match(/\bfunction escapeHtml\s*\(/g) || [];
  assert.equal(definitions.length, 1);
});

test('escapeHtml preserves existing DOM text-node escaping behavior', () => {
  const escapeHtml = vm.runInNewContext(`(${extractFunction('escapeHtml')})`, {
    document: makeDocumentStub()
  });

  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('"quoted"'), '"quoted"');
  assert.equal(escapeHtml("it's"), "it's");
});
