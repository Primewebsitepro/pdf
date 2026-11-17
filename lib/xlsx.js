/* Minimal, dependency-free readers for .xlsx and .csv files.
 * Works in Node and in the browser (no Buffer needed).
 * readSpreadsheet(bytes: Uint8Array, filename, inflateRaw) -> Promise<rows>
 *   inflateRaw(Uint8Array) -> Uint8Array | Promise<Uint8Array>  (raw DEFLATE decoder)
 * Each row is an array of cell values (string | number | null).
 */
(function (root) {
  'use strict';
  const utf8 = new TextDecoder('utf-8');

  // ---------- ZIP ----------
  function readZip(u8, inflateRaw) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File is not a valid .xlsx (zip) file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt xlsx: bad central directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
      files[name] = { method, csize, localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      names: Object.keys(files),
      async read(name) {
        const f = files[name];
        if (!f) return null;
        const lo = f.localOff;
        const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
        const data = u8.subarray(start, start + f.csize);
        if (f.method === 0) return utf8.decode(data);
        if (f.method === 8) return utf8.decode(await inflateRaw(data));
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

  async function readXlsx(u8, inflateRaw) {
    const zip = readZip(u8, inflateRaw);
    const ssXml = await zip.read('xl/sharedStrings.xml');
    const shared = [];
    if (ssXml) {
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(ssXml))) shared.push(textOf(m[1]));
    }
    const sheetNames = zip.names.filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
    if (!sheetNames.length) throw new Error('No worksheet found in xlsx');
    let best = null; // use the sheet with the most data
    for (const n of sheetNames) {
      const rows = parseSheet(await zip.read(n), shared);
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
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
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

  async function readSpreadsheet(bytes, filename, inflateRaw) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const name = (filename || '').toLowerCase();
    if (u8.length >= 4 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) {
      throw new Error('This is an old .xls file. Please open it in Excel and "Save As" .xlsx or .csv, then upload again.');
    }
    if ((u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b) || name.endsWith('.xlsx')) return readXlsx(u8, inflateRaw);
    return readCsv(utf8.decode(u8));
  }

  // Browser helper: raw DEFLATE decoder using the built-in DecompressionStream.
  async function browserInflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }

  const api = { readSpreadsheet, readCsv, browserInflateRaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StockXlsx = api;
})(typeof self !== 'undefined' ? self : this);
