const { httpsPost, pickProductCode, logSearchSummary } = require('./utils');

const API_KEY  = '6d3a42a3-6d93-4f98-838d-bcc0ab2307fd';
const STORE_ID = 1;

async function search(query) {
  const gqlQuery = `query { searchProducts(search: ${JSON.stringify(query)}, limit: 60) { products { product { headerText productId brand packaging image productAssortment(storeId: ${STORE_ID}) { normalPrice offerPrice } } } } }`;
  const body = JSON.stringify({ query: gqlQuery, variables: {} });

  const result = await httpsPost(
    'web-gateway.dirk.nl',
    '/graphql',
    {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Api_key':        API_KEY,
      'Origin':         'https://www.dekamarkt.nl',
      'Referer':        'https://www.dekamarkt.nl/',
      'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body
  );

  if (result.status !== 200) throw new Error(`DekaMarkt API ${result.status}: ${result.body.slice(0, 200)}`);

  const gql   = JSON.parse(result.body);
  const items = gql?.data?.searchProducts?.products ?? [];

  const products = items.map(({ product: p }) => {
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

  logSearchSummary('DekaMarkt', query, products);
  return { products };
}

module.exports = { id: 'dekamarkt', name: 'DekaMarkt', search };
