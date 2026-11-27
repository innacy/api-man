// Master-password gate (as in MQLens): first launch creates the password,
// later launches ask for it. The app scripts load only once unlocked.
(async () => {
  let t = 'dark', a = 'amber';
  try { t = localStorage.getItem('apiperf-theme') || t; a = localStorage.getItem('apiperf-accent') || a; } catch {}
  const de = document.documentElement;
  de.classList.toggle('dark', ['dark', 'nord', 'dracula'].includes(t) || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
  de.classList.toggle('nord', t === 'nord'); de.classList.toggle('dracula', t === 'dracula'); de.dataset.accent = a;

  const api = async (path, body) => {
    const r = await fetch('/api/vault' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j.status;
  };
  const boot = () => {
    document.getElementById('vault')?.remove();
    for (const s of ['app.js', 'postman.js', 'codegen.js', 'send.js']) {
      const el = document.createElement('script'); el.src = s; el.async = false; document.body.append(el);
    }
  };
  let status;
  try { status = await api(''); } catch (e) { status = 'error'; }
  if (status === 'unlocked') return boot();

  const box = document.createElement('div');
  box.id = 'vault';
  const inp = 'style="background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:.5rem .6rem;font-size:13px"';
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg)';
  document.body.append(box);
  const render = () => {
    const setup = status === 'uninitialized';
    box.innerHTML = `<form style="width:100%;max-width:400px;display:grid;gap:12px;padding:24px;border:1px solid var(--border);border-radius:10px;background:var(--card);box-shadow:var(--shadow)">
      <h2 style="margin:0;font-size:17px;text-transform:none;letter-spacing:0;color:var(--fg)">${setup ? 'Create a master password' : 'Unlock API-Man'}</h2>
      <p style="margin:0;color:var(--muted)">${setup ? 'Your saved requests, environments and history are protected with this password. There is no recovery if you forget it.' : 'Enter your master password to open your workspace.'}</p>
      <input ${inp} type="password" id="v-pw" placeholder="Master password" autofocus autocomplete="${setup ? 'new-password' : 'current-password'}">
      ${setup ? `<input ${inp} type="password" id="v-cf" placeholder="Confirm password" autocomplete="new-password">` : ''}
      <div id="v-err" style="color:var(--bad);font-size:12px"></div>
      <button type="submit" >${setup ? 'Create &amp; unlock' : 'Unlock'}</button>
      ${setup ? '' : '<button type="button" class="link" id="v-reset" style="color:var(--muted)">Forgot password? Reset (deletes all saved data)</button>'}
    </form>`;
    const err = box.querySelector('#v-err'), f = box.querySelector('form');
    box.querySelector('#v-pw').focus();
    f.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = '';
      const pw = f.querySelector('#v-pw').value;
      if (!pw) return err.textContent = 'Master password is required';
      if (setup && pw !== f.querySelector('#v-cf').value) return err.textContent = 'Passwords do not match';
      f.querySelector('[type=submit]').disabled = true;
      try { status = await api(setup ? '/init' : '/unlock', { password: pw }); boot(); }
      catch (e2) { err.textContent = e2.message; f.querySelector('[type=submit]').disabled = false; }
    };
    const rs = box.querySelector('#v-reset');
    if (rs) rs.onclick = async () => {
      if (!confirm('Reset deletes ALL saved collections, environments, history and cookies. Continue?')) return;
      try {
        status = await api('/reset', {});
        try { for (const k of ['apiperf-send-tabs', 'apiperf-send-prefs', 'apiperf-send-draft']) localStorage.removeItem(k); } catch {}
        render();
      } catch (e2) { err.textContent = e2.message; }
    };
  };
  render();
})();
