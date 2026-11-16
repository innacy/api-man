'use strict';
// Send view: request tabs, collection tree, request/response panes.
// Reuses $, esc, ms, go and probeTimingHTML from app.js (classic scripts share globals).

const PRETTY_MAX = 2e6; // above this, Pretty falls back to plain text to stay fast
// Above this, Pretty JSON is indented but not coloured/foldable: laying out
// ~150k highlighted spans costs ~1.3s per MB in Chrome, plain text ~0.1s.
const HILITE_MAX = 150e3;
const TABS_KEY = 'apiperf-send-tabs', PREFS_KEY = 'apiperf-send-prefs', OLD_DRAFT_KEY = 'apiperf-send-draft';
const RESP_KEY = 'apiperf-resp-', RESP_KEEP_MAX = 1 << 20; // each tab's last response is kept across reloads up to 1 MB
const blank = () => ({ on: true, k: '', v: '', d: '' });
// The fields that make up a request; what Save stores and what "unsaved" compares.
const FORM_KEYS = ['method', 'url', 'params', 'headers', 'auth', 'bodyMode', 'body', 'form', 'follow', 'insecure', 'timeout'];
const newTab = (extra = {}) => ({
  tid: Math.random().toString(36).slice(2),
  method: 'GET', url: '', params: [], headers: [], auth: { type: 'none' }, bodyMode: 'none', body: '', form: [],
  follow: false, insecure: false, timeout: 30,
  reqTab: 'params', resTab: 'body', view: 'pretty', fmt: 'auto', bulk: {},
  savedId: null, name: '', collectionId: null, folderId: null, snapshot: '', ...extra,
});
let tabs = [newTab()], active = 0, S = tabs[0];
// Preferences shared by every tab.
const P = { envId: null, collapsed: {}, codeLang: 'curl', wrap: false, split: .5, side: 'tree', sideHidden: false, resDown: false, sideW: 260, resHidden: false };
const resp = {}; // tab id → { res, bytes, text, sent } (kept in memory only)
let res = null, bytes = null, text = '', sent = null, blobURL = null;
let envs = [], lib = { collections: [], folders: [], requests: [] }, hist = [];

const formOf = (t) => Object.fromEntries(FORM_KEYS.map(k => [k, t[k]]));
const formData = () => formOf(S);
const isDirty = (t) => t.savedId ? JSON.stringify(formOf(t)) !== t.snapshot : !!t.url.trim();
const isPristine = (t) => !t.savedId && !t.url.trim() && !resp[t.tid]?.res;

// ---------- pure helpers ----------
// Saved/imported data is untrusted: force timeout to a number before it reaches HTML.
const clampTimeout = (v) => Math.min(120, Math.max(1, Math.round(+v) || 30));
const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const ICO = {
  chev: '<svg class="ico chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>',
  more: '<svg class="ico" viewBox="0 0 16 16"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/></svg>',
  x: '<svg class="ico" viewBox="0 0 16 16" style="width:13px;height:13px"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  trash: '<svg class="ico" viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.8 9.5h5.4l.8-9.5"/></svg>',
  plus: '<svg class="ico" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  back: '<svg class="ico" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>',
};

function paramsFromURL(url) {
  const q = url.split('#')[0], i = q.indexOf('?');
  if (i < 0) return [];
  return q.slice(i + 1).split('&').filter(Boolean).map(p => {
    const j = p.indexOf('=');
    return { on: true, k: dec(j < 0 ? p : p.slice(0, j)), v: j < 0 ? '' : dec(p.slice(j + 1)), d: '' };
  });
}
function urlWithParams(url, rows) {
  const hashAt = url.indexOf('#'), hash = hashAt < 0 ? '' : url.slice(hashAt);
  const base = (hashAt < 0 ? url : url.slice(0, hashAt)).split('?')[0];
  // Encode, but leave {{variables}} readable so they still resolve at send time.
  const enc = (s) => encodeURIComponent(s).replace(/%7B%7B(.+?)%7D%7D/g, (_, v) => '{{' + decodeURIComponent(v) + '}}');
  const q = rows.filter(r => r.on !== false && r.k).map(r => enc(r.k) + '=' + enc(r.v)).join('&');
  return base + (q ? '?' + q : '') + hash;
}
// The URL holds the enabled params; descriptions and disabled params live
// only in the table, so keep them when the URL is edited by hand.
function mergeParams(url, old) {
  const on = old.filter(r => r.on !== false && r.k);
  const fromURL = paramsFromURL(url).map((p, i) => ({ ...p, d: on[i]?.k === p.k ? on[i].d || '' : '' }));
  return [...fromURL, ...old.filter(r => r.on === false && r.k)];
}

// subst replaces {{name}} with the active environment's value; names it
// can't resolve are left as-is (like Postman) and collected in missing.
function subst(s, vars, missing) {
  return String(s).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name) => {
    if (Object.hasOwn(vars, name)) return vars[name];
    missing.add(name);
    return m;
  });
}
const activeVars = () => Object.fromEntries((envs.find(e => e.id === P.envId)?.vars || []).filter(v => v.on && v.k).map(v => [v.k, v.v]));

// prettyJSON re-indents JSON from its tokens instead of JSON.parse +
// stringify, so big integers and number formatting survive untouched.
// Containers are wrapped in .jf spans: clicking the bracket folds them.
// plain=true returns indented text only (no HTML) for large bodies.
function prettyJSON(src, plain = false) {
  const toks = src.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) || [];
  let out = '', depth = 0;
  const nl = () => '\n' + '  '.repeat(depth);
  const span = (cls, t) => plain ? t : `<span class="${cls}">${esc(t)}</span>`;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '{' || t === '[') {
      if (toks[i + 1] === (t === '{' ? '}' : ']')) { out += t + toks[++i]; continue; }
      depth++;
      out += (plain ? t : `<span class="jf"><span class="fold">${t}</span><span class="c">`) + nl();
    } else if (t === '}' || t === ']') { depth--; out += nl() + (plain ? t : `</span>${t}</span>`); }
    else if (t === ',') out += ',' + nl();
    else if (t === ':') out += ': ';
    else if (t[0] === '"') out += span(toks[i + 1] === ':' ? 'j-k' : 'j-s', t);
    else out += span(t === 'true' || t === 'false' ? 'j-b' : t === 'null' ? 'j-null' : 'j-n', t);
  }
  return out;
}
// indentXML breaks minified XML onto one tag per line. HTML is left alone:
// void tags (<br>, <img>) would throw the depth off.
function indentXML(s) {
  let d = 0;
  return s.replace(/>\s*</g, '>\n<').split('\n').map(l => {
    if (/^<\//.test(l)) d = Math.max(d - 1, 0);
    const line = '  '.repeat(d) + l;
    if (/^<[^!?\/][^>]*[^\/]>$/.test(l)) d++;
    return line;
  }).join('\n');
}
const highlightMarkup = (s) => s.split(/(<[^>]*>)/).map((p, i) =>
  i % 2 ? `<span class="m-t">${esc(p).replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<span class="j-s">$1</span>')}</span>` : esc(p)).join('');
function hexdump(b) {
  const n = Math.min(b.length, 65536);
  let o = '';
  for (let i = 0; i < n; i += 16) {
    const row = [...b.subarray(i, Math.min(i + 16, n))];
    o += i.toString(16).padStart(8, '0') + '  ' + row.map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(48) +
      '  ' + row.map(x => x > 31 && x < 127 ? String.fromCharCode(x) : '.').join('') + '\n';
  }
  return b.length > n ? o + `… ${b.length - n} more bytes (Save to get them all)` : o;
}

// ---------- request ----------
// JSON bodies may have whole lines commented out with // (Ctrl+/); those
// lines are left out of what's sent.
const isCommentLine = (l) => /^\s*\/\//.test(l);
const stripComments = (s) => s.split('\n').filter(l => !isCommentLine(l)).join('\n');
const contentTypes = { json: 'application/json', xml: 'application/xml', text: 'text/plain', form: 'application/x-www-form-urlencoded' };
// buildRequest turns the form into a /api/send body with {{variables}}
// resolved; unresolved names are added to missing.
function buildRequest(missing = new Set()) {
  const vars = activeVars(), sub = (s) => subst(s ?? '', vars, missing);
  let url = sub(S.url.trim());
  const headers = S.headers.filter(r => r.on && r.k.trim()).map(r => [sub(r.k.trim()), sub(r.v)]);
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
  const a = Object.fromEntries(Object.entries(S.auth).map(([k, v]) => [k, k === 'type' || k === 'where' ? v : sub(v)]));
  if (a.type === 'bearer' && a.token && !has('authorization')) headers.push(['Authorization', 'Bearer ' + a.token]);
  if (a.type === 'basic' && !has('authorization'))
    headers.push(['Authorization', 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode((a.user || '') + ':' + (a.pass || ''))))]);
  if (a.type === 'apikey' && a.key) {
    if (a.where === 'query') url = urlWithParams(url, [...paramsFromURL(url), { k: a.key, v: a.value || '' }]);
    else if (!has(a.key.toLowerCase())) headers.push([a.key, a.value || '']);
  }
  let body = '';
  if (S.bodyMode === 'form') body = new URLSearchParams(S.form.filter(r => r.on && r.k).map(r => [sub(r.k), sub(r.v)])).toString();
  else if (S.bodyMode === 'json') body = sub(stripComments(S.body));
  else if (S.bodyMode !== 'none') body = sub(S.body);
  if (S.bodyMode !== 'none' && !has('content-type')) headers.push(['Content-Type', contentTypes[S.bodyMode]]);
  return { method: S.method.trim().toUpperCase() || 'GET', url, headers, body,
    followRedirects: S.follow, insecure: S.insecure, timeoutMs: clampTimeout(S.timeout) * 1000 };
}

// Key/value tables work like Postman: one empty row always sits at the end;
// typing in it turns it into a real row and a fresh empty one appears below.
// The empty row has no checkbox or remove button; every real row does.
const isBlank = (r) => !r.k && !r.v && !r.d;
const withGhost = (rows) => rows.length && isBlank(rows[rows.length - 1]) ? rows : [...rows, blank()];
const kvHTML = (name, rows, keyLabel = 'Name') => { const all = withGhost(rows), g = all.length - 1;
  return `<table class="kv" data-kv="${name}"><colgroup><col class="cc"><col><col><col><col class="dc"></colgroup>
    <tr><th class="cc"></th><th>${keyLabel}</th><th>Value</th><th>Description</th><th class="dc"></th></tr>` + all.map((r, i) =>
    `<tr class="${i === g ? 'ghost-row' : r.on === false ? 'off' : ''}">
      <td class="cc">${i < g ? `<input type="checkbox" data-i="${i}" data-f="on" ${r.on !== false ? 'checked' : ''} aria-label="Enabled">` : ''}</td>
      <td><input data-i="${i}" data-f="k" value="${esc(r.k)}" placeholder="${i === g ? keyLabel : ''}" spellcheck="false"></td>
      <td><input data-i="${i}" data-f="v" value="${esc(r.v)}" placeholder="${i === g ? 'Value' : ''}" spellcheck="false"></td>
      <td><input data-i="${i}" data-f="d" value="${esc(r.d || '')}" placeholder="${i === g ? 'Description' : ''}" spellcheck="false"></td>
      <td class="dc">${i < g ? `<button class="ib" data-i="${i}" data-del title="Remove">${ICO.trash}</button>` : ''}</td></tr>`).join('') + '</table>'; };
// Applies one table edit; returns true when the empty last row was used, so the caller re-renders to add a new one.
function kvEdit(rows, el) {
  const i = +el.dataset.i, f = el.dataset.f, wasGhost = i >= rows.length - 1 && (!rows[i] || isBlank(rows[i]));
  if (!rows[i]) rows.push(blank());
  rows[i][f] = f === 'on' ? el.checked : el.value;
  return (wasGhost && !isBlank(rows[i])) || f === 'on';
}
function refocus(sel, el) {
  const again = $(`${sel} [data-i="${el.dataset.i}"][data-f="${el.dataset.f}"]`);
  if (!again) return;
  again.focus(); if (el.dataset.f !== 'on') again.setSelectionRange(again.value.length, again.value.length);
}
// Bulk edit: one "key: value" per line, "//" in front = disabled. Descriptions
// aren't in the text, so they're carried over by key.
const toBulk = (rows) => rows.filter(r => r.k || r.v).map(r => (r.on === false ? '//' : '') + r.k + ': ' + r.v).join('\n');
function fromBulk(txt, old) {
  return txt.split('\n').filter(l => l.trim()).map(l => {
    const off = /^\s*\/\//.test(l), body = l.replace(/^\s*\/\/\s*/, ''), j = body.indexOf(':');
    const k = (j < 0 ? body : body.slice(0, j)).trim(), v = j < 0 ? '' : body.slice(j + 1).trim();
    return { on: !off, k, v, d: old.find(r => r.k === k)?.d || '' };
  });
}
const kvSection = (name, title, keyLabel) => `<div class="sec">${title}<button class="link" data-bulk="${name}">${S.bulk[name] ? 'Key/value edit' : 'Bulk edit'}</button></div>` +
  (S.bulk[name] ? `<textarea class="bulk" data-bulktext="${name}" spellcheck="false" placeholder="key: value&#10;//disabled: value">${esc(toBulk(S[name]))}</textarea>` : kvHTML(name, S[name], keyLabel));
const opt = (v, cur, label = v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;

function renderReqTabs() {
  const n = (rows) => rows.filter(r => r.on !== false && r.k).length;
  const counts = { params: n(S.params), headers: n(S.headers), body: S.bodyMode !== 'none' ? '●' : 0, auth: S.auth.type !== 'none' ? '●' : 0 };
  document.querySelectorAll('#sx-reqtabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === S.reqTab);
    b.innerHTML = b.textContent.replace(/[\d●]+$/, '') + (counts[b.dataset.v] ? `<sup>${counts[b.dataset.v]}</sup>` : '');
  });
}
function renderReqPane() {
  renderReqTabs();
  const a = S.auth, pane = $('#sx-reqpane');
  if (S.reqTab === 'params') pane.innerHTML = kvSection('params', 'Query', 'Name') +
    '<p class="hint">Enabled params are written into the URL; untick one to leave it out without deleting it.</p>';
  else if (S.reqTab === 'headers') pane.innerHTML = kvSection('headers', 'Headers', 'Name') +
    '<p class="hint">Content-Type and Authorization are added from the Body and Auth tabs unless set here.</p>';
  else if (S.reqTab === 'auth') pane.innerHTML = `<div class="sec">Auth</div><div class="sx-row"><select data-s="auth.type">${opt('none', a.type, 'No auth')}${opt('bearer', a.type, 'Bearer token')}${opt('basic', a.type, 'Basic auth')}${opt('apikey', a.type, 'API key')}</select></div>` +
    (a.type === 'bearer' ? `<div class="sx-row"><input data-s="auth.token" value="${esc(a.token || '')}" placeholder="Token" style="flex:1" spellcheck="false"></div>` :
     a.type === 'basic' ? `<div class="sx-row"><input data-s="auth.user" value="${esc(a.user || '')}" placeholder="Username"><input data-s="auth.pass" type="password" value="${esc(a.pass || '')}" placeholder="Password"></div>` :
     a.type === 'apikey' ? `<div class="sx-row"><input data-s="auth.key" value="${esc(a.key || '')}" placeholder="Key name (e.g. X-API-Key)"><input data-s="auth.value" value="${esc(a.value || '')}" placeholder="Value" style="flex:1"><select data-s="auth.where">${opt('header', a.where, 'in header')}${opt('query', a.where, 'in query')}</select></div>` : '');
  else if (S.reqTab === 'body') pane.innerHTML = `<div class="sec"><span class="seg" id="sx-bodymode">${['none', 'json', 'text', 'xml', 'form'].map(m =>
      `<button data-v="${m}" class="${S.bodyMode === m ? 'on' : ''}">${{ none: 'None', json: 'JSON', text: 'Text', xml: 'XML', form: 'Form' }[m]}</button>`).join('')}</span>
      ${S.bodyMode === 'json' ? '<button class="link" id="sx-beautify">Beautify</button>' : ''}</div>` +
    (S.bodyMode === 'form' ? kvSection('form', 'Form fields', 'Name') :
     S.bodyMode === 'none' ? '<p class="muted" style="margin:0">This request has no body.</p>' :
     `<textarea class="sx-body" data-s="body" spellcheck="false">${esc(S.body)}</textarea>` +
     (S.bodyMode === 'json' ? '<p class="hint"><kbd>Ctrl</kbd> + <kbd>/</kbd> comments out lines; they are left out when sending. <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> beautifies.</p>' : ''));
  else if (S.reqTab === 'code') {
    const lang = CODE_LANGS[P.codeLang] ? P.codeLang : 'curl', missing = new Set();
    const code = CODE_LANGS[lang].gen(buildRequest(missing));
    pane.innerHTML = `<div class="sx-row" style="margin-top:6px"><select data-p="codeLang" aria-label="Language">${Object.entries(CODE_LANGS).map(([id, l]) => opt(id, lang, l.label)).join('')}</select>
        <button class="ghost" id="sx-codecopy">Copy</button>
        ${missing.size ? `<span class="muted sx-codenote">Left as-is (${P.envId ? 'not in this environment' : 'no environment selected'}): ${esc([...missing].map(v => `{{${v}}}`).join(', '))}</span>` : ''}</div>
      <pre class="code boxed" id="sx-code"></pre>`;
    $('#sx-code').textContent = code;
  }
  else pane.innerHTML = `<div class="sec">Settings</div><label class="sx-row"><input type="checkbox" data-s="follow" ${S.follow ? 'checked' : ''}> Follow redirects</label>
    <label class="sx-row"><input type="checkbox" data-s="insecure" ${S.insecure ? 'checked' : ''}> Skip TLS certificate check <span class="muted">(self-signed dev servers only)</span></label>
    <label class="sx-row">Timeout <input type="number" data-s="timeout" min="1" max="120" value="${clampTimeout(S.timeout)}"> seconds</label>`;
}

// ---------- persistence of open tabs ----------
function saveState() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active }));
    localStorage.setItem(PREFS_KEY, JSON.stringify(P));
  } catch {}
  renderChrome();
  if (S.reqTab === 'code' && $('#sx-code')) renderReqPane(); // keep the snippet in step with URL/method/env edits
}
function setPath(path, v) {
  const [a, b] = path.split('.');
  if (b) S[a][b] = v; else S[a] = v;
}
function syncURLFromParams() { S.url = urlWithParams(S.url, S.params); $('#sx-url').value = S.url; renderURL(); }

// Edits to a key/value table. A new blank row appears once the last one is used.
function onKV(el) {
  const name = el.closest('[data-kv]').dataset.kv, grew = kvEdit(S[name], el);
  if (name === 'params') syncURLFromParams();
  if (grew) { renderReqPane(); refocus('#sx-reqpane', el); } else renderReqTabs();
  saveState();
}

const reqPane = $('#sx-reqpane');
reqPane.addEventListener('input', (e) => {
  const el = e.target;
  if (el.closest('[data-kv]') && el.dataset.f) return onKV(el);
  if (el.dataset.bulktext) {
    const name = el.dataset.bulktext;
    S[name] = fromBulk(el.value, S[name]);
    if (name === 'params') syncURLFromParams();
    renderReqTabs(); saveState();
    return;
  }
  if (el.dataset.p) { P[el.dataset.p] = el.value; renderReqPane(); saveState(); return; }
  if (!el.dataset.s) return;
  setPath(el.dataset.s, el.type === 'checkbox' ? el.checked : el.value);
  if (el.dataset.s === 'body' && /^Body is not valid JSON/.test($('#sx-err').textContent)) $('#sx-err').textContent = '';
  if (el.dataset.s === 'auth.type') renderReqPane(); else renderReqTabs();
  saveState();
});
reqPane.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
reqPane.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const name = del.closest('[data-kv]').dataset.kv;
    S[name].splice(+del.dataset.i, 1);
    if (name === 'params') syncURLFromParams();
    renderReqPane(); saveState();
    return;
  }
  const bulk = e.target.closest('[data-bulk]');
  if (bulk) { S.bulk[bulk.dataset.bulk] = !S.bulk[bulk.dataset.bulk]; renderReqPane(); saveState(); return; }
  if (e.target.id === 'sx-codecopy') {
    navigator.clipboard.writeText($('#sx-code').textContent).then(() => toast('Code copied to the clipboard.'));
    return;
  }
  const mode = e.target.closest('#sx-bodymode button');
  if (mode) { S.bodyMode = mode.dataset.v; renderReqPane(); saveState(); return; }
  if (e.target.id === 'sx-beautify') beautify();
});
// beautifyJSON re-indents JSON from its tokens, keeping // comment lines
// (each on its own line at the current depth) and the exact number text.
function beautifyJSON(src) {
  const toks = src.match(/\/\/[^\n]*|"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) || [];
  let out = '', d = 0, fresh = true; // fresh: at the start of a new, indented line
  const indent = () => '  '.repeat(d);
  const newline = () => { if (fresh) out = out.replace(/ *$/, indent()); else { out += '\n' + indent(); fresh = true; } };
  const put = (t) => { out += t; fresh = false; };
  for (const t of toks) {
    if (t.startsWith('//')) { if (out) newline(); put(t.trim()); newline(); }
    else if (t === '{' || t === '[') { put(t); d++; newline(); }
    else if (t === '}' || t === ']') {
      d--;
      if (fresh && /[{\[]\s*$/.test(out)) { out = out.replace(/\s*$/, ''); put(t); } // empty {} / []
      else { newline(); put(t); }
    }
    else if (t === ',') { put(','); newline(); }
    else if (t === ':') put(': ');
    else put(t);
  }
  return out.replace(/\s+$/, '');
}
function beautify() {
  if (S.bodyMode !== 'json') return;
  const hasComments = S.body.split('\n').some(isCommentLine);
  try { JSON.parse(stripComments(S.body)); } catch (err) {
    // Commenting out the last field leaves a trailing comma; still tidy it.
    if (!hasComments) { $('#sx-err').textContent = 'Body is not valid JSON: ' + err.message; return; }
  }
  S.body = beautifyJSON(S.body); renderReqPane(); saveState(); $('#sx-err').textContent = '';
}
// Body editor keys: Ctrl+/ toggles // on the selected lines (JSON), Tab indents.
// execCommand keeps the browser's undo history working.
reqPane.addEventListener('keydown', (e) => {
  const ta = e.target;
  if (!ta.classList?.contains('sx-body')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === '/' && S.bodyMode === 'json') {
    e.preventDefault();
    const v = ta.value, a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let b = v.indexOf('\n', Math.max(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0), a));
    if (b < 0) b = v.length;
    const s0 = ta.selectionStart, e0 = ta.selectionEnd;
    const lines = v.slice(a, b).split('\n'), all = lines.filter(l => l.trim()).every(isCommentLine);
    const changed = lines.map(l => all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l);
    const out = changed.join('\n');
    ta.setSelectionRange(a, b);
    document.execCommand('insertText', false, out);
    // Put the caret/selection back where it was, shifted by what was added or removed.
    const lead = lines[0].match(/^\s*/)[0].length, d1 = changed[0].length - lines[0].length, dt = out.length - (b - a);
    const start = s0 - a > lead ? Math.max(a + lead, s0 + d1) : s0;
    ta.setSelectionRange(start, s0 === e0 ? start : e0 + dt);
  } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});
$('#sx-reqtabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.reqTab = b.dataset.v; renderReqPane(); saveState(); } };
$('#sx-codebtn').onclick = () => { S.reqTab = 'code'; renderReqPane(); saveState(); };

// A <select> (a datalist filters its options by the current value, so it
// looked empty once a method was set). Methods from a pasted curl or an
// import that aren't in the list are added as an extra option.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
function renderMethod() {
  const m = (S.method || 'GET').toUpperCase();
  $('#sx-method').innerHTML = [...METHODS, ...(METHODS.includes(m) ? [] : [m])].map(x => opt(esc(x), m)).join('');
  $('#sx-method').className = 'm-' + esc(m);
}
$('#sx-method').onchange = (e) => { S.method = e.target.value; renderMethod(); saveState(); };

// The URL box is a transparent input over a highlighted copy, so {{variables}}
// show green when the active environment defines them and red when not.
function renderURL() {
  const vars = activeVars();
  $('#sx-urlhl').firstChild.innerHTML = esc(S.url).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, n) =>
    `<span class="var${Object.hasOwn(vars, n) ? '' : ' miss'}">${m}</span>`) + ' ';
  syncURLScroll();
}
const syncURLScroll = () => { $('#sx-urlhl').firstChild.style.transform = `translateX(${-$('#sx-url').scrollLeft}px)`; };
$('#sx-url').addEventListener('scroll', syncURLScroll);
$('#sx-url').addEventListener('keyup', syncURLScroll);
$('#sx-url').oninput = (e) => {
  S.url = e.target.value; S.params = mergeParams(S.url, S.params);
  renderURL();
  if (S.reqTab === 'params') renderReqPane(); else renderReqTabs();
  saveState();
};
// Pasting a curl command into the URL box fills the whole form.
$('#sx-url').addEventListener('paste', async (e) => {
  const pasted = e.clipboardData.getData('text');
  if (!/^\s*curl\s/.test(pasted)) return;
  e.preventDefault();
  const r = await fetch('/api/curl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ curl: pasted }) });
  const j = await r.json();
  if (!r.ok) { $('#sx-err').textContent = 'Could not read that curl: ' + j.error; return; }
  $('#sx-err').textContent = '';
  const ct = (j.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  Object.assign(S, {
    method: j.method, url: j.url, params: paramsFromURL(j.url), follow: j.followRedirects, insecure: j.insecure, auth: { type: 'none' },
    headers: j.headers.map(([k, v]) => ({ on: true, k, v, d: '' })), body: j.body,
    bodyMode: !j.body ? 'none' : /json/.test(ct) ? 'json' : /xml/.test(ct) ? 'xml' : 'text',
  });
  renderEditor(); saveState();
});

async function sendNow() {
  const btn = $('#sx-send');
  if (btn.disabled) return;
  if (P.resHidden) toggleRes(); // a result you can't see is no result
  $('#sx-err').textContent = '';
  const tab = S;
  const missing = new Set(), req = buildRequest(missing);
  const urlVars = [...new Set([...req.url.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(m => `{{${m[1]}}}`))];
  if (urlVars.length) {
    $('#sx-err').textContent = `The URL uses ${urlVars.join(', ')}, which ${P.envId ? "isn't set in the active environment" : 'needs an environment (none selected)'}.`;
    return;
  }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    resp[tab.tid] = respFrom(j, req);
    keepResp(tab.tid, j, req);
    tab.fmt = 'auto';
    if (tab === S) {
      ({ res, bytes, text, sent } = resp[tab.tid]);
      renderRes();
      if (missing.size) $('#sx-err').textContent = `Sent with unresolved variables: ${[...missing].map(n => `{{${n}}}`).join(', ')}. Pick or edit an environment.`;
    }
  } catch (err) {
    if (tab === S) $('#sx-err').textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Send';
    loadReqHistory();
  }
}
$('#sx-send').onclick = sendNow;
const onSend = () => !$('#view-send').classList.contains('hidden');
// Keyboard shortcuts. Alt combinations use e.code so they work whatever
// character the layout puts on Alt+key.
const SHORTCUTS = [
  ['Ctrl Enter', 'Send the request'], ['Ctrl S', 'Save'], ['Ctrl Shift S', 'Save as new request'],
  ['Ctrl K', 'Search requests, environments and actions (also Ctrl P)'], ['Ctrl L', 'Go to the URL box'],
  ['Ctrl N', 'New request tab (also Ctrl T)'], ['Ctrl W', 'Close the tab (also Ctrl F4)'], ['Ctrl Shift T', 'Reopen the last closed tab'],
  ['Ctrl Tab', 'Next tab (also Ctrl PgDn)'], ['Ctrl Shift Tab', 'Previous tab (also Ctrl PgUp)'], ['Ctrl 1 … 8', 'Go to tab 1 … 8'], ['Ctrl 9', 'Go to the last tab'],
  ['Ctrl /', 'Comment out lines in a JSON body'], ['Shift Alt F', 'Format the JSON body (also Ctrl Shift F)'], ['Tab', 'Indent in the body editor'],
  ['Ctrl B', 'Show or hide the sidebar'], ['Ctrl J', 'Show or hide the response'], ['Alt L', 'Response on the right or below'], ['Alt Z', 'Wrap or unwrap the response'],
  ['F2', 'Rename the selected sidebar item'], ['F1', 'Show these shortcuts (also ?)'], ['Esc', 'Close menus and dialogs'],
];
function showShortcuts() {
  $('#sx-keys').innerHTML = SHORTCUTS.map(([k, d]) => `<tr><td>${k.split(' ').map(x => x === '…' ? '…' : `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${esc(d)}</td></tr>`).join('');
  $('#sx-keysdlg').showModal();
}
function setWrap(on) { P.wrap = on; if (res && S.resTab === 'body') renderRes(); saveState(); }
// Desktop-standard shortcuts (VS Code / Postman conventions). The old Alt
// variants stay as aliases: in a plain browser tab (-headless) Chrome reserves
// Ctrl+N/T/W and never hands them to the page.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey, typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const alt = e.altKey && !mod, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && (key === 'k' || key === 'p')) { e.preventDefault(); return openPalette(); }
  if (e.key === 'Escape') { hideMenu(); closePalette(); }
  if (document.querySelector('dialog[open]') || !$('#pal').classList.contains('hidden')) return;
  if ((mod && !e.altKey && !e.shiftKey && key === 'b') || (alt && e.code === 'KeyB')) { e.preventDefault(); P.sideHidden = !P.sideHidden; applySide(); return saveState(); }
  if (e.key === 'F1' || (!typing && !mod && !e.altKey && e.key === '?')) { e.preventDefault(); return showShortcuts(); }
  if (!onSend()) return;
  const go = (i) => { e.preventDefault(); if (tabs.length) switchTab((i + tabs.length) % tabs.length); };
  if (mod && e.key === 'Enter') { e.preventDefault(); sendNow(); }
  else if (mod && !e.altKey && key === 's') { e.preventDefault(); save(e.shiftKey); }
  else if (((e.shiftKey && e.altKey && !mod && e.code === 'KeyF') || (mod && e.shiftKey && key === 'f')) && S.bodyMode === 'json' && S.reqTab === 'body') { e.preventDefault(); beautify(); }
  else if (mod && !e.shiftKey && !e.altKey && key === 'l') { e.preventDefault(); $('#sx-url').focus(); $('#sx-url').select(); }
  else if ((mod && !e.altKey && !e.shiftKey && (key === 'n' || key === 't')) || (alt && e.code === 'KeyN')) { e.preventDefault(); newRequest(); }
  else if ((mod && !e.altKey && !e.shiftKey && (key === 'w' || e.key === 'F4')) || (alt && e.code === 'KeyW')) { e.preventDefault(); closeTab(active); }
  else if ((mod || e.altKey) && e.shiftKey && e.code === 'KeyT') { e.preventDefault(); reopenTab(); }
  else if (mod && e.key === 'Tab') go(active + (e.shiftKey ? -1 : 1));
  else if (mod && e.key === 'PageDown') go(active + 1);
  else if (mod && e.key === 'PageUp') go(active - 1);
  else if (mod && !e.altKey && /^Digit[1-9]$/.test(e.code)) { const n = +e.code.slice(5); if (n === 9 || tabs[n - 1]) go(n === 9 ? tabs.length - 1 : n - 1); }
  else if (alt && /^Digit[1-9]$/.test(e.code)) { const i = +e.code.slice(5) - 1; if (tabs[i]) go(i); }
  else if ((mod && !e.altKey && !e.shiftKey && key === 'j') || (alt && e.code === 'KeyR')) { e.preventDefault(); toggleRes(); }
  else if (alt && e.code === 'KeyZ') { e.preventDefault(); setWrap(!P.wrap); }
  else if (alt && e.code === 'KeyL') { e.preventDefault(); P.resDown = !P.resDown; applySide(); saveState(); }
  else if (e.key === 'F2' && !typing && lastRow) { e.preventDefault(); renameItem(lastRow.kind, lastRow.id); }
});

// ---------- response ----------
// respFrom decodes a /api/send reply (body is base64) into what the panes show.
function respFrom(j, req) {
  const b = j.body ? Uint8Array.from(atob(j.body), c => c.charCodeAt(0)) : new Uint8Array();
  const charset = /charset=([\w-]+)/i.exec(j.header?.['Content-Type']?.[0] || '')?.[1] || 'utf-8';
  let t;
  try { t = new TextDecoder(charset).decode(b); } catch { t = new TextDecoder().decode(b); }
  return { res: j, bytes: b, text: t, sent: req };
}
// keepResp stores a tab's last response so it's still there after a reload;
// bigger ones (or a full storage quota) are simply not kept.
function keepResp(tid, j, req) {
  try {
    localStorage.removeItem(RESP_KEY + tid);
    if ((j.body?.length || 0) * .75 <= RESP_KEEP_MAX) localStorage.setItem(RESP_KEY + tid, JSON.stringify({ res: j, sent: req }));
  } catch {}
}
const dropResp = (tid) => { delete resp[tid]; try { localStorage.removeItem(RESP_KEY + tid); } catch {} };
const ctype = () => (res.header?.['Content-Type']?.[0] || '').toLowerCase();
function isBinary() {
  if (/^(image|audio|video)\/|pdf|octet-stream|zip|protobuf|font/.test(ctype())) return true;
  return bytes.subarray(0, 1024).includes(0);
}
function detectFmt() {
  if (S.fmt !== 'auto') return S.fmt;
  const ct = ctype(), t = text.trimStart();
  if (/json/.test(ct) || ((!ct || /text\/plain/.test(ct)) && /^[{\[]/.test(t))) return 'json';
  if (/html/.test(ct)) return 'html';
  if (/xml/.test(ct) || t.startsWith('<?xml')) return 'xml';
  return 'text';
}
// numberLines fills the gutter beside a response <pre>; it numbers visible
// lines, so a folded block counts as one line.
function numberLines(p, n) {
  const g = p.previousElementSibling;
  if (P.wrap || !g) return;
  n ??= p.innerText.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  g.textContent = s;
}

function renderRes() {
  const pane = $('#sx-respane'), meta = $('#sx-meta');
  document.querySelectorAll('#sx-restabs > button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === S.resTab);
    if (b.dataset.v === 'headers') b.innerHTML = 'Headers' + (res?.header ? `<sup>${Object.keys(res.header).length}</sup>` : '');
  });
  if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = null; }
  if (!res) {
    meta.innerHTML = '';
    pane.innerHTML = `<div class="empty-res"><div>Send the request to see its response here.</div><div><kbd>Ctrl</kbd> + <kbd>Enter</kbd></div></div>`;
    return;
  }
  const s = res.status;
  meta.innerHTML = res.error
    ? `<b class="rs s0">Error</b><span>${ms(res.timeMs)}</span>`
    : (S.resTab === 'body' && !isBinary() ? `<select id="sx-fmt" aria-label="Format">${opt('auto', S.fmt, '{ } ' + detectFmt().toUpperCase())}${['json', 'xml', 'html', 'text'].map(f => opt(f, S.fmt, f.toUpperCase())).join('')}</select>` : '') +
      `<b class="rs s${String(s).charAt(0)}">${s} ${esc(res.statusText)}</b><b>${ms(res.timeMs)}</b><b title="${res.truncated ? 'Truncated' : ''}">${fmtBytes(res.size)}</b>`;
  if (S.resTab === 'timing') {
    const req = sent || {};
    pane.innerHTML = `<div class="tl"><h4>Request</h4><div class="line"><b class="m-${esc(req.method || '')}">${esc(req.method || '')}</b> ${esc(req.url || '')}</div>
      <h4>Request headers</h4><table class="hdrs">${(req.headers || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') || '<tr><td class="muted">none</td><td></td></tr>'}</table>
      ${req.body ? `<h4>Request body</h4><pre class="code boxed wrap">${esc(req.body.length > 5000 ? req.body.slice(0, 5000) + '…' : req.body)}</pre>` : ''}
      <h4>Response</h4><div class="line">${res.error ? `<span class="bad">${esc(res.error)}</span>` : `${res.status} ${esc(res.statusText)} · ${esc(res.proto || '')}${res.tls ? ' · ' + esc(res.tls) : ''}${res.phases?.remote ? ' · ' + esc(res.phases.remote) : ''}`}</div>
      ${res.redirects?.length ? `<h4>Redirects</h4><div class="line">${res.redirects.map(esc).join(' → ')}</div>` : ''}
      <h4>Timing</h4>${res.phases ? probeTimingHTML({ cold: res.phases, proto: res.proto }) : '<p class="muted">No timing recorded.</p>'}</div>`;
    return;
  }
  if (res.error) { pane.innerHTML = `<p class="bad">${esc(res.error)}</p>` + (res.phases ? probeTimingHTML({ cold: res.phases }) : ''); return; }
  if (S.resTab === 'headers') {
    const rows = Object.entries(res.header || {}).flatMap(([k, vs]) => vs.map(v => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)).join('');
    const extra = [res.decompressed && 'Body was gzip-compressed; size shown is after decompression.'].filter(Boolean);
    pane.innerHTML = `<table class="hdrs">${rows}</table>` + extra.map(x => `<p class="hint">${x}</p>`).join('');
    return;
  }

  const fmt = detectFmt(), bin = isBinary();
  pane.innerHTML = `<div class="restool">
      <span class="seg" id="sx-view">${['pretty', 'raw', 'preview', 'hex'].map(v => `<button data-v="${v}" class="${S.view === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</span>
      <span class="sp"><label title="Alt+Z"><input type="checkbox" id="sx-wrap" ${P.wrap ? 'checked' : ''}> Wrap</label>
      <button class="ghost" id="sx-copy">Copy</button><button class="ghost" id="sx-dl">Download</button></span>
    </div>${res.truncated ? `<p class="hint bad">Showing the first ${fmtBytes(bytes.length)} of ${fmtBytes(res.size)}.</p>` : ''}<div id="sx-out"></div>`;
  const out = $('#sx-out');
  const pre = (numbered = true) => {
    const p = document.createElement('pre');
    p.className = 'code' + (P.wrap ? ' wrap' : '');
    if (!numbered) { p.classList.add('boxed'); out.replaceChildren(p); return p; }
    const box = document.createElement('div'), g = document.createElement('pre');
    box.className = 'codebox' + (P.wrap ? ' wrap' : ''); g.className = 'gutter';
    box.append(g, p); out.replaceChildren(box);
    return p;
  };
  if (!bytes.length) { out.innerHTML = '<p class="muted">Empty body.</p>'; return; }
  if (S.view === 'hex') { pre(false).textContent = hexdump(bytes); return; }
  if (S.view === 'preview') {
    // Blob URLs share this page's origin, so the blob's type is set from an
    // exact allowlist, never from the server's Content-Type: a response
    // labelled "text/html; x=pdf" must not render as HTML here.
    const mt = ctype().split(';')[0].trim();
    if (/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mt)) {
      blobURL = URL.createObjectURL(new Blob([bytes], { type: mt })); // <img> never runs SVG scripts
      out.innerHTML = `<img class="sx-img" src="${blobURL}" alt="Response image">`;
    } else if (mt === 'application/pdf') {
      blobURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      out.innerHTML = `<embed class="sx-preview" src="${blobURL}" type="application/pdf">`;
    } else if (fmt === 'html') {
      // sandbox with no allow-* flags: the page renders but its scripts can't run.
      const f = document.createElement('iframe');
      f.className = 'sx-preview'; f.setAttribute('sandbox', ''); f.srcdoc = text;
      out.replaceChildren(f);
    } else out.innerHTML = '<p class="muted">No preview for this type. Use Pretty or Raw.</p>';
    return;
  }
  if (bin) { out.innerHTML = '<p class="muted">Binary response. Use Preview or Hex, or Download it.</p>'; return; }
  if (S.view === 'raw' || text.length > PRETTY_MAX || fmt === 'text') {
    const p = pre(); p.textContent = text; numberLines(p, text.split('\n').length);
    if (S.view === 'pretty' && text.length > PRETTY_MAX) out.insertAdjacentHTML('afterbegin', `<p class="hint">Over ${fmtBytes(PRETTY_MAX)}: shown as plain text to stay fast.</p>`);
    return;
  }
  if (fmt === 'json') {
    try { JSON.parse(text); } catch (err) {
      const p = pre(); p.textContent = text; numberLines(p, text.split('\n').length);
      out.insertAdjacentHTML('afterbegin', `<p class="hint bad">Not valid JSON (${esc(err.message)}). Showing raw.</p>`);
      return;
    }
    if (text.length > HILITE_MAX) {
      // 1000-line blocks with content-visibility:auto: Chrome skips laying
      // out blocks that are off-screen, so 100k+ lines still open instantly.
      const p = pre(), lines = prettyJSON(text, true).split('\n');
      for (let i = 0; i < lines.length; i += 1000) {
        const d = document.createElement('div');
        d.style.cssText = `content-visibility:auto;contain-intrinsic-size:auto ${Math.min(1000, lines.length - i) * 1.6}em`;
        d.textContent = lines.slice(i, i + 1000).join('\n');
        p.append(d);
      }
      numberLines(p, lines.length);
      out.insertAdjacentHTML('afterbegin', `<p class="hint">Over ${fmtBytes(HILITE_MAX)}: indented without colours or folding to stay fast.</p>`);
    } else { const p = pre(); p.innerHTML = prettyJSON(text); numberLines(p); }
  } else { const p = pre(); p.innerHTML = highlightMarkup(fmt === 'xml' && !/\n/.test(text.slice(0, 2000)) ? indentXML(text) : text); numberLines(p); }
}

$('#sx-restabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.resTab = b.dataset.v; renderRes(); saveState(); } };
$('#sx-meta').onchange = (e) => { if (e.target.id === 'sx-fmt') { S.fmt = e.target.value; renderRes(); saveState(); } };
$('#sx-respane').addEventListener('click', (e) => {
  const fold = e.target.closest('.fold');
  if (fold) { fold.parentElement.classList.toggle('x'); numberLines(fold.closest('pre')); return; }
  const v = e.target.closest('#sx-view button');
  if (v) { S.view = v.dataset.v; renderRes(); saveState(); return; }
  if (e.target.id === 'sx-copy') navigator.clipboard.writeText(text).then(() => toast('Response copied to the clipboard.'));
  if (e.target.id === 'sx-dl') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: ctype() }));
    const ext = { json: '.json', xml: '.xml', html: '.html', text: '.txt' }[detectFmt()];
    a.download = (new URL(sent?.url || S.url, 'http://x').pathname.split('/').filter(Boolean).pop() || 'response').replace(/\.\w+$/, '') + (isBinary() ? '' : ext);
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});
$('#sx-respane').addEventListener('change', (e) => {
  if (e.target.id === 'sx-wrap') setWrap(e.target.checked);
});

// Request/response divider: drag to resize; the split is kept between sessions.
function applySplit() { const s = $('#sx-split'); s.style.setProperty('--l', P.split + 'fr'); s.style.setProperty('--r', (1 - P.split) + 'fr'); }
// dragHandle makes el a resize handle: left button only, no text selection
// while dragging (WebKit otherwise selects across the page), and the drag ends
// on lostpointercapture, which fires on release *and* on pointercancel.
function dragHandle(el, onStart, onMove) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const ctx = onStart();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag'); document.documentElement.classList.add('dragging');
    el.onpointermove = (m) => onMove(m, ctx);
    el.addEventListener('lostpointercapture', () => {
      el.onpointermove = null;
      el.classList.remove('drag'); document.documentElement.classList.remove('dragging');
      saveState();
    }, { once: true });
  });
}
dragHandle($('#sx-gut'), () => $('#sx-split').getBoundingClientRect(), (m, box) => {
  P.split = Math.min(.8, Math.max(.2, P.resDown ? (m.clientY - box.top) / box.height : (m.clientX - box.left) / box.width)); applySplit();
});
$('#sx-gut').ondblclick = () => { P.split = .5; applySplit(); saveState(); };

// ---------- tabs ----------
const mth = (m) => `<span class="mth m-${esc(m)}">${esc(m === 'DELETE' ? 'DEL' : m.slice(0, 6))}</span>`;
const tabTitle = (t) => t.name || (t.url.trim() ? t.url.replace(/^https?:\/\//, '').replace(/\?.*/, '') : 'Untitled');
// Where a saved request (or a new one's target) lives, as names.
function locationOf(cid, fid) {
  const out = [], col = lib.collections.find(c => c.id === cid);
  for (let f = lib.folders.find(x => x.id === fid); f; f = lib.folders.find(x => x.id === f.parentId)) out.unshift(f.name);
  if (col) out.unshift(col.name);
  return out;
}
function renderChrome() {
  $('#sx-tabs').innerHTML = tabs.map((t, i) => `<div class="tab ${i === active ? 'on' : ''}" data-tab="${i}" title="${esc(t.url)}">
      ${mth((t.method || 'GET').toUpperCase())}<span class="nm">${esc(tabTitle(t))}</span>${isDirty(t) ? '<span class="dot" title="Unsaved changes"></span>' : ''}<button class="ib xx" data-close="${i}" title="Close (Ctrl+W)">${ICO.x}</button></div>`).join('') +
    `<button class="ib tab-add" id="sx-newtab" title="New request (Ctrl+N)">${ICO.plus}</button>`;
  const loc = locationOf(S.collectionId, S.folderId);
  $('#sx-crumb').innerHTML = (loc.length ? loc.map(esc).map(n => `<span>${n}</span>`).join('<span class="sep">/</span>') + '<span class="sep">/</span>' : '') +
    `<span>${esc(S.name || (S.savedId ? '' : 'Unsaved request'))}</span>`;
  document.title = (S.name || 'API-Man') + (S.name ? ' · API-Man' : '');
}
// renderEditor redraws everything that shows the active tab.
function renderEditor() {
  renderMethod(); $('#sx-url').value = S.url; renderURL();
  renderReqPane(); renderRes(); renderChrome(); renderTree();
  $('#sx-err').textContent = '';
}
function switchTab(i) {
  active = i; S = tabs[i];
  ({ res, bytes, text, sent } = resp[S.tid] || { res: null, bytes: null, text: '', sent: null });
  renderEditor(); saveState();
}
// placeTab opens t: into the current tab when that one is empty, else a new tab.
// New blank tab with the URL box focused, ready for a paste.
function newRequest() { placeTab(newTab(), true); requestAnimationFrame(() => $('#sx-url').focus()); }
function placeTab(t, forceNew) {
  if (!forceNew && isPristine(S)) { dropResp(S.tid); tabs[active] = t; switchTab(active); }
  else { tabs.push(t); switchTab(tabs.length - 1); }
  go('#send');
}
// ponytail: closed tabs kept in memory for this session only, last 20.
const closed = [];
function remember(t) { if (!isPristine(t)) { closed.push(structuredClone(t)); if (closed.length > 20) closed.shift(); } }
function reopenTab() { const t = closed.pop(); if (t) placeTab({ ...t, tid: newTab().tid }); }
// okToClose asks Save / Don't save / Cancel for a dirty tab; true means it may close.
async function okToClose(i) {
  const t = tabs[i];
  if (!isDirty(t)) return true;
  const a = await ask({ title: 'Close without saving?', body: `"${tabTitle(t)}" has changes that aren't saved.`, alt: "Don't save", ok: 'Save' });
  if (a === 'alt') return true;
  if (a !== 'ok') return false;
  switchTab(i); await save(false); return !isDirty(tabs[i]);
}
async function closeTab(i) {
  if (!await okToClose(i)) return;
  i = Math.min(i, tabs.length - 1); const t = tabs[i];
  dropResp(t.tid);
  remember(t);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(newTab());
  switchTab(Math.min(i < active ? active - 1 : active, tabs.length - 1));
}
$('#sx-tabs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) return closeTab(+c.dataset.close);
  if (e.target.closest('#sx-newtab')) return newRequest();
  const t = e.target.closest('[data-tab]');
  if (t && +t.dataset.tab !== active) switchTab(+t.dataset.tab);
});
$('#sx-tabs').addEventListener('auxclick', (e) => { const t = e.target.closest('[data-tab]'); if (t && e.button === 1) closeTab(+t.dataset.tab); });
$('#sx-tabs').addEventListener('contextmenu', (e) => {
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  e.preventDefault();
  const i = +t.dataset.tab;
  if (i !== active) switchTab(i);
  menu(e.clientX, e.clientY, [
    { label: 'Save', key: 'Ctrl S', run: () => save(false) },
    { label: 'Save as…', key: 'Ctrl Shift S', run: () => save(true) },
    { label: 'Duplicate tab', run: () => placeTab({ ...structuredClone(S), tid: newTab().tid, savedId: null, name: S.name ? S.name + ' copy' : '' }, true) },
    '-',
    { label: 'Close', key: 'Ctrl W', run: () => closeTab(active) },
    { label: 'Reopen closed tab', key: 'Ctrl Shift T', run: reopenTab },
    { label: 'Close other tabs', run: async () => { const keep = tabs[active]; for (const t of tabs.slice()) if (t !== keep && await okToClose(tabs.indexOf(t))) { dropResp(t.tid); remember(t); tabs.splice(tabs.indexOf(t), 1); } switchTab(tabs.indexOf(keep)); } },
  ]);
});
// Tab from saved form fields (or fields rebuilt from history).
function tabFrom(data, meta = {}) {
  const t = newTab();
  Object.assign(t, data);
  t.params = Array.isArray(data.params) ? data.params : paramsFromURL(t.url);
  t.timeout = clampTimeout(t.timeout);
  t.savedId = meta.id ?? null; t.name = meta.name ?? ''; t.collectionId = meta.collectionId ?? null; t.folderId = meta.folderId ?? null;
  t.snapshot = JSON.stringify(formOf(t));
  return t;
}
// History stores what was sent (auth already turned into headers).
function formFromSent(d) {
  const ct = (d.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  return { method: d.method, url: d.url, headers: d.headers.map(([k, v]) => ({ on: true, k, v, d: '' })),
    body: d.body || '', bodyMode: !d.body ? 'none' : /json/.test(ct) ? 'json' : /xml/.test(ct) ? 'xml' : 'text',
    follow: !!d.followRedirects, insecure: !!d.insecure, timeout: d.timeoutMs ? d.timeoutMs / 1000 : 30 };
}
async function openSaved(id, forceNew) {
  const open = tabs.findIndex(t => t.savedId === id);
  if (open >= 0 && !forceNew) { switchTab(open); go('#send'); return; }
  try { const r = await api('GET', `/api/requests/${id}`); placeTab(tabFrom(r.data, r), forceNew); } catch (e) { toast(e.message, true); }
}

// ---------- saved requests, collections, folders, history ----------
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, bad = false) {
  const d = document.createElement('div');
  d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = msg; d.setAttribute('role', 'status');
  $('#toasts').append(d);
  setTimeout(() => d.remove(), bad ? 6000 : 3500);
}
async function loadLibrary() {
  try { lib = await api('GET', '/api/library'); } catch (e) { return toast(e.message, true); }
  // Open tabs follow moves and renames made in the sidebar.
  for (const t of tabs) {
    const r = t.savedId && lib.requests.find(x => x.id === t.savedId);
    if (r) Object.assign(t, { name: r.name, collectionId: r.collectionId, folderId: r.folderId });
  }
  renderTree(); renderChrome();
}
async function loadReqHistory() {
  try { hist = await api('GET', '/api/history'); $('#f-histn').textContent = hist.length || ''; if (P.side === 'history') renderTree(); } catch (e) { toast(e.message, true); }
}

async function storeReq(id, name, collectionId, folderId) {
  const saved = await api(id ? 'PUT' : 'POST', id ? `/api/requests/${id}` : '/api/requests',
    { collectionId, folderId, name, method: S.method.trim().toUpperCase() || 'GET', url: S.url.trim(), data: formData() });
  Object.assign(S, { savedId: saved.id, name, collectionId, folderId, snapshot: JSON.stringify(formData()) });
  saveState(); await loadLibrary();
  toast(`Saved "${name}".`);
}
// Every place a request can be saved: "c:ID" (collection root) or "f:ID" (folder).
function placesHTML(cur) {
  const out = [opt('', cur, '— no collection —')];
  const walk = (cid, parent, path) => lib.folders.filter(f => f.collectionId === cid && f.parentId === parent).forEach(f => {
    out.push(opt('f:' + f.id, cur, esc(path + ' / ' + f.name))); walk(cid, f.id, path + ' / ' + f.name);
  });
  lib.collections.forEach(c => { out.push(opt('c:' + c.id, cur, esc(c.name))); walk(c.id, null, c.name); });
  return out.join('') + opt('new', '', '+ New collection…');
}
const parsePlace = (v) => v.startsWith('f:') ? { folderId: +v.slice(2), collectionId: lib.folders.find(f => f.id === +v.slice(2))?.collectionId ?? null }
  : v.startsWith('c:') ? { collectionId: +v.slice(2), folderId: null } : { collectionId: null, folderId: null };
async function save(asNew) {
  $('#sx-err').textContent = '';
  if (!S.url.trim()) return toast('Enter a URL before saving.', true);
  try {
    if (S.savedId && !asNew) return await storeReq(S.savedId, S.name, S.collectionId, S.folderId);
    const dlg = $('#sx-dlg');
    $('#sx-dlg-title').textContent = asNew ? 'Save as new request' : 'Save request';
    $('#sx-dlg-name').value = asNew && S.name ? S.name + ' copy' : S.name ||
      (S.method.toUpperCase() + ' ' + (new URL(S.url, 'http://x').pathname || '/'));
    $('#sx-dlg-col').innerHTML = placesHTML(S.folderId ? 'f:' + S.folderId : S.collectionId ? 'c:' + S.collectionId : '');
    showNewCol();
    dlg.returnValue = '';
    dlg.showModal(); $('#sx-dlg-name').select();
    await new Promise(r => dlg.addEventListener('close', r, { once: true }));
    if (dlg.returnValue !== 'ok') return;
    let place = $('#sx-dlg-col').value;
    if (place === 'new') place = 'c:' + (await api('POST', '/api/collections', { name: $('#sx-dlg-newname').value.trim() })).id;
    const { collectionId, folderId } = parsePlace(place);
    await storeReq(null, $('#sx-dlg-name').value.trim(), collectionId, folderId);
  } catch (e) { toast(e.message, true); }
}
$('#sx-save').onclick = () => save(false);
// "+ New collection…" in the Save dialog shows a name field in place; required keeps Save from closing on a blank name.
function showNewCol() {
  const on = $('#sx-dlg-col').value === 'new', i = $('#sx-dlg-newname');
  $('#sx-dlg-newcol').hidden = !on; i.required = on; i.value = '';
  if (on) i.focus();
}
$('#sx-dlg-col').onchange = showNewCol;

const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd';
};
function renderTree() {
  const q = $('#sx-search').value.trim().toLowerCase();
  const hit = (...xs) => !q || xs.some(x => String(x).toLowerCase().includes(q));
  $('#f-history').classList.toggle('on', P.side === 'history');
  if (P.side === 'history') {
    const rows = hist.filter(h => hit(h.method, h.url)).map(h => `<div class="ti" data-hist="${h.id}" title="${esc(h.url)}">
      ${mth(h.method)}<span class="nm">${esc(h.url.replace(/^https?:\/\//, ''))}</span>
      <small class="rs s${h.error ? 0 : String(h.status)[0]}">${h.error ? 'ERR' : h.status}</small><small>${ago(h.at)}</small></div>`);
    $('#sx-list').innerHTML = `<div class="hist-head"><button class="ib" id="sx-histback" title="Back to collections">${ICO.back}</button><b>History</b>
        <button class="link" id="sx-histclear" ${hist.length ? '' : 'disabled'}>Clear</button></div>` +
      (rows.join('') || `<p class="muted" style="padding:0 14px">${q ? 'No matches.' : 'Requests you send appear here.'}</p>`);
    return;
  }
  const reqRow = (r, d) => `<div class="ti r ${r.id === S.savedId ? 'on' : ''}" style="--d:${d}" data-kind="r" data-id="${r.id}" draggable="true" title="${esc(r.name)}&#10;${esc(r.url)}">
    ${mth(r.method)}<span class="nm">${esc(r.name)}</span><button class="ib more" data-more title="More">${ICO.more}</button></div>`;
  const box = (kind, id, name, d, inner) => {
    const closed = P.collapsed[kind + id] && !q; // searching always shows matches
    return `<div class="ti ${kind} ${closed ? 'closed' : ''}" style="--d:${d}" data-kind="${kind}" data-id="${id}" aria-expanded="${!closed}"${kind === 'f' ? ' draggable="true"' : ''}>
      ${ICO.chev}<span class="nm">${esc(name)}</span><button class="ib more" data-more title="More">${ICO.more}</button></div>` + (closed ? '' : inner);
  };
  const folderHTML = (f, d, up) => {
    const self = up || hit(f.name);
    const inner = lib.folders.filter(x => x.parentId === f.id).map(x => folderHTML(x, d + 1, self)).join('') +
      lib.requests.filter(r => r.folderId === f.id && (self || hit(r.name, r.url, r.method))).map(r => reqRow(r, d + 1)).join('');
    return q && !inner && !self ? '' : box('f', f.id, f.name, d, inner);
  };
  const loose = lib.requests.filter(r => r.collectionId == null && hit(r.name, r.url, r.method)).map(r => reqRow(r, 0)).join('');
  const cols = lib.collections.map(c => {
    const self = hit(c.name);
    const inner = lib.folders.filter(f => f.collectionId === c.id && f.parentId == null).map(f => folderHTML(f, 1, self)).join('') +
      lib.requests.filter(r => r.collectionId === c.id && r.folderId == null && (self || hit(r.name, r.url, r.method))).map(r => reqRow(r, 1)).join('');
    return q && !inner && !self ? '' : box('c', c.id, c.name, 0, inner);
  }).join('');
  $('#sx-list').innerHTML = cols + loose || (q ? '<p class="muted" style="padding:0 14px">No matches.</p>' :
    `<div class="tree-empty">No collections yet.<button id="sx-firstcol">New collection</button><button class="ghost" id="sx-firstimport">Import from Postman</button></div>`);
}

async function newCollection() {
  const n = await askName({ title: 'New collection', body: 'Group related requests, for example one collection per API.', placeholder: 'e.g. Payments API', ok: 'Create collection', taken: lib.collections.map(c => c.name) });
  if (n) { try { await api('POST', '/api/collections', { name: n }); await loadLibrary(); } catch (e) { toast(e.message, true); } }
}
async function newFolder(collectionId, parentId) {
  const path = [];
  for (let f = lib.folders.find(x => x.id === parentId); f; f = lib.folders.find(x => x.id === f.parentId)) path.unshift(f.name);
  path.unshift(lib.collections.find(c => c.id === collectionId)?.name);
  const n = await askName({ title: 'New folder', crumb: 'in ' + path.join(' › '), placeholder: 'e.g. Webhooks', ok: 'Create folder',
    taken: lib.folders.filter(f => f.collectionId === collectionId && f.parentId === parentId).map(f => f.name) });
  if (!n) return;
  try {
    await api('POST', '/api/folders', { collectionId, parentId, name: n });
    delete P.collapsed[parentId ? 'f' + parentId : 'c' + collectionId];
    await loadLibrary();
  } catch (e) { toast(e.message, true); }
}
// Rename in place: the row's name becomes a text box. Enter or leaving the
// box saves, Esc cancels.
let lastRow = null; // the tree row last clicked, for F2
function renameItem(kind, id) {
  const row = $(`#sx-list .ti[data-kind="${kind}"][data-id="${id}"]`);
  const cur = (kind === 'c' ? lib.collections : kind === 'f' ? lib.folders : lib.requests).find(x => x.id === id);
  if (!row || !cur) return;
  const nm = row.querySelector('.nm'), box = document.createElement('input');
  box.className = 'rename'; box.value = cur.name; box.maxLength = 200; box.spellcheck = false; box.setAttribute('aria-label', 'New name');
  row.draggable = false;
  nm.replaceWith(box); box.focus(); box.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    const n = box.value.trim();
    if (!keep || !n || n === cur.name) return renderTree();
    try {
      if (kind === 'c') await api('PUT', `/api/collections/${id}`, { name: n });
      if (kind === 'f') await api('PUT', `/api/folders/${id}`, { name: n });
      if (kind === 'r') await api('PATCH', `/api/requests/${id}`, { name: n });
      await loadLibrary(); saveState();
    } catch (e) { toast(e.message, true); renderTree(); }
  };
  box.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  box.onblur = () => finish(true);
}
// Requests inside a collection or folder, at any depth (for delete warnings).
function requestsUnder(kind, id) {
  if (kind === 'c') return lib.requests.filter(r => r.collectionId === id);
  const ids = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of lib.folders) if (ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  return lib.requests.filter(r => ids.has(r.folderId));
}
async function deleteItem(kind, id) {
  const gone = kind === 'r' ? lib.requests.filter(r => r.id === id) : requestsUnder(kind, id), n = gone.length;
  const what = kind === 'c' ? 'collection' : kind === 'f' ? 'folder' : 'saved request';
  const name = kind === 'c' ? lib.collections.find(c => c.id === id)?.name : kind === 'f' ? lib.folders.find(f => f.id === id)?.name : gone[0]?.name;
  if (!await confirmAsk({ title: `Delete ${what}?`, ok: 'Delete', danger: true,
    body: `"${name}"${kind !== 'r' && n ? ` and its ${n} request${n > 1 ? 's' : ''}` : ''} will be deleted. This can't be undone.` })) return;
  try {
    await api('DELETE', `/api/${{ c: 'collections', f: 'folders', r: 'requests' }[kind]}/${id}`);
    // Open tabs keep their contents but become unsaved copies.
    const ids = new Set(gone.map(r => r.id));
    tabs.forEach(t => { if (ids.has(t.savedId)) Object.assign(t, { savedId: null, collectionId: null, folderId: null }); });
    await loadLibrary(); saveState();
  } catch (e) { toast(e.message, true); }
}
async function duplicateReq(id) {
  try {
    const r = await api('GET', `/api/requests/${id}`);
    await api('POST', '/api/requests', { ...r, id: 0, name: r.name + ' copy' });
    await loadLibrary();
  } catch (e) { toast(e.message, true); }
}
// Export a collection as a Postman v2.1 file (saved tokens included, as stored).
async function exportCollection(cid) {
  const col = lib.collections.find(c => c.id === cid);
  try {
    const reqs = lib.requests.filter(r => r.collectionId === cid);
    const full = new Map((await Promise.all(reqs.map(r => api('GET', `/api/requests/${r.id}`)))).map(r => [r.id, r]));
    const node = (parent) => ({
      folders: lib.folders.filter(f => f.collectionId === cid && f.parentId === parent).map(f => ({ name: f.name, ...node(f.id) })),
      requests: reqs.filter(r => (r.folderId ?? null) === parent).map(r => ({ name: r.name, data: full.get(r.id).data })),
    });
    const blob = new Blob([JSON.stringify(toPostman({ name: col.name, ...node(null) }), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = col.name.replace(/[^\w.-]+/g, '_') + '.postman_collection.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported "${col.name}" (${reqs.length} request${reqs.length === 1 ? '' : 's'}). It includes any tokens saved in those requests.`);
  } catch (e) { toast('Export failed: ' + e.message, true); }
}
async function loadTestReq(id) {
  await openSaved(id, false);
  loadTest();
}
function itemMenu(x, y, kind, id) {
  const folder = kind === 'f' && lib.folders.find(f => f.id === id);
  const newReqHere = () => placeTab(newTab(kind === 'c' ? { collectionId: id } : { collectionId: folder.collectionId, folderId: id }), true);
  const items = kind === 'r' ? [
    { label: 'Open', run: () => openSaved(id, false) },
    { label: 'Open in new tab', run: () => openSaved(id, true) },
    { label: 'Rename', run: () => renameItem('r', id), key: 'F2' },
    { label: 'Duplicate', run: () => duplicateReq(id) },
    { label: 'Load test this…', run: () => loadTestReq(id) },
    '-', { label: 'Delete', danger: true, run: () => deleteItem('r', id) },
  ] : [
    { label: 'New request', run: newReqHere },
    { label: 'New folder', run: () => kind === 'c' ? newFolder(id, null) : newFolder(folder.collectionId, id) },
    { label: 'Rename', run: () => renameItem(kind, id), key: 'F2' },
    ...(kind === 'c' ? [{ label: 'Export as Postman collection…', run: () => exportCollection(id) }] : []),
    '-', { label: 'Delete', danger: true, run: () => deleteItem(kind, id) },
  ];
  menu(x, y, items);
}
$('#sx-list').addEventListener('click', async (e) => {
  const t = (sel) => e.target.closest(sel);
  if (t('#sx-firstcol')) return newCollection();
  if (t('#sx-firstimport')) return $('#sx-importfile').click();
  if (t('#sx-histback')) { P.side = 'tree'; renderTree(); saveState(); return; }
  if (t('#sx-histclear')) {
    if (!await confirmAsk({ title: 'Clear all request history?', body: "This can't be undone.", ok: 'Clear history', danger: true })) return;
    try { await api('DELETE', '/api/history'); await loadReqHistory(); renderTree(); } catch (err) { toast(err.message, true); }
    return;
  }
  if (t('[data-hist]')) {
    try { const h = await api('GET', `/api/history/${t('[data-hist]').dataset.hist}`); placeTab(tabFrom(formFromSent(h.data)), e.ctrlKey || e.metaKey); } catch (err) { toast(err.message, true); }
    return;
  }
  if (t('input.rename')) return;
  const row = t('[data-kind]');
  if (!row) return;
  const kind = row.dataset.kind, id = +row.dataset.id;
  lastRow = { kind, id };
  if (t('[data-more]')) { const r = t('[data-more]').getBoundingClientRect(); return itemMenu(r.left, r.bottom + 4, kind, id); }
  if (kind === 'r') return openSaved(id, e.ctrlKey || e.metaKey);
  if (P.collapsed[kind + id]) delete P.collapsed[kind + id]; else P.collapsed[kind + id] = true;
  renderTree(); saveState();
});
$('#sx-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('[data-kind]');
  if (!row || e.target.closest('input.rename, [data-more]')) return;
  renameItem(row.dataset.kind, +row.dataset.id); // on a collection/folder the two clicks toggled it twice, so it's unchanged
});
$('#sx-list').addEventListener('auxclick', (e) => { const r = e.target.closest('[data-kind="r"]'); if (r && e.button === 1) openSaved(+r.dataset.id, true); });
$('#sx-list').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-kind]');
  if (!row) return;
  e.preventDefault();
  itemMenu(e.clientX, e.clientY, row.dataset.kind, +row.dataset.id);
});
// Drag a request or folder onto a collection or folder to move it there;
// drop a request on empty space below the tree to take it out of its collection.
const REQ_T = 'text/x-apiman-req', FOLDER_T = 'text/x-apiman-folder';
$('#sx-list').addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-kind="r"], [data-kind="f"]');
  if (row) { e.dataTransfer.setData(row.dataset.kind === 'r' ? REQ_T : FOLDER_T, row.dataset.id); e.dataTransfer.effectAllowed = 'move'; }
});
function dropTarget(e) {
  const types = e.dataTransfer.types;
  if (!types.includes(REQ_T) && !types.includes(FOLDER_T)) return null;
  const box = e.target.closest('[data-kind="c"], [data-kind="f"]');
  if (box) return box;
  return !e.target.closest('.ti') && types.includes(REQ_T) ? $('#sx-list') : null; // empty space: requests only
}
const clearDrop = () => document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
$('#sx-list').addEventListener('dragover', (e) => {
  const box = dropTarget(e);
  clearDrop();
  if (!box) return;
  e.preventDefault();
  box.classList.add('drop');
});
$('#sx-list').addEventListener('dragleave', (e) => { if (!$('#sx-list').contains(e.relatedTarget)) clearDrop(); });
$('#sx-list').addEventListener('dragend', clearDrop);
$('#sx-list').addEventListener('drop', async (e) => {
  const box = dropTarget(e), reqId = +e.dataTransfer.getData(REQ_T), folderId = +e.dataTransfer.getData(FOLDER_T);
  clearDrop();
  if (!box) return;
  e.preventDefault();
  const kind = box.dataset.kind, id = +box.dataset.id;
  try {
    if (reqId) {
      const move = !kind ? { collectionId: null, folderId: null } : kind === 'c' ? { collectionId: id, folderId: null } : { folderId: id };
      await api('PATCH', `/api/requests/${reqId}`, { move });
    } else if (folderId && !(kind === 'f' && id === folderId)) {
      const move = kind === 'c' ? { collectionId: id } : { collectionId: lib.folders.find(f => f.id === id).collectionId, parentId: id };
      await api('PATCH', `/api/folders/${folderId}`, { move });
      if (kind) delete P.collapsed[kind + id];
    }
    await loadLibrary(); saveState();
  } catch (err) { toast(err.message, true); }
});
$('#sx-searchbtn').onclick = () => { const s = $('#sx-search'); s.classList.toggle('hidden'); if (s.classList.contains('hidden')) { s.value = ''; renderTree(); } else s.focus(); };
$('#sx-search').oninput = renderTree;
$('#sx-addbtn').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, [
  { label: 'New request', run: () => newRequest() },
  { label: 'New collection', run: newCollection },
  { label: 'Import from Postman…', run: () => $('#sx-importfile').click() },
]); };

// ---------- sidebar footer, header, title bar ----------
$('#f-history').onclick = () => { P.side = P.side === 'history' ? 'tree' : 'history'; renderTree(); saveState(); if (P.side === 'history') loadReqHistory(); };
$('#f-env').onclick = () => openEnvDialog(P.envId);
$('#f-load').onclick = () => go('#new');
$('#f-runs').onclick = () => go('#history');
$('#brand').onclick = () => go('#send');
document.addEventListener('viewchange', (e) => {
  $('#f-load').classList.toggle('on', e.detail === 'setup');
  $('#f-runs').classList.toggle('on', e.detail === 'history' || e.detail === 'report' || e.detail === 'live');
});
function applySide() {
  $('#body').classList.toggle('noside', P.sideHidden);
  $('#body').style.setProperty('--sidew', P.sideW + 'px');
  document.documentElement.classList.toggle('down', P.resDown);
  document.documentElement.classList.toggle('nores', P.resHidden);
}
const toggleRes = () => { P.resHidden = !P.resHidden; applySide(); saveState(); };
$('#toggle-res').onclick = toggleRes;
// Sidebar width: drag its right edge; double-click resets. Kept between sessions.
dragHandle($('#side-gut'), () => $('#body').getBoundingClientRect().left, (m, left) => {
  P.sideW = Math.round(Math.min(600, Math.max(180, m.clientX - left))); applySide();
});
$('#side-gut').ondblclick = () => { P.sideW = 260; applySide(); saveState(); };
$('#toggle-layout').onclick = () => { P.resDown = !P.resDown; applySide(); saveState(); };
$('#toggle-side').onclick = () => { P.sideHidden = !P.sideHidden; applySide(); saveState(); };
$('#sb-host').textContent = '● ' + location.host;
$('#sb-search').onclick = () => openPalette();
$('#sb-import').onclick = () => $('#sx-importfile').click();
$('#sb-keys').onclick = showShortcuts;
// Load test: hand the current request to the New run page as a curl.
function loadTest() {
  const req = buildRequest();
  if (!S.url.trim()) return toast('Enter a URL first.', true);
  if (/\{\{/.test(req.url)) return toast('The URL has variables the active environment doesn\'t set. Pick an environment first.', true);
  $('#curl').value = CODE_LANGS.curl.gen(req);
  $('#curl').dispatchEvent(new Event('input'));
  go('#new');
}
$('#sx-loadtest').onclick = loadTest;

// ---------- context menu ----------
let menuItems = [];
function menu(x, y, items) {
  menuItems = items;
  const m = $('#ctx');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'dg' : ''}" role="menuitem">${esc(it.label)}${it.key ? `<span class="k">${it.key}</span>` : ''}</button>`).join('');
  m.classList.remove('hidden');
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px';
  m.querySelector('button')?.focus();
}
function hideMenu() { $('#ctx').classList.add('hidden'); }
$('#ctx').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { hideMenu(); menuItems[+b.dataset.i].run(); } };
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideMenu(); });
addEventListener('blur', hideMenu); addEventListener('resize', hideMenu);

// ---------- search everything (Ctrl+K) ----------
let palItems = [], palSel = 0;
function openPalette() {
  $('#pal').classList.remove('hidden');
  $('#pal-in').value = ''; renderPalette(); $('#pal-in').focus();
}
function closePalette() { $('#pal').classList.add('hidden'); }
function renderPalette() {
  const q = $('#pal-in').value.trim().toLowerCase();
  const all = [
    ...lib.requests.map(r => ({ html: mth(r.method) + esc(r.name), sub: locationOf(r.collectionId, r.folderId).join(' / ') || r.url, text: r.name + ' ' + r.url, run: () => openSaved(r.id, false) })),
    ...envs.map(e => ({ html: '⇄ Use environment: ' + esc(e.name), sub: 'environment', text: 'environment ' + e.name, run: () => setEnv(e.id) })),
    { html: '+ New request', sub: 'action', text: 'new request tab', run: () => newRequest() },
    { html: '+ New collection', sub: 'action', text: 'new collection', run: newCollection },
    { html: 'Manage environments', sub: 'action', text: 'environments variables manage', run: () => openEnvDialog(P.envId) },
    { html: 'Import from Postman', sub: 'action', text: 'import postman', run: () => $('#sx-importfile').click() },
    { html: 'Load test the current request', sub: 'action', text: 'load test run', run: loadTest },
    { html: 'Past load tests', sub: 'action', text: 'runs history load tests past', run: () => go('#history') },
    { html: 'Keyboard shortcuts', sub: 'action', text: 'keyboard shortcuts keys help', run: showShortcuts },
    { html: 'Request history', sub: 'action', text: 'history sent', run: () => { P.side = 'history'; renderTree(); saveState(); } },
  ];
  palItems = all.filter(i => !q || q.split(/\s+/).every(w => i.text.toLowerCase().includes(w) || i.sub.toLowerCase().includes(w))).slice(0, 60);
  palSel = 0;
  drawPalette();
}
function drawPalette() {
  $('#pal-list').innerHTML = palItems.map((it, i) => `<div class="${i === palSel ? 'on' : ''}" data-i="${i}">${it.html}<small>${esc(it.sub)}</small></div>`).join('') ||
    '<div class="muted">Nothing matches.</div>';
  $('#pal-list .on')?.scrollIntoView({ block: 'nearest' });
}
$('#pal-in').oninput = renderPalette;
$('#pal-in').onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % (palItems.length || 1); drawPalette(); }
  if (e.key === 'Enter' && palItems[palSel]) { e.preventDefault(); closePalette(); palItems[palSel].run(); }
};
$('#pal-list').onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) { closePalette(); palItems[+d.dataset.i].run(); } };
$('#pal').onmousedown = (e) => { if (e.target.id === 'pal') closePalette(); };

// ---------- environments ----------
const ENV_MANAGE = 'manage';
function renderEnvSelect() {
  $('#sx-env').innerHTML = opt('', String(P.envId ?? ''), 'No environment') +
    envs.map(e => opt(String(e.id), String(P.envId ?? ''), esc(e.name))).join('') + opt(ENV_MANAGE, '', 'Manage environments…');
  $('#f-envn').textContent = envs.length || '';
}
function setEnv(id) { P.envId = id; renderEnvSelect(); renderURL(); saveState(); }
async function loadEnvs() {
  try { envs = await api('GET', '/api/environments'); } catch (e) { return toast(e.message, true); }
  if (!envs.some(e => e.id === P.envId)) P.envId = null;
  renderEnvSelect(); renderURL();
}
$('#sx-env').onchange = (e) => {
  if (e.target.value === ENV_MANAGE) { renderEnvSelect(); return openEnvDialog(P.envId); }
  setEnv(e.target.value ? +e.target.value : null);
};

// The dialog edits a copy (E) and writes it back only on Save.
let E = null;
function openEnvDialog(id) {
  const src = envs.find(e => e.id === id) || envs[0];
  E = src ? { id: src.id, name: src.name, vars: src.vars.map(v => ({ ...v })) } : { id: null, name: 'Local', vars: [] };
  renderEnvDialog();
  if (!$('#sx-envdlg').open) $('#sx-envdlg').showModal();
}
function renderEnvDialog() {
  $('#sx-envpick').innerHTML = envs.map(e => opt(String(e.id), String(E.id), esc(e.name))).join('') + (E.id ? '' : opt('', '', '(new environment)'));
  $('#sx-envname').value = E.name;
  $('#sx-envvars').innerHTML = kvHTML('envvars', E.vars, 'Variable');
  $('#sx-envdel').disabled = !E.id;
  $('#sx-envmsg').textContent = '';
}
$('#sx-envname').oninput = (e) => { E.name = e.target.value; };
$('#sx-envvars').addEventListener('input', (e) => {
  if (e.target.dataset.f && kvEdit(E.vars, e.target)) { renderEnvDialog(); refocus('#sx-envvars', e.target); }
});
$('#sx-envvars').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  E.vars.splice(+del.dataset.i, 1);
  renderEnvDialog();
});
$('#sx-envpick').onchange = (e) => openEnvDialog(+e.target.value);
$('#sx-envnew').onclick = () => { E = { id: null, name: 'New environment', vars: [] }; renderEnvDialog(); $('#sx-envname').select(); };
$('#sx-envclose').onclick = () => $('#sx-envdlg').close();
$('#sx-envsave').onclick = async () => {
  try {
    const body = { name: E.name, vars: E.vars.filter(v => v.k) };
    const r = await api(E.id ? 'PUT' : 'POST', E.id ? `/api/environments/${E.id}` : '/api/environments', body);
    if (!E.id) P.envId = r.id; // a new environment becomes the active one
    E.id = r.id;
    await loadEnvs(); saveState(); openEnvDialog(E.id);
    $('#sx-envmsg').className = 'muted'; $('#sx-envmsg').textContent = 'Saved.';
  } catch (err) { $('#sx-envmsg').className = 'bad'; $('#sx-envmsg').textContent = err.message; }
};
// No <form> here (rows are added live), so Enter in a field saves explicitly.
$('#sx-envdlg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); $('#sx-envsave').click(); } });
$('#sx-envdel').onclick = async () => {
  if (!E.id || !await confirmAsk({ title: 'Delete environment?', body: `"${E.name}" and its variables will be deleted.`, ok: 'Delete', danger: true })) return;
  try {
    await api('DELETE', `/api/environments/${E.id}`);
    await loadEnvs(); saveState();
    envs.length ? openEnvDialog(envs[0].id) : $('#sx-envdlg').close();
  } catch (err) { $('#sx-envmsg').textContent = err.message; }
};

// ---------- import ----------
$('#sx-importfile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    let json;
    try { json = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
    const p = fromPostman(json);
    if (p.kind === 'environment') {
      const r = await api('POST', '/api/environments', { name: p.name, vars: p.vars });
      P.envId = r.id; await loadEnvs(); saveState();
      toast(`Imported environment "${p.name}" (${p.vars.length} variable${p.vars.length === 1 ? '' : 's'}) and made it active.`);
      return;
    }
    const r = await api('POST', '/api/import', { name: p.name, requests: p.requests, environment: p.environment });
    if (r.environmentId) { P.envId = r.environmentId; await loadEnvs(); saveState(); }
    P.side = 'tree'; await loadLibrary();
    toast(`Imported "${p.name}": ${p.requests.length} request${p.requests.length === 1 ? '' : 's'}` +
      (p.environment ? `, plus its variables as environment "${p.environment.name}" (now active)` : '') + '.' +
      (p.warnings.length ? ' Note: ' + p.warnings.join(' ') : ''));
  } catch (e2) { toast('Import failed: ' + e2.message, true); }
};

// ---------- restore open tabs ----------
try { Object.assign(P, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
try {
  const saved = JSON.parse(localStorage.getItem(TABS_KEY));
  if (saved?.tabs?.length) { tabs = saved.tabs.map(t => ({ ...newTab(), ...t })); active = Math.min(saved.active | 0, tabs.length - 1); }
  else { // the single-request draft from before tabs existed
    const old = JSON.parse(localStorage.getItem(OLD_DRAFT_KEY));
    if (old) {
      const t = { ...newTab(), ...old, folderId: null };
      if (old.envId != null) P.envId = old.envId;
      if (old.snapshot && old.savedId) { const o = JSON.parse(old.snapshot); o.params = t.params; t.snapshot = JSON.stringify(Object.fromEntries(FORM_KEYS.map(k => [k, o[k]]))); }
      tabs = [t];
      localStorage.removeItem(OLD_DRAFT_KEY);
    }
  }
} catch {}
// Bring back kept responses; forget ones whose tab is gone.
try {
  const open = new Set(tabs.map(t => t.tid));
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(RESP_KEY)) continue;
    const tid = k.slice(RESP_KEY.length);
    if (!open.has(tid)) { localStorage.removeItem(k); continue; }
    const { res: j, sent: req } = JSON.parse(localStorage.getItem(k));
    resp[tid] = respFrom(j, req);
  }
} catch {}
S = tabs[active];
({ res, bytes, text, sent } = resp[S.tid] || { res: null, bytes: null, text: '', sent: null });
applySide(); applySplit();
renderEditor();
loadLibrary(); loadReqHistory(); loadEnvs();
