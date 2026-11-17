'use strict';
// Simple JSON-file storage (no database server needed).
// All writes are atomic (write to temp file, then rename) so a crash never leaves a half-written file.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name); }

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function writeJSON(name, value) {
  const target = file(name);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, target);
  delete cache[name];
}

// In-memory cache for files that are read on every request.
const cache = {};
function cached(name, fallback) {
  if (!(name in cache)) cache[name] = readJSON(name, fallback);
  return cache[name];
}

const DEFAULT_SETTINGS = {
  siteName: 'Meghavi Distributors',
  address: 'G-2, T.M. Park, B/H Mukund, Parnera, N.H. No. 8 (48), Valsad, Gujarat',
  gst: '24ABJFM8976D1ZW',
  retailerPin: '',          // blank = page is open to anyone with the link
  stockDisplay: 'qty',      // 'qty' = show quantity, 'status' = show In stock / Low / Out of stock
  lowStockLimit: 5,
  showOutOfStock: true,
  contactPhone: '+91 99743 43448', // shown to retailers (call / WhatsApp)
};

module.exports = {
  DATA_DIR,
  getConfig: () => readJSON('config.json', {}),
  setConfig: (c) => writeJSON('config.json', c),

  getSettings: () => ({ ...DEFAULT_SETTINGS, ...cached('settings.json', {}) }),
  setSettings: (s) => writeJSON('settings.json', s),

  getStock: () => cached('stock.json', { items: [], asOf: '', updatedAt: null, version: 0 }),
  // Put a backup back as the current stock (used by "Undo last upload").
  restoreBackup(b, version) {
    writeJSON('stock.json', { ...b.data, version });
    fs.unlinkSync(b.path);
  },
  setStock(stock) {
    const prev = file('stock.json');
    if (fs.existsSync(prev)) {
      fs.copyFileSync(prev, path.join(BACKUP_DIR, 'stock-' + Date.now() + '.json'));
      const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('stock-')).sort();
      while (old.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
    }
    writeJSON('stock.json', stock);
  },
  latestBackup() {
    const list = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('stock-')).sort();
    if (!list.length) return null;
    const f = path.join(BACKUP_DIR, list[list.length - 1]);
    return { path: f, data: JSON.parse(fs.readFileSync(f, 'utf8')) };
  },

  getUploads: () => readJSON('uploads.json', []),
  setUploads: (u) => writeJSON('uploads.json', u),

  getRequests: () => readJSON('requests.json', []),
  setRequests: (r) => writeJSON('requests.json', r),
};
