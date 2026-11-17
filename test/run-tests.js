'use strict';
// End-to-end test: starts the server on a temp data folder and exercises every feature.
// Usage: node test/run-tests.js [path-to-stock.xlsx]
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stockportal-test-'));
const server = require('../server');
const S = require('../public/search.js');

const xlsxPath = process.argv[2] || path.join(__dirname, '..', '..', 'StockBtc meghavi -1.xlsx');
let base, adminCookie = '', retailerCookie = '';
let passed = 0;
const ok = (name) => { passed++; console.log('  ✔', name); };

async function call(method, p, { body, cookie, headers = {}, raw } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'X-Requested-With': 'stockportal', ...(cookie ? { Cookie: cookie } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, setCookie, headers: res.headers };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('Server', base, 'data', process.env.DATA_DIR);

  // --- admin setup + login
  let r = await call('GET', '/api/admin/state');
  assert.strictEqual(r.data.setupNeeded, true); ok('first run asks for admin password');
  r = await call('POST', '/api/admin/setup', { body: { password: 'short' } });
  assert.strictEqual(r.status, 400); ok('short password rejected');
  r = await call('POST', '/api/admin/setup', { body: { password: 'Secret@123' } });
  assert.strictEqual(r.status, 200); adminCookie = r.setCookie.split(';')[0]; ok('admin password set');
  r = await call('POST', '/api/admin/setup', { body: { password: 'Another@123' } });
  assert.strictEqual(r.status, 400); ok('setup cannot be repeated');
  r = await call('POST', '/api/admin/login', { body: { password: 'wrong-pass' } });
  assert.strictEqual(r.status, 401); ok('wrong password rejected');
  r = await call('POST', '/api/admin/login', { body: { password: 'Secret@123' } });
  assert.strictEqual(r.status, 200); adminCookie = r.setCookie.split(';')[0]; ok('admin login works');
  r = await call('GET', '/api/admin/dashboard');
  assert.strictEqual(r.status, 401); ok('admin API blocked without login');

  // --- CSRF
  const nohdr = await fetch(base + '/api/admin/logout', { method: 'POST', headers: { Cookie: adminCookie } });
  assert.strictEqual(nohdr.status, 403); ok('POST without app header blocked (CSRF)');
  const evil = await fetch(base + '/api/requests', { method: 'POST', headers: { 'X-Requested-With': 'stockportal', Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(evil.status, 403); ok('cross-origin POST blocked');

  // --- upload real stock file
  r = await call('POST', '/api/admin/upload', { cookie: adminCookie, raw: fs.readFileSync(xlsxPath), headers: { 'X-Filename': encodeURIComponent(path.basename(xlsxPath)) } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.stats.totalStock, 53038);
  assert.strictEqual(r.data.stats.rowsRead, 3833);
  console.log('     import:', JSON.stringify(r.data.stats), r.data.asOf);
  ok('real stock Excel imported (3833 rows, total 53038 matches report)');

  r = await call('POST', '/api/admin/upload', { cookie: adminCookie, raw: Buffer.from('hello world'), headers: { 'X-Filename': 'x.csv' } });
  assert.strictEqual(r.status, 400); ok('bad file rejected with message: ' + r.data.error.slice(0, 50) + '…');

  // --- second upload (CSV, flat layout) updates existing stock
  const csv = 'Item Code,Item Name,Company,Stock,MRP,Group\nD650,DOLO 650 MG TAB,MICRO LABS LTD,99,30.91,PARACETAMOL 650MG\nNEW1,"CERBOPROST INJ, 1ML",TEST PHARMA,5,450,CARBOPROST\n';
  r = await call('POST', '/api/admin/upload', { cookie: adminCookie, raw: Buffer.from(csv), headers: { 'X-Filename': 'today.csv' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.stats.products, 2);
  assert.ok(r.data.changes.removed > 2000);
  ok(`CSV upload replaces stock (added ${r.data.changes.added}, removed ${r.data.changes.removed})`);
  let p = await call('GET', '/api/products');
  const items = p.data.items.map((row) => Object.fromEntries(p.data.fields.map((k, i) => [k, row[i]])));
  const idx = S.buildIndex(items);
  assert.strictEqual(S.search(idx, 'carboprost')[0].item.name, 'CERBOPROST INJ, 1ML'); ok('typo search: carboprost -> CERBOPROST');
  assert.strictEqual(S.search(idx, 'd650')[0].item.code, 'D650'); ok('item code search works');

  // --- undo restores previous upload
  r = await call('POST', '/api/admin/undo-upload', { cookie: adminCookie });
  assert.strictEqual(r.status, 200);
  p = await call('GET', '/api/products');
  assert.ok(p.data.items.length > 2000); ok('undo last upload restores previous stock');
  const etag = p.headers.get('etag');
  const p304 = await fetch(base + '/api/products', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(p304.status, 304); ok('unchanged stock served from browser cache (304)');

  // --- search on real data
  const all = p.data.items.map((row) => Object.fromEntries(p.data.fields.map((k, i) => [k, row[i]])));
  const ix = S.buildIndex(all);
  const top = (q) => S.search(ix, q).slice(0, 3).map((x) => x.item.name);
  assert.ok(top('prost').some((n) => n.includes('PROST'))); ok('middle letters: "prost" -> ' + top('prost')[0]);
  assert.ok(S.search(ix, 'gard').some((x) => x.item.name === 'PROSTAGARD 4 MG')); ok('last letters: "gard" finds PROSTAGARD');
  assert.ok(top('agumentin')[0].startsWith('AUGMENTIN')); ok('typo: "agumentin" -> ' + top('agumentin')[0]);
  assert.ok(top('zerodl')[0].startsWith('ZERODOL')); ok('typo: "zerodl" -> ' + top('zerodl')[0]);
  assert.ok(top('dolo650')[0].startsWith('DOLO 650')); ok('no-space: "dolo650" -> ' + top('dolo650')[0]);
  assert.ok(S.search(ix, 'amlodipine').length > 10); ok('salt/group search: amlodipine -> ' + S.search(ix, 'amlodipine').length + ' results');

  // --- PDF download
  let pdf = await fetch(base + '/api/stock.pdf');
  let pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(pdfBuf.subarray(0, 5).toString() === '%PDF-' && pdfBuf.subarray(-6).toString().includes('%%EOF'));
  const pageCount = Number(pdfBuf.toString('latin1').match(/\/Count (\d+)/)[1]);
  assert.ok(pageCount > 20);
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'full.pdf'), pdfBuf);
  ok(`full stock PDF: ${pageCount} pages, ${Math.round(pdfBuf.length / 1024)} KB`);
  pdf = await fetch(base + '/api/stock.pdf?q=prost&inStock=1');
  pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.strictEqual(Number(pdfBuf.toString('latin1').match(/\/Count (\d+)/)[1]), 1);
  ok('search PDF (q=prost) is 1 page');

  // --- product request
  r = await call('POST', '/api/requests', { body: { type: 'new', product: 'CERBOPROST INJ', qty: '5', shop: 'Shree Medical', phone: '9876543210', message: '<script>alert(1)</script>' } });
  assert.strictEqual(r.status, 200); ok('retailer can send product request');
  r = await call('POST', '/api/requests', { body: { type: 'new', product: 'X' } });
  assert.strictEqual(r.status, 400); ok('request without shop/mobile rejected');
  r = await call('GET', '/api/admin/requests', { cookie: adminCookie });
  assert.strictEqual(r.data.items[0].shop, 'Shree Medical');
  const id = r.data.items[0].id;
  r = await call('POST', '/api/admin/requests/' + id, { cookie: adminCookie, body: { status: 'done' } });
  r = await call('GET', '/api/admin/requests', { cookie: adminCookie });
  assert.strictEqual(r.data.items[0].status, 'done'); ok('admin sees request and marks it done');
  r = await call('GET', '/api/admin/requests.csv', { cookie: adminCookie });
  assert.ok(String(r.data).includes('Shree Medical')); ok('requests export to CSV');

  // --- retailer access code
  r = await call('POST', '/api/admin/settings', { cookie: adminCookie, body: { retailerPin: '4521', stockDisplay: 'status' } });
  assert.strictEqual(r.status, 200);
  r = await call('GET', '/api/products');
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await fetch(base + '/api/stock.pdf')).status, 401);
  ok('with access code set, stock and PDF are hidden');
  r = await call('POST', '/api/retailer-login', { body: { pin: '1111' } });
  assert.strictEqual(r.status, 401);
  r = await call('POST', '/api/retailer-login', { body: { pin: '4521' } });
  retailerCookie = r.setCookie.split(';')[0];
  r = await call('GET', '/api/products', { cookie: retailerCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.items.every((row) => [0, 1, 2].includes(row[6]))); ok('correct code opens stock; "status" mode hides exact qty');
  await call('POST', '/api/admin/settings', { cookie: adminCookie, body: { retailerPin: '9999' } });
  r = await call('GET', '/api/products', { cookie: retailerCookie });
  assert.strictEqual(r.status, 401); ok('changing the code logs out old retailers');
  await call('POST', '/api/admin/settings', { cookie: adminCookie, body: { retailerPin: '', stockDisplay: 'qty' } });

  // --- many simultaneous users
  const N = 300, t0 = Date.now();
  const http = require('http');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
  const get = () => new Promise((resolve, reject) => {
    http.get(base + '/api/products', { agent, headers: { 'Accept-Encoding': 'gzip' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  const res = await Promise.all(Array.from({ length: N }, get));
  agent.destroy();
  assert.ok(res.every((s) => s === 200));
  ok(`${N} simultaneous stock downloads in ${Date.now() - t0} ms`);
  const size = (await call('GET', '/api/products', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding');
  assert.strictEqual(size, 'gzip'); ok('stock list is gzip-compressed');

  // --- pages
  for (const pg of ['/', '/admin', '/static/app.js', '/static/admin.js', '/static/search.js', '/static/style.css']) {
    const x = await fetch(base + pg); assert.strictEqual(x.status, 200, pg);
  }
  const trav = await fetch(base + '/static/..%2f..%2fserver.js'); assert.notStrictEqual(trav.status, 200); ok('pages load; path traversal blocked');

  console.log(`\nAll ${passed} checks passed.`);
  server.close();
  if (!process.env.KEEP) fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch((e) => { console.error('\nTEST FAILED:', e); server.close(); process.exit(1); });
