/* Admin panel for the GitHub Pages version.
 * Stock and settings are saved as JSON files in the GitHub repository through the GitHub API;
 * GitHub Pages then republishes the website (about 1 minute).
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
    const [s, st] = await Promise.all([getFile('stock/stock.json'), getFile('stock/settings.json')]);
    stock = { file: s.json, sha: s.sha, items: s.json ? StockImporter.fromStockFile(s.json) : [] };
    settings = { file: st.json || {}, sha: st.sha };
    pindex = StockSearch.buildIndex(stock.items);
  }

  // ---------- auth ----------
  function logout() { token = ''; ls.set('gh_token', ''); showAuth(); }
  function showAuth() {
    $('panel').classList.add('hidden'); $('logout').classList.add('hidden'); $('auth').classList.remove('hidden');
    $('repoName').textContent = $('repoName2').textContent = OWNER + '/' + REPO;
  }
  $('logout').addEventListener('click', logout);
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('token').value.trim();
    try {
      const repo = await gh('');
      if (!repo.permissions || !repo.permissions.push) throw new Error('This token cannot write to ' + OWNER + '/' + REPO + '. Give it "Contents: Read and write".');
      ls.set('gh_token', token); $('token').value = ''; msg('authMsg', '');
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
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) tab(g.dataset.go); });

  // ---------- dashboard ----------
  async function renderDash() {
    const f = stock.file, low = settings.file.lowStockLimit ?? 5, items = stock.items;
    $('waNum').textContent = settings.file.contactPhone || '-';
    const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('stats').innerHTML = [
      stat(num(items.length), 'Products'), stat(num(new Set(items.map((p) => p.company)).size), 'Companies'),
      stat(num(items.reduce((s, p) => s + Math.max(0, p.stock), 0)), 'Total stock (units)'),
      stat(num(items.filter((p) => p.stock <= 0).length), 'Out of stock'), stat(num(items.filter((p) => p.stock > 0 && p.stock <= low).length), 'Low stock'),
    ].join('');
    $('lastUpload').innerHTML = f
      ? `<div class="row" style="justify-content:space-between"><div><b>Stock as on ${esc(f.asOf || '-')}</b><div class="muted">Uploaded ${when(f.updatedAt)} · ${esc(f.fileName)}</div></div>
         <div class="row"><button class="btn accent" data-go="upload">Upload new stock</button><button class="btn secondary" id="undo">Undo last upload</button></div></div>`
      : '<div class="row" style="justify-content:space-between"><b>No stock uploaded yet.</b><button class="btn accent" data-go="upload">Upload stock file</button></div>';
    try {
      const commits = await gh('/commits?path=stock/stock.json&per_page=15&sha=' + branch);
      $('history').innerHTML = commits.map((c) => `<tr><td>${when(c.commit.author.date)}</td><td>${esc(c.commit.message.split('\n')[0])}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No uploads yet</td></tr>';
    } catch { $('history').innerHTML = '<tr><td colspan="2" class="muted">Could not load history</td></tr>'; }
  }

  $('panel').addEventListener('click', async (e) => {
    if (e.target.id !== 'undo') return;
    if (!confirm('Restore the stock from before the last upload?')) return;
    try {
      const commits = await gh('/commits?path=stock/stock.json&per_page=2&sha=' + branch);
      if (commits.length < 2) throw new Error('There is no earlier stock to restore.');
      const prev = await getFile('stock/stock.json', commits[1].sha);
      const restored = { ...prev.json, version: (stock.file.version || 0) + 1 };
      await putFile('stock/stock.json', restored, 'Restore previous stock (as on ' + (prev.json.asOf || '-') + ')', stock.sha);
      await loadAll(); renderDash(); watchLive(restored.version);
    } catch (err) { toast(err.message); }
  });

  // Wait until GitHub Pages serves the new version, then say so.
  async function watchLive(version) {
    const box = $('liveMsg');
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
      const changes = StockImporter.diff(stock.items, r.items);
      pending = { result: r, fileName: file.name, changes };
      out.innerHTML = `<div class="card"><div class="msg ok">File read successfully${r.asOf ? ' — stock as on ' + esc(r.asOf) : ''}. Check the numbers and press <b>Publish</b>.</div>
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
      const fileObj = StockImporter.toStockFile(pending.result, pending.fileName, stock.file ? stock.file.version : 0);
      const c = pending.changes;
      await putFile('stock/stock.json', fileObj, `Stock as on ${fileObj.asOf || '-'}: ${fileObj.stats.products} products (+${c.added} new, ${c.changed} changed, -${c.removed} removed)`, stock.sha);
      pending = null;
      $('uploadResult').innerHTML = '<div class="msg ok">✔ Published. The website will show the new stock in about 1 minute.</div>';
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
    const filter = (p) => !f || (f === 'out' && p.stock <= 0) || (f === 'low' && p.stock > 0 && p.stock <= low) || (f === 'nogroup' && !p.group);
    const list = StockSearch.norm(q) ? StockSearch.search(pindex, q, { filter }).map((r) => r.item) : stock.items.filter(filter);
    $('pmeta').textContent = `${num(list.length)} of ${num(stock.items.length)} products`;
    $('ptable').innerHTML = list.slice(0, pShown).map((p) => `<tr>
      <td><b>${esc(p.name)}</b>${p.scheme ? ` <span class="scheme">${esc(p.scheme)}</span>` : ''}${p.code ? ` <span class="code">${esc(p.code)}</span>` : ''}</td>
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
    const items = [...stock.items].sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name));
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
      await putFile('stock/settings.json', next, 'Update website settings', settings.sha);
      await loadAll(); msg('setMsg', 'Saved. The website will update in about 1 minute.', true);
    } catch (err) { msg('setMsg', err.message); }
  });

  // ---------- start ----------
  async function start() {
    $('auth').classList.add('hidden');
    $('panel').classList.remove('hidden'); $('logout').classList.remove('hidden');
    $('topSub').textContent = 'Loading…';
    try {
      const repo = await gh('');
      branch = repo.default_branch || 'main';
      await loadAll();
      $('topSub').textContent = settings.file.siteName || 'Upload stock and manage the website';
      tab('dash');
    } catch (err) { $('topSub').textContent = err.message; }
  }
  if (token) start(); else showAuth();
})();
