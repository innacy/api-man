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
    '-X', 'POST', '--url', req.url,
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
  assert.equal(CODE_LANGS.curl.gen({ method: 'GET', url: 'http://h/', headers: [], body: '', followRedirects: true, insecure: false, timeoutMs: 30000 }), "curl \\\n  --url 'http://h/' \\\n  -L");
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

test('a hostile URL or header name cannot become a curl/HTTPie option or field', () => {
  const evil = { ...req, body: '', url: 'http://h/', headers: [['x=@/etc/passwd', 'v'], ['Ok', 'y']] };
  const run = (id, r) => execFileSync('sh', ['-c', CODE_LANGS[id].gen(r).replace(/^(curl|http)/, "printf '%s\\n'")]).toString().trimEnd().split('\n');
  const curl = run('curl', evil);
  assert.equal(curl[curl.indexOf('http://h/') - 1], '--url', 'curl URL must follow --url');
  const httpie = run('httpie', evil);
  assert.equal(httpie[httpie.indexOf('http://h/') - 2], '--', 'HTTPie positionals must follow --');
  for (const id of ['curl', 'httpie']) {
    const code = CODE_LANGS[id].gen(evil);
    assert.ok(!code.includes('passwd'), `${id} kept a non-token header name: ${code}`);
    assert.match(code, /Ok: ?y/, id);
    assert.ok(!CODE_LANGS[id].gen({ ...evil, url: '-o/tmp/pwned' }).includes('pwned'), `${id} emitted an option-like URL`);
  }
});

test('non-http(s) URLs are refused in shell snippets', () => {
  for (const id of ['curl', 'httpie']) {
    const code = CODE_LANGS[id].gen({ ...req, url: 'file:///etc/passwd' });
    assert.ok(!code.includes('passwd'), `${id}: ${code}`);
  }
});

test('HTTPie header values starting with = or @ are escaped, not read as file/JSON items', () => {
  const r = { ...req, body: '', url: 'http://h/', headers: [['X', '=@/etc/passwd'], ['Y', '@/etc/passwd'], ['Z', 'a=@b']] };
  const args = execFileSync('sh', ['-c', CODE_LANGS.httpie.gen(r).replace(/^http/, "printf '%s\\n'")]).toString().trimEnd().split('\n');
  assert.ok(args.includes('X:\\=@/etc/passwd'), args.join(' '));
  assert.ok(args.includes('Y:\\@/etc/passwd'), args.join(' '));
  assert.ok(args.includes('Z:a=@b'), args.join(' ')); // only the leading separator matters
});

test('authFromHeaders moves Basic and Bearer into Auth', () => {
  const { authFromHeaders } = require('./ui/codegen.js');
  const b64 = Buffer.from('APIUser:pa:ss').toString('base64');
  assert.deepStrictEqual(authFromHeaders([['Authorization', 'Basic ' + b64], ['Accept', 'application/json']]),
    { auth: { type: 'basic', user: 'APIUser', pass: 'pa:ss' }, headers: [['Accept', 'application/json']] });
  assert.deepStrictEqual(authFromHeaders([['authorization', 'Bearer abc.def']]), { auth: { type: 'bearer', token: 'abc.def' }, headers: [] });
  const digest = [['Authorization', 'Digest username="x"']];
  assert.deepStrictEqual(authFromHeaders(digest), { auth: { type: 'none' }, headers: digest });
  const bad = [['Authorization', 'Basic !!notbase64']];
  assert.deepStrictEqual(authFromHeaders(bad), { auth: { type: 'none' }, headers: bad });
});
