'use strict';
// Converts Postman exports (collection v2.0/v2.1, or an environment) into the
// Send tab's form fields. Pure: no DOM, so server/postman.test.js runs it in Node.

function fromPostman(json) {
  if (json && Array.isArray(json.values) && typeof json.name === 'string') {
    return { kind: json._postman_variable_scope === 'globals' ? 'globals' : 'environment', name: json.name, vars: json.values.map(v => ({ on: v.enabled !== false, k: v.key || '', v: String(v.value ?? '') })) };
  }
  if (!json || !json.info || !Array.isArray(json.item)) {
    if (json && Array.isArray(json.requests)) throw new Error('This is a Postman v1 collection. Re-export it from Postman as Collection v2.1.');
    throw new Error('Not a Postman collection (v2.x) or environment export.');
  }
  const warnings = new Set(), requests = [], folderMeta = {};
  let hasScripts = false;
  const walk = (items, folder, auth, follow) => {
    for (const it of items) {
      const itAuth = it.auth && it.auth.type !== 'inherit' ? it.auth : auth;
      const itFollow = it.protocolProfileBehavior?.followRedirects ?? follow;
      const ev = scriptsOf(it.event);
      if (ev.pre || ev.post) hasScripts = true;
      if (Array.isArray(it.item)) {
        const path = [...folder, it.name || 'Folder'];
        if (ev.pre || ev.post) folderMeta[path.map(p => '\0' + p).join('')] = ev; // same key the server builds
        walk(it.item, path, itAuth, itFollow); continue;
      }
      const data = { ...requestForm(it.request ?? '', itAuth, itFollow, warnings), preScript: ev.pre, postScript: ev.post };
      requests.push({ name: it.name || data.url || 'Untitled request', folder, method: data.method, url: data.url, data });
    }
  };
  walk(json.item, [], json.auth, json.protocolProfileBehavior?.followRedirects ?? true);
  const vars = (json.variable || []).filter(v => v.key).map(v => ({ on: !v.disabled, k: v.key, v: String(v.value ?? '') }));
  const ev = scriptsOf(json.event);
  if (ev.pre || ev.post) hasScripts = true;
  const meta = { ...(vars.length ? { vars } : {}), ...(ev.pre ? { pre: ev.pre } : {}), ...(ev.post ? { post: ev.post } : {}), ...(hasScripts ? { scriptsReview: true } : {}) };
  return {
    kind: 'collection', name: json.info.name || 'Imported collection', requests,
    meta, folderMeta, hasScripts, // collection variables stay on the collection, as in Postman
    warnings: [...warnings],
  };
}

// scriptsOf maps Postman events to { pre, post } script text.
function scriptsOf(events) {
  const code = (name) => (events || []).filter(e => e.listen === name).map(e => [].concat(e.script?.exec ?? '').join('\n')).join('\n').trim();
  return { pre: code('prerequest'), post: code('test') };
}
const eventsOf = (pre, post) => [['prerequest', pre], ['test', post]].filter(([, c]) => c?.trim())
  .map(([listen, c]) => ({ listen, script: { type: 'text/javascript', exec: c.split('\n') } }));

function urlOf(u) {
  if (typeof u === 'string') return u;
  if (!u) return '';
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
  const path = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
  const q = (u.query || []).filter(p => !p.disabled).map(p => p.key + '=' + (p.value ?? '')).join('&');
  return (u.protocol ? u.protocol + '://' : '') + host + (path ? '/' + path : '') + (q ? '?' + q : '');
}

function authOf(a, warnings) {
  if (!a || a.type === 'noauth') return { type: 'none' };
  const kv = Object.fromEntries((Array.isArray(a[a.type]) ? a[a.type] : []).map(p => [p.key, String(p.value ?? '')]));
  if (a.type === 'bearer') return { type: 'bearer', token: kv.token || '' };
  if (a.type === 'basic') return { type: 'basic', user: kv.username || '', pass: kv.password || '' };
  if (a.type === 'apikey') return { type: 'apikey', key: kv.key || '', value: kv.value || '', where: kv.in === 'query' ? 'query' : 'header' };
  warnings.add(`Auth type "${a.type}" isn't supported; those requests were imported without auth.`);
  return { type: 'none' };
}

const desc = (d) => typeof d === 'string' ? d : d?.content || '';
const rows = (list) => (list || []).map(p => ({ on: !p.disabled, k: p.key || '', v: String(p.value ?? ''), d: desc(p.description) }));

function requestForm(req, auth, follow, warnings) {
  if (typeof req === 'string') req = { url: req };
  const headers = rows(req.header);
  let method = (req.method || 'GET').toUpperCase();
  if (!/^[A-Z0-9!#%&*+.^_|~-]+$/.test(method)) { // not an HTTP token: never store it
    warnings.add('Requests with an invalid HTTP method were imported as GET.');
    method = 'GET';
  }
  const f = { method, url: urlOf(req.url), headers, auth: authOf(req.auth && req.auth.type !== 'inherit' ? req.auth : auth, warnings),
    bodyMode: 'none', body: '', form: rows([]), follow: req.protocolProfileBehavior?.followRedirects ?? follow, insecure: false, timeout: 30 };
  // The query list keeps disabled params and descriptions, which the raw URL drops.
  if (Array.isArray(req.url?.query)) f.params = rows(req.url.query);
  const b = req.body;
  if (!b || b.disabled) return f;
  if (b.mode === 'raw') {
    const lang = b.options?.raw?.language;
    const ct = (headers.find(h => h.on && h.k.toLowerCase() === 'content-type') || {}).v || '';
    f.bodyMode = lang === 'json' || /json/.test(ct) ? 'json' : lang === 'xml' || /xml/.test(ct) ? 'xml' : 'text';
    f.body = b.raw || '';
  } else if (b.mode === 'urlencoded') {
    f.bodyMode = 'form'; f.form = rows(b.urlencoded);
  } else if (b.mode === 'formdata') {
    const fields = (b.formdata || []).filter(p => p.type !== 'file');
    if (fields.length < (b.formdata || []).length) warnings.add('File fields in form-data bodies were skipped.');
    warnings.add('Form-data bodies were imported as URL-encoded forms.');
    f.bodyMode = 'form'; f.form = rows(fields);
  } else if (b.mode === 'graphql') {
    let variables = {};
    try { variables = JSON.parse(b.graphql?.variables || '{}'); } catch {}
    f.bodyMode = 'json'; f.body = JSON.stringify({ query: b.graphql?.query || '', variables }, null, 2);
  } else if (b.mode === 'file') {
    warnings.add('File bodies were skipped.');
  }
  return f;
}

// toPostman turns a collection back into a Postman v2.1 export. tree is
// { name, folders: [{ name, folders, requests }], requests }, where each
// request is { name, data } with data being the Send tab's form fields.
function toPostman(tree) {
  const kv = (list) => (list || []).filter(r => r.k).map(r => ({ key: r.k, value: r.v, ...(r.on === false ? { disabled: true } : {}), ...(r.d ? { description: r.d } : {}) }));
  const authOut = (a = {}) => a.type === 'bearer' ? { type: 'bearer', bearer: [{ key: 'token', value: a.token || '', type: 'string' }] }
    : a.type === 'basic' ? { type: 'basic', basic: [{ key: 'username', value: a.user || '', type: 'string' }, { key: 'password', value: a.pass || '', type: 'string' }] }
    : a.type === 'apikey' ? { type: 'apikey', apikey: [{ key: 'key', value: a.key || '', type: 'string' }, { key: 'value', value: a.value || '', type: 'string' }, { key: 'in', value: a.where === 'query' ? 'query' : 'header', type: 'string' }] }
    : { type: 'noauth' };
  const reqItem = ({ name, data: d }) => {
    const request = { method: d.method || 'GET', header: kv(d.headers), url: { raw: d.url || '' }, auth: authOut(d.auth) };
    const query = kv(Array.isArray(d.params) ? d.params : []);
    if (query.length) request.url.query = query;
    if (d.bodyMode === 'form') request.body = { mode: 'urlencoded', urlencoded: kv(d.form) };
    else if (d.bodyMode && d.bodyMode !== 'none') request.body = { mode: 'raw', raw: d.body || '', options: { raw: { language: d.bodyMode } } };
    const event = eventsOf(d.preScript, d.postScript);
    return { name, request, protocolProfileBehavior: { followRedirects: !!d.follow }, ...(event.length ? { event } : {}) };
  };
  const withEvents = (o, m = {}) => { const event = eventsOf(m.pre, m.post); return event.length ? { ...o, event } : o; };
  const items = (node) => [...(node.folders || []).map(f => withEvents({ name: f.name, item: items(f) }, f.meta)), ...(node.requests || []).map(reqItem)];
  const variable = kv(tree.vars);
  return withEvents({ info: { name: tree.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: items(tree), ...(variable.length ? { variable } : {}) }, tree.meta);
}

if (typeof module !== 'undefined') module.exports = { fromPostman, toPostman };
