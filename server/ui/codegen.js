'use strict';
// Code snippets for a request in /api/send shape: {method, url, headers:[[k,v]], body,
// followRedirects, insecure, timeoutMs}. Pure: server/codegen.test.js runs it in Node.

const sh = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'"; // POSIX single quotes
const q = (s) => JSON.stringify(String(s)); // valid string literal in JS, Python and Go
// PowerShell single quotes. It also treats the curly quotes ‘ ’ ‚ ‛ as quote
// characters, so each one is doubled too, or it would end the string early.
const ps = (s) => "'" + String(s).replace(/['‘’‚‛]/g, '$&$&') + "'";
// Methods come from saved/imported data: allow only an RFC 9110 token (letters,
// digits, a few symbols; no spaces, quotes or ;$`) and fall back to GET.
const isToken = (s) => /^[A-Za-z0-9!#%&*+.^_|~-]+$/.test(s || '');
const httpMethod = (m) => isToken(m) ? m.toUpperCase() : 'GET';
// Shell snippets: header names must be tokens too (HTTPie reads '=', ':=', '@' in an
// item as a body field or file upload), and only http(s) URLs are emitted.
const tokenHeaders = (hs) => hs.filter(([k]) => isToken(k));
const notHTTP = (u) => /^https?:\/\//i.test(u || '') ? '' : '# Only http(s) URLs can be exported as a shell command.';

const CODE_LANGS = {
  curl: {
    label: 'cURL',
    gen: (r) => {
      if (notHTTP(r.url)) return notHTTP(r.url);
      const parts = ['curl'];
      const method = httpMethod(r.method);
      if (method !== 'GET' || r.body) parts.push('-X ' + sh(method));
      parts.push('--url ' + sh(r.url));
      for (const [k, v] of tokenHeaders(r.headers)) parts.push('-H ' + sh(k + ': ' + v));
      if (r.body) parts.push('--data-raw ' + sh(r.body));
      if (r.followRedirects) parts.push('-L');
      if (r.insecure) parts.push('-k');
      return parts.join(' \\\n  ');
    },
  },
  fetch: {
    label: 'JavaScript (fetch)',
    gen: (r) => {
      const opts = [`  method: ${q(r.method)},`];
      if (r.headers.length) opts.push('  headers: {\n' + r.headers.map(([k, v]) => `    ${q(k)}: ${q(v)},`).join('\n') + '\n  },');
      if (r.body) opts.push(`  body: ${q(r.body)},`);
      if (!r.followRedirects) opts.push(`  redirect: "manual",`);
      return `const res = await fetch(${q(r.url)}, {\n${opts.join('\n')}\n});\n` +
        `console.log(res.status, await res.text());` + (r.insecure ? '\n// Note: fetch has no option to skip TLS verification.' : '');
    },
  },
  python: {
    label: 'Python (requests)',
    gen: (r) => {
      const args = [q(r.method), q(r.url)];
      if (r.headers.length) args.push('headers={\n' + r.headers.map(([k, v]) => `        ${q(k)}: ${q(v)},`).join('\n') + '\n    }');
      if (r.body) args.push(`data=${q(r.body)}.encode()`);
      args.push(`allow_redirects=${r.followRedirects ? 'True' : 'False'}`);
      if (r.insecure) args.push('verify=False');
      args.push(`timeout=${Math.round(r.timeoutMs / 1000) || 30}`);
      return `import requests\n\nres = requests.request(\n    ${args.join(',\n    ')},\n)\nprint(res.status_code, res.text)`;
    },
  },
  go: {
    label: 'Go (net/http)',
    gen: (r) => {
      const imports = ['"fmt"', '"io"', '"net/http"', ...(r.body ? ['"strings"'] : []), ...(r.insecure ? ['"crypto/tls"'] : []), '"time"'].sort();
      const client = [`Timeout: ${Math.round(r.timeoutMs / 1000) || 30} * time.Second`];
      if (r.insecure) client.push('Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}');
      if (!r.followRedirects) client.push('CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }');
      return `package main\n\nimport (\n${imports.map(i => '\t' + i).join('\n')}\n)\n\nfunc main() {\n` +
        `\treq, err := http.NewRequest(${q(r.method)}, ${q(r.url)}, ${r.body ? `strings.NewReader(${q(r.body)})` : 'nil'})\n` +
        `\tif err != nil {\n\t\tpanic(err)\n\t}\n` +
        r.headers.map(([k, v]) => `\treq.Header.Add(${q(k)}, ${q(v)})\n`).join('') +
        `\tclient := &http.Client{\n${client.map(c => '\t\t' + c + ',').join('\n')}\n\t}\n` +
        `\tres, err := client.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n` +
        `\tbody, _ := io.ReadAll(res.Body)\n\tfmt.Println(res.StatusCode, string(body))\n}`;
    },
  },
  httpie: {
    label: 'HTTPie',
    gen: (r) => {
      if (notHTTP(r.url)) return notHTTP(r.url);
      const parts = ['http'];
      if (r.followRedirects) parts.push('--follow');
      if (r.insecure) parts.push('--verify=no');
      parts.push('--', sh(httpMethod(r.method)), sh(r.url));
      // A value starting with = or @ would form ':=', ':=@' or ':@' (JSON field / file
      // read); HTTPie's backslash escape keeps it a literal header value.
      for (const [k, v] of tokenHeaders(r.headers)) parts.push(sh(k + ':' + String(v).replace(/^[=@]/, '\\$&')));
      const cmd = parts.join(' \\\n  ');
      return r.body ? `printf '%s' ${sh(r.body)} | ${cmd}` : cmd;
    },
  },
  powershell: {
    label: 'PowerShell',
    gen: (r) => {
      const lines = [];
      if (r.headers.length) lines.push('$headers = @{\n' + r.headers.map(([k, v]) => `  ${ps(k)} = ${ps(v)}`).join('\n') + '\n}');
      const args = [`-Method ${ps(httpMethod(r.method))}`, `-Uri ${ps(r.url)}`];
      if (r.headers.length) args.push('-Headers $headers');
      if (r.body) args.push(`-Body ${ps(r.body)}`);
      if (!r.followRedirects) args.push('-MaximumRedirection 0');
      if (r.insecure) args.push('-SkipCertificateCheck');
      lines.push(`Invoke-WebRequest ${args.join(' ')}`);
      return lines.join('\n');
    },
  },
};

if (typeof module !== 'undefined') module.exports = { CODE_LANGS };
