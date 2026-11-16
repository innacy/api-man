'use strict';
// Postman-compatible pre-request / post-response scripts (a pm.* subset).
// runScripts is pure so server/scripts.test.js runs it in Node; in the app it
// only ever runs inside a Web Worker (bottom of this file) that has no network.
//
// ctx: { scripts: [{ name, code }], vars: { global, collection, environment }
//        (row lists [{on,k,v}], environment null when none is active), local: {},
//        request: { method, url, headers: [[k,v]], body }, response?: { code,
//        status, timeMs, headers: [[k,v]], body }, info: { requestName, eventName } }
// returns { vars, local, request, requestChanged, tests: [{name, pass, error}],
//           logs: [{level, text}], error }

function runScripts(ctx) {
  const vars = JSON.parse(JSON.stringify(ctx.vars));
  const local = { ...ctx.local };
  const tests = [], logs = [];
  let requestChanged = false;
  const fmt = (a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();
  const log = (level) => (...a) => logs.push({ level, text: a.map(fmt).join(' ') });
  const console = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log') };

  // A Postman variable scope over a row list.
  const scope = (name) => {
    const rows = () => vars[name];
    const live = () => (rows() || []).filter(r => r.on !== false && r.k);
    return {
      get: (k) => live().find(r => r.k === k)?.v,
      has: (k) => live().some(r => r.k === k),
      set: (k, v) => {
        if (!rows()) return console.warn(`pm.${name === 'collection' ? 'collectionVariables' : name}.set("${k}") ignored: ${name === 'collection' ? 'the request is not saved in a collection' : 'no environment is selected'}.`);
        const s = v == null ? '' : typeof v === 'string' ? v : fmt(v);
        const r = rows().find(x => x.k === k);
        if (r) Object.assign(r, { v: s, on: true }); else rows().push({ on: true, k, v: s });
      },
      unset: (k) => { if (rows()) vars[name] = rows().filter(r => r.k !== k); },
      clear: () => { if (rows()) vars[name] = []; },
      toObject: () => Object.fromEntries(live().map(r => [r.k, r.v])),
    };
  };
  const globals = scope('global'), collectionVariables = scope('collection'), environment = scope('environment');
  const variables = { // local first, then Postman's order: environment, collection, global
    get: (k) => Object.hasOwn(local, k) ? local[k] : [environment, collectionVariables, globals].find(s => s.has(k))?.get(k),
    has: (k) => Object.hasOwn(local, k) || [environment, collectionVariables, globals].some(s => s.has(k)),
    set: (k, v) => { local[k] = v == null ? '' : typeof v === 'string' ? v : fmt(v); },
    unset: (k) => { delete local[k]; },
    toObject: () => ({ ...globals.toObject(), ...collectionVariables.toObject(), ...environment.toObject(), ...local }),
    replaceIn: (s) => String(s).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, n) => variables.has(n) ? variables.get(n) : m),
  };

  // Postman's PropertyList of headers: array helpers plus get/add/upsert/remove.
  const headerList = (pairs, onChange) => {
    let list = pairs.map(([key, value]) => ({ key, value }));
    const find = (k) => list.find(h => h.key.toLowerCase() === String(k).toLowerCase());
    const changed = () => onChange && onChange();
    return {
      get: (k) => find(k)?.value, has: (k) => !!find(k), all: () => list.slice(), count: () => list.length,
      toObject: () => Object.fromEntries(list.map(h => [h.key, h.value])),
      each: (f) => list.forEach(f), filter: (f) => list.filter(f), map: (f) => list.map(f), find: (f) => list.find(f),
      add: (h) => { list.push({ key: h.key, value: String(h.value ?? '') }); changed(); },
      upsert: (h) => { const e = find(h.key); if (e) e.value = String(h.value ?? ''); else list.push({ key: h.key, value: String(h.value ?? '') }); changed(); },
      remove: (k) => { list = list.filter(h => typeof k === 'function' ? !k(h) : h.key.toLowerCase() !== String(k).toLowerCase()); changed(); },
      pairs: () => list.map(h => [h.key, h.value]),
      [Symbol.iterator]: () => list[Symbol.iterator](),
    };
  };

  const rq = ctx.request;
  const reqHeaders = headerList(rq.headers || [], () => { requestChanged = true; });
  let url = rq.url, method = rq.method, body = rq.body ?? '';
  const request = {
    get method() { return method; }, set method(v) { method = String(v).toUpperCase(); requestChanged = true; },
    get url() { return { toString: () => url, raw: url, update: (v) => { url = String(v); requestChanged = true; } }; },
    set url(v) { url = String(v); requestChanged = true; },
    headers: reqHeaders,
    addHeader: (h) => reqHeaders.add(h), removeHeader: (k) => reqHeaders.remove(k), upsertHeader: (h) => reqHeaders.upsert(h),
    body: {
      get mode() { return 'raw'; },
      get raw() { return body; }, set raw(v) { body = String(v); requestChanged = true; },
      update: (v) => { body = typeof v === 'string' ? v : String(v?.raw ?? ''); requestChanged = true; },
      toString: () => body,
    },
  };

  const expect = makeExpect();
  let response;
  if (ctx.response) {
    const r = ctx.response, rh = headerList(r.headers || []);
    const status = (n) => { expect(r.code, `expected response to have status code ${n} but got ${r.code}`).to.equal(n); };
    response = {
      code: r.code, status: r.status, responseTime: r.timeMs, headers: rh,
      text: () => r.body, json: () => JSON.parse(r.body),
      get responseSize() { return r.body.length; },
      to: { have: { status, header: (k) => { if (!rh.has(k)) throw new Error(`expected response to have header "${k}"`); } },
        be: { get ok() { if (r.code < 200 || r.code >= 300) throw new Error(`expected 2xx but got ${r.code}`); return true; } } },
    };
  }
  const cookieList = () => (ctx.response?.headers || []).filter(([k]) => k.toLowerCase() === 'set-cookie')
    .map(([, v]) => { const [nv] = v.split(';'), i = nv.indexOf('='); return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() }; });
  const cookies = { get: (n) => cookieList().find(c => c.name === n)?.value, has: (n) => cookieList().some(c => c.name === n), toObject: () => Object.fromEntries(cookieList().map(c => [c.name, c.value])) };

  const pm = {
    globals, collectionVariables, environment, variables, request, response, cookies, expect,
    info: { requestName: ctx.info?.requestName || '', eventName: ctx.info?.eventName || '', iteration: 0, iterationCount: 1 },
    test: (name, fn) => {
      try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('async tests are not supported'); tests.push({ name, pass: true }); }
      catch (e) { tests.push({ name, pass: false, error: e.message }); }
    },
    sendRequest: () => { throw new Error("pm.sendRequest isn't supported in API-Man scripts."); },
  };
  // Legacy postman.* and tests[...] API, still common in older collections.
  const legacyTests = {};
  const postman = {
    setEnvironmentVariable: environment.set, getEnvironmentVariable: environment.get, clearEnvironmentVariable: environment.unset,
    setGlobalVariable: globals.set, getGlobalVariable: globals.get, clearGlobalVariable: globals.unset,
    getResponseHeader: (k) => response?.headers.get(k),
  };
  const require = (m) => { throw new Error(`require("${m}") isn't supported in API-Man scripts.`); };

  let error = '';
  for (const s of ctx.scripts) {
    if (!s.code || !s.code.trim()) continue;
    try {
      new Function('pm', 'postman', 'console', 'require', 'tests', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders',
        '"use strict";\n' + s.code)(pm, postman, console, require, legacyTests,
        ctx.response?.body, ctx.response && { code: ctx.response.code, name: ctx.response.status },
        ctx.response?.timeMs, response && response.headers.toObject());
    } catch (e) {
      error = `${s.name}: ${e && e.message || e}`;
      break; // like Postman, a failing script stops the ones after it
    }
  }
  for (const [name, pass] of Object.entries(legacyTests)) tests.push({ name, pass: !!pass, ...(pass ? {} : { error: 'tests["…"] was false' }) });
  return { vars, local, request: { method, url, headers: reqHeaders.pairs(), body }, requestChanged, tests, logs, error };
}

// makeExpect is a small chai-style pm.expect: enough for what Postman
// snippets use (equal, eql, include, property, a/an, above/below, ok…).
function makeExpect() {
  const eq = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; } };
  const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
  return function expect(actual, msg) {
    let neg = false;
    const ok = (cond, text) => { if (cond === neg) throw new Error(msg || `expected ${show(actual)} ${neg ? 'not ' : ''}${text}`); return chain; };
    const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    const chain = {
      equal: (v) => ok(actual === v, `to equal ${show(v)}`), equals: (v) => chain.equal(v), eq: (v) => chain.equal(v),
      eql: (v) => ok(eq(actual, v), `to deeply equal ${show(v)}`),
      include: (v) => ok(typeof actual === 'string' ? actual.includes(v) : Array.isArray(actual) ? actual.some(x => eq(x, v))
        : actual && typeof v === 'object' ? Object.entries(v).every(([k, x]) => eq(actual[k], x)) : false, `to include ${show(v)}`),
      property: (k, v) => ok(actual != null && Object.hasOwn(Object(actual), k) && (v === undefined || eq(actual[k], v)), `to have property ${show(k)}${v === undefined ? '' : ' of ' + show(v)}`),
      a: (t) => ok(typeOf(actual) === t.toLowerCase(), `to be a ${t}`), an: (t) => chain.a(t),
      above: (n) => ok(actual > n, `to be above ${n}`), below: (n) => ok(actual < n, `to be below ${n}`),
      least: (n) => ok(actual >= n, `to be at least ${n}`), most: (n) => ok(actual <= n, `to be at most ${n}`),
      oneOf: (list) => ok(list.some(x => eq(x, actual)), `to be one of ${show(list)}`),
      lengthOf: (n) => ok(actual != null && actual.length === n, `to have length ${n}`),
      match: (re) => ok(re.test(actual), `to match ${re}`),
      get ok() { return ok(!!actual, 'to be truthy'); }, get true() { return ok(actual === true, 'to be true'); },
      get false() { return ok(actual === false, 'to be false'); }, get null() { return ok(actual === null, 'to be null'); },
      get undefined() { return ok(actual === undefined, 'to be undefined'); }, get exist() { return ok(actual != null, 'to exist'); },
      get empty() { return ok(actual != null && (actual.length === 0 || (typeof actual === 'object' && !Object.keys(actual).length)), 'to be empty'); },
      get not() { neg = !neg; return chain; },
    };
    for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'deep', 'does']) Object.defineProperty(chain, w, { get: () => chain });
    chain.have.length = chain.lengthOf; chain.lengthOf.above = (n) => ok(actual != null && actual.length > n, `to have length above ${n}`);
    return chain;
  };
}

if (typeof module !== 'undefined') module.exports = { runScripts };

// In a Worker: remove every network and storage API (the server also sends
// this file with a CSP that blocks connections), then run one batch per message.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker',
      'BroadcastChannel', 'indexedDB', 'caches', 'WebTransport', 'Request', 'Response']) {
      try { delete o[k]; } catch {}
      try { Object.defineProperty(o, k, { value: undefined, configurable: false }); } catch {}
    }
  }
  self.onmessage = (e) => self.postMessage(runScripts(e.data));
}
