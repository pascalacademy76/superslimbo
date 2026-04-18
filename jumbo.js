const { httpsPost, pickProductCode, logSearchSummary } = require('./utils');

const GQL_QUERY = `query SearchMobileProducts($input: ProductSearchInput!) {
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

async function fetchProducts(query) {
  const body = JSON.stringify({
    operationName: 'SearchMobileProducts',
    query: GQL_QUERY,
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
      'Content-Type':                 'application/json',
      'Content-Length':               Buffer.byteLength(body),
      'User-Agent':                   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':                       'application/json',
      'Origin':                       'https://www.jumbo.com',
      'Referer':                      `https://www.jumbo.com/producten/zoeken?searchTerms=${encodeURIComponent(query)}`,
      'apollographql-client-name':    'JUMBO_WEB',
      'apollographql-client-version': 'master-v30.15.0-web',
    },
    body
  );

  if (result.status !== 200) throw new Error(`Jumbo GraphQL ${result.status}: ${result.body.slice(0, 200)}`);

  const gql   = JSON.parse(result.body);
  const items = gql?.data?.searchProducts?.products ?? [];

  return items.map(p => ({
    id:           String(p.id ?? Math.random()),
    name:         p.title  ?? '',
    brand:        p.brand  ?? '',
    unit:         p.subtitle ?? '',
    price:        p.prices?.price != null ? p.prices.price / 100 : null,
    pricePerUnit: p.prices?.pricePerUnit
      ? `€\u202f${(p.prices.pricePerUnit.price / 100).toFixed(2)} per ${p.prices.pricePerUnit.unit}`
      : '',
    image:        p.image ?? '',
    bonusLabel:   p.promotions?.[0]?.tags?.[0]?.text ?? null,
    productCode:  pickProductCode(p.productCode, p.ean, p.gtin, p.barcode, p.globalTradeItemNumber),
  }));
}

async function search(query) {
  // Jumbo raakt de kluts kwijt bij lange queries — beperk tot 4 woorden
  const shortQuery = query.split(/\s+/).slice(0, 4).join(' ');
  let products = await fetchProducts(shortQuery);

  // Samengestelde woorden zonder spatie (bijv. "broccoliroosjes") automatisch splitsen
  if (products.length === 0 && !query.includes(' ') && query.length >= 6) {
    const MIN_PART = 3;
    for (let i = MIN_PART; i <= query.length - MIN_PART; i++) {
      const split = `${query.slice(0, i)} ${query.slice(i)}`;
      products = await fetchProducts(split);
      if (products.length > 0) break;
    }
  }

  logSearchSummary('Jumbo', query, products);
  return { products };
}

module.exports = { id: 'jumbo', name: 'Jumbo', search };
