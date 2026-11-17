/* Admin panel for the static website. Two storage backends:
 *  - PHP hosting (cPanel, MilesWeb, Hostinger...): api.php saves stock/settings/requests on the server.
 *  - GitHub Pages: stock and settings are saved as JSON files in the GitHub repository via the GitHub API;
 *    GitHub Pages then republishes the website (about 1 minute).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v || 0).toLocaleString('en-IN');
  const mrp = (v) => (v === null || v === undefined || v === '' ? '' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
  function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500); }
  const msg = (el, text, ok) => { $(el).innerHTML = text ? `<div class="msg ${ok ? 'ok' : 'err'}">${esc(text)}</div>` : ''; };
  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // Repository = the one this page is served from (owner.github.io/repo), with a fallback.
  const host = location.hostname;
  const OWNER = host.endsWith('.github.io') ? host.split('.')[0] : 'Primewebsitepro';
  const REPO = host.endsWith('.github.io') ? (location.pathname.split('/')[1] || OWNER + '.github.io') : 'pdf';
  // Commits are made with GitHub's no-reply address, never a personal email.
  const AUTHOR = { name: OWNER, email: OWNER + '@users.noreply.github.com' };
  let token = ls.get('gh_token');
  let branch = 'main';
  let PHP = false, phpInfo = null;

  // ---------- demo mode (GitHub Pages) ----------
  // Lets a client try every admin feature without any GitHub access. Changes are kept only in
  // this browser (localStorage) and the website in the same browser shows the demo stock.
  const DEMO_PASSWORD = 'demo1234';
  let DEMO = ls.get('demo_mode') === '1';
  const dget = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const dset = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { throw new Error('Browser storage is full or blocked.'); } };
  const fetchSite = (p) => fetch(p + '?t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // ---------- admin password (GitHub Pages) ----------
  // The GitHub token is encrypted with the admin password (PBKDF2 + AES-GCM) and stored in the
  // repository as stock/admin-key.json. Logging in with the password decrypts the token.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const toB64 = (u8) => btoa(String.fromCharCode.apply(null, u8));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptToken(tok, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 310000;
    const key = await deriveKey(password, salt, iter);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(tok)));
    return { v: 1, iter, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  }
  async function decryptToken(obj, password) {
    const key = await deriveKey(password, fromB64(obj.salt), obj.iter);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(obj.iv) }, key, fromB64(obj.data)));
  }

  // ---------- PHP backend ----------
  async function php(action, body, query) {
    const res = await fetch('api.php?action=' + action + (query || ''), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Requested-With': 'stockportal', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !['login', 'password'].includes(action)) { showAuth(); throw new Error('Please log in again'); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Server error ' + res.status), { status: res.status });
    return data;
  }
  async function detectPhp() {
    try {
      const d = await fetch('api.php?action=info&t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json());
      if (d && d.mode === 'php') { PHP = true; phpInfo = d; }
    } catch { /* not PHP hosting */ }
  }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const res = await fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + path, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error('Token is wrong or expired. Please log in again.'); }
    if (!res.ok) throw Object.assign(new Error(data.message || 'GitHub error ' + res.status), { status: res.status });
    return data;
  }
  const b64encode = (text) => { const u8 = new TextEncoder().encode(text); let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  async function getFile(path, ref) {
    try {
      const d = await gh('/contents/' + path + '?ref=' + encodeURIComponent(ref || branch));
      if (d.content) return { sha: d.sha, json: JSON.parse(b64decode(d.content)) };
      // files over 1 MB: fetch raw
      const raw = await fetch(d.download_url).then((r) => r.json());
      return { sha: d.sha, json: raw };
    } catch (e) { if (e.status === 404) return { sha: null, json: null }; throw e; }
  }
  async function putFile(path, obj, message, sha) {
    return gh('/contents/' + path, {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64encode(JSON.stringify(obj)), sha: sha || undefined, branch, author: AUTHOR, committer: AUTHOR }),
    });
  }

  // ---------- state ----------
  let stock = { file: null, sha: null, items: [] }, settings = { file: null, sha: null }, pindex = [], pShown = 100;

  async function loadAll() {
    if (DEMO) {
      const sj = dget('demo_stock') || await fetchSite('stock/stock.json');
      const stj = dget('demo_settings') || await fetchSite('stock/settings.json') || {};
      stock = { file: sj, sha: null, items: sj && sj.items ? StockImporter.fromStockFile(sj) : [] };
      settings = { file: stj, sha: null };
      pindex = StockSearch.buildIndex(stock.items);
      return;
    }
    if (PHP) {
      const [sj, stj] = await Promise.all([php('stock'), php('settings')]);
      stock = { file: sj.version ? sj : null, sha: null, items: sj.items && sj.items.length ? StockImporter.fromStockFile(sj) : [] };
      settings = { file: stj || {}, sha: null };
      pindex = StockSearch.buildIndex(stock.items);
      return;
    }
    const [s, st] = await Promise.all([getFile('stock/stock.json'), getFile('stock/settings.json')]);
    stock = { file: s.json, sha: s.sha, items: s.json ? StockImporter.fromStockFile(s.json) : [] };
    settings = { file: st.json || {}, sha: st.sha };
    pindex = StockSearch.buildIndex(stock.items);
  }

  // ---------- storage operations (PHP or GitHub) ----------
  async function saveStock(fileObj, message) {
    if (DEMO) {
      if (stock.file) dset('demo_prev', stock.file);
      fileObj.updatedAt = new Date().toISOString();
      dset('demo_stock', fileObj);
      dset('demo_history', [{ at: fileObj.updatedAt, message }].concat(dget('demo_history') || []).slice(0, 20));
      return { version: fileObj.version };
    }
    if (PHP) return php('save_stock', fileObj, '&message=' + encodeURIComponent(message));
    return putFile('stock/stock.json', fileObj, message, stock.sha);
  }
  async function saveSettings(next) {
    if (DEMO) return dset('demo_settings', next);
    if (PHP) return php('save_settings', next);
    return putFile('stock/settings.json', next, 'Update website settings', settings.sha);
  }
  async function loadHistory() {
    if (DEMO) return dget('demo_history') || [];
    if (PHP) { const h = await php('history'); return h.items.map((x) => ({ at: x.at, message: x.message })); }
    const commits = await gh('/commits?path=stock/stock.json&per_page=15&sha=' + branch);
    return commits.map((c) => ({ at: c.commit.author.date, message: c.commit.message.split('\n')[0] }));
  }
  async function undoLast() {
    if (DEMO) {
      const prev = dget('demo_prev');
      if (!prev) throw new Error('There is no earlier stock to restore.');
      prev.version = (stock.file ? stock.file.version : 0) + 1;
      dset('demo_stock', prev); dset('demo_prev', null);
      dset('demo_history', [{ at: new Date().toISOString(), message: 'Restored previous stock' }].concat(dget('demo_history') || []));
      return { version: prev.version };
    }
    if (PHP) return php('undo', {});
    const commits = await gh('/commits?path=stock/stock.json&per_page=2&sha=' + branch);
    if (commits.length < 2) throw new Error('There is no earlier stock to restore.');
    const prev = await getFile('stock/stock.json', commits[1].sha);
    const restored = { ...prev.json, version: (stock.file.version || 0) + 1 };
    await putFile('stock/stock.json', restored, 'Restore previous stock (as on ' + (prev.json.asOf || '-') + ')', stock.sha);
    return { version: restored.version };
  }

  // ---------- auth ----------
  async function logout() {
    if (PHP) { await php('logout', {}).catch(() => {}); phpInfo.loggedIn = false; }
    if (DEMO) { ['demo_stock', 'demo_settings', 'demo_prev', 'demo_history'].forEach((k) => dset(k, null)); DEMO = false; ls.set('demo_mode', ''); }
    token = ''; ls.set('gh_token', ''); showAuth();
  }
  function showAuth() {
    $('panel').classList.add('hidden'); $('logout').classList.add('hidden'); $('auth').classList.remove('hidden');
    if (PHP) {
      const setup = !!phpInfo.setupNeeded;
      $('pwLoginForm').classList.remove('hidden'); $('authForm').classList.add('hidden');
      $('pwTitle').textContent = setup ? 'Set admin password' : 'Admin login';
      $('setupText').classList.toggle('hidden', !setup); $('pw2Wrap').classList.toggle('hidden', !setup);
      $('pwBtn').textContent = setup ? 'Save password' : 'Login';
      $('pw').focus();
      return;
    }
    $('authForm').classList.remove('hidden'); $('pwLoginForm').classList.add('hidden');
    $('repoName').textContent = $('repoName2').textContent = OWNER + '/' + REPO;
  }
  $('logout').addEventListener('click', logout);
  $('pwLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const setup = !!phpInfo.setupNeeded, password = $('pw').value;
    if (setup && password !== $('pw2').value) return msg('pwLoginMsg', 'Passwords do not match');
    try {
      await php(setup ? 'setup' : 'login', { password });
      phpInfo.setupNeeded = false; $('pw').value = $('pw2').value = ''; msg('pwLoginMsg', '');
      start();
    } catch (err) { msg('pwLoginMsg', err.message); }
  });
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('ghPw').value;
    if (!$('token').value.trim()) {
      if (!password) return msg('authMsg', 'Please enter the password');
      if (password === DEMO_PASSWORD) {
        DEMO = true; ls.set('demo_mode', '1'); $('ghPw').value = ''; msg('authMsg', '');
        return start();
      }
      msg('authMsg', 'Checking…', true);
      const keyFile = await fetchSite('stock/admin-key.json');
      if (!keyFile) return msg('authMsg', 'Admin password is not set yet. The owner must log in once with a GitHub token (below) and set a password in Settings.');
      try { token = await decryptToken(keyFile, password); } catch { token = ''; return msg('authMsg', 'Wrong password'); }
    } else token = $('token').value.trim();
    try {
      const repo = await gh('');
      if (!repo.permissions || !repo.permissions.push) throw new Error('This token cannot write to ' + OWNER + '/' + REPO + '. Give it "Contents: Read and write".');
      ls.set('gh_token', token); $('token').value = ''; $('ghPw').value = ''; msg('authMsg', '');
      start();
    } catch (err) { token = ''; msg('authMsg', err.message); }
  });

  // ---------- tabs ----------
  function tab(name) {
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('main section').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    if (name === 'dash') renderDash();
    if (name === 'products') renderProducts();
    if (name === 'settings') renderSettings();
    if (name === 'requests') loadRequests();
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) tab(g.dataset.go); });

  // ---------- dashboard ----------
  async function renderDash() {
    const f = stock.file, low = settings.file.lowStockLimit ?? 5, items = stock.items;
    $('waNum').textContent = settings.file.contactPhone || '-';
    const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const FIRMS = StockImporter.FIRMS;
    $('stats').innerHTML = [
      stat(num(items.length), 'Products'),
      stat(num(items.filter((p) => p.firm === 'MD').length), FIRMS.MD), stat(num(items.filter((p) => p.firm === 'MM').length), FIRMS.MM),
      stat(num(new Set(items.map((p) => p.company)).size), 'Companies'),
      stat(num(items.reduce((s, p) => s + Math.max(0, p.stock), 0)), 'Total stock (units)'),
      stat(num(items.filter((p) => p.stock <= 0).length), 'Out of stock'), stat(num(items.filter((p) => p.stock > 0 && p.stock <= low).length), 'Low stock'),
    ].join('');
    const fi = StockImporter.firmsOf(f);
    const firmLine = (k) => `<div style="margin-bottom:6px"><i class="dot ${k.toLowerCase()}"></i> <b>${FIRMS[k]}</b> — ${fi[k] ? `stock as on ${esc(fi[k].asOf || '-')} <span class="muted">(uploaded ${when(fi[k].updatedAt)} · ${esc(fi[k].fileName)})</span>` : '<span class="muted">not uploaded yet</span>'}</div>`;
    $('lastUpload').innerHTML = f
      ? `<div class="row" style="justify-content:space-between;align-items:flex-start"><div>${firmLine('MD')}${firmLine('MM')}</div>
         <div class="row"><button class="btn accent" data-go="upload">Upload new stock</button><button class="btn secondary" id="undo">Undo last upload</button></div></div>`
      : '<div class="row" style="justify-content:space-between"><b>No stock uploaded yet.</b><button class="btn accent" data-go="upload">Upload stock file</button></div>';
    try {
      const h = await loadHistory();
      $('history').innerHTML = h.map((c) => `<tr><td>${when(c.at)}</td><td>${esc(c.message)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No uploads yet</td></tr>';
    } catch { $('history').innerHTML = '<tr><td colspan="2" class="muted">Could not load history</td></tr>'; }
  }

  $('panel').addEventListener('click', async (e) => {
    if (e.target.id !== 'undo') return;
    if (!confirm('Restore the stock from before the last upload?')) return;
    try {
      const r = await undoLast();
      await loadAll(); renderDash(); watchLive(r.version);
    } catch (err) { toast(err.message); }
  });

  // Wait until GitHub Pages serves the new version, then say so.
  async function watchLive(version) {
    const box = $('liveMsg');
    if (DEMO) { box.innerHTML = '<div class="msg ok">✔ Saved in demo mode. Open "View website" in this browser to see it.</div>'; toast('Saved (demo)'); return; }
    if (PHP) { box.innerHTML = '<div class="msg ok">✔ Saved. The website is now showing the new stock.</div>'; toast('Website updated'); return; }
    box.innerHTML = '<div class="msg ok">Saved. The website is updating… (about 1 minute)</div>';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const live = await fetch('stock/stock.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
        if (live.version >= version) { box.innerHTML = '<div class="msg ok">✔ The website is now showing the new stock.</div>'; toast('Website updated'); return; }
      } catch { /* keep waiting */ }
    }
    box.innerHTML = '<div class="msg err">GitHub Pages is taking longer than usual. The new stock will appear soon.</div>';
  }

  // ---------- upload ----------
  let pending = null;
  const drop = $('drop');
  $('file').addEventListener('change', () => { if ($('file').files[0]) readFile($('file').files[0]); });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

  async function readFile(file) {
    const out = $('uploadResult');
    out.innerHTML = `<div class="card">Reading <b>${esc(file.name)}</b>…</div>`;
    try {
      const rows = await StockXlsx.readSpreadsheet(new Uint8Array(await file.arrayBuffer()), file.name, StockXlsx.browserInflateRaw);
      const r = StockImporter.importRows(rows);
      const firm = (document.querySelector('input[name="firm"]:checked') || {}).value || 'MD';
      const changes = StockImporter.diff(stock.items.filter((p) => p.firm === firm), r.items);
      pending = { result: r, fileName: file.name, changes, firm };
      out.innerHTML = `<div class="card"><div class="msg ok">File read successfully for <b>${esc(StockImporter.FIRMS[firm])}</b>${r.asOf ? ' — stock as on ' + esc(r.asOf) : ''}. Check the numbers and press <b>Publish</b>.</div>
        <div class="stats">
          <div class="stat"><div class="v">${num(r.stats.products)}</div><div class="l">Products (from ${num(r.stats.rowsRead)} rows)</div></div>
          <div class="stat"><div class="v">${num(r.stats.companies)}</div><div class="l">Companies</div></div>
          <div class="stat"><div class="v">${num(r.stats.totalStock)}</div><div class="l">Total stock</div></div>
          <div class="stat"><div class="v">${num(changes.added)}</div><div class="l">New products</div></div>
          <div class="stat"><div class="v">${num(changes.changed)}</div><div class="l">Stock changed</div></div>
          <div class="stat"><div class="v">${num(changes.removed)}</div><div class="l">Removed</div></div>
        </div>
        ${r.warnings.length ? `<ul class="warn-list">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <div class="actions" style="margin-top:12px"><button class="btn secondary" id="cancelUp">Cancel</button><button class="btn accent" id="publish">Publish to website</button></div></div>`;
    } catch (err) {
      out.innerHTML = `<div class="msg err">Could not read file: ${esc(err.message)}</div>`;
    } finally { $('file').value = ''; }
  }
  $('uploadResult').addEventListener('click', async (e) => {
    if (e.target.id === 'cancelUp') { pending = null; $('uploadResult').innerHTML = ''; return; }
    if (e.target.id !== 'publish' || !pending) return;
    e.target.disabled = true; e.target.textContent = 'Publishing…';
    try {
      const fileObj = StockImporter.toStockFile(pending.result, pending.fileName, stock.file ? stock.file.version : 0, pending.firm, stock.file);
      const c = pending.changes;
      await saveStock(fileObj, `${StockImporter.FIRMS[pending.firm]}: stock as on ${fileObj.asOf || '-'}, ${fileObj.stats.products} products (+${c.added} new, ${c.changed} changed, -${c.removed} removed)`);
      pending = null;
      $('uploadResult').innerHTML = PHP ? '<div class="msg ok">✔ Published. The website now shows the new stock.</div>' : '<div class="msg ok">✔ Published. The website will show the new stock in about 1 minute.</div>';
      await loadAll();
      tab('dash');
      watchLive(fileObj.version);
    } catch (err) {
      e.target.disabled = false; e.target.textContent = 'Publish to website';
      toast(err.status === 409 ? 'Stock was changed from another device. Reload the page and try again.' : err.message);
    }
  });

  // ---------- products ----------
  function renderProducts() {
    const q = $('pq').value, f = $('pf').value, low = settings.file.lowStockLimit ?? 5;
    const filter = (p) => !f || (f === 'out' && p.stock <= 0) || (f === 'low' && p.stock > 0 && p.stock <= low) || (f === 'nogroup' && !p.group) || p.firm === f;
    const list = StockSearch.norm(q) ? StockSearch.search(pindex, q, { filter }).map((r) => r.item) : stock.items.filter(filter);
    $('pmeta').textContent = `${num(list.length)} of ${num(stock.items.length)} products`;
    $('ptable').innerHTML = list.slice(0, pShown).map((p) => `<tr>
      <td><b>${esc(p.name)}</b>${p.scheme ? ` <span class="scheme">${esc(p.scheme)}</span>` : ''}${p.code ? ` <span class="code">${esc(p.code)}</span>` : ''}<span class="firm-tag ${p.firm.toLowerCase()}">${p.firm === 'MM' ? 'Medical' : 'Distributors'}</span></td>
      <td class="muted">${esc(p.group)}</td><td class="muted">${esc(p.company)}</td><td class="num">${mrp(p.mrp)}</td>
      <td class="num"><span class="badge ${p.stock <= 0 ? 'out' : p.stock <= low ? 'low' : 'ok'}">${num(p.stock)}</span></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No products</td></tr>';
    $('pmore').classList.toggle('hidden', list.length <= pShown);
  }
  let pt; $('pq').addEventListener('input', () => { pShown = 100; clearTimeout(pt); pt = setTimeout(renderProducts, 100); });
  $('pf').addEventListener('change', () => { pShown = 100; renderProducts(); });
  $('pmore').addEventListener('click', () => { pShown += 200; renderProducts(); });
  $('pdfAdmin').addEventListener('click', () => {
    const f = stock.file || {};
    const items = [...stock.items].sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name))
      .map((p) => (p.firm === 'MM' ? { ...p, name: p.name + '  (Meghavi Medical)' } : p));
    const bytes = StockPdf.buildStockPdf({
      title: settings.file.siteName || 'Stock', subtitle: `Stock as on ${f.asOf || '-'}   |   Updated ${when(f.updatedAt)}   |   ${items.length} item(s)`,
      filterText: '', stockDisplay: 'qty', items, grouped: true,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = 'stock-full.pdf'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  // ---------- settings ----------
  function renderSettings() {
    const s = settings.file;
    $('shareLink').value = location.origin + location.pathname.replace(/admin\.html$/, '');
    $('sName').value = s.siteName || ''; $('sPhone').value = s.contactPhone || ''; $('sAddress').value = s.address || ''; $('sGst').value = s.gst || '';
    $('sDisplay').value = s.stockDisplay || 'qty'; $('sLow').value = s.lowStockLimit ?? 5; $('sOut').value = s.showOutOfStock === false ? '0' : '1';
  }
  $('copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('shareLink').value); toast('Link copied'); } catch { $('shareLink').select(); } });
  $('setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = {
      siteName: $('sName').value.trim() || 'Stock', contactPhone: $('sPhone').value.replace(/[^\d+ ]/g, '').trim(),
      address: $('sAddress').value.trim(), gst: $('sGst').value.trim().toUpperCase(),
      stockDisplay: $('sDisplay').value === 'status' ? 'status' : 'qty',
      lowStockLimit: Math.max(0, Number($('sLow').value) || 0), showOutOfStock: $('sOut').value === '1',
    };
    try {
      await saveSettings(next);
      await loadAll(); msg('setMsg', PHP || DEMO ? 'Settings saved.' : 'Saved. The website will update in about 1 minute.', true);
    } catch (err) { msg('setMsg', err.message); }
  });

  // ---------- requests (PHP hosting only) ----------
  let requests = [];
  const typeLabel = { order: 'Order', new: 'New product', other: 'Other' };
  function setCount(n) { const c = $('reqCount'); c.textContent = n; c.classList.toggle('hidden', !n); }
  async function loadRequests() { requests = (await php('requests')).items; renderRequests(); }
  function renderRequests() {
    const f = $('rf').value, q = $('rq').value.trim().toLowerCase();
    const list = requests.filter((r) => (!f || (f === 'open' ? r.status !== 'done' : r.status === f))
      && (!q || [r.shop, r.product, r.phone, r.message].join(' ').toLowerCase().includes(q)));
    setCount(requests.filter((r) => r.status === 'new').length);
    $('rlist').innerHTML = list.map((r) => {
      const digits = String(r.phone).replace(/\D/g, ''); const wa = digits.length === 10 ? '91' + digits : digits;
      const waText = encodeURIComponent(`Hello ${r.shop}, regarding your request: ${r.product || r.message}`);
      return `<div class="req ${r.status === 'new' ? 'new' : ''}">
        <div class="head"><div><span class="tag">${esc(typeLabel[r.type] || r.type)}</span> <span class="tag st-${esc(r.status)}">${esc(r.status)}</span></div><div class="muted">${when(r.at)}</div></div>
        <div class="prod">${esc(r.product || '(no product name)')}${r.qty ? ` — Qty: ${esc(r.qty)}` : ''}</div>
        <div class="who">${esc(r.shop)} · ${esc(r.phone)}</div>
        ${r.message ? `<div class="msgtxt">${esc(r.message)}</div>` : ''}
        ${r.photo ? `<a href="api.php?action=photo&id=${esc(r.id)}" target="_blank" rel="noopener"><img class="req-photo" src="api.php?action=photo&id=${esc(r.id)}" alt="Product photo" loading="lazy"></a>` : ''}
        <div class="btns">
          <a class="btn secondary" href="tel:${esc(r.phone)}">Call</a>
          <a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${esc(wa)}?text=${waText}">WhatsApp</a>
          ${r.status !== 'done' ? `<button class="btn accent" data-st="done" data-id="${esc(r.id)}">Mark done</button>` : `<button class="btn secondary" data-st="new" data-id="${esc(r.id)}">Re-open</button>`}
          ${r.status === 'new' ? `<button class="btn secondary" data-st="seen" data-id="${esc(r.id)}">Mark seen</button>` : ''}
          <button class="btn secondary" data-del="${esc(r.id)}">Delete</button>
        </div></div>`;
    }).join('') || '<div class="card muted">No requests here.</div>';
  }
  $('rf').addEventListener('change', renderRequests);
  $('rq').addEventListener('input', renderRequests);
  $('rlist').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.st) await php('request_update', { id: b.dataset.id, status: b.dataset.st });
      else if (b.dataset.del) { if (!confirm('Delete this request?')) return; await php('request_delete', { id: b.dataset.del }); }
      loadRequests();
    } catch (err) { toast(err.message); }
  });
  $('reqCsv').addEventListener('click', () => {
    const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [['Date', 'Type', 'Product', 'Qty', 'Shop', 'Mobile', 'Message', 'Status']]
      .concat(requests.map((r) => [r.at, r.type, r.product, r.qty, r.shop, r.phone, r.message, r.status]));
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'requests.csv'; document.body.appendChild(a); a.click(); a.remove();
  });
  // GitHub Pages: set / change the admin password (encrypts the current GitHub token).
  $('ghPwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('ghNew').value, p2 = $('ghNew2').value;
    if (p1.length < 8) return msg('ghPwMsg', 'Password must be at least 8 characters');
    if (p1 !== p2) return msg('ghPwMsg', 'Passwords do not match');
    if (p1 === DEMO_PASSWORD) return msg('ghPwMsg', 'Choose a different password');
    try {
      const cur = await getFile('stock/admin-key.json');
      await putFile('stock/admin-key.json', await encryptToken(token, p1), 'Update admin password', cur.sha);
      $('ghNew').value = $('ghNew2').value = '';
      msg('ghPwMsg', 'Admin password saved. From now on log in with this password (works after about 1 minute).', true);
    } catch (err) { msg('ghPwMsg', err.message); }
  });
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await php('password', { current: $('pwCur').value, password: $('pwNew').value });
      $('pwCur').value = $('pwNew').value = ''; msg('pwMsg', 'Password changed', true);
    } catch (err) { msg('pwMsg', err.message); }
  });

  // ---------- start ----------
  async function start() {
    $('auth').classList.add('hidden');
    $('panel').classList.remove('hidden'); $('logout').classList.remove('hidden');
    $('topSub').textContent = 'Loading…';
    $('reqTabBtn').classList.toggle('hidden', !PHP); $('pwForm').classList.toggle('hidden', !PHP);
    $('ghPwForm').classList.toggle('hidden', PHP || DEMO);
    if (PHP) $('waNote').classList.add('hidden');
    try {
      if (DEMO) {
        await loadAll();
      } else if (PHP) {
        await loadAll();
        php('requests').then((d) => setCount(d.items.filter((r) => r.status === 'new').length)).catch(() => {});
      } else {
        const repo = await gh('');
        branch = repo.default_branch || 'main';
        await loadAll();
      }
      $('topSub').textContent = (settings.file.siteName || 'Upload stock and manage the website') + (DEMO ? ' · DEMO' : '');
      tab('dash');
    } catch (err) { $('topSub').textContent = err.message; }
  }
  detectPhp().then(() => {
    if (PHP) { if (phpInfo.loggedIn) start(); else showAuth(); }
    else if (token || DEMO) start(); else showAuth();
  });
})();
