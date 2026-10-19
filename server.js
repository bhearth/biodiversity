const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.PASS || 'biodiversity';
const DB = path.join(__dirname, 'items.json');

// ─── IN-MEMORY DB ───
let items = [], byId = {}, index = {}, wordKeys = [], lastUpdate = 0;
const STOP = new Set(['the','and','a','an','of','to','in','is','it','for','on','with','as','by','at','or','be','this','that','from','into','has','have','had','was','were']);

function tokenize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]+/g, ' ')
    .split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function buildIndex() {
  index = {};
  items.forEach(it => {
    const text = [it.name, it.poetic, it.teaches, it.usage, it.origin, it.region,
                  ...(it.tags||[]), ...(it.benefits||[]), ...(it.risks||[])].join(' ');
    new Set(tokenize(text)).forEach(w => {
      if (!index[w]) index[w] = new Set();
      index[w].add(it.id);
    });
  });
  wordKeys = Object.keys(index).sort();
}

function loadDB() {
  if (!fs.existsSync(DB)) fs.writeFileSync(DB, '[]');
  try {
    items = JSON.parse(fs.readFileSync(DB, 'utf8'));
    if (!Array.isArray(items)) items = [];
    items.forEach(it => { if (!it.id) it.id = genId(); });
    byId = {}; items.forEach(it => byId[it.id] = it);
    buildIndex();
    lastUpdate = Date.now();
    console.log(`✅ ${items.length} items · ${wordKeys.length} indexed words`);
  } catch (e) { console.error('load error:', e.message); items = []; byId = {}; index = {}; wordKeys = []; }
}

function saveDB() { fs.writeFileSync(DB, JSON.stringify(items, null, 2)); lastUpdate = Date.now(); }

// ─── SEARCH (indexed, never scans file) ───
function search(q, limit = 60) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];

  // 1. Inverted index lookup + prefix expansion (uses sorted wordKeys)
  const sets = tokens.map(t => {
    const s = new Set();
    if (index[t]) index[t].forEach(id => s.add(id));
    for (const key of wordKeys) if (key.startsWith(t) && key !== t) index[key].forEach(id => s.add(id));
    return s;
  });

  // 2. Intersect (all tokens must match)
  let cand = sets[0];
  for (let i = 1; i < sets.length; i++) {
    const next = new Set();
    cand.forEach(id => { if (sets[i].has(id)) next.add(id); });
    cand = next;
  }

  // 3. Score + explain (Google-lite)
  return [...cand].map(id => {
    const it = byId[id], why = [];
    const n = (it.name||'').toLowerCase(), p = (it.poetic||'').toLowerCase();
    const tags = (it.tags||[]).map(x=>x.toLowerCase());
    const teach = (it.teaches||'').toLowerCase(), usage = (it.usage||'').toLowerCase();
    let score = 0;
    tokens.forEach(t => {
      if (n === t) { score += 100; why.push('name') }
      else if (n.startsWith(t)) { score += 60; why.push('name') }
      else if (n.includes(t)) { score += 30; why.push('name') }
      else if (p.includes(t)) { score += 20; why.push('poetic') }
      else if (tags.some(tag => tag.includes(t))) { score += 15; why.push('tag') }
      else if (teach.includes(t)) { score += 8; why.push('teaches') }
      else if (usage.includes(t)) { score += 5; why.push('usage') }
    });
    return { it, score, why: [...new Set(why)].join(', ') };
  }).sort((a,b) => b.score - a.score).slice(0, limit).map(r => ({
    id: r.it.id, name: r.it.name, icon: r.it.icon || '✨',
    poetic: r.it.poetic || '', dimension: r.it.dimension || '',
    tags: r.it.tags || [], why: r.why
  }));
}

// ─── HTTP ───
function send(res, code, data, type='application/json') {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Steward-Pass'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)) }) }

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, '');
  const u = new URL(req.url, 'http://x'), p = u.pathname;

  if (req.method === 'GET' && p === '/api/stats')
    return send(res, 200, { count: items.length, updated: lastUpdate, words: wordKeys.length });

  if (req.method === 'GET' && p === '/api/items') {
    const offset = parseInt(u.searchParams.get('offset')) || 0;
    const limit = parseInt(u.searchParams.get('limit')) || 5000;
    const slice = items.slice(offset, offset + limit);
    return send(res, 200, {
      total: items.length, offset, limit,
      items: slice.map(it => ({
        id: it.id, name: it.name, icon: it.icon || '✨',
        poetic: it.poetic || '', dimension: it.dimension || '',
        tags: it.tags || []
      }))
    });
  }

  if (req.method === 'GET' && p === '/api/search')
    return send(res, 200, { query: u.searchParams.get('q')||'', items: search(u.searchParams.get('q')||'') });

  if (req.method === 'GET' && p.startsWith('/api/item/')) {
    const id = p.split('/').pop();
    if (!byId[id]) return send(res, 404, { error: 'not found' });
    return send(res, 200, byId[id]);
  }

  if (req.method === 'POST' && p === '/api/items') {
    if (req.headers['x-steward-pass'] !== PASS) return send(res, 401, { error: 'unauthorized' });
    try {
      const data = JSON.parse(await readBody(req));
      const incoming = Array.isArray(data) ? data : [data];
      let added = 0, updated = 0;
      incoming.forEach(c => {
        if (!c.name || !c.icon) return;
        // Auto-assign dimension by tag overlap if missing
        if (!c.dimension) {
          const scores = {};
          items.forEach(it => {
            if (!it.dimension) return;
            const ov = (it.tags||[]).filter(t => (c.tags||[]).includes(t)).length;
            if (ov) scores[it.dimension] = (scores[it.dimension]||0) + ov;
          });
          const best = Object.entries(scores).sort((a,b) => b[1]-a[1])[0];
          c.dimension = best ? best[0] : 'Uncategorized';
        }
        // Update if same name + same dimension, else add
        const existing = items.find(it => it.name.toLowerCase() === c.name.toLowerCase() && it.dimension === c.dimension);
        if (existing) { Object.assign(existing, c); updated++ }
        else { c.id = c.id || genId(); c._created = new Date().toISOString(); items.push(c); byId[c.id] = c; added++ }
      });
      saveDB(); buildIndex();
      send(res, 200, { ok: true, added, updated, total: items.length });
    } catch (e) { send(res, 400, { error: 'invalid json: ' + e.message }) }
    return;
  }

  if (req.method === 'DELETE' && p.startsWith('/api/item/')) {
    if (req.headers['x-steward-pass'] !== PASS) return send(res, 401, { error: 'unauthorized' });
    const id = p.split('/').pop();
    const i = items.findIndex(x => x.id === id);
    if (i < 0) return send(res, 404, { error: 'not found' });
    items.splice(i, 1); delete byId[id];
    saveDB(); buildIndex();
    return send(res, 200, { ok: true, total: items.length });
  }

  const file = p === '/' ? '/index.html' : p;
  const fp = path.join(__dirname, decodeURIComponent(file));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const types = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.css':'text/css' };
    return send(res, 200, fs.readFileSync(fp), types[ext] || 'text/plain');
  }

  send(res, 404, 'not found', 'text/plain');
});

loadDB();
server.listen(PORT, () => console.log(`🌍 http://localhost:${PORT}`));
