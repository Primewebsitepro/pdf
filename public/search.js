/* Product search engine - runs in the browser (and in Node for tests).
 * - Matches anywhere in the name: start, middle or last letters ("prost" finds MISOPROST)
 * - Ignores spaces/dots/dashes ("dolo650" finds "DOLO 650 TAB")
 * - Tolerates typos ("carboprost" finds "CERBOPROST")
 * - Also searches item code, generic/salt (group) and company
 */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  }

  // Optimal string alignment distance (Levenshtein + adjacent swaps), with early exit.
  function editDistance(a, b, max) {
    const al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    let prev2 = null, prev = new Array(bl + 1), cur = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= bl; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const t = prev2 || new Array(bl + 1);
      prev2 = prev; prev = cur; cur = t;
    }
    return prev[bl];
  }

  function allowedTypos(len) {
    if (len >= 8) return 2;
    if (len >= 4) return 1;
    return 0;
  }

  // Best fuzzy distance of token t against a list of words (whole word or word prefix).
  function fuzzyWords(t, words, max) {
    let best = max + 1;
    const L = t.length;
    for (const w of words) {
      if (w.length < L - max) continue;
      let d = editDistance(t, w, max);
      if (d < best) best = d;
      for (let len = L - 1; len <= L + 1 && best > 0; len++) {
        if (len < 3 || len >= w.length) continue;
        d = editDistance(t, w.slice(0, len), max);
        if (d < best) best = d;
      }
      if (best === 0) break;
    }
    return best;
  }

  function buildIndex(items) {
    return items.map((it) => {
      const name = norm(it.name);
      const group = norm(it.group);
      const company = norm(it.company);
      return {
        it,
        name, nameC: name.replace(/ /g, ''), nameW: name.split(' ').filter(Boolean),
        group, groupC: group.replace(/ /g, ''), groupW: group.split(' ').filter((w) => w.length > 2),
        companyC: company.replace(/ /g, ''),
        code: norm(it.code).replace(/ /g, ''),
      };
    });
  }

  function scoreToken(e, t) {
    if (e.code) {
      if (e.code === t) return 300;
      if (e.code.indexOf(t) >= 0) return 150;
    }
    const i = e.nameC.indexOf(t);
    if (i >= 0) {
      let s = 100;
      if (i === 0) s += 40;
      else if (e.name.indexOf(' ' + t) >= 0) s += 20; // starts a word
      return s + Math.min(t.length, 10);
    }
    if (e.groupC.indexOf(t) >= 0) return 55;
    if (t.length >= 3 && e.companyC.indexOf(t) >= 0) return 35;

    const max = allowedTypos(t.length);
    if (!max) return 0;
    const dn = fuzzyWords(t, e.nameW, max);
    if (dn <= max) return 70 - dn * 15;
    const dg = fuzzyWords(t, e.groupW, max);
    if (dg <= max) return 35 - dg * 10;
    return 0;
  }

  function search(index, query, opts) {
    opts = opts || {};
    const q = norm(query);
    if (!q) return [];
    let tokens = q.split(' ').filter(Boolean);
    const qC = q.replace(/ /g, '');
    const out = [];
    for (const e of index) {
      if (opts.filter && !opts.filter(e.it)) continue;
      let total = 0, ok = true;
      if (tokens.length > 1 && e.nameC.indexOf(qC) >= 0) {
        total = 200 + (e.nameC.indexOf(qC) === 0 ? 40 : 0);
      } else {
        for (const t of tokens) {
          const s = scoreToken(e, t);
          if (!s) { ok = false; break; }
          total += s;
        }
      }
      if (!ok) continue;
      if (e.it.stock > 0) total += 5;
      total -= e.name.length * 0.05;
      out.push({ item: e.it, score: total });
    }
    out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return out;
  }

  const api = { norm, editDistance, buildIndex, search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StockSearch = api;
})(typeof self !== 'undefined' ? self : this);
