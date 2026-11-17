'use strict';
// Convert a stock Excel/CSV into stock/stock.json for the GitHub Pages version.
// Usage: node tools/build-stock-json.js "path/to/StockBtc.xlsx"
// (Normally the admin page does this in the browser; this is a command-line alternative.)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readSpreadsheet } = require('../lib/xlsx');
const { importRows, toStockFile } = require('../lib/importer');

(async () => {
  const src = process.argv[2];
  if (!src) { console.error('Usage: node tools/build-stock-json.js <stock.xlsx|csv>'); process.exit(1); }
  const out = path.join(__dirname, '..', 'stock', 'stock.json');
  let prev = 0;
  try { prev = JSON.parse(fs.readFileSync(out, 'utf8')).version || 0; } catch { /* first time */ }
  const rows = await readSpreadsheet(fs.readFileSync(src), path.basename(src), (u8) => zlib.inflateRawSync(u8));
  const result = importRows(rows);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(toStockFile(result, path.basename(src), prev)));
  console.log('Wrote', out, result.stats, result.warnings);
})().catch((e) => { console.error(e.message); process.exit(1); });
