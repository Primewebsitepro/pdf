(function (root) {
'use strict';
// Turns spreadsheet rows into a clean product list.
// Supports two layouts:
//  1. "Report" layout from the billing software (company name on its own row, items below,
//     "Total for: ..." rows) - e.g. "Current Stock Detail of All company".
//  2. "Flat" layout - one product per row with a Company column.
// Column headers are detected by name, so column order does not matter.

const HEADERS = {
  name: /^(item\s*name|item|product(\s*name)?|description|particulars|medicine(\s*name)?|name)$/i,
  stock: /^(stock|qty|quantity|closing(\s*stock|\s*qty)?|cl\.?\s*stock|balance|bal\.?\s*qty|available)$/i,
  mrp: /^(mrp|m\.r\.p\.?|price|rate|sale\s*rate)$/i,
  group: /^(group|generic(\s*name)?|salt|composition|content|molecule)$/i,
  company: /^(company|company\s*name|mfg|mfr|manufacturer|brand|division)$/i,
  code: /^(item\s*code|code|product\s*code|sku|barcode|item\s*id)$/i,
  srno: /^(sr\.?\s*no\.?|s\.?\s*no\.?|sl\.?\s*no\.?|#)$/i,
};

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const str = (v) => (isBlank(v) ? '' : String(v).replace(/\s+/g, ' ').trim());
const toNum = (v) => {
  if (typeof v === 'number') return v;
  if (isBlank(v)) return null;
  const n = Number(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const map = {};
    (rows[r] || []).forEach((v, c) => {
      const s = str(v);
      if (!s) return;
      for (const [key, re] of Object.entries(HEADERS)) {
        if (map[key] === undefined && re.test(s)) { map[key] = c; break; }
      }
    });
    if (map.name !== undefined && map.stock !== undefined) return { row: r, map };
  }
  return null;
}

// "BURNOL CREAM 25 GM                  5+1" -> name "BURNOL CREAM 25 GM", scheme "5+1"
function splitScheme(raw) {
  const s = String(raw || '');
  const m = s.match(/^(.*?\S)\s{2,}(\d+\s*\+\s*\d+)\s*$/);
  if (m) return { name: str(m[1]), scheme: m[2].replace(/\s+/g, '') };
  return { name: str(s), scheme: '' };
}

function cleanGroup(g) {
  let s = str(g).replace(/^[-=+]+\s*/, '');
  if (/^(-|not\s*available|n\/?a|na|none|0)$/i.test(s)) s = '';
  return s;
}

function findAsOf(rows, upto) {
  for (let r = 0; r < upto; r++) {
    for (const v of rows[r] || []) {
      const m = str(v).match(/as\s*on\s*:?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
      if (m) return m[1];
    }
  }
  return '';
}

function importRows(rows) {
  const warnings = [];
  const hdr = findHeader(rows);
  if (!hdr) {
    throw new Error('Could not find the header row. The file must have columns like "ItemName" and "Stock" (optional: Mrp, Group, Company, Item Code).');
  }
  const { map } = hdr;
  const asOf = findAsOf(rows, hdr.row + 1);
  const flat = map.company !== undefined;
  let company = '';
  let reportTotal = null;
  const merged = new Map();
  let itemRows = 0;
  let negative = 0;

  for (let r = hdr.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const nameRaw = row[map.name];
    const name = str(nameRaw);
    const sr = map.srno !== undefined ? str(row[map.srno]) : '';
    const stock = toNum(row[map.stock]);

    if (!name) {
      // Grand total row (only a stock number) - remember it for a sanity check.
      if (stock !== null && row.filter((v) => !isBlank(v)).length === 1) reportTotal = stock;
      continue;
    }
    if (sr === '*' || /^total\b|^\*?\s*total\s*for\s*:/i.test(name) || /^grand\s*total/i.test(name)) continue;
    if (name === '-' ) { if (!flat) company = ''; continue; }

    if (!flat && stock === null && isBlank(row[map.mrp])) {
      // Company heading row in report layout.
      company = name;
      continue;
    }
    if (stock === null) {
      warnings.push(`Row ${r + 1}: "${name}" has no stock number - skipped`);
      continue;
    }

    itemRows++;
    const { name: cleanName, scheme } = splitScheme(nameRaw);
    const mrp = map.mrp !== undefined ? toNum(row[map.mrp]) : null;
    const comp = flat ? str(row[map.company]) : company;
    const code = map.code !== undefined ? str(row[map.code]) : '';
    const group = map.group !== undefined ? cleanGroup(row[map.group]) : '';
    if (stock < 0) negative++;

    // Same item + same MRP appearing on several rows (different batches) -> add stock together.
    const key = [comp, cleanName, mrp ?? '', code].join('|').toUpperCase();
    const ex = merged.get(key);
    if (ex) {
      ex.stock += stock;
      if (!ex.group && group) ex.group = group;
      if (!ex.scheme && scheme) ex.scheme = scheme;
      ex.rows++;
    } else {
      merged.set(key, { key, name: cleanName, company: comp || 'OTHERS', group, code, mrp, stock, scheme, rows: 1 });
    }
  }

  const items = [...merged.values()].map((p) => ({ ...p, stock: Math.round(p.stock * 1000) / 1000 }));
  items.sort((a, b) => a.name.localeCompare(b.name) || (a.mrp ?? 0) - (b.mrp ?? 0));
  items.forEach((p, i) => { p.id = i + 1; });

  if (!items.length) throw new Error('No products found in the file.');
  const sum = items.reduce((s, p) => s + p.stock, 0);
  if (reportTotal !== null && Math.abs(reportTotal - sum) > 0.01) {
    warnings.push(`Report grand total is ${reportTotal} but imported items add up to ${sum}. Please check the file.`);
  }
  if (negative) warnings.push(`${negative} row(s) in the file have negative stock (items with total stock 0 or less are shown as "Out of stock").`);

  return {
    items,
    asOf,
    layout: flat ? 'flat' : 'report',
    stats: {
      rowsRead: itemRows,
      products: items.length,
      companies: new Set(items.map((p) => p.company)).size,
      totalStock: sum,
      outOfStock: items.filter((p) => p.stock <= 0).length,
    },
    warnings: warnings.slice(0, 50),
  };
}

// Compare a new import with the previous product list.
function diff(oldItems, newItems) {
  const oldMap = new Map((oldItems || []).map((p) => [p.key, p]));
  const newKeys = new Set();
  let added = 0, changed = 0, same = 0;
  for (const p of newItems) {
    newKeys.add(p.key);
    const o = oldMap.get(p.key);
    if (!o) added++;
    else if (o.stock !== p.stock) changed++;
    else same++;
  }
  let removed = 0;
  for (const k of oldMap.keys()) if (!newKeys.has(k)) removed++;
  return { added, changed, same, removed };
}

// Two firms share one website. Each upload replaces only the chosen firm's stock.
// Button colours: MD green, MM red, MC yellow, MP blue, MH orange (see public/style.css .f-*)
const FIRMS = { MD: 'Meghavi Distributors', MM: 'Meghavi Medical', MC: 'Meghavi Chemist', MP: 'Meghavi Pharmacy', MH: 'Meghavi Healthcare' };

// Compact file format used by the static/PHP website (stock/stock.json).
const STOCK_FIELDS = ['id', 'name', 'company', 'group', 'code', 'mrp', 'stock', 'scheme', 'firm'];
// firm: a key of FIRMS (default 'MD'); prevFile: current stock file, whose other-firm items are kept.
function toStockFile(result, fileName, prevVersion, firm, prevFile) {
  firm = FIRMS[firm] ? firm : 'MD';
  const now = new Date().toISOString();
  const keep = prevFile ? fromStockFile(prevFile).filter((p) => p.firm !== firm) : [];
  const fresh = result.items.map((p) => ({ ...p, firm }));
  const all = keep.concat(fresh).sort((a, b) => a.name.localeCompare(b.name) || (a.mrp ?? 0) - (b.mrp ?? 0) || a.firm.localeCompare(b.firm));
  all.forEach((p, i) => { p.id = i + 1; });
  const firms = { ...firmsOf(prevFile) };
  firms[firm] = { asOf: result.asOf, updatedAt: now, fileName: fileName || '', products: fresh.length };
  return {
    version: (prevVersion || 0) + 1,
    asOf: result.asOf,
    updatedAt: now,
    fileName: fileName || '',
    firm,
    stats: result.stats,
    firms,
    fields: STOCK_FIELDS,
    items: all.map((p) => STOCK_FIELDS.map((k) => (p[k] === undefined ? '' : p[k]))),
  };
}
// Per-firm upload info; older files (before firms existed) belong to Meghavi Distributors.
function firmsOf(file) {
  if (!file) return {};
  if (file.firms) return file.firms;
  if (file.items && file.items.length) return { MD: { asOf: file.asOf, updatedAt: file.updatedAt, fileName: file.fileName || '', products: file.items.length } };
  return {};
}
function fromStockFile(file) {
  return (file.items || []).map((row) => {
    const o = {};
    file.fields.forEach((k, i) => { o[k] = row[i]; });
    o.firm = FIRMS[o.firm] ? o.firm : 'MD';
    o.key = [o.company === 'OTHERS' ? '' : o.company, o.name, o.mrp ?? '', o.code].join('|').toUpperCase();
    return o;
  });
}

const api = { importRows, diff, splitScheme, toStockFile, fromStockFile, firmsOf, FIRMS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.StockImporter = api;
})(typeof self !== 'undefined' ? self : this);
