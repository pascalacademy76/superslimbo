const https = require('https');

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

function normalizeProductCode(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return normalizeProductCode(value[0]);
  const digits = String(value).trim().replace(/\D/g, '');
  if ([8, 12, 13, 14].includes(digits.length)) return digits;
  return null;
}

function pickProductCode(...candidates) {
  for (const candidate of candidates) {
    const code = normalizeProductCode(candidate);
    if (code) return code;
  }
  return null;
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
  const withUnit         = list.filter(p => String(p.unit         || '').trim().length > 0).length;
  const withPricePerUnit = list.filter(p => String(p.pricePerUnit || '').trim().length > 0).length;
  const withQtyInName    = list.filter(p => hasQtyHint(p.name)).length;
  const withQtyInUnit    = list.filter(p => hasQtyHint(p.unit)).length;
  const withPackInName   = list.filter(p => hasPackHint(p.name)).length;
  const withPackInUnit   = list.filter(p => hasPackHint(p.unit)).length;

  console.log(
    `[SEARCH][${store}] q="${query}" total=${total} unit=${withUnit}/${total} ppu=${withPricePerUnit}/${total} ` +
    `qty(name)=${withQtyInName}/${total} qty(unit)=${withQtyInUnit}/${total} ` +
    `pack(name)=${withPackInName}/${total} pack(unit)=${withPackInUnit}/${total}`
  );
}

module.exports = { httpsGet, httpsPost, pickProductCode, logSearchSummary };
