/**
 * Boodschappen Vergelijker – lokale proxy server
 * Geen installatie nodig: draai gewoon "node server.js"
 * Werkt met Node.js 18+ (ingebouwde https/http modules)
 *
 * Nieuwe winkel toevoegen:
 *   1. Maak stores/<naam>.js met module.exports = { id, name, search(query) }
 *   2. Voeg één regel toe in stores/index.js
 */

const http   = require('http');
const stores = require('./stores');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';

// ── CORS + response helper ──────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type':                 'application/json; charset=utf-8',
};

function send(res, status, data) {
  res.writeHead(status, CORS);
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

// ── Debug endpoint ──────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleDebugMeta(req, res) {
  try {
    const body = await readJsonBody(req);
    const safe = {
      event: body.event ?? null, ts: body.ts ?? null, source: body.source ?? null,
      currentQuery: body.currentQuery ?? null, storeId: body.storeId ?? null,
      productId: body.productId ?? null, imageUrl: body.imageUrl ?? null,
      product: body.product ?? null,
    };
    console.log(`[ZOOM] ${JSON.stringify(safe)}`);
    send(res, 200, { ok: true });
  } catch (e) {
    console.error('[ZOOM]', e.message);
    send(res, 400, { error: e.message });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, '');

  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const q        = (parsed.searchParams.get('q') || '').trim();

  if (pathname === '/ping') return send(res, 200, { ok: true, ts: Date.now() });
  if (pathname === '/debug/meta' && req.method === 'POST') return handleDebugMeta(req, res);

  // Generieke winkel-route: /api/<storeId>?q=...
  const storeMatch = pathname.match(/^\/api\/(\w+)$/);
  if (storeMatch) {
    const storeId = storeMatch[1];
    const store   = stores[storeId];
    if (!store)  return send(res, 404, { error: `Onbekende winkel: ${storeId}` });
    if (!q)      return send(res, 400, { error: 'Geen zoekterm opgegeven (parameter: q)' });

    try {
      const result = await store.search(q);
      // AH stuurt raw JSON terug; andere stores sturen { products }
      send(res, 200, result.raw ?? result);
    } catch (e) {
      console.error(`[${storeId.toUpperCase()}]`, e.message);
      send(res, 502, { error: e.message });
    }
    return;
  }

  send(res, 404, { error: 'Onbekend pad' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ✅  Boodschappen proxy draait!');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('');
  console.log('  Open nu boodschappen.html in je browser.');
  console.log('  Sluit dit venster om de server te stoppen.');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌  Poort ${PORT} is al in gebruik.`);
    console.error(`     Sluit het andere proces of pas PORT aan in server.js.\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
