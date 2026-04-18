const { httpsGet, httpsPost, logSearchSummary } = require('./utils');

let ahToken    = null;
let ahTokenExp = 0;

async function getToken() {
  if (ahToken && Date.now() < ahTokenExp) return ahToken;

  const body = JSON.stringify({ clientId: 'appie-android', clientSecret: 'GfEuqEWbuJs6LfgZm2kEhTnijBjb7wqJ' });
  const { body: data } = await httpsPost(
    'api.ah.nl',
    '/mobile-auth/v1/auth/token/anonymous',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body
  );

  const parsed   = JSON.parse(data);
  ahToken        = parsed.access_token;
  ahTokenExp     = Date.now() + ((parsed.expires_in ?? 3600) - 60) * 1000;
  return ahToken;
}

async function search(query) {
  const token = await getToken();
  const path  = `/mobile-services/product/search/v2?query=${encodeURIComponent(query)}&sortOn=RELEVANCE&size=30`;

  const result = await httpsGet('api.ah.nl', path, {
    'Authorization':    `Bearer ${token}`,
    'X-Client-Name':    'Appie',
    'X-Client-Version': '8.22.3',
    'User-Agent':       'Appie/8.22.3 (Android)',
    'X-Application':    'AHWEBSHOP',
  });

  if (result.status !== 200) throw new Error(`AH API ${result.status}: ${result.body.slice(0, 200)}`);

  const parsed = JSON.parse(result.body);
  const items  = parsed?.products ?? [];

  logSearchSummary('AH', query, items.map(p => ({
    name: p.title ?? '',
    unit: p.salesUnitSize ?? p.unitSize ?? '',
    pricePerUnit: p.unitPriceDescription ?? '',
  })));

  // AH-response wordt ongewijzigd doorgestuurd naar de frontend (eigen normalizer in app.js)
  return { raw: result.body };
}

module.exports = { id: 'ah', name: 'Albert Heijn', search };
