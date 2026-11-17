'use strict';
// Stock Portal - retailer stock search + admin panel.
// Pure Node.js (v18+), no npm packages needed.  Start with:  node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const store = require('./lib/store');
const { readSpreadsheet } = require('./lib/xlsx');
const { importRows, diff } = require('./lib/importer');
const { buildStockPdf } = require('./lib/pdf');
const StockSearch = require('./public/search.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 20 * 1024 * 1024;

// ---------- config / secrets ----------
const config = store.getConfig();
if (!config.secret) { config.secret = crypto.randomBytes(32).toString('hex'); store.setConfig(config); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- sessions ----------
const sessions = new Map(); // sid -> { role, expires }
const SESSION_MS = 12 * 60 * 60 * 1000;
function newSession(role, res, req) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { role, expires: Date.now() + SESSION_MS });
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `asid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9.]+)'));
  return m ? m[1] : null;
}
// Retailer access uses a signed cookie (survives server restarts; changing the PIN logs out all shops).
function retailerSig(exp) {
  return crypto.createHmac('sha256', config.secret).update('r|' + exp + '|' + (store.getSettings().retailerPin || '')).digest('hex');
}
function setRetailerCookie(req, res) {
  const exp = Date.now() + 60 * 86400000;
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `rtok=${exp}.${retailerSig(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 86400}${secure}`);
}
function hasSession(req, role) {
  if (role === 'retailer') {
    const tok = getCookie(req, 'rtok');
    if (!tok) return false;
    const [exp, sig] = tok.split('.');
    if (!sig || Number(exp) < Date.now()) return false;
    const want = retailerSig(exp);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
  const sid = getCookie(req, 'asid');
  const s = sid && sessions.get(sid);
  if (!s) return false;
  if (s.expires < Date.now() || s.role !== role) { sessions.delete(sid); return false; }
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k); }, 3600000).unref();

// ---------- simple rate limiter ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600000).unref();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(body);
}
function json(req, res, status, obj, extra = {}) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
  }
  send(res, status, body, headers);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('File too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, rel) {
  const p = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!p.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(p, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const headers = { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|javascript|svg|json/.test(headers['Content-Type'])) {
      data = zlib.gzipSync(data); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
    }
    send(res, 200, data, headers);
  });
}

// ---------- public stock payload (cached per version) ----------
let publicCache = { key: null, gz: null, raw: null, etag: null };
function publicPayload() {
  const stock = store.getStock();
  const st = store.getSettings();
  const key = stock.version + '|' + st.stockDisplay + '|' + st.lowStockLimit + '|' + st.showOutOfStock;
  if (publicCache.key === key) return publicCache;
  const items = stock.items
    .filter((p) => st.showOutOfStock || p.stock > 0)
    .map((p) => {
      const s = p.stock > 0 ? p.stock : 0;
      const stockVal = st.stockDisplay === 'status' ? (s <= 0 ? 0 : s <= st.lowStockLimit ? 1 : 2) : s;
      return [p.id, p.name, p.company, p.group, p.code, p.mrp, stockVal, p.scheme];
    });
  const raw = Buffer.from(JSON.stringify({
    version: stock.version, asOf: stock.asOf, updatedAt: stock.updatedAt,
    stockDisplay: st.stockDisplay, fields: ['id', 'name', 'company', 'group', 'code', 'mrp', 'stock', 'scheme'], items,
  }));
  publicCache = { key, raw, gz: zlib.gzipSync(raw), etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' };
  return publicCache;
}

function publicInfo(req) {
  const st = store.getSettings();
  const stock = store.getStock();
  return {
    siteName: st.siteName,
    contactPhone: st.contactPhone,
    address: st.address,
    gst: st.gst,
    pinRequired: !!st.retailerPin,
    authorized: !st.retailerPin || hasSession(req, 'retailer'),
    version: stock.version, asOf: stock.asOf, updatedAt: stock.updatedAt,
  };
}

// ---------- PDF download (same search/filters as the page) ----------
const pdfCache = new Map(); // small cache: key -> Buffer
let searchIndex = { version: null, index: null };
function stockPdf(params, forAdmin) {
  const stock = store.getStock();
  const st = store.getSettings();
  const q = clip(params.get('q'), 100);
  const company = clip(params.get('company'), 200);
  const inStock = params.get('inStock') === '1';
  const display = forAdmin ? 'qty' : st.stockDisplay;
  const key = [stock.version, display, st.lowStockLimit, st.showOutOfStock, st.siteName, forAdmin, q, company, inStock].join('|');
  if (pdfCache.has(key)) return pdfCache.get(key);

  let items = stock.items.filter((p) => (forAdmin || st.showOutOfStock || p.stock > 0)
    && (!company || p.company === company) && (!inStock || p.stock > 0));
  let grouped = true;
  if (StockSearch.norm(q)) {
    if (searchIndex.version !== stock.version) searchIndex = { version: stock.version, index: StockSearch.buildIndex(stock.items) };
    const allowed = new Set(items);
    items = StockSearch.search(searchIndex.index, q, { filter: (p) => allowed.has(p) }).map((r) => r.item);
    grouped = false; // keep best matches first
  } else {
    items = [...items].sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name));
  }
  const when = stock.updatedAt ? new Date(stock.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const filters = [q && `Search: "${q}"`, company && `Company: ${company}`, inStock && 'In stock only'].filter(Boolean).join('   ');
  const buf = Buffer.from(buildStockPdf({
    title: st.siteName,
    subtitle: `Stock as on ${stock.asOf || '-'}   |   Updated ${when}   |   ${items.length} item(s)` + (st.contactPhone ? `   |   Contact: ${st.contactPhone}` : ''),
    filterText: filters,
    stockDisplay: display, lowStockLimit: st.lowStockLimit, items, grouped,
  }, (u8) => zlib.deflateSync(u8)));
  if (pdfCache.size > 30) pdfCache.clear();
  pdfCache.set(key, buf);
  return buf;
}

// ---------- admin actions ----------
async function doImport(buf, filename) {
  const rows = await readSpreadsheet(buf, filename, (u8) => zlib.inflateRawSync(u8));
  const result = importRows(rows);
  const old = store.getStock();
  const changes = diff(old.items, result.items);
  const now = new Date().toISOString();
  store.setStock({ items: result.items, asOf: result.asOf, updatedAt: now, version: (old.version || 0) + 1, fileName: filename });
  const uploads = store.getUploads();
  uploads.unshift({ at: now, fileName: filename, asOf: result.asOf, layout: result.layout, ...result.stats, changes, warnings: result.warnings.length });
  store.setUploads(uploads.slice(0, 200));
  return { ok: true, asOf: result.asOf, layout: result.layout, stats: result.stats, changes, warnings: result.warnings };
}

function dashboard() {
  const stock = store.getStock();
  const reqs = store.getRequests();
  const st = store.getSettings();
  return {
    asOf: stock.asOf, updatedAt: stock.updatedAt, fileName: stock.fileName || '',
    products: stock.items.length,
    companies: new Set(stock.items.map((p) => p.company)).size,
    totalStock: stock.items.reduce((s, p) => s + Math.max(0, p.stock), 0),
    outOfStock: stock.items.filter((p) => p.stock <= 0).length,
    lowStock: stock.items.filter((p) => p.stock > 0 && p.stock <= st.lowStockLimit).length,
    newRequests: reqs.filter((r) => r.status === 'new').length,
    totalRequests: reqs.length,
    uploads: store.getUploads().slice(0, 15),
    canUndo: !!store.latestBackup(),
  };
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// ---------- router ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  const isApi = p.startsWith('/api/');

  // CSRF protection: state-changing API calls must come from our own pages (custom header + same origin).
  if (isApi && m !== 'GET') {
    if (req.headers['x-requested-with'] !== 'stockportal') return json(req, res, 403, { error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(req, res, 403, { error: 'Forbidden' });
  }

  // ----- pages -----
  if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(req, res, 'index.html');
  if (m === 'GET' && (p === '/admin' || p === '/admin/')) return serveStatic(req, res, 'admin.html');
  if (m === 'GET' && p.startsWith('/static/')) return serveStatic(req, res, p.slice(8));

  // ----- public API -----
  if (p === '/api/info' && m === 'GET') return json(req, res, 200, publicInfo(req));

  if (p === '/api/retailer-login' && m === 'POST') {
    if (limited('pin:' + clientIp(req), 10, 10 * 60000)) return json(req, res, 429, { error: 'Too many attempts. Try again in 10 minutes.' });
    const { pin } = await readJsonBody(req);
    const st = store.getSettings();
    const ok = st.retailerPin && crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(pin || '')).digest(), crypto.createHash('sha256').update(st.retailerPin).digest());
    if (!ok) return json(req, res, 401, { error: 'Wrong access code' });
    setRetailerCookie(req, res);
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/products' && m === 'GET') {
    if (!publicInfo(req).authorized) return json(req, res, 401, { error: 'Access code required' });
    const c = publicPayload();
    if (req.headers['if-none-match'] === c.etag) return send(res, 304, '', { ETag: c.etag });
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    return send(res, 200, gz ? c.gz : c.raw, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
  }

  if (p === '/api/stock.pdf' && m === 'GET') {
    const admin = hasSession(req, 'admin');
    if (!admin && !publicInfo(req).authorized) return json(req, res, 401, { error: 'Access code required' });
    if (limited('pdf:' + clientIp(req), 30, 60000)) return json(req, res, 429, { error: 'Too many downloads, please wait a minute.' });
    const forAdmin = admin && url.searchParams.get('admin') === '1';
    const buf = stockPdf(url.searchParams, forAdmin);
    const asOf = (store.getStock().asOf || new Date().toISOString().slice(0, 10)).replace(/[^\d]+/g, '-');
    return send(res, 200, buf, {
      'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
      'Content-Disposition': `${url.searchParams.get('view') === '1' ? 'inline' : 'attachment'}; filename="stock-${asOf}.pdf"`,
    });
  }

  if (p === '/api/requests' && m === 'POST') {
    if (!publicInfo(req).authorized) return json(req, res, 401, { error: 'Access code required' });
    if (limited('req:' + clientIp(req), 20, 10 * 60000)) return json(req, res, 429, { error: 'Too many requests sent. Please wait a few minutes.' });
    const b = await readJsonBody(req, 8 * 1024 * 1024);
    const r = {
      id: crypto.randomBytes(8).toString('hex'),
      at: new Date().toISOString(),
      type: ['order', 'new', 'other'].includes(b.type) ? b.type : 'other',
      product: clip(b.product, 200), qty: clip(b.qty, 40),
      shop: clip(b.shop, 120), phone: clip(b.phone, 20), message: clip(b.message, 1000),
      status: 'new',
    };
    if (!r.shop || !r.phone || (!r.product && !r.message)) return json(req, res, 400, { error: 'Please fill shop name, mobile number and product / message.' });
    if (b.photo) {
      const pm = String(b.photo).match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
      if (!pm) return json(req, res, 400, { error: 'The photo must be an image.' });
      const bin = Buffer.from(pm[2], 'base64');
      if (bin.length > 5 * 1024 * 1024) return json(req, res, 400, { error: 'The photo is too large.' });
      const ext = pm[1] === 'jpeg' ? 'jpg' : pm[1];
      fs.mkdirSync(path.join(store.DATA_DIR, 'photos'), { recursive: true });
      fs.writeFileSync(path.join(store.DATA_DIR, 'photos', r.id + '.' + ext), bin);
      r.photo = ext;
    }
    const all = store.getRequests();
    all.unshift(r);
    store.setRequests(all.slice(0, 5000));
    return json(req, res, 200, { ok: true });
  }

  // ----- admin API -----
  if (p === '/api/admin/state' && m === 'GET') {
    return json(req, res, 200, { setupNeeded: !store.getConfig().adminHash, loggedIn: hasSession(req, 'admin') });
  }
  if (p === '/api/admin/setup' && m === 'POST') {
    const cfg = store.getConfig();
    if (cfg.adminHash) return json(req, res, 400, { error: 'Already set up' });
    const { password } = await readJsonBody(req);
    if (!password || String(password).length < 8) return json(req, res, 400, { error: 'Password must be at least 8 characters' });
    cfg.adminHash = hashPassword(String(password));
    store.setConfig(cfg);
    newSession('admin', res, req);
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited('login:' + clientIp(req), 8, 15 * 60000)) return json(req, res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { password } = await readJsonBody(req);
    if (!checkPassword(password, store.getConfig().adminHash)) return json(req, res, 401, { error: 'Wrong password' });
    newSession('admin', res, req);
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    const sid = getCookie(req, 'asid'); if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'asid=; Path=/; Max-Age=0');
    return json(req, res, 200, { ok: true });
  }

  if (p.startsWith('/api/admin/')) {
    if (!hasSession(req, 'admin')) return json(req, res, 401, { error: 'Please log in' });

    if (p === '/api/admin/dashboard' && m === 'GET') return json(req, res, 200, dashboard());

    if (p === '/api/admin/upload' && m === 'POST') {
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) return json(req, res, 400, { error: 'Empty file' });
      const name = clip(decodeURIComponent(req.headers['x-filename'] || 'upload.xlsx'), 200);
      try { return json(req, res, 200, await doImport(buf, name)); } catch (e) { return json(req, res, 400, { error: e.message }); }
    }

    if (p === '/api/admin/undo-upload' && m === 'POST') {
      const b = store.latestBackup();
      if (!b) return json(req, res, 400, { error: 'No previous stock to restore' });
      const cur = store.getStock();
      store.restoreBackup(b, (cur.version || 0) + 1);
      const uploads = store.getUploads();
      uploads.unshift({ at: new Date().toISOString(), fileName: '(restored previous stock: ' + (b.data.fileName || '') + ')', asOf: b.data.asOf, products: b.data.items.length, undo: true });
      store.setUploads(uploads.slice(0, 200));
      return json(req, res, 200, { ok: true });
    }

    if (p === '/api/admin/products' && m === 'GET') {
      const s = store.getStock();
      return json(req, res, 200, { items: s.items, asOf: s.asOf, updatedAt: s.updatedAt });
    }

    if (p === '/api/admin/requests' && m === 'GET') return json(req, res, 200, { items: store.getRequests() });

    if (p === '/api/admin/requests.csv' && m === 'GET') {
      const rows = [['Date', 'Type', 'Product', 'Qty', 'Shop', 'Mobile', 'Message', 'Status']];
      for (const r of store.getRequests()) rows.push([r.at, r.type, r.product, r.qty, r.shop, r.phone, r.message, r.status]);
      const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="requests.csv"' });
    }

    const pm = p.match(/^\/api\/admin\/photo\/([a-f0-9]+)$/);
    if (pm && m === 'GET') {
      for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
        const f = path.join(store.DATA_DIR, 'photos', pm[1] + '.' + ext);
        if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
      }
      return json(req, res, 404, { error: 'Not found' });
    }

    const rm = p.match(/^\/api\/admin\/requests\/([a-f0-9]+)$/);
    if (rm && (m === 'POST' || m === 'DELETE')) {
      const all = store.getRequests();
      const i = all.findIndex((r) => r.id === rm[1]);
      if (i < 0) return json(req, res, 404, { error: 'Not found' });
      if (m === 'DELETE') {
        for (const ext of ['jpg', 'png', 'webp']) fs.rmSync(path.join(store.DATA_DIR, 'photos', all[i].id + '.' + ext), { force: true });
        all.splice(i, 1);
      }
      else {
        const { status, note } = await readJsonBody(req);
        if (['new', 'seen', 'done'].includes(status)) all[i].status = status;
        if (note !== undefined) all[i].note = clip(note, 500);
      }
      store.setRequests(all);
      return json(req, res, 200, { ok: true });
    }

    if (p === '/api/admin/settings' && m === 'GET') return json(req, res, 200, store.getSettings());
    if (p === '/api/admin/settings' && m === 'POST') {
      const b = await readJsonBody(req);
      const cur = store.getSettings();
      const next = {
        siteName: clip(b.siteName ?? cur.siteName, 100) || cur.siteName,
        retailerPin: clip(b.retailerPin ?? cur.retailerPin, 40),
        stockDisplay: b.stockDisplay === 'status' ? 'status' : 'qty',
        lowStockLimit: Math.max(0, Math.min(100000, Number(b.lowStockLimit ?? cur.lowStockLimit) || 0)),
        showOutOfStock: b.showOutOfStock === undefined ? cur.showOutOfStock : !!b.showOutOfStock,
        contactPhone: clip(b.contactPhone ?? cur.contactPhone, 20).replace(/[^\d+ ]/g, ''),
        address: clip(b.address ?? cur.address, 300),
        gst: clip(b.gst ?? cur.gst, 20).toUpperCase(),
      };
      store.setSettings(next);
      return json(req, res, 200, { ok: true, settings: next });
    }

    if (p === '/api/admin/password' && m === 'POST') {
      const { current, password } = await readJsonBody(req);
      const cfg = store.getConfig();
      if (!checkPassword(current, cfg.adminHash)) return json(req, res, 401, { error: 'Current password is wrong' });
      if (!password || String(password).length < 8) return json(req, res, 400, { error: 'New password must be at least 8 characters' });
      cfg.adminHash = hashPassword(String(password));
      store.setConfig(cfg);
      for (const [k, s] of sessions) if (s.role === 'admin') sessions.delete(k);
      newSession('admin', res, req);
      return json(req, res, 200, { ok: true });
    }
  }

  if (isApi) return json(req, res, 404, { error: 'Not found' });
  return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) json(req, res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  });
});
server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Stock portal running:  http://localhost:${PORT}   (admin: http://localhost:${PORT}/admin)`);
    console.log('Data folder:', store.DATA_DIR);
  });
}
module.exports = server;
