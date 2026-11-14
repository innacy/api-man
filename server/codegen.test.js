// Run: node --test server/codegen.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { CODE_LANGS } = require('./ui/codegen.js');

const req = {
  method: 'POST', url: "http://h/x?a=1&b=it's",
  headers: [['Content-Type', 'application/json'], ['X-Quote', `say "hi" and 'bye'`]],
  body: `{"msg":"it's \\"ok\\"\n$HOME \`x\`"}`, followRedirects: false, insecure: true, timeoutMs: 15000,
};

test('curl quotes survive a real shell', () => {
  const code = CODE_LANGS.curl.gen(req);
  // Replace the program with printf so the shell shows exactly the arguments curl would get.
  const out = execFileSync('sh', ['-c', code.replace(/^curl/, "printf '%s\\n'")]).toString();
  assert.deepEqual(out.trimEnd().split('\n'), [
    '-X', 'POST', req.url,
    '-H', 'Content-Type: application/json', '-H', `X-Quote: say "hi" and 'bye'`,
    '--data-raw', ...req.body.split('\n'), '-k',
  ]);
});

test('a hostile method cannot inject shell or PowerShell commands', () => {
  const evil = { ...req, method: "GET;touch /tmp/pwned$(id)'" };
  for (const id of ['curl', 'httpie', 'powershell']) {
    const code = CODE_LANGS[id].gen(evil);
    assert.ok(!code.includes('touch'), `${id} kept the hostile method: ${code}`);
    assert.match(code, /GET/, id); // falls back to GET
  }
  // A valid but unusual token is kept, and quoted for the shell.
  assert.match(CODE_LANGS.curl.gen({ ...req, method: 'PURGE' }), /-X 'PURGE'/);
});

test('PowerShell doubles every quote variant it recognises', () => {
  const code = CODE_LANGS.powershell.gen({ ...req, headers: [['X', "a'b‘c’d‚e‛f"]] });
  assert.match(code, /'a''b‘‘c’’d‚‚e‛‛f'/);
});

test('GET without body omits -X and data', () => {
  assert.equal(CODE_LANGS.curl.gen({ method: 'GET', url: 'http://h/', headers: [], body: '', followRedirects: true, insecure: false, timeoutMs: 30000 }), "curl \\\n  'http://h/' \\\n  -L");
});

test('JS snippet is valid JavaScript with exact values', () => {
  const code = CODE_LANGS.fetch.gen(req);
  let seen;
  // Test-only: executes our own generated snippet from a fixed fixture to prove it parses.
  new Function('fetch', `return (async () => { ${code}\n})()`)(async (url, opts) => { seen = { url, opts }; return { status: 200, text: async () => '' }; });
  assert.equal(seen.url, req.url);
  assert.equal(seen.opts.body, req.body);
  assert.equal(seen.opts.headers['X-Quote'], req.headers[1][1]);
  assert.equal(seen.opts.redirect, 'manual');
});

test('every language produces output and embeds the URL', () => {
  for (const [id, l] of Object.entries(CODE_LANGS)) {
    const code = l.gen(req);
    assert.ok(code.length > 20, id);
    assert.ok(code.includes('http://h/x'), id);
  }
  assert.match(CODE_LANGS.go.gen(req), /InsecureSkipVerify: true/);
  assert.match(CODE_LANGS.python.gen(req), /verify=False/);
});
