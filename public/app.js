(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const PAGE = 60;
  let items = [], index = [], stockDisplay = 'qty', version = null, shown = PAGE, timer = null;

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'stockportal', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Network error'), { status: res.status });
    return data;
  }
  // ---------- data source ----------
  // Node server: /api/...
  // Static page (window.STOCK_STATIC):
  //   - PHP hosting (cPanel / Hostinger / MilesWeb): api.php serves stock + saves requests
  //   - GitHub Pages: stock/stock.json + stock/settings.json, requests go to WhatsApp
  const STATIC = !!window.STOCK_STATIC;
  let PHP = false, STOCK_URL = 'stock/stock.json', SETTINGS_URL = 'stock/settings.json';
  let settings = {}, staticStock = null;
  async function detectPhp() {
    try {
      const r = await fetch('api.php?action=info&t=' + Date.now(), { cache: 'no-store' });
      const d = await r.json();
      if (d && d.mode === 'php') { PHP = true; STOCK_URL = 'api.php?action=stock'; SETTINGS_URL = 'api.php?action=settings'; }
    } catch { /* GitHub Pages: api.php is not executed */ }
  }
  async function getJSON(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load ' + url);
    return r.json();
  }
  async function getInfo() {
    if (!STATIC) return (settings = await api('/api/info'));
    await detectPhp();
    if (PHP) $('reqSend').textContent = 'Send request';
    settings = demoGet('demo_settings') || await getJSON(SETTINGS_URL);
    staticStock = await loadStockSrc();
    if (isDemo()) showDemoBar();
    return { ...settings, authorized: true, version: staticStock.version };
  }
  async function getProducts() {
    if (!STATIC) return api('/api/products');
    const st = staticStock || await loadStockSrc();
    staticStock = null;
    const f = st.fields, iStock = f.indexOf('stock'), low = settings.lowStockLimit ?? 5;
    let rows = st.items;
    if (settings.showOutOfStock === false) rows = rows.filter((r) => r[iStock] > 0);
    // In "status" mode the page shows only In stock / Low / Out; raw qty is kept for the PDF.
    if (settings.stockDisplay === 'status') {
      rows = rows.map((r) => { const v = r[iStock]; const c = r.slice(); c[iStock] = v <= 0 ? 0 : v <= low ? 1 : 2; c.push(v); return c; });
    } else rows = rows.map((r) => r.concat([r[iStock]]));
    return { version: st.version, asOf: st.asOf, updatedAt: st.updatedAt, stockDisplay: settings.stockDisplay || 'qty', fields: f.concat(['raw']), items: rows };
  }
  // Demo mode (set from the admin page on GitHub Pages): show the demo stock saved in this browser.
  const isDemo = () => { try { return !PHP && localStorage.getItem('demo_mode') === '1'; } catch { return false; } };
  const demoGet = (k) => { if (!isDemo()) return null; try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  async function loadStockSrc() { return demoGet('demo_stock') || getJSON(STOCK_URL); }
  function showDemoBar() {
    const bar = document.createElement('div');
    bar.textContent = 'DEMO MODE: showing demo stock saved in this browser only';
    bar.style.cssText = 'background:#16a05d;color:#fff;text-align:center;font-size:13px;font-weight:500;padding:6px 10px';
    document.body.prepend(bar);
  }
  function waLink(text) {
    const digits = String(settings.contactPhone || '').replace(/\D/g, '');
    const num = digits.length === 10 ? '91' + digits : digits;
    return 'https://wa.me/' + num + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  async function sendRequest(body) {
    if (!STATIC) return api('/api/requests', { method: 'POST', body: JSON.stringify(body) });
    if (PHP) return api('api.php?action=request', { method: 'POST', body: JSON.stringify(body) });
    // No server on GitHub Pages: the request is sent to the business on WhatsApp.
    const type = { order: 'ORDER', new: 'NEW PRODUCT REQUEST', other: 'REQUEST' }[body.type] || 'REQUEST';
    const lines = [`*${type}*`, body.product && `Product: ${body.product}`, body.qty && `Qty: ${body.qty}`,
      `Shop: ${body.shop}`, `Mobile: ${body.phone}`, body.message && `Message: ${body.message}`].filter(Boolean);
    window.open(waLink(lines.join('\n')), '_blank', 'noopener');
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  const fmtMrp = (v) => (v === null || v === undefined || v === '' ? '' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  // Highlight the parts of the name that match what was typed.
  function highlight(text, query) {
    const tokens = StockSearch.norm(query).split(' ').filter((t) => t.length > 0);
    const up = String(text).toUpperCase();
    const ranges = [];
    for (const t of tokens) {
      let i = up.indexOf(t);
      while (i >= 0) { ranges.push([i, i + t.length]); i = up.indexOf(t, i + t.length); }
    }
    if (!ranges.length) return esc(text);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0]];
    for (const r of ranges.slice(1)) {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r);
    }
    let out = '', pos = 0;
    for (const [a, b] of merged) { out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b; }
    return out + esc(text.slice(pos));
  }

  function badge(s) {
    if (stockDisplay === 'status') {
      if (s === 2) return '<span class="badge ok">In stock</span>';
      if (s === 1) return '<span class="badge low">Low stock</span>';
      return '<span class="badge out">Out of stock</span>';
    }
    if (s > 0) return `<span class="badge ok">Stock: ${esc(s)}</span>`;
    return '<span class="badge out">Out of stock</span>';
  }

  // ---------- rendering ----------
  function currentResults() {
    const q = $('q').value;
    const comp = $('company').value;
    const inStock = $('inStock').checked;
    const filter = (it) => (!comp || it.company === comp) && (!inStock || it.stock > 0);
    if (StockSearch.norm(q)) return { q, list: StockSearch.search(index, q, { filter }).map((r) => r.item) };
    if (comp) return { q, list: items.filter(filter) };
    return null;
  }

  // PDF link always matches what is on screen (search + company + in-stock filter).
  function updatePdfLink() {
    const q = $('q').value.trim(), comp = $('company').value, inStock = $('inStock').checked;
    const params = new URLSearchParams();
    if (StockSearch.norm(q)) params.set('q', q);
    if (comp) params.set('company', comp);
    if (inStock) params.set('inStock', '1');
    const qs = params.toString();
    $('pdf').href = STATIC ? '#' : '/api/stock.pdf' + (qs ? '?' + qs : '');
    $('pdfLabel').textContent = qs ? 'PDF (this list)' : 'Full stock PDF';
  }

  // GitHub Pages: build the PDF in the browser (same layout as the server PDF).
  let lastData = {};
  function downloadPdf(onlyCurrent) {
    const q = $('q').value.trim(), comp = $('company').value, inStock = $('inStock').checked;
    let list, grouped = true;
    const r = onlyCurrent ? currentResults() : null;
    if (r && StockSearch.norm(q)) { list = r.list; grouped = false; }
    else list = items.filter((it) => !onlyCurrent || ((!comp || it.company === comp) && (!inStock || it.stock > 0)));
    if (grouped) list = [...list].sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name));
    const filters = onlyCurrent ? [StockSearch.norm(q) && `Search: "${q}"`, comp && `Company: ${comp}`, inStock && 'In stock only'].filter(Boolean).join('   ') : '';
    const when = lastData.updatedAt ? new Date(lastData.updatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const bytes = StockPdf.buildStockPdf({
      title: settings.siteName || 'Stock',
      subtitle: `Stock as on ${lastData.asOf || '-'}   |   Updated ${when}   |   ${list.length} item(s)` + (settings.contactPhone ? `   |   Contact: ${settings.contactPhone}` : ''),
      filterText: filters, stockDisplay: stockDisplay, lowStockLimit: settings.lowStockLimit ?? 5,
      items: list.map((it) => ({ ...it, stock: it.raw })), grouped,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = `stock-${String(lastData.asOf || new Date().toISOString().slice(0, 10)).replace(/[^\d]+/g, '-')}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  if (STATIC) {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('#pdf, #navPdf, #heroPdf');
      if (!a) return;
      e.preventDefault();
      if (!items.length) return toast('Stock is still loading…');
      toast('Preparing PDF…');
      setTimeout(() => downloadPdf(a.id === 'pdf'), 30);
    });
  }

  function render() {
    updatePdfLink();
    const list = $('list'), meta = $('meta');
    $('searchBox').classList.toggle('has-text', !!$('q').value);
    const r = currentResults();
    $('homeInfo').classList.toggle('hidden', !!r); // feature cards only when nothing is searched
    if (!r) {
      meta.textContent = items.length ? `${items.length.toLocaleString('en-IN')} products available. Type any part of a name or salt to search.` : '';
      list.innerHTML = '';
      return;
    }
    const total = r.list.length;
    meta.textContent = total ? `${total.toLocaleString('en-IN')} result${total === 1 ? '' : 's'}` : '';
    if (!total) {
      const q = r.q.trim();
      list.innerHTML = `<li class="empty">No product found${q ? ' for <b>' + esc(q) + '</b>' : ''}.<br><br>
        <button class="btn" type="button" data-req-new="${esc(q)}">Request this product</button></li>`;
      return;
    }
    const html = r.list.slice(0, shown).map((it) => `
      <li class="item">
        <div class="name">${highlight(it.name, r.q)}${it.scheme ? `<span class="scheme">Scheme ${esc(it.scheme)}</span>` : ''}${it.code ? `<span class="code">${highlight(it.code, r.q)}</span>` : ''}</div>
        <div class="right">
          <span class="mrp">${fmtMrp(it.mrp) ? 'MRP ' + fmtMrp(it.mrp) : ''}</span>
          ${badge(it.stock)}
          <button class="req-btn" type="button" data-req="${it.id}">${it.stock > 0 ? 'Order' : 'Request'}</button>
        </div>
        ${it.group ? `<div class="group">${highlight(it.group, r.q)}</div>` : ''}
        <div class="company">${esc(it.company)}</div>
      </li>`).join('');
    list.innerHTML = html + (total > shown ? `<li><button class="btn secondary more" type="button" id="more">Show more (${(total - shown).toLocaleString('en-IN')} more)</button></li>` : '');
  }

  function scheduleRender() {
    shown = PAGE;
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  }

  // ---------- data ----------
  async function loadProducts(silent) {
    const data = await getProducts();
    lastData = data;
    const f = data.fields;
    items = data.items.map((row) => { const o = {}; f.forEach((k, i) => { o[k] = row[i] ?? ''; }); return o; });
    index = StockSearch.buildIndex(items);
    stockDisplay = data.stockDisplay;
    version = data.version;
    const companies = [...new Set(items.map((i) => i.company))].sort();
    $('statProducts').textContent = items.length.toLocaleString('en-IN');
    $('statCompanies').textContent = companies.length.toLocaleString('en-IN');
    $('aboutCompanies').textContent = Math.floor(companies.length / 50) * 50 + '+';
    $('statDate').textContent = data.updatedAt ? (data.asOf || fmtTime(data.updatedAt)) : 'Not uploaded';
    $('asOf').textContent = 'Stock as on';
    $('statDate').title = data.updatedAt ? 'Last updated ' + fmtTime(data.updatedAt) : '';
    const sel = $('company'), keep = sel.value;
    sel.innerHTML = '<option value="">All companies</option>' + companies.map((c) => `<option>${esc(c)}</option>`).join('');
    if (companies.includes(keep)) sel.value = keep;
    render();
    if (silent) toast('Stock list updated');
  }

  async function checkForUpdate() {
    if (document.hidden) return;
    try {
      if (STATIC) {
        const st = await loadStockSrc();
        if (st.version !== version) { settings = demoGet('demo_settings') || await getJSON(SETTINGS_URL); staticStock = st; await loadProducts(true); }
        return;
      }
      const info = await api('/api/info');
      if (!info.authorized) return location.reload();
      if (info.version !== version) await loadProducts(true);
    } catch { /* offline - try later */ }
  }

  // ---------- requests ----------
  function openRequest(product, type) {
    $('reqMsg').innerHTML = '';
    $('rProduct').value = product || '';
    $('rQty').value = ''; $('rMessage').value = '';
    $('rShop').value = store.get('shop'); $('rPhone').value = store.get('phone');
    document.querySelector(`input[name="type"][value="${type || 'order'}"]`).checked = true;
    $('reqModal').classList.add('open');
    setTimeout(() => (product ? $('rQty') : $('rProduct')).focus(), 50);
  }
  function closeRequest() { $('reqModal').classList.remove('open'); }

  $('reqForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      type: document.querySelector('input[name="type"]:checked').value,
      product: $('rProduct').value, qty: $('rQty').value,
      shop: $('rShop').value, phone: $('rPhone').value, message: $('rMessage').value,
    };
    if (!/^[+\d][\d\s-]{8,}$/.test(body.phone.trim())) { $('reqMsg').innerHTML = '<div class="msg err">Please enter a valid mobile number.</div>'; return; }
    if (!body.product.trim() && !body.message.trim()) { $('reqMsg').innerHTML = '<div class="msg err">Please write the product name or a message.</div>'; return; }
    $('reqSend').disabled = true;
    try {
      await sendRequest(body);
      store.set('shop', body.shop); store.set('phone', body.phone);
      closeRequest();
      toast(STATIC && !PHP ? 'Opening WhatsApp… press Send there.' : 'Request sent. Thank you!');
    } catch (err) {
      $('reqMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    } finally { $('reqSend').disabled = false; }
  });
  $('reqCancel').addEventListener('click', closeRequest);
  $('reqModal').addEventListener('click', (e) => { if (e.target === $('reqModal')) closeRequest(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRequest(); });
  $('fab').addEventListener('click', () => openRequest(StockSearch.norm($('q').value) ? $('q').value.trim() : '', 'new'));

  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'more') { shown += PAGE; render(); return; }
    if (b.dataset.reqNew !== undefined) { openRequest(b.dataset.reqNew, 'new'); return; }
    const it = items.find((i) => String(i.id) === b.dataset.req);
    if (it) openRequest(it.name + (it.mrp ? ` (MRP ${fmtMrp(it.mrp)})` : '') + ' - ' + it.company, 'order');
  });

  // ---------- search inputs ----------
  $('q').addEventListener('input', scheduleRender);
  $('company').addEventListener('change', () => { shown = PAGE; render(); });
  $('inStock').addEventListener('change', () => { shown = PAGE; render(); });
  $('clear').addEventListener('click', () => { $('q').value = ''; shown = PAGE; render(); $('q').focus(); });
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('q').blur(); }); // hides phone keyboard

  // ---------- start ----------
  // Fill business details (name, phone, WhatsApp, address, GST) from admin settings.
  function showBusiness(info) {
    document.title = info.siteName;
    $('siteName').textContent = info.siteName;
    document.querySelectorAll('.js-site').forEach((el) => { el.textContent = info.siteName; });
    $('year').textContent = new Date().getFullYear();
    if (info.contactPhone) {
      const digits = info.contactPhone.replace(/\D/g, '');
      const wa = 'https://wa.me/' + (digits.length === 10 ? '91' + digits : digits);
      const tel = 'tel:' + (digits.length === 10 ? '+91' + digits : '+' + digits);
      $('tsPhone').href = tel; $('tsPhoneText').textContent = info.contactPhone;
      $('cPhone').href = tel; $('cPhone').textContent = info.contactPhone;
      $('cWa').href = wa; $('heroWa').href = wa;
    }
    if (info.address) { $('cAddress').textContent = info.address; $('tsAddress').textContent = info.address; }
    $('cGst').textContent = info.gst || '';
    $('cGstRow').classList.toggle('hidden', !info.gst);
  }

  // ---------- menu ----------
  const nav = $('nav');
  function setMenu(open) { nav.classList.toggle('open', open); $('menuBtn').setAttribute('aria-expanded', String(open)); }
  $('menuBtn').addEventListener('click', () => setMenu(!nav.classList.contains('open')));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a, button');
    if (!e.target.closest('#nav')) setMenu(false);
    if (!a) return;
    if (a.hasAttribute('data-close')) setMenu(false);
    if (a.hasAttribute('data-open-request')) { e.preventDefault(); openRequest('', 'new'); }
    if (a.hasAttribute('data-focus-search') && !$('app').classList.contains('hidden')) {
      e.preventDefault();
      $('search').scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => $('q').focus({ preventScroll: true }), 350);
    }
  });

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/retailer-login', { method: 'POST', body: JSON.stringify({ pin: $('pin').value }) });
      location.reload();
    } catch (err) { $('pinMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  });

  async function start() {
    try {
      const info = await getInfo();
      showBusiness(info);
      if (!info.authorized) {
        $('asOf').textContent = 'Access code required';
        document.querySelectorAll('#navPdf, #heroPdf').forEach((el) => el.classList.add('hidden'));
        $('pinScreen').classList.remove('hidden');
        $('pin').focus();
        return;
      }
      $('app').classList.remove('hidden');
      $('fab').classList.remove('hidden');
      const pre = new URLSearchParams(location.search).get('q'); // allows links like /?q=dolo
      if (pre) $('q').value = pre;
      await loadProducts(false);
      setInterval(checkForUpdate, 3 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    } catch (err) {
      toast('Could not load stock. Please check internet and refresh.');
    }
  }
  start();
})();
