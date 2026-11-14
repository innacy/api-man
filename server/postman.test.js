// Run: node --test server/postman.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fromPostman, toPostman } = require('./ui/postman.js');

const collection = {
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  variable: [{ key: 'host', value: 'http://localhost:8080' }, { key: 'off', value: 'x', disabled: true }],
  item: [
    {
      name: 'Items',
      item: [
        { name: 'List', request: { method: 'get', url: { raw: '{{host}}/items?page=1' }, header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }] } },
        {
          name: 'Create', event: [{ listen: 'test', script: { exec: ['pm.test("ok")'] } }],
          request: { method: 'POST', url: '{{host}}/items', body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } }, auth: { type: 'inherit' } },
        },
      ],
    },
    { name: 'Login', request: { method: 'POST', url: { protocol: 'https', host: ['api', 'shop', 'io'], path: ['login'], query: [{ key: 'v', value: '2' }] },
      auth: { type: 'basic', basic: [{ key: 'username', value: 'zoë' }, { key: 'password', value: 'pw' }] },
      body: { mode: 'formdata', formdata: [{ key: 'user', value: 'u' }, { key: 'avatar', type: 'file', src: '/x.png' }] } } },
    { name: 'Key', request: { method: 'GET', url: 'http://h/k', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'k1' }, { key: 'in', value: 'query' }] } },
      protocolProfileBehavior: { followRedirects: false } },
    { name: 'GQL', request: { method: 'POST', url: 'http://h/graphql', auth: { type: 'oauth2' }, body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } },
    { name: 'Bare', request: 'http://h/bare' },
  ],
};

test('collection: names, urls, headers, inherited auth, bodies, variables', () => {
  const c = fromPostman(collection);
  assert.equal(c.kind, 'collection');
  assert.equal(c.name, 'Shop');
  assert.deepEqual(c.requests.map(r => [r.folder.join('/'), r.name, r.method, r.url]), [
    ['Items', 'List', 'GET', '{{host}}/items?page=1'],
    ['Items', 'Create', 'POST', '{{host}}/items'],
    ['', 'Login', 'POST', 'https://api.shop.io/login?v=2'],
    ['', 'Key', 'GET', 'http://h/k'],
    ['', 'GQL', 'POST', 'http://h/graphql'],
    ['', 'Bare', 'GET', 'http://h/bare'],
  ]);
  const [list, create, login, key, gql] = c.requests.map(r => r.data);
  assert.deepEqual(list.headers.slice(0, 2), [{ on: true, k: 'Accept', v: 'application/json', d: '' }, { on: false, k: 'X-Off', v: '1', d: '' }]);
  assert.deepEqual(list.auth, { type: 'bearer', token: '{{token}}' }); // from the collection
  assert.deepEqual(create.auth, { type: 'bearer', token: '{{token}}' }); // explicit inherit
  assert.equal(create.bodyMode, 'json');
  assert.equal(create.body, '{"a":1}');
  assert.deepEqual(login.auth, { type: 'basic', user: 'zoë', pass: 'pw' });
  assert.equal(login.bodyMode, 'form');
  assert.deepEqual(login.form.filter(r => r.k), [{ on: true, k: 'user', v: 'u', d: '' }]);
  assert.deepEqual(key.auth, { type: 'apikey', key: 'X-Key', value: 'k1', where: 'query' });
  assert.equal(key.follow, false);
  assert.equal(list.follow, true); // Postman follows redirects by default
  assert.deepEqual(gql.auth, { type: 'none' });
  assert.deepEqual(JSON.parse(gql.body), { query: '{ me { id } }', variables: { a: 1 } });
  assert.deepEqual(c.environment, { name: 'Shop variables', vars: [{ on: true, k: 'host', v: 'http://localhost:8080' }, { on: false, k: 'off', v: 'x' }] });
  assert.equal(c.warnings.length, 4); // scripts, file field, form-data as urlencoded, oauth2
});

test('invalid methods are not imported', () => {
  const c = fromPostman({ info: { name: 'x' }, item: [{ name: 'evil', request: { method: 'GET;rm -rf ~', url: 'http://h' } }, { name: 'ok', request: { method: 'purge', url: 'http://h' } }] });
  assert.deepEqual(c.requests.map(r => [r.method, r.data.method]), [['GET', 'GET'], ['PURGE', 'PURGE']]);
  assert.ok(c.warnings.some(w => /method/.test(w)));
});

test('environment export', () => {
  const e = fromPostman({ name: 'Prod', values: [{ key: 'host', value: 'https://api', enabled: true }, { key: 'k', value: 3, enabled: false }], _postman_variable_scope: 'environment' });
  assert.deepEqual(e, { kind: 'environment', name: 'Prod', vars: [{ on: true, k: 'host', v: 'https://api' }, { on: false, k: 'k', v: '3' }] });
});

test('rejects other files', () => {
  assert.throws(() => fromPostman({ requests: [] }), /v1 collection/);
  assert.throws(() => fromPostman({ hello: 1 }), /Not a Postman/);
});

test('export then import gives the same requests back', () => {
  const data = (o) => ({ method: 'GET', url: '', params: [], headers: [], auth: { type: 'none' }, bodyMode: 'none', body: '', form: [], follow: false, ...o });
  const tree = { name: 'Round', requests: [{ name: 'Top', data: data({ url: 'http://h/a?x=1', params: [{ on: true, k: 'x', v: '1', d: 'the x' }, { on: false, k: 'y', v: '2', d: '' }] }) }],
    folders: [{ name: 'F', requests: [{ name: 'Post', data: data({ method: 'POST', url: 'http://h/p', headers: [{ on: false, k: 'X-A', v: '1', d: 'off' }],
      auth: { type: 'apikey', key: 'K', value: 'v', where: 'query' }, bodyMode: 'json', body: '{"a":1}', follow: true }) }],
      folders: [{ name: 'G', requests: [{ name: 'Form', data: data({ method: 'PUT', url: 'http://h/f', auth: { type: 'basic', user: 'u', pass: 'p' }, bodyMode: 'form', form: [{ on: true, k: 'a', v: 'b', d: '' }] }) }] }] }] };
  const back = fromPostman(JSON.parse(JSON.stringify(toPostman(tree))));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.requests.map(r => [r.folder.join('/'), r.name]), [['F/G', 'Form'], ['F', 'Post'], ['', 'Top']]);
  const [form, post, top] = back.requests.map(r => r.data);
  assert.deepEqual(top.params, tree.requests[0].data.params);
  assert.deepEqual(post.headers, [{ on: false, k: 'X-A', v: '1', d: 'off' }]);
  assert.deepEqual(post.auth, { type: 'apikey', key: 'K', value: 'v', where: 'query' });
  assert.equal(post.bodyMode, 'json'); assert.equal(post.body, '{"a":1}'); assert.equal(post.follow, true);
  assert.deepEqual(form.auth, { type: 'basic', user: 'u', pass: 'p' });
  assert.equal(form.bodyMode, 'form'); assert.deepEqual(form.form, [{ on: true, k: 'a', v: 'b', d: '' }]);
});
