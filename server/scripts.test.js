// Run: node --test server/scripts.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runScripts } = require('./ui/scripts.js');

const base = (over = {}) => ({
  scripts: [], vars: { global: [], collection: [], environment: null }, local: {},
  request: { method: 'GET', url: 'https://h/{{p}}', headers: [['Accept', 'json']], body: '' },
  info: { requestName: 'Login', eventName: 'test' }, ...over,
});

test("the user's x360Cookie line works unchanged", () => {
  const r = runScripts(base({
    response: { code: 204, status: 'No Content', timeMs: 5, body: '',
      headers: [['Set-Cookie', '.ASPXAUTH=abc; path=/; HttpOnly'], ['Content-Type', 'x'], ['set-cookie', 'UserBranch=1; path=/']] },
    scripts: [{ name: 'Login post-response', code: "pm.globals.set('x360Cookie', pm.response.headers.filter(h => h.key.toLowerCase() === 'set-cookie').map(h => h.value.split(';')[0]).join('; '));" }],
  }));
  assert.equal(r.error, '');
  assert.deepEqual(r.vars.global, [{ on: true, k: 'x360Cookie', v: '.ASPXAUTH=abc; UserBranch=1' }]);
});

test('scopes, variables.get order and environment without one selected', () => {
  const r = runScripts(base({
    vars: { global: [{ on: true, k: 'a', v: 'g' }], collection: [{ on: true, k: 'a', v: 'c' }], environment: null },
    scripts: [{ name: 's', code: `
      pm.variables.set('loc', 'L');
      pm.collectionVariables.set('n', 42);
      pm.environment.set('e', 1);
      console.log('a is', pm.variables.get('a'), pm.variables.replaceIn('{{loc}}-{{a}}'));
      pm.globals.unset('a');` }],
  }));
  assert.equal(r.error, '');
  assert.deepEqual(r.local, { loc: 'L' });
  assert.deepEqual(r.vars.collection, [{ on: true, k: 'a', v: 'c' }, { on: true, k: 'n', v: '42' }]);
  assert.deepEqual(r.vars.global, []);
  assert.equal(r.vars.environment, null);
  assert.match(r.logs[0].text, /no environment is selected/);
  assert.equal(r.logs[1].text, 'a is c L-c');
});

test('pre-request edits the request', () => {
  const r = runScripts(base({ scripts: [{ name: 'pre', code: `
    pm.request.headers.add({ key: 'X-Id', value: 7 });
    pm.request.headers.upsert({ key: 'accept', value: 'xml' });
    pm.request.url = pm.request.url.toString() + '?x=1';
    pm.request.body.raw = '{}';` }] }));
  assert.equal(r.requestChanged, true);
  assert.deepEqual(r.request, { method: 'GET', url: 'https://h/{{p}}?x=1', headers: [['Accept', 'xml'], ['X-Id', '7']], body: '{}' });
  assert.equal(runScripts(base({ scripts: [{ name: 'noop', code: 'pm.request.headers.get("Accept")' }] })).requestChanged, false);
});

test('pm.test, pm.expect, legacy tests[] and errors', () => {
  const r = runScripts(base({
    response: { code: 200, status: 'OK', timeMs: 5, headers: [['Set-Cookie', 'sid=1; path=/']], body: '{"user":{"id":3,"tags":["a"]}}' },
    scripts: [{ name: 'tests', code: `
      pm.test('status', () => pm.response.to.have.status(200));
      pm.test('body', () => { const j = pm.response.json(); pm.expect(j.user).to.have.property('id', 3); pm.expect(j.user.tags).to.include('a'); pm.expect(j).to.be.an('object'); });
      pm.test('fails', () => pm.expect(1).to.not.equal(1));
      pm.test('cookie', () => pm.expect(pm.cookies.get('sid')).to.eql('1'));
      tests['legacy'] = responseCode.code === 200;` }],
  }));
  assert.deepEqual(r.tests.map(t => [t.name, t.pass]), [['status', true], ['body', true], ['fails', false], ['cookie', true], ['legacy', true]]);
  assert.match(r.tests[2].error, /not to equal 1/);
  const bad = runScripts(base({ scripts: [{ name: 'A', code: 'throw new Error("boom")' }, { name: 'B', code: 'pm.globals.set("x", 1)' }] }));
  assert.equal(bad.error, 'A: boom');
  assert.deepEqual(bad.vars.global, []); // B never ran
  assert.match(runScripts(base({ scripts: [{ name: 'r', code: 'require("lodash")' }] })).error, /require\("lodash"\) isn't supported/);
  assert.match(runScripts(base({ scripts: [{ name: 'r', code: 'pm.sendRequest("x")' }] })).error, /sendRequest/);
});
