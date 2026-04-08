/**
 * Boodschappen Vergelijker – lokale proxy server
 * Geen installatie nodig: draai gewoon "node server.js"
 * Werkt met Node.js 18+ (ingebouwde https/http modules)
 */

const http  = require('http');
const https = require('https');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';

function normalizeProductCode(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return normalizeProductCode(value[0]);
  const digits = String(value).trim().replace(/\D/g, '');
  if (digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14) {
    return digits;
  }
  return null;
}

function pickProductCode(...candidates) {
  for (const candidate of candidates) {
    const code = normalizeProductCode(candidate);
    if (code) return code;
  }
  return null;
}

// ── AH token cache ─────────────────────────────────────────────────────────
let ahToken     = null;
let ahTokenExp  = 0;  // unix ms

async function getAHToken() {
  if (ahToken && Date.now() < ahTokenExp) return ahToken;

  const body = JSON.stringify({ clientId: 'appie-android', clientSecret: 'GfEuqEWbuJs6LfgZm2kEhTnijBjb7wqJ' });
  const { body: data } = await httpsPost(
    'api.ah.nl',
    '/mobile-auth/v1/auth/token/anonymous',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body
  );

  const parsed = JSON.parse(data);
  ahToken    = parsed.access_token;
  // expires_in is in seconds; refresh 60s early
  ahTokenExp = Date.now() + ((parsed.expires_in ?? 3600) - 60) * 1000;
  return ahToken;
}

// ── Generic HTTPS helpers ───────────────────────────────────────────────────
function httpsGet(host, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, port: 443, path, method: 'GET', headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpsPost(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, port: 443, path, method: 'POST', headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── CORS headers ────────────────────────────────────────────────────────────
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

function hasQtyHint(text) {
  const t = String(text || '');
  return /\b\d+\s*(stuks?|cups?|capsules?|pods?|pads?|tabletten?|tabs?)\b/i.test(t)
    || /\b\d+\s*[x×]\s*\d+\b/i.test(t);
}

function hasPackHint(text) {
  const t = String(text || '');
  return /\b\d+\s*[- ]?pack\b/i.test(t)
    || /\bpack\b/i.test(t)
    || /\b\d+\s*[x×]\s*\d+\b/i.test(t);
}

function logSearchSummary(store, query, products) {
  const list = Array.isArray(products) ? products : [];
  const total = list.length;
  const withUnit = list.filter(p => String(p.unit || '').trim().length > 0).length;
  const withPricePerUnit = list.filter(p => String(p.pricePerUnit || '').trim().length > 0).length;
  const withQtyInName = list.filter(p => hasQtyHint(p.name)).length;
  const withQtyInUnit = list.filter(p => hasQtyHint(p.unit)).length;
  const withPackInName = list.filter(p => hasPackHint(p.name)).length;
  const withPackInUnit = list.filter(p => hasPackHint(p.unit)).length;

  console.log(
    `[SEARCH][${store}] q="${query}" total=${total} unit=${withUnit}/${total} ppu=${withPricePerUnit}/${total} ` +
    `qty(name)=${withQtyInName}/${total} qty(unit)=${withQtyInUnit}/${total} ` +
    `pack(name)=${withPackInName}/${total} pack(unit)=${withPackInUnit}/${total}`
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleDebugMeta(req, res) {
  try {
    const body = await readJsonBody(req);
    const safe = {
      event: body.event ?? null,
      ts: body.ts ?? null,
      source: body.source ?? null,
      currentQuery: body.currentQuery ?? null,
      storeId: body.storeId ?? null,
      productId: body.productId ?? null,
      imageUrl: body.imageUrl ?? null,
      product: body.product ?? null,
    };
    console.log(`[ZOOM] ${JSON.stringify(safe)}`);
    send(res, 200, { ok: true });
  } catch (e) {
    console.error('[ZOOM]', e.message);
    send(res, 400, { error: e.message });
  }
}

// ── Route handlers ──────────────────────────────────────────────────────────
async function handleAH(query, res) {
  try {
    const token = await getAHToken();
    const path  = `/mobile-services/product/search/v2?query=${encodeURIComponent(query)}&sortOn=RELEVANCE&size=30`;
    const result = await httpsGet('api.ah.nl', path, {
      'Authorization':   `Bearer ${token}`,
      'X-Client-Name':   'Appie',
      'X-Client-Version': '8.22.3',
      'User-Agent':      'Appie/8.22.3 (Android)',
      'X-Application':   'AHWEBSHOP',
    });
    if (result.status !== 200) throw new Error(`AH API ${result.status}: ${result.body.slice(0,200)}`);
    try {
      const parsed = JSON.parse(result.body);
      const items = parsed?.products ?? [];
      const summaryProducts = items.map(p => ({
        name: p.title ?? '',
        unit: p.salesUnitSize ?? p.unitSize ?? '',
        pricePerUnit: p.unitPriceDescription ?? '',
      }));
      logSearchSummary('AH', query, summaryProducts);
    } catch (_) {}
    send(res, 200, result.body);
  } catch (e) {
    console.error('[AH]', e.message);
    send(res, 502, { error: e.message });
  }
}

// ── Jumbo GraphQL query ─────────────────────────────────────────────────────
const JUMBO_GQL_QUERY = `query SearchMobileProducts($input: ProductSearchInput!) {
  searchProducts(input: $input) {
    count
    products {
      id: sku
      title
      brand
      subtitle: packSizeDisplay
      image
      prices: price {
        price
        pricePerUnit { price unit }
      }
      promotions {
        tags { text }
      }
    }
  }
}`;

// Haalt producten op van Jumbo voor één specifieke zoekterm; retourneert array
async function fetchJumboProducts(query) {
  const body = JSON.stringify({
    operationName: 'SearchMobileProducts',
    query: JUMBO_GQL_QUERY,
    variables: {
      input: {
        searchType:         'keyword',
        searchTerms:        query,
        friendlyUrl:        `zoeken?searchTerms=${encodeURIComponent(query)}`,
        offSet:             0,
        sort:               null,
        currentUrl:         `https://www.jumbo.com/producten/zoeken?searchTerms=${encodeURIComponent(query)}`,
        previousUrl:        '',
        bloomreachCookieId: '',
      },
    },
  });

  const result = await httpsPost(
    'www.jumbo.com',
    '/api/graphql',
    {
      'Content-Type':                  'application/json',
      'Content-Length':                Buffer.byteLength(body),
      'User-Agent':                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':                        'application/json',
      'Origin':                        'https://www.jumbo.com',
      'Referer':                       `https://www.jumbo.com/producten/zoeken?searchTerms=${encodeURIComponent(query)}`,
      'apollographql-client-name':     'JUMBO_WEB',
      'apollographql-client-version':  'master-v30.15.0-web',
    },
    body
  );

  if (result.status !== 200) throw new Error(`Jumbo GraphQL ${result.status}: ${result.body.slice(0, 200)}`);

  const gql   = JSON.parse(result.body);
  const items = gql?.data?.searchProducts?.products ?? [];
  return items.map(p => ({
    id:         String(p.id ?? Math.random()),
    name:       p.title  ?? '',
    brand:      p.brand  ?? '',
    unit:       p.subtitle ?? '',
    price:      p.prices?.price != null ? p.prices.price / 100 : null,
    pricePerUnit: p.prices?.pricePerUnit
      ? `€\u202f${(p.prices.pricePerUnit.price / 100).toFixed(2)} per ${p.prices.pricePerUnit.unit}`
      : '',
    image:      p.image ?? '',
    bonusLabel: p.promotions?.[0]?.tags?.[0]?.text ?? null,
    productCode: pickProductCode(p.productCode, p.ean, p.gtin, p.barcode, p.globalTradeItemNumber),
  }));
}

// Bij samengestelde woorden zonder spatie (bijv. "broccoliroosjes") probeert Jumbo
// automatisch alle mogelijke 2-splits totdat er resultaten komen — geen hardcoding.
async function handleJumbo(query, res) {
  try {
    // Jumbo's zoekmachine raakt de kluts kwijt bij lange queries — beperk tot 4 woorden
    const shortQuery = query.split(/\s+/).slice(0, 4).join(' ');
    let products = await fetchJumboProducts(shortQuery);

    if (products.length === 0 && !query.includes(' ') && query.length >= 6) {
      const MIN_PART = 3;
      for (let i = MIN_PART; i <= query.length - MIN_PART; i++) {
        const split = `${query.slice(0, i)} ${query.slice(i)}`;
        products = await fetchJumboProducts(split);
        if (products.length > 0) break;
      }
    }

    logSearchSummary('Jumbo', query, products);
    send(res, 200, { products });
  } catch (e) {
    console.error('[Jumbo]', e.message);
    send(res, 502, { error: e.message });
  }
}

// ── Dirk ────────────────────────────────────────────────────────────────────
const DIRK_API_KEY = '6d3a42a3-6d93-4f98-838d-bcc0ab2307fd';
const DIRK_STORE_ID = 66;

async function fetchDirkProducts(query) {
  const gqlQuery = `query { searchProducts(search: ${JSON.stringify(query)}, limit: 60) { products { product { headerText productId brand packaging image productAssortment(storeId: ${DIRK_STORE_ID}) { normalPrice offerPrice } } } } }`;
  const body = JSON.stringify({ query: gqlQuery, variables: {} });

  const result = await httpsPost(
    'web-gateway.dirk.nl',
    '/graphql',
    {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Api_key':        DIRK_API_KEY,
      'Origin':         'https://www.dirk.nl',
      'Referer':        'https://www.dirk.nl/',
      'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body
  );

  if (result.status !== 200) throw new Error(`Dirk API ${result.status}: ${result.body.slice(0, 200)}`);

  const gql      = JSON.parse(result.body);
  const items    = gql?.data?.searchProducts?.products ?? [];

  return items.map(({ product: p }) => {
    const a        = p.productAssortment ?? {};
    const hasBonus = a.offerPrice > 0 && a.normalPrice > 0 && a.offerPrice < a.normalPrice;
    const price    = hasBonus ? a.offerPrice : (a.normalPrice > 0 ? a.normalPrice : null);
    const image    = p.image ? `https://web-fileserver.dirk.nl/${p.image}?width=200` : '';
    return {
      id:            String(p.productId ?? Math.random()),
      name:          p.headerText ?? '',
      brand:         p.brand ?? '',
      unit:          p.packaging ?? '',
      price:         price !== null ? Number(price) : null,
      priceOriginal: hasBonus ? Number(a.normalPrice) : null,
      bonusLabel:    hasBonus ? 'Aanbieding' : null,
      pricePerUnit:  '',
      image,
      productCode:   pickProductCode(p.productCode, p.ean, p.gtin, p.barcode, p.globalTradeItemNumber),
    };
  }).filter(p => p.price !== null);
}

async function handleDirk(query, res) {
  try {
    const products = await fetchDirkProducts(query);
    logSearchSummary('Dirk', query, products);
    send(res, 200, { products });
  } catch (e) {
    console.error('[Dirk]', e.message);
    send(res, 502, { error: e.message });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') return send(res, 200, '');

  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const q        = (parsed.searchParams.get('q') || '').trim();

  if (!q && pathname !== '/ping' && pathname !== '/debug/meta') {
    return send(res, 400, { error: 'Geen zoekterm opgegeven (parameter: q)' });
  }

  if (pathname === '/api/ah')    return handleAH(q, res);
  // Voor Jumbo: spaties toevoegen tussen aaneen geschreven woorden helpt de zoekfunctie
  // bijv. "broccoliroosjes" → "broccoli roosjes" via spatie voor bekende scheidingen
  if (pathname === '/api/jumbo') return handleJumbo(q, res);
  if (pathname === '/api/dirk')  return handleDirk(q, res);  // compound splitting zit in handleDirk zelf
  if (pathname === '/debug/meta' && req.method === 'POST') return handleDebugMeta(req, res);
  if (pathname === '/ping')      return send(res, 200, { ok: true, ts: Date.now() });

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
