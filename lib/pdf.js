'use strict';
// Dependency-free PDF writer for the stock list (A4, company-wise table, page numbers).
// Uses the built-in Helvetica fonts, so the text is real text: it can be searched (Ctrl+F) and copied.

const zlib = require('zlib');

// Character widths (1/1000 em) for ASCII 32..126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const ascii = (s) => String(s ?? '').replace(/₹/g, 'Rs.').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
function textWidth(s, size, bold) {
  const w = bold ? W_BOLD : W_REG;
  let t = 0;
  for (let i = 0; i < s.length; i++) t += w[s.charCodeAt(i) - 32] || 556;
  return (t * size) / 1000;
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// Wrap text into at most `maxLines` lines that fit `width`; adds "..." if cut.
function wrap(text, width, size, bold, maxLines) {
  const tw = (s) => textWidth(s, size, bold);
  const pieces = [];
  for (let w of ascii(text).split(' ').filter(Boolean)) {
    while (tw(w) > width) { // very long word: hard-break it
      let k = w.length - 1;
      while (k > 1 && tw(w.slice(0, k)) > width) k--;
      pieces.push(w.slice(0, k)); w = w.slice(k);
    }
    pieces.push(w);
  }
  const lines = [];
  let cur = '';
  for (const p of pieces) {
    const next = cur ? cur + ' ' + p : p;
    if (tw(next) <= width) cur = next; else { lines.push(cur); cur = p; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && tw(last + '...') > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '...';
  }
  return lines.length ? lines : [''];
}

/**
 * @param {object} o
 *  title, subtitle, filterText, stockDisplay ('qty'|'status'), lowStockLimit,
 *  items: [{name, scheme, code, group, company, mrp, stock}], grouped: boolean (group rows by company)
 */
function buildStockPdf(o) {
  const PW = 595.28, PH = 841.89, M = 32;
  const FS = 8.5, LH = 10.5, PAD = 3;
  const cols = [
    { key: 'sr', title: 'Sr', w: 26, align: 'right' },
    { key: 'name', title: 'Item name', w: 196 },
    { key: 'group', title: 'Group / Salt', w: 178 },
    { key: 'mrp', title: 'MRP (Rs.)', w: 62, align: 'right' },
    { key: 'stock', title: o.stockDisplay === 'status' ? 'Status' : 'Stock', w: PW - 2 * M - 26 - 196 - 178 - 62, align: 'right' },
  ];
  const pages = [];
  let ops = null, y = 0;

  const fill = (x, yy, w, h, rgb) => ops.push(`${rgb} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const text = (x, yy, s, size, bold, rgb = '0.09 0.13 0.17') =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  const cellText = (col, x, yy, s, bold) => {
    const tx = col.align === 'right' ? x + col.w - PAD - textWidth(s, FS, bold) : x + PAD;
    text(tx, yy, s, FS, bold);
  };

  function tableHeader() {
    const h = 16;
    fill(M, y - h, PW - 2 * M, h, '0.04 0.43 0.43');
    let x = M;
    for (const c of cols) {
      const tx = c.align === 'right' ? x + c.w - PAD - textWidth(c.title, FS, true) : x + PAD;
      text(tx, y - 11, c.title, FS, true, '1 1 1');
      x += c.w;
    }
    y -= h;
  }
  function newPage() {
    ops = [];
    pages.push(ops);
    y = PH - M;
    text(M, y - 13, ascii(o.title), 14, true);
    y -= 19;
    text(M, y - 9, ascii(o.subtitle), 8.5, false, '0.37 0.42 0.47');
    y -= 12;
    if (o.filterText) { text(M, y - 9, ascii(o.filterText), 8.5, true, '0.6 0.36 0'); y -= 12; }
    y -= 6;
    tableHeader();
  }
  const ensure = (h) => { if (y - h < M + 18) newPage(); };

  newPage();
  let lastCompany = null, sr = 0, zebra = false;
  for (const it of o.items) {
    if (o.grouped && it.company !== lastCompany) {
      ensure(16 + LH * 2 + 2 * PAD);
      const h = 15;
      fill(M, y - h, PW - 2 * M, h, '0.89 0.95 0.95');
      text(M + PAD, y - 10.5, ascii(it.company || 'OTHERS'), 9, true, '0.04 0.35 0.35');
      y -= h;
      lastCompany = it.company;
      zebra = false;
    }
    sr++;
    const name = ascii(it.name) + (it.scheme ? '  [Scheme ' + ascii(it.scheme) + ']' : '') + (it.code ? '  #' + ascii(it.code) : '');
    const nameLines = wrap(name, cols[1].w - 2 * PAD, FS, true, 2);
    const groupText = o.grouped ? it.group : [it.group, it.company].filter(Boolean).join(' | ');
    const groupLines = wrap(groupText || '-', cols[2].w - 2 * PAD, FS, false, 2);
    const n = Math.max(nameLines.length, groupLines.length);
    const h = n * LH + 2 * PAD;
    ensure(h);
    if (zebra) fill(M, y - h, PW - 2 * M, h, '0.96 0.97 0.98');
    zebra = !zebra;
    const base = y - PAD - 8;
    let x = M;
    cellText(cols[0], x, base, String(sr), false); x += cols[0].w;
    nameLines.forEach((l, i) => cellText(cols[1], x, base - i * LH, l, true)); x += cols[1].w;
    groupLines.forEach((l, i) => text(x + PAD, base - i * LH, l, FS, false, '0.37 0.42 0.47')); x += cols[2].w;
    const mrp = it.mrp === null || it.mrp === '' || it.mrp === undefined ? '' : Number(it.mrp).toFixed(2);
    cellText(cols[3], x, base, mrp, false); x += cols[3].w;
    const s = Number(it.stock) || 0;
    let st, rgb;
    if (o.stockDisplay === 'status') {
      st = s <= 0 ? 'Out of stock' : s <= (o.lowStockLimit ?? 5) ? 'Low' : 'In stock';
    } else st = s <= 0 ? 'Out' : String(s);
    rgb = s <= 0 ? '0.71 0.14 0.09' : '0.08 0.48 0.24';
    text(x + cols[4].w - PAD - textWidth(st, FS, true), base, st, FS, true, rgb);
    y -= h;
    ops.push(`0.87 0.89 0.92 RG 0.4 w ${M} ${y.toFixed(2)} m ${(PW - M).toFixed(2)} ${y.toFixed(2)} l S`);
  }
  if (!o.items.length) { text(M + PAD, y - 16, 'No products found.', 10, false); }

  // Footer with page numbers.
  pages.forEach((p, i) => {
    ops = p;
    const label = `Page ${i + 1} of ${pages.length}`;
    text(PW - M - textWidth(label, 8, false), M - 4, label, 8, false, '0.37 0.42 0.47');
    text(M, M - 4, `${sr} item(s)`, 8, false, '0.37 0.42 0.47');
  });

  // ---- assemble PDF objects ----
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const data = zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(ascii(o.title))}) /Producer (Stock Portal) >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const xref = [];
  objs.forEach((body, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    xref.push(offset); offset += b.length; chunks.push(b);
  });
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of xref) tail += String(off).padStart(10, '0') + ' 00000 n \n';
  tail += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(chunks);
}

module.exports = { buildStockPdf };
