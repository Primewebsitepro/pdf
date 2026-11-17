(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v || 0).toLocaleString('en-IN');
  const mrp = (v) => (v === null || v === undefined ? '' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
  let settings = {}, products = [], pindex = [], pShown = 100, requests = [];

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'stockportal', ...(typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.includes('login') && !path.includes('password')) { showAuth(false); throw new Error('Please log in again'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000); }
  const msg = (el, text, ok) => { $(el).innerHTML = text ? `<div class="msg ${ok ? 'ok' : 'err'}">${esc(text)}</div>` : ''; };

  // ---------- auth ----------
  let setupMode = false;
  function showAuth(setup) {
    setupMode = setup;
    $('panel').classList.add('hidden'); $('logout').classList.add('hidden'); $('viewSite').classList.add('hidden');
    $('auth').classList.remove('hidden');
    $('authTitle').textContent = setup ? 'Set admin password' : 'Admin login';
    $('setupText').classList.toggle('hidden', !setup);
    $('pw2Wrap').classList.toggle('hidden', !setup);
    $('authBtn').textContent = setup ? 'Save password' : 'Login';
    $('pw').autocomplete = setup ? 'new-password' : 'current-password';
    $('pw').focus();
  }
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('pw').value;
    if (setupMode && password !== $('pw2').value) return msg('authMsg', 'Passwords do not match');
    try {
      await api(setupMode ? '/api/admin/setup' : '/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      $('pw').value = $('pw2').value = ''; msg('authMsg', '');
      showPanel();
    } catch (err) { msg('authMsg', err.message); }
  });
  $('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); showAuth(false); });

  // ---------- tabs ----------
  function tab(name) {
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('main section').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    if (name === 'dash') loadDash();
    if (name === 'products') loadProducts();
    if (name === 'requests') loadRequests();
    if (name === 'settings') loadSettings();
    try { sessionStorage.setItem('tab', name); } catch { /* ignore */ }
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); });

  async function showPanel() {
    $('auth').classList.add('hidden');
    $('panel').classList.remove('hidden'); $('logout').classList.remove('hidden'); $('viewSite').classList.remove('hidden');
    let t = 'dash'; try { t = sessionStorage.getItem('tab') || 'dash'; } catch { /* ignore */ }
    tab(t);
    refreshCount();
  }

  // ---------- dashboard ----------
  async function loadDash() {
    const d = await api('/api/admin/dashboard');
    setCount(d.newRequests);
    const stat = (v, l, t) => `<div class="stat"${t ? ` style="cursor:pointer" data-go="${t}"` : ''}><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('stats').innerHTML = [
      stat(num(d.products), 'Products'), stat(num(d.companies), 'Companies'), stat(num(d.totalStock), 'Total stock (units)'),
      stat(num(d.outOfStock), 'Out of stock', 'products'), stat(num(d.lowStock), 'Low stock', 'products'),
      stat(num(d.newRequests), 'New requests', 'requests'),
    ].join('');
    $('lastUpload').innerHTML = d.updatedAt
      ? `<div class="row" style="justify-content:space-between"><div><b>Stock as on ${esc(d.asOf || '-')}</b><div class="muted">Last uploaded ${when(d.updatedAt)} · ${esc(d.fileName)}</div></div>
         <div class="row"><button class="btn" data-go="upload">Upload new stock</button>${d.canUndo ? '<button class="btn secondary" id="undo">Undo last upload</button>' : ''}</div></div>`
      : `<div class="row" style="justify-content:space-between"><b>No stock uploaded yet.</b><button class="btn" data-go="upload">Upload stock file</button></div>`;
    $('history').innerHTML = d.uploads.length ? d.uploads.map((u) => `<tr>
        <td>${when(u.at)}</td><td>${esc(u.fileName)}</td><td>${esc(u.asOf || '')}</td><td class="num">${num(u.products)}</td>
        <td class="num">${u.changes ? num(u.changes.added) : ''}</td><td class="num">${u.changes ? num(u.changes.changed) : ''}</td><td class="num">${u.changes ? num(u.changes.removed) : ''}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted">No uploads yet</td></tr>';
  }
  document.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { tab(go.dataset.go); if (go.dataset.go === 'products' && /Out|Low/.test(go.textContent)) { $('pf').value = /Out/.test(go.textContent) ? 'out' : 'low'; renderProducts(); } return; }
    if (e.target.id === 'undo') {
      if (!confirm('Restore the stock from before the last upload?')) return;
      try { await api('/api/admin/undo-upload', { method: 'POST' }); toast('Previous stock restored'); products = []; loadDash(); } catch (err) { toast(err.message); }
    }
  });

  // ---------- upload ----------
  const drop = $('drop');
  $('file').addEventListener('change', () => { if ($('file').files[0]) upload($('file').files[0]); });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

  async function upload(file) {
    const out = $('uploadResult');
    out.innerHTML = `<div class="card">Uploading <b>${esc(file.name)}</b>…</div>`;
    try {
      const r = await api('/api/admin/upload', { method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } });
      products = [];
      out.innerHTML = `<div class="card"><div class="msg ok">✔ Stock updated successfully${r.asOf ? ' — stock as on ' + esc(r.asOf) : ''}. Retailers will see it automatically.</div>
        <div class="stats">
          <div class="stat"><div class="v">${num(r.stats.products)}</div><div class="l">Products (from ${num(r.stats.rowsRead)} rows)</div></div>
          <div class="stat"><div class="v">${num(r.stats.companies)}</div><div class="l">Companies</div></div>
          <div class="stat"><div class="v">${num(r.stats.totalStock)}</div><div class="l">Total stock</div></div>
          <div class="stat"><div class="v">${num(r.changes.added)}</div><div class="l">New products</div></div>
          <div class="stat"><div class="v">${num(r.changes.changed)}</div><div class="l">Stock changed</div></div>
          <div class="stat"><div class="v">${num(r.changes.removed)}</div><div class="l">Removed (not in new file)</div></div>
        </div>
        ${r.warnings.length ? `<ul class="warn-list">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <div class="actions" style="margin-top:12px"><button class="btn secondary" id="undo">Undo this upload</button><button class="btn" data-go="products">View products</button></div></div>`;
    } catch (err) {
      out.innerHTML = `<div class="msg err">Upload failed: ${esc(err.message)}</div>`;
    } finally { $('file').value = ''; }
  }

  // ---------- products ----------
  async function loadProducts() {
    if (!products.length) {
      const d = await api('/api/admin/products');
      products = d.items;
      pindex = StockSearch.buildIndex(products);
    }
    if (!settings.siteName) settings = await api('/api/admin/settings');
    renderProducts();
  }
  function renderProducts() {
    const q = $('pq').value, f = $('pf').value, low = settings.lowStockLimit ?? 5;
    const filter = (p) => !f || (f === 'out' && p.stock <= 0) || (f === 'low' && p.stock > 0 && p.stock <= low) || (f === 'nogroup' && !p.group);
    const list = StockSearch.norm(q) ? StockSearch.search(pindex, q, { filter }).map((r) => r.item) : products.filter(filter);
    $('pmeta').textContent = `${num(list.length)} of ${num(products.length)} products`;
    $('pdfAdmin').href = '/api/stock.pdf?admin=1' + (StockSearch.norm(q) ? '&q=' + encodeURIComponent(q) : '');
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

  // ---------- requests ----------
  function setCount(n) { const c = $('reqCount'); c.textContent = n; c.classList.toggle('hidden', !n); }
  async function refreshCount() { try { const d = await api('/api/admin/dashboard'); setCount(d.newRequests); } catch { /* ignore */ } }
  setInterval(() => { if (!document.hidden && !$('panel').classList.contains('hidden')) refreshCount(); }, 60000);

  async function loadRequests() { requests = (await api('/api/admin/requests')).items; renderRequests(); }
  const typeLabel = { order: 'Order', new: 'New product', other: 'Other' };
  function renderRequests() {
    const f = $('rf').value, q = $('rq').value.trim().toLowerCase();
    const list = requests.filter((r) => (!f || (f === 'open' ? r.status !== 'done' : r.status === f))
      && (!q || [r.shop, r.product, r.phone, r.message].join(' ').toLowerCase().includes(q)));
    setCount(requests.filter((r) => r.status === 'new').length);
    $('rlist').innerHTML = list.map((r) => {
      const digits = String(r.phone).replace(/\D/g, ''); const wa = digits.length === 10 ? '91' + digits : digits;
      const waText = encodeURIComponent(`Hello ${r.shop}, regarding your request: ${r.product || r.message}`);
      return `<div class="req ${r.status === 'new' ? 'new' : ''}">
        <div class="head"><div><span class="tag">${typeLabel[r.type] || r.type}</span> <span class="tag st-${r.status}">${r.status}</span></div><div class="muted">${when(r.at)}</div></div>
        <div class="prod" style="margin-top:6px">${esc(r.product || '(no product name)')}${r.qty ? ` — Qty: ${esc(r.qty)}` : ''}</div>
        <div class="who">${esc(r.shop)} · ${esc(r.phone)}</div>
        ${r.message ? `<div class="msgtxt">${esc(r.message)}</div>` : ''}
        <div class="btns">
          <a class="btn secondary" href="tel:${esc(r.phone)}">Call</a>
          <a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${esc(wa)}?text=${waText}">WhatsApp</a>
          ${r.status !== 'done' ? `<button class="btn" data-st="done" data-id="${r.id}">Mark done</button>` : `<button class="btn secondary" data-st="new" data-id="${r.id}">Re-open</button>`}
          ${r.status === 'new' ? `<button class="btn secondary" data-st="seen" data-id="${r.id}">Mark seen</button>` : ''}
          <button class="btn secondary" data-del="${r.id}">Delete</button>
        </div></div>`;
    }).join('') || '<div class="card muted">No requests here.</div>';
  }
  $('rf').addEventListener('change', renderRequests);
  $('rq').addEventListener('input', renderRequests);
  $('rlist').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.st) await api('/api/admin/requests/' + b.dataset.id, { method: 'POST', body: JSON.stringify({ status: b.dataset.st }) });
      else if (b.dataset.del) { if (!confirm('Delete this request?')) return; await api('/api/admin/requests/' + b.dataset.del, { method: 'DELETE' }); }
      loadRequests();
    } catch (err) { toast(err.message); }
  });

  // ---------- settings ----------
  async function loadSettings() {
    settings = await api('/api/admin/settings');
    $('shareLink').value = location.origin + '/';
    $('sName').value = settings.siteName; $('sPhone').value = settings.contactPhone; $('sPin').value = settings.retailerPin;
    $('sAddress').value = settings.address || ''; $('sGst').value = settings.gst || '';
    $('sDisplay').value = settings.stockDisplay; $('sLow').value = settings.lowStockLimit; $('sOut').value = settings.showOutOfStock ? '1' : '0';
  }
  $('copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('shareLink').value); toast('Link copied'); } catch { $('shareLink').select(); }
  });
  $('setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({
        siteName: $('sName').value, contactPhone: $('sPhone').value, retailerPin: $('sPin').value, address: $('sAddress').value, gst: $('sGst').value,
        stockDisplay: $('sDisplay').value, lowStockLimit: $('sLow').value, showOutOfStock: $('sOut').value === '1',
      }) });
      settings = r.settings; msg('setMsg', 'Settings saved', true);
    } catch (err) { msg('setMsg', err.message); }
  });
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: $('pwCur').value, password: $('pwNew').value }) });
      $('pwCur').value = $('pwNew').value = ''; msg('pwMsg', 'Password changed', true);
    } catch (err) { msg('pwMsg', err.message); }
  });

  // ---------- start ----------
  api('/api/admin/state').then((s) => (s.loggedIn ? showPanel() : showAuth(s.setupNeeded))).catch(() => showAuth(false));
})();
