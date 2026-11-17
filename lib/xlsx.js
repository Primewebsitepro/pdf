'use strict';
// Minimal, dependency-free readers for .xlsx and .csv files.
// Returns an array of rows; each row is an array of cell values (string | number | null).

const zlib = require('zlib');

// ---------- ZIP ----------
function readZip(buf) {
  // Find End Of Central Directory record (scan backwards).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('File is not a valid .xlsx (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt xlsx: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files[name] = { method, csize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: Object.keys(files),
    read(name) {
      const f = files[name];
      if (!f) return null;
      const lo = f.localOff;
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const data = buf.subarray(start, start + f.csize);
      if (f.method === 0) return data.toString('utf8');
      if (f.method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error('Unsupported zip compression in xlsx');
    },
  };
}

// ---------- XML helpers ----------
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? m[1] : null;
}
function textOf(xml) {
  // Join all <t> nodes (handles rich text runs).
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return decodeXml(out);
}
function colIndex(ref) {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm, autoRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = attr(rm[1], 'r');
    const rIdx = rAttr ? parseInt(rAttr, 10) - 1 : autoRow;
    autoRow = rIdx + 1;
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cellRe.exec(rm[2]))) {
      const a = cm[1], body = cm[2] || '';
      const ref = attr(a, 'r');
      const ci = ref ? colIndex(ref) : autoCol;
      autoCol = ci + 1;
      const t = attr(a, 't');
      const vM = body.match(/<v>([\s\S]*?)<\/v>/);
      const fM = body.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/);
      let val = null;
      if (t === 's' && vM) val = shared[parseInt(vM[1], 10)] ?? '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'str') val = vM ? decodeXml(vM[1]) : '';
      else if (t === 'b') val = vM ? vM[1] : null;
      else if (t === 'e') {
        // Error cell. Billing exports sometimes write text like "-PANCREATIN..." which Excel
        // turns into a broken formula; recover the original text from the formula.
        val = fM ? decodeXml(fM[1]).replace(/^=/, '') : null;
      } else if (vM) {
        const num = Number(vM[1]);
        val = Number.isFinite(num) ? num : decodeXml(vM[1]);
      }
      if (val === null && fM && !vM) {
        // Formula without cached value: keep formula text if it looks like plain text.
        const ft = decodeXml(fM[1]);
        if (/[A-Za-z]{3,}/.test(ft) && !/\(/.test(ft)) val = ft.replace(/^=/, '');
      }
      row[ci] = val;
    }
    rows[rIdx] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function readXlsx(buf) {
  const zip = readZip(buf);
  const ssXml = zip.read('xl/sharedStrings.xml');
  const shared = [];
  if (ssXml) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ssXml))) shared.push(textOf(m[1]));
  }
  const sheetNames = zip.names.filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
  if (!sheetNames.length) throw new Error('No worksheet found in xlsx');
  // Use the sheet that has the most data.
  let best = null;
  for (const n of sheetNames) {
    const rows = parseSheet(zip.read(n), shared);
    const filled = rows.reduce((s, r) => s + (r.some((v) => v !== null && v !== undefined && v !== '') ? 1 : 0), 0);
    if (!best || filled > best.filled) best = { rows, filled };
  }
  return best.rows;
}

// ---------- CSV ----------
function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delims = [',', ';', '\t', '|'];
  const delim = delims.reduce((a, d) => (firstLine.split(d).length > firstLine.split(a).length ? d : a), ',');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((v) => {
    const s = v.trim();
    if (s === '') return null;
    const num = Number(s.replace(/,/g, ''));
    return /^-?[\d,]*\.?\d+$/.test(s) && Number.isFinite(num) ? num : s;
  }));
}

function readSpreadsheet(buf, filename) {
  const name = (filename || '').toLowerCase();
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd0) {
    throw new Error('This is an old .xls file. Please open it in Excel and "Save As" .xlsx or .csv, then upload again.');
  }
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf);
  if (name.endsWith('.xlsx')) return readXlsx(buf);
  return readCsv(buf.toString('utf8'));
}

module.exports = { readSpreadsheet, readXlsx, readCsv };
