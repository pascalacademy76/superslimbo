// ========================================================
//  STATE
// ========================================================
const STORAGE_KEY = 'bverg_v1';
const BETA_BANNER_KEY = 'bverg_beta_banner_closed_v1';
const DEV_FILTER  = []; // lege array = geen filter actief

const DEFAULT_STORES = [
  { id: 'ah',    name: 'Albert Heijn', type: 'api', enabled: true,  color: '#0071C2' },
  { id: 'jumbo', name: 'Jumbo',        type: 'api', enabled: true,  color: '#E2A000' },
  { id: 'dirk',  name: 'Dirk',         type: 'api', enabled: true,  color: '#E2001A' },
];

let state = {
  supermarkets: JSON.parse(JSON.stringify(DEFAULT_STORES)),
  shoppingList: [],
  listCreatedAt: null,
  customCounter: 0,
};

// In-memory product registry (keyed by "storeId:productId")
const productRegistry = {};

// Current search results cache
let currentResults  = {}; // { storeId: Product[] | null }
let currentQuery    = '';
let allGroups       = []; // computed groups from last search
let hiddenItems     = new Set(); // "storeId:productId" weggeslipte rijen
const comparePerStuk = false; // stuks altijd meenemen in groupkey (vergelijking per stuk via ⚖ knop)

const cardQtyMap   = new Map();     // groupDisplayName → qty (card-level hoeveelheid)
const cardGroupMap = new WeakMap(); // card element → group

// ========================================================
//  PERSISTENCE
// ========================================================
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    if (Array.isArray(saved.supermarkets)) {
      // Keep defaults that aren't in saved (in case new defaults added)
      const savedIds = new Set(saved.supermarkets.map(s => s.id));
      const missing  = DEFAULT_STORES.filter(d => !savedIds.has(d.id));
      state.supermarkets = [...saved.supermarkets, ...missing];
    }
    if (Array.isArray(saved.shoppingList)) {
      state.shoppingList = saved.shoppingList.map(i => ({ ...i, qty: i.qty ?? 1 }));
    }
    if (saved.listCreatedAt)             state.listCreatedAt = saved.listCreatedAt;
    if (saved.customCounter)             state.customCounter = saved.customCounter;
  } catch (e) { console.warn('Load failed', e); }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      supermarkets:   state.supermarkets,
      shoppingList:   state.shoppingList,
      listCreatedAt:  state.listCreatedAt,
      customCounter:  state.customCounter,
    }));
  } catch (e) { console.warn('Save failed', e); }
}

// ========================================================
//  API LAYER
// ========================================================
const IS_LOCAL_DEV =
  window.location.protocol === 'file:' ||
  ['localhost', '127.0.0.1'].includes(window.location.hostname);
const CONFIGURED_REMOTE_API_BASE = (
  document.querySelector('meta[name="superslimbo-api-base"]')?.content || ''
).trim().replace(/\/+$/, '');
const API_BASE = IS_LOCAL_DEV ? 'http://localhost:3001' : CONFIGURED_REMOTE_API_BASE;
let   useLocalServer = false;   // discovered on first search

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Check once if local server is running
async function detectServer() {
  if (!API_BASE) return false;
  try {
    const res = await fetch(apiUrl('/ping'), { signal: AbortSignal.timeout(1500) });
    if (res.ok) { useLocalServer = true; return true; }
  } catch (_) {}
  return false;
}

async function localFetch(path) {
  const res = await fetch(apiUrl(path), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Server antwoordde met ${res.status}`);
  return res.json();
}

async function fetchAH(query) {
  if (useLocalServer) {
    const data = await localFetch(`/api/ah?q=${encodeURIComponent(query)}`);
    return parseAHResponse(data);
  }
  throw new Error('no-server');
}

async function fetchJumbo(query) {
  if (useLocalServer) {
    const data = await localFetch(`/api/jumbo?q=${encodeURIComponent(query)}`);
    return parseJumboResponse(data);
  }
  throw new Error('no-server');
}

function parseAHResponse(data) {
  const items = data.products ?? [];
  return items.map(p => {
    const hasBonus      = p.isBonus === true && p.priceBeforeBonus != null && p.currentPrice != null;
    const price         = hasBonus ? p.currentPrice : (p.currentPrice ?? p.priceBeforeBonus ?? null);
    const productCode   = pickProductCode(
      p.ean, p.gtin, p.barcode, p.gtin13, p.productCode,
      p.globalTradeItemNumber, p.eans?.[0]
    );
    return {
      id:            String(p.id ?? p.webshopId ?? Math.random()),
      name:          p.title ?? '',
      brand:         p.brand ?? p.category ?? '',
      unit:          p.salesUnitSize ?? p.unitSize ?? '',
      pricePerUnit:  hasBonus ? '' : (p.unitPriceDescription ?? ''),
      price:         price !== null ? Number(price) : null,
      priceOriginal: hasBonus ? Number(p.priceBeforeBonus) : null,
      bonusLabel:    hasBonus ? (p.bonusMechanism ?? '') : null,
      image:         p.images?.[0]?.url ?? '',
      productCode,
      store:         'ah',
    };
  });
}

function extractUnitFromName(name) {
  const m = name.match(/(\d[\d,.]*\s*(?:g|gr|gram|kg|kilo|ml|cl|l|liter|stuks?|st\.?))\s*$/i);
  return m ? m[1].trim() : '';
}

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

function parseJumboResponse(data) {
  const list = data.products ?? [];
  return list.map(p => ({
    id:           String(p.id ?? Math.random()),
    name:         p.name ?? '',
    brand:        p.brand ?? '',
    unit:         p.unit || extractUnitFromName(p.name ?? ''),
    price:        p.price ?? null,
    pricePerUnit: p.pricePerUnit ?? '',
    image:        p.image ?? '',
    bonusLabel:   p.bonusLabel ?? null,
    productCode:  pickProductCode(p.productCode, p.ean, p.gtin, p.barcode, p.globalTradeItemNumber),
    store:        'jumbo',
  }));
}

async function fetchDirk(query) {
  if (useLocalServer) {
    const data = await localFetch(`/api/dirk?q=${encodeURIComponent(query)}`);
    return (data.products ?? []).map(p => ({
      ...p,
      priceOriginal: p.priceOriginal ?? null,
      bonusLabel:    p.bonusLabel ?? null,
      productCode:   pickProductCode(p.productCode, p.ean, p.gtin, p.barcode, p.globalTradeItemNumber),
      store: 'dirk',
    }));
  }
  throw new Error('no-server');
}

async function searchStore(store, query) {
  if (store.type !== 'api') return [];
  if (store.id === 'ah')    return fetchAH(query);
  if (store.id === 'jumbo') return fetchJumbo(query);
  if (store.id === 'dirk')  return fetchDirk(query);
  return [];
}

// ========================================================
//  SEARCH
// ========================================================
async function triggerSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return;

  const activeStores = state.supermarkets.filter(s => s.enabled);
  if (!activeStores.length) {
    showToast('Geen actieve supermarkten. Voeg er een toe via "Supermarkten".');
    return;
  }

  currentQuery   = query;
  currentResults = {};
  hiddenItems    = new Set();
  cardQtyMap.clear();
  combinedOverrides.clear();
  document.getElementById('heroSection')?.classList.add('hidden');
  document.getElementById('faqSection')?.classList.add('hidden');

  const btn = document.getElementById('searchBtn');
  btn.disabled    = true;
  btn.textContent = '…';

  // Detect local server on first use
  if (!useLocalServer) {
    const found = await detectServer();
    if (!found) {
      btn.disabled    = false;
      btn.textContent = 'Zoeken';
      document.getElementById('searchResults').innerHTML = !API_BASE && !IS_LOCAL_DEV
        ? `
        <div style="background:#FFF8E1;border:1.5px solid #F9A825;border-radius:14px;padding:24px 28px;max-width:620px;margin:0 auto">
          <div style="font-size:1.2rem;margin-bottom:10px">⚙️ Backend-URL nog niet ingesteld</div>
          <p style="margin-bottom:14px;line-height:1.6;color:#555">
            Voeg in <strong>index.html</strong> de URL van je API toe in:
            <code style="background:#f6f7f8;padding:2px 6px;border-radius:4px">&lt;meta name="superslimbo-api-base" content="https://jouw-api.onrender.com"&gt;</code>
          </p>
          <p style="font-size:0.85rem;color:#777;line-height:1.6">
            Daarna werkt zoeken op je live site direct via die backend.
          </p>
        </div>`
        : IS_LOCAL_DEV
        ? `
        <div style="background:#FFF8E1;border:1.5px solid #F9A825;border-radius:14px;padding:24px 28px;max-width:560px;margin:0 auto">
          <div style="font-size:1.3rem;margin-bottom:10px">⚡ Start even de lokale server</div>
          <p style="margin-bottom:14px;line-height:1.6;color:#555">
            De app heeft een kleine lokale server nodig om prijzen op te halen
            (de supermarkt-APIs blokkeren anders browserverzoeken).
          </p>
          <div style="background:#1C2833;color:#A9DFBF;font-family:monospace;padding:14px 16px;border-radius:8px;font-size:0.95rem;margin-bottom:14px">
            node server.js
          </div>
          <p style="font-size:0.85rem;color:#777;line-height:1.6">
            Open een terminal in de map waar <strong>server.js</strong> staat en voer het commando hierboven in.
            Daarna kun je gewoon zoeken — de pagina hoeft niet te herladen.
          </p>
          <button onclick="retryDetect()" style="margin-top:14px;background:#27AE60;color:white;border:none;border-radius:8px;padding:9px 22px;font-size:0.9rem;font-weight:600;cursor:pointer">
            ↺ Server gevonden, opnieuw proberen
          </button>
        </div>`
        : `
        <div style="background:#FFF8E1;border:1.5px solid #F9A825;border-radius:14px;padding:24px 28px;max-width:560px;margin:0 auto">
          <div style="font-size:1.2rem;margin-bottom:10px">⚠️ Prijsservice tijdelijk niet bereikbaar</div>
          <p style="margin-bottom:14px;line-height:1.6;color:#555">
            De backend voor prijsdata reageert niet. Probeer het over een paar minuten opnieuw.
          </p>
          <button onclick="retryDetect()" style="margin-top:10px;background:#27AE60;color:white;border:none;border-radius:8px;padding:9px 22px;font-size:0.9rem;font-weight:600;cursor:pointer">
            ↺ Opnieuw proberen
          </button>
        </div>`;
      return;
    }
  }

  renderLoadingColumns(activeStores);

  // ── Alle winkels parallel bevragen ───────────────────────────────────────
  const results = await Promise.allSettled(activeStores.map(s => searchStore(s, query)));
  activeStores.forEach((store, i) => {
    const outcome = results[i];
    if (outcome.status === 'fulfilled') {
      outcome.value.forEach(p => { fillPricePerUnit(p); productRegistry[`${store.id}:${p.id}`] = p; });
      currentResults[store.id] = outcome.value;
    } else {
      console.warn(`${store.name} failed:`, outcome.reason);
      currentResults[store.id] = null;
    }
  });

  btn.disabled    = false;
  btn.textContent = 'Zoeken';

  renderResults(activeStores);
}

function renderLoadingColumns(stores) {
  const el = document.getElementById('searchResults');
  el.innerHTML = `<div class="state-box"><div class="spinner"></div>Zoeken bij ${stores.map(s => esc(s.name)).join(' & ')}…</div>`;
}

// Parse a "prijs per kg €3.31" or "€ 3.58 per kg" string into a number (€/kg)
function parsePricePerKg(str) {
  if (!str) return null;
  const m = str.match(/[\d]+[,.][\d]+/);
  if (!m) return null;
  const val = parseFloat(m[0].replace(',', '.'));
  // Only treat as per-kg if the unit mentions kg/kilo
  if (!/kg|kilo/i.test(str)) return null;
  return val;
}

function renderResults(stores) {
  const el = document.getElementById('searchResults');
  el.innerHTML = '';

  // Collect errors
  const errors = stores.filter(s => s.type === 'api' && currentResults[s.id] === null);
  if (errors.length) {
    const errDiv = document.createElement('div');
    errDiv.className = 'state-box full-width';
    errDiv.style.color = '#C0392B';
    errDiv.innerHTML = errors.map(s =>
      `⚠️ Kon <strong>${esc(s.name)}</strong> niet bereiken.`
    ).join('<br>') + `<br><small style="color:#888">Controleer of server.js nog draait.</small>`;
    el.appendChild(errDiv);
  }

  // Gather all products from all stores into one flat list
  let allProducts = [];
  stores.forEach(store => {
    const res = currentResults[store.id];
    if (!Array.isArray(res)) return;
    res.forEach(p => allProducts.push({ ...p, store }));
  });

  if (DEV_FILTER.length) {
    allProducts = allProducts.filter(p =>
      DEV_FILTER.some(f => normName(p.name).includes(f))
    );
  }

  if (!allProducts.length && !errors.length) {
    el.innerHTML = `<div class="state-box">Geen resultaten voor <em>${esc(currentQuery)}</em>.</div>`;
    return;
  }

  // Group products by normalized name (store prefix + weight stripped)
  const groupMap = new Map(); // key → { displayName, products[] }
  allProducts.forEach(p => {
    const productCode = normalizeProductCode(p.productCode);
    const groupName = getGroupName(p.name);
    const yFamilyKey = productFamilyKey(groupName, currentQuery);
    const qty = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
    const qtyKey = qty ? '|' + qty : '';
    const effectiveQty = qty;
    const baseKey = productCode ? `code:${productCode}` : productGroupKey(groupName);
    const key = productCode ? baseKey : (baseKey + qtyKey);
    if (!groupMap.has(key)) {
      const displayQty = effectiveQty ? formatQuantity(effectiveQty) : '';
      groupMap.set(key, {
        displayName: groupName,
        displayQty,
        baseKey,
        yFamilyKey,
        isCodeGroup: Boolean(productCode),
        products: [],
      });
    }
    const group = groupMap.get(key);
    // Prefer display name with more words (e.g. "Broccoli Roosjes" over "Broccoliroosjes")
    if (groupName.split(' ').length > group.displayName.split(' ').length) {
      group.displayName = groupName;
    }
    group.products.push(p);
  });

  // Merge groepen zonder qty in een groep mét qty als de basiskey gelijk is
  // (bijv. "Bananen tros" [geen qty] + "Bananen 1 kg" [qty=1000g] → samen)
  // Overgeslagen in comparePerStuk-modus: stuks hebben dan al geen qty-suffix
  if (!comparePerStuk) {
    groupMap.forEach((group, key) => {
      if (group.isCodeGroup) return;
      if (key.includes('|')) return;
      const baseKey = key;
      let mergeTarget = null;
      groupMap.forEach((otherGroup, otherKey) => {
        if (otherKey !== key && otherKey.startsWith(baseKey + '|')) {
          if (!mergeTarget) mergeTarget = otherGroup;
        }
      });
      if (mergeTarget) {
        group.products.forEach(p => mergeTarget.products.push(p));
        groupMap.delete(key);
      }
    });
  }

  // Groepen met ≥ 2 producten altijd tonen; groepen met 1 product ook als er een
  // andere groep met dezelfde Y-familie bestaat (ook bij code-first groepen).
  const baseKeyCount2 = new Map();
  groupMap.forEach(g => baseKeyCount2.set(g.baseKey, (baseKeyCount2.get(g.baseKey) ?? 0) + 1));
  const yFamilyCount = new Map();
  groupMap.forEach(g => yFamilyCount.set(g.yFamilyKey, (yFamilyCount.get(g.yFamilyKey) ?? 0) + 1));

  allGroups = [...groupMap.values()]
    .filter(g => g.products.length >= 2 || (baseKeyCount2.get(g.baseKey) ?? 0) > 1 || (yFamilyCount.get(g.yFamilyKey) ?? 0) > 1)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'nl'));

  renderGroupCards(allGroups);
}

function renderGroupCards(groups) {
  const el = document.getElementById('searchResults');
  el.innerHTML = '';

  const filtered = groups;

  // Sort by product count descending (meest producten = hoogste card = links)
  const visible = [...filtered].sort((a, b) => b.products.length - a.products.length);

  if (!visible.length) {
    const activeCount = state.supermarkets.filter(s => s.enabled).length;
    const msg = activeCount === 0
      ? 'Zet minstens één supermarkt aan om resultaten te zien.'
      : activeCount === 1
        ? 'Er zijn geen vergelijkbare resultaten gevonden bij deze supermarkt — schakel meer supermarkten in voor een vergelijking.'
        : 'Geen vergelijkbare resultaten gevonden. Probeer een andere zoekterm.';
    el.innerHTML = `<div class="state-box">${msg}</div>`;
    return;
  }

  const visibleWithProducts = visible.filter(g =>
    g.products.some(p => !hiddenItems.has(`${p.store.id}:${p.id}`))
  );

  // Count how many visible groups share the same family-key (determines ⚖ visibility)
  const familyKeyCount = new Map();
  visibleWithProducts.forEach(g => {
    familyKeyCount.set(g.yFamilyKey, (familyKeyCount.get(g.yFamilyKey) ?? 0) + 1);
  });

  visible.forEach(group => {
    const products = [...group.products].filter(p => !hiddenItems.has(`${p.store.id}:${p.id}`));
    if (!products.length) return;

    const groupKey = group.displayName + '|' + (group.displayQty ?? '');
    const cardQty  = cardQtyMap.get(groupKey) ?? 1;
    const isSingle = products.length === 1;
    const card     = document.createElement('div');
    card.className = 'group-card' + (isSingle ? ' group-card--single' : '');
    card.dataset.groupKey = groupKey;
    cardGroupMap.set(card, group);

    const qtyLabel  = group.displayQty && !comparePerStuk ? `<span class="card-qty-label">${esc(group.displayQty.toUpperCase())}</span>` : '';
    const nameLabel = group.displayName.toUpperCase();
    const hasFamily = (familyKeyCount.get(group.yFamilyKey) ?? 0) > 1;

    card.innerHTML = `
      <div class="group-card-header">
        <div class="card-title">${qtyLabel}<span>${esc(nameLabel)}</span></div>
        <div class="card-header-actions">
          <div class="card-qty-control">
            <button onclick="adjustCardQty(this,-1)">−</button>
            <span class="card-qty-value">${cardQty}</span>
            <button onclick="adjustCardQty(this,1)">+</button>
          </div>
          ${isSingle ? '<span class="single-store-tag">1 winkel</span>' : ''}
          <button class="card-search-btn" onclick="searchByName('${esc(nameLabel)}')" title="Zoek op dit product"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          ${hasFamily ? `<button class="card-compare-btn" onclick="compareByUnit(this)" title="Samenvoegen en vergelijken"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M20 4l-8 8M12 12v8"/></svg></button>` : ''}
          <button class="card-close-btn" onclick="dismissGroup(this)" title="Verberg groep">✕</button>
        </div>
      </div>
      <div class="group-rows">${buildCardRows(products, cardQty)}</div>`;

    card.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
      addSwipeListeners(rowEl, rowEl.dataset.store, rowEl.dataset.product);
    });

    el.appendChild(card);
  });
}

// Berekent de totaalprijs voor qty stuks, inclusief promotie-korting
function calcTotalPrice(unitPrice, qty, bonusLabel) {
  if (!unitPrice || !qty) return unitPrice;
  let total;
  if (bonusLabel === '2e halve prijs' && qty >= 2) {
    const pairs = Math.floor(qty / 2);
    const rem   = qty % 2;
    total = pairs * unitPrice * 1.5 + rem * unitPrice;
  } else {
    total = unitPrice * qty;
  }
  return Math.floor(total * 100) / 100;
}

function buildPriceHint(unitPrice, qty, bonusLabel) {
  const fmt = v => '€\u202f' + v.toFixed(2).replace('.', ',');
  if (bonusLabel === '2e halve prijs' && qty >= 2) {
    const parts = [];
    for (let i = 0; i < qty; i++) {
      const p = i % 2 === 1 ? Math.floor(unitPrice / 2 * 100) / 100 : unitPrice;
      parts.push(fmt(p));
    }
    return parts.join(' + ');
  }
  return `${qty}\u202f×\u202f${fmt(unitPrice)}`;
}

function buildCardRows(products, cardQty) {
  function getPricePerStuk(p) {
    if (!comparePerStuk) return null;
    const qty = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
    if (!qty || !qty.endsWith('st')) return null;
    const count = parseInt(qty);
    if (!count || !p.price) return null;
    return p.price / count;
  }

  // Effectieve vergelijkingseenheid per stuk, rekening houdend met bonus bij cardQty
  function effectiveUnitPrice(p) {
    const base = comparePerStuk
      ? (getPricePerStuk(p) ?? p.price)
      : (parsePricePerKg(p.pricePerUnit) ?? p.price);
    if (base == null) return null;
    return calcTotalPrice(base, cardQty, p.bonusLabel) / cardQty;
  }

  // Sorteer op effectieve prijs per eenheid
  products.sort((a, b) => {
    const aEff = effectiveUnitPrice(a) ?? Infinity;
    const bEff = effectiveUnitPrice(b) ?? Infinity;
    return aEff - bEff;
  });

  const effPrices = products.map(p => effectiveUnitPrice(p)).filter(v => v !== null);
  const minEff    = effPrices.length ? Math.min(...effPrices) : null;

  return products.map(p => {
    const listQty    = getListQty(p.store.id, p.id);
    const perKg      = parsePricePerKg(p.pricePerUnit);
    const perStuk    = getPricePerStuk(p);
    const eff        = effectiveUnitPrice(p);
    const isWinner   = eff !== null && minEff !== null && Math.abs(eff - minEff) < 0.001;
    const pctMore    = (!isWinner && eff !== null && minEff !== null && minEff > 0)
      ? Math.round((eff - minEff) / minEff * 100)
      : null;

    const totalPrice    = cardQty > 1 ? calcTotalPrice(p.price, cardQty, p.bonusLabel) : p.price;
    const totalOriginal = p.priceOriginal != null ? p.priceOriginal * cardQty : null;

    return `
      <div class="row-wrapper">
        <div class="delete-bg"><span>Verwijderen</span></div>
        <div class="group-row${isWinner ? ' group-row--winner' : ''}"
             data-store="${p.store.id}" data-product="${esc(p.id)}">
          <div class="group-row-img">
            ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onpointerdown="event.stopPropagation()" onclick="openImageZoom(event,'${esc(p.image)}')" onerror="this.style.display='none'">` : ''}
            ${isWinner ? '<div class="winner-badge">✓</div>' : ''}
          </div>
          <div class="group-row-info">
            <div class="badges-row">
              <span class="store-badge" style="background:${p.store.color}">${esc(p.store.name)}</span>
              ${p.bonusLabel ? `<span class="bonus-badge">${esc(p.bonusLabel)}</span>` : ''}
            </div>
            <div class="group-row-name" style="cursor:pointer" onclick="searchByName('${esc(stripWeightSuffix(p.name))}')">${esc(stripWeightSuffix(p.name))}</div>
            ${(() => { const nq = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name); const u = nq ? formatQuantity(nq) : p.unit; return u ? `<div class="group-row-weight">${esc(u)}</div>` : ''; })()}
          </div>
          <div class="group-row-pricing">
            <div class="group-row-price">
              ${totalOriginal != null ? `<span class="price-original">€\u202f${totalOriginal.toFixed(2).replace('.', ',')}</span>` : ''}
              ${totalPrice !== null ? '€\u202f' + totalPrice.toFixed(2).replace('.', ',') : '–'}
              ${cardQty > 1 && p.price !== null ? `<span class="price-qty-hint">${buildPriceHint(p.price, cardQty, p.bonusLabel)}</span>` : ''}
            </div>
            <div class="group-row-pkg${isWinner ? ' group-row-pkg--winner' : ''}">
              ${perKg !== null && !comparePerStuk ? `€\u202f${perKg.toFixed(2).replace('.', ',')}/kg${isWinner ? '\u202f✓' : ''}` : ''}
              ${perStuk !== null && comparePerStuk ? `€\u202f${perStuk.toFixed(3).replace('.', ',')}/st${isWinner ? '\u202f✓' : ''}` : ''}
              ${pctMore !== null ? `<span class="pct-more">+${pctMore}%</span>` : ''}
            </div>
          </div>
          <div class="row-actions">
            ${listQty > 0 ? `
              <div class="qty-control">
                <button onclick="removeFromList('${p.store.id}', '${esc(p.id)}')">−</button>
                <span class="qty-value">${listQty}</span>
                <button onclick="addToList('${p.store.id}', '${esc(p.id)}')">+</button>
              </div>
            ` : `
              <button class="add-btn" title="Voeg toe aan lijst"
                      onclick="addToList('${p.store.id}', '${esc(p.id)}', ${cardQty})">+</button>
            `}
            <button class="dismiss-btn" title="Verwijder uit resultaten"
                    onclick="dismissItem(this, '${p.store.id}', '${esc(p.id)}')">✕</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function adjustCardQty(btn, delta) {
  const card     = btn.closest('.group-card');
  const groupKey = card.dataset.groupKey;
  const current  = cardQtyMap.get(groupKey) ?? 1;
  const newQty   = Math.max(1, current + delta);
  if (newQty === current) return;
  cardQtyMap.set(groupKey, newQty);
  card.querySelector('.card-qty-value').textContent = newQty;
  const group    = cardGroupMap.get(card);
  if (!group) return;
  const products = [...group.products].filter(p => !hiddenItems.has(`${p.store.id}:${p.id}`));
  card.querySelector('.group-rows').innerHTML = buildCardRows(products, newQty);
  card.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
    addSwipeListeners(rowEl, rowEl.dataset.store, rowEl.dataset.product);
  });
}

// ========================================================
//  SHOPPING LIST
// ========================================================
function getListQty(storeId, productId) {
  const item = state.shoppingList.find(i => i.storeId === storeId && i.productId === productId);
  return item ? item.qty : 0;
}

function getComparableUnit(product) {
  if (!product || product.price == null) return null;
  const qty = extractCompoundQty(product.name) || normalizeQuantity(product.unit) || normalizeQuantity(product.name);
  if (!qty) return null;

  if (qty.endsWith('st')) {
    const count = parseInt(qty, 10);
    if (!count) return null;
    return { type: 'st', amount: count, unitPrice: product.price / count };
  }
  if (qty.endsWith('g')) {
    const grams = parseInt(qty, 10);
    if (!grams) return null;
    return { type: 'g', amount: grams, unitPrice: product.price / grams * 100 };
  }
  if (qty.endsWith('ml')) {
    const ml = parseInt(qty, 10);
    if (!ml) return null;
    return { type: 'ml', amount: ml, unitPrice: product.price / ml * 100 };
  }
  return null;
}

function absolutePriceFromUnit(type, amount, unitPrice) {
  if (type === 'st') return unitPrice * amount;
  if (type === 'g' || type === 'ml') return unitPrice * (amount / 100);
  return null;
}

function addToList(storeId, productId, qty = 1) {
  const existing = state.shoppingList.find(i => i.storeId === storeId && i.productId === productId);
  if (existing) {
    existing.qty += qty;
    showToast(`${existing.name} → ${existing.qty}×`);
  } else {
    const product = productRegistry[`${storeId}:${productId}`];
    if (!product) return;
    const store = state.supermarkets.find(s => s.id === storeId);
    if (!state.listCreatedAt) state.listCreatedAt = new Date().toISOString();

    // Bepaal referentieprijs voor voordeel:
    // 1) voorkeur: duurste equivalent binnen dezelfde Y-familie op dezelfde vergelijkingseenheid
    // 2) fallback: huidige groep (absoluut)
    let maxGroupPrice = null;
    if (product.price !== null) {
      const group = allGroups.find(g => g.products.some(p => p.store.id === storeId && p.id === productId));
      if (group) {
        const selfCmp = getComparableUnit(product);
        const familyProducts = allGroups
          .filter(g => g.yFamilyKey === group.yFamilyKey)
          .flatMap(g => g.products);

        if (selfCmp) {
          const unitCandidates = familyProducts
            .map(p => getComparableUnit(p))
            .filter(c => c && c.type === selfCmp.type)
            .map(c => c.unitPrice);
          if (unitCandidates.length > 1) {
            const worstUnitPrice = Math.max(...unitCandidates);
            const equivalentWorst = absolutePriceFromUnit(selfCmp.type, selfCmp.amount, worstUnitPrice);
            if (equivalentWorst != null && equivalentWorst > product.price) {
              maxGroupPrice = equivalentWorst;
            }
          }
        }

        if (maxGroupPrice == null && group.products.length > 1) {
          const prices = group.products.map(p => p.price).filter(v => v !== null);
          maxGroupPrice = prices.length ? Math.max(...prices) : null;
        }
      }
    }

    state.shoppingList.push({
      uid:           Date.now() + '_' + Math.random().toString(36).slice(2),
      storeId, storeName: store?.name ?? storeId, storeColor: store?.color ?? '#888',
      productId,
      name: product.name, brand: product.brand, unit: product.unit,
      pricePerUnit: product.pricePerUnit ?? '',
      price: product.price, priceOriginal: product.priceOriginal ?? null, image: product.image,
      maxGroupPrice,
      checked: false, qty,
    });
    showToast(`${product.name} toegevoegd ✓`);
  }
  saveState();
  updateBadge();
  if (currentQuery) refreshSearchButtons();
}

function removeFromList(storeId, productId) {
  const idx = state.shoppingList.findIndex(i => i.storeId === storeId && i.productId === productId);
  if (idx === -1) return;
  if (state.shoppingList[idx].qty > 1) {
    state.shoppingList[idx].qty--;
    showToast(`${state.shoppingList[idx].name} → ${state.shoppingList[idx].qty}×`);
  } else {
    showToast('Verwijderd uit je lijst.');
    state.shoppingList.splice(idx, 1);
  }
  saveState();
  updateBadge();
  if (currentQuery) refreshSearchButtons();
}

function refreshSearchButtons() {
  // Als er een combined card actief is, alleen de row-actions in-place updaten
  const combined = document.querySelector('#searchResults .group-card--combined');
  if (combined) {
    combined.querySelectorAll('.group-row[data-store][data-product]').forEach(row => {
      const storeId   = row.dataset.store;
      const productId = row.dataset.product;
      const listQty   = state.shoppingList.filter(i => i.storeId === storeId && i.productId === productId)
                                          .reduce((s, i) => s + (i.qty ?? 1), 0);
      const actionsEl = row.querySelector('.row-actions');
      if (!actionsEl) return;
      // Vervang alleen de qty-control of add-btn, bewaar move en dismiss knoppen
      const moveBtn    = actionsEl.querySelector('.move-section-btn')?.outerHTML ?? '';
      const dismissBtn = actionsEl.querySelector('.dismiss-btn')?.outerHTML ?? '';
      const listHtml = listQty > 0
        ? `<div class="qty-control">
            <button onclick="removeFromList('${storeId}', '${esc(productId)}')">−</button>
            <span class="qty-value">${listQty}</span>
            <button onclick="addToList('${storeId}', '${esc(productId)}')">+</button>
           </div>`
        : `<button class="add-btn" title="Voeg toe aan lijst"
                  onclick="addToList('${storeId}', '${esc(productId)}')">+</button>`;
      actionsEl.innerHTML = moveBtn + listHtml + dismissBtn;
    });
    return;
  }
  // Geen combined card: gewoon opnieuw renderen
  renderGroupCards(allGroups);
}

function removeListItem(uid) {
  state.shoppingList = state.shoppingList.filter(i => i.uid !== uid);
  saveState();
  updateBadge();
  renderList();
}

function toggleChecked(uid) {
  const item = state.shoppingList.find(i => i.uid === uid);
  if (item) item.checked = !item.checked;
  saveState();
  renderList();
}

function nlPrice(amount) {
  return '€ ' + amount.toFixed(2).replace('.', ',');
}

function shareList() {
  // Bouw leesbare tekst op, gegroepeerd per winkel
  const groups = {};
  state.shoppingList.forEach(item => {
    if (!groups[item.storeId]) groups[item.storeId] = { name: item.storeName, items: [] };
    groups[item.storeId].items.push(item);
  });

  const dateStr = state.listCreatedAt
    ? new Date(state.listCreatedAt).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const lines = [`🛒 Mijn boodschappenlijst via Super Slimbo${dateStr ? '\n📅 ' + dateStr : ''}\n`];
  let totalAll = 0;

  Object.values(groups).forEach(group => {
    const storeTotal = group.items.reduce((s, i) => s + (i.price ?? 0) * (i.qty ?? 1), 0);
    lines.push(`\n📍 ${group.name} (${nlPrice(storeTotal)})`);
    group.items.forEach(item => {
      const subtotal = (item.price ?? 0) * (item.qty ?? 1);
      const qty = item.qty > 1 ? `${item.qty}× ` : '';
      lines.push(`  ${qty}${item.name}${item.unit ? ' ' + item.unit : ''} — ${nlPrice(subtotal)}`);
    });
    totalAll += storeTotal;
  });

  lines.push(`\nTotaal: ${nlPrice(totalAll)}`);
  const text = lines.join('\n');

  if (navigator.share) {
    navigator.share({ title: 'Mijn boodschappenlijst', text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Lijst gekopieerd naar klembord');
    }).catch(() => {
      showToast('Kopiëren mislukt');
    });
  }
}

function clearList() {
  if (!confirm('Wil je de hele lijst wissen?')) return;
  state.shoppingList = [];
  state.listCreatedAt = null;
  saveState();
  updateBadge();
  renderList();
}

function renderList() {
  const el = document.getElementById('listContent');

  if (!state.shoppingList.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">📋</div>
      <p>Je lijst is leeg. Zoek producten en voeg ze toe aan je lijst.</p>
    </div>`;
    return;
  }

  function getReferencePrice(item) {
    const refs = [item.maxGroupPrice, item.priceOriginal]
      .filter(v => v != null && item.price != null && v > item.price);
    return refs.length ? Math.max(...refs) : null;
  }

  // Group by store
  const groups = {};
  state.shoppingList.forEach(item => {
    if (!groups[item.storeId]) {
      groups[item.storeId] = { name: item.storeName, color: item.storeColor, items: [] };
    }
    groups[item.storeId].items.push(item);
  });

  const totalAll      = state.shoppingList.reduce((s, i) => s + (i.price ?? 0) * (i.qty ?? 1), 0);
  const totalSaving   = state.shoppingList.reduce((s, i) => {
    const ref = getReferencePrice(i);
    if (ref != null && i.price !== null) {
      return s + (ref - i.price) * (i.qty ?? 1);
    }
    return s;
  }, 0);
  const checkedCount  = state.shoppingList.filter(i => i.checked).reduce((s, i) => s + (i.qty ?? 1), 0);

  const createdLabel = state.listCreatedAt
    ? new Date(state.listCreatedAt).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  let html = `
    <div class="list-toolbar">
      <div class="list-summary">
        <strong>${state.shoppingList.reduce((s,i) => s + (i.qty ?? 1), 0)} stuks</strong>
        ${checkedCount ? `<span> · ${checkedCount} in mandje</span>` : ''}
        ${createdLabel ? `<div class="list-date">Aangemaakt op ${createdLabel}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="list-total">
          <span>Totaal: €\u202f${totalAll.toFixed(2).replace('.', ',')}${totalSaving > 0.005 ? ` <span class="list-total-orig">€\u202f${(totalAll + totalSaving).toFixed(2).replace('.', ',')}</span>` : ''}</span>
          ${totalSaving > 0.005 ? (() => {
              const pct = totalAll > 0 ? Math.round(totalSaving / totalAll * 100) : 0;
              return `<span class="list-total-saving">Voordeel: €\u202f${totalSaving.toFixed(2).replace('.', ',')} (${pct}%)</span>`;
            })() : ''}
        </div>
        <div class="list-actions">
          <button class="btn-share" onclick="shareList()">Delen</button>
          <button class="btn-danger" onclick="clearList()">Lijst wissen</button>
        </div>
      </div>
    </div>`;

  Object.entries(groups).forEach(([, group]) => {
    const storeTotal = group.items.reduce((s, i) => s + (i.price ?? 0) * (i.qty ?? 1), 0);
    html += `
      <div class="store-section">
        <div class="store-section-header" style="background:${group.color}">
          <span>${esc(group.name)}</span>
          <span class="store-section-total">€\u202f${storeTotal.toFixed(2).replace('.', ',')}</span>
        </div>
        <div class="list-card">
          ${group.items.map(item => `
            <div class="list-item ${item.checked ? 'checked' : ''}">
              <input type="checkbox" ${item.checked ? 'checked' : ''}
                     onchange="toggleChecked('${item.uid}')">
              ${item.image
                ? `<img class="list-item-img" src="${esc(item.image)}" alt="" loading="lazy" onclick="openImageZoom(event,'${esc(item.image)}')"
                        onerror="this.style.display='none'">`
                : ''}
              <div class="list-item-info">
                <div class="list-item-name">${esc(item.name)}</div>
                <div class="list-item-sub">${esc(([item.brand, item.unit].filter(Boolean).join(' · ')))}</div>
              </div>
              <div class="list-item-price">
                ${item.qty > 1 ? `<span class="list-item-qty">${item.qty}×</span>` : ''}
                ${item.price !== null ? '€\u202f' + item.price.toFixed(2).replace('.', ',') : '–'}
                ${(() => {
                    const ref = getReferencePrice(item);
                    return item.qty <= 1 && ref != null
                      ? `<span class="list-item-orig">€\u202f${ref.toFixed(2).replace('.', ',')}</span>`
                      : '';
                  })()}
                ${item.qty > 1 && item.price !== null
                  ? (() => {
                      const ref = getReferencePrice(item);
                      return `= €\u202f${(item.price * item.qty).toFixed(2).replace('.', ',')}${ref != null ? ` <span class="list-item-orig">€\u202f${(ref * item.qty).toFixed(2).replace('.', ',')}</span>` : ''}`;
                    })()
                  : ''}
                ${(() => {
                    const ref = getReferencePrice(item);
                    if (ref == null || item.price === null) return '';
                    const saved = (ref - item.price) * (item.qty ?? 1);
                    const pct   = Math.round((ref - item.price) / item.price * 100);
                    return `<span class="list-item-saving">Voordeel: €\u202f${saved.toFixed(2).replace('.', ',')} (${pct}%)</span>`;
                  })()}
              </div>
              <button class="remove-btn" title="Verwijder" onclick="removeListItem('${item.uid}')">✕</button>
            </div>`).join('')}
        </div>
      </div>`;
  });

  el.innerHTML = html;
}

function updateBadge() {
  const count = state.shoppingList.reduce((s, i) => s + (i.qty ?? 1), 0);
  const badge = document.getElementById('listBadge');
  if (count) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ========================================================
//  STORE MANAGER
// ========================================================
function renderStoreManager() {
  const el = document.getElementById('storeToggles');
  if (!el) return;
  el.innerHTML = state.supermarkets.map(s => `
    <button class="store-toggle-pill ${s.enabled ? 'on' : 'off'}"
            onclick="toggleStore('${s.id}')"
            style="${s.enabled ? `background:${s.color};border-color:${s.color}` : ''}">
      <span class="store-toggle-dot" style="background:${s.color}"></span>
      ${esc(s.name)}
    </button>`).join('');
}

function toggleStore(id) {
  const s = state.supermarkets.find(x => x.id === id);
  if (!s) return;
  s.enabled = !s.enabled;
  saveState();
  renderStoreManager();
  if (currentQuery) {
    const activeStores = state.supermarkets.filter(x => x.enabled);
    renderResults(activeStores);
  }
}

function deleteStore(id) {
  if (!confirm('Supermarkt verwijderen?')) return;
  state.supermarkets = state.supermarkets.filter(x => x.id !== id);
  state.shoppingList = state.shoppingList.filter(x => x.storeId !== id);
  saveState();
  updateBadge();
  renderStoreManager();
  showToast('Supermarkt verwijderd.');
}

function addCustomStore() {
  const name = document.getElementById('newStoreName').value.trim();
  if (!name) { showToast('Voer een naam in.'); return; }

  const palette = ['#8E44AD','#E74C3C','#D35400','#16A085','#2980B9','#95A5A6'];
  state.customCounter++;
  state.supermarkets.push({
    id:      `custom_${state.customCounter}`,
    name:    name,
    type:    'custom',
    enabled: true,
    color:   palette[(state.customCounter - 1) % palette.length],
  });

  document.getElementById('newStoreName').value = '';
  saveState();
  renderStoreManager();
  showToast(`${name} toegevoegd!`);
}

// ========================================================
//  NAVIGATION
// ========================================================
function goHome() {
  // Activeer zoeken tab
  const searchBtn = document.querySelector('.tab-btn[data-view="search"]');
  showView('search', searchBtn);
  // Reset zoekbalk en resultaten
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('heroSection').classList.remove('hidden');
  document.getElementById('faqSection')?.classList.remove('hidden');
  currentQuery = '';
  allGroups = [];
  activeFilters = new Set();
  hiddenItems = new Set();
}

function showView(viewId, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(viewId + 'View').classList.add('active');
  btn.classList.add('active');

  if (viewId === 'list')   renderList();
}

// ========================================================
//  TOAST
// ========================================================
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function closeBetaBanner() {
  const banner = document.getElementById('betaBanner');
  if (!banner) return;
  banner.style.display = 'none';
  try { localStorage.setItem(BETA_BANNER_KEY, '1'); } catch (_) {}
}

function openImageZoom(ev, src) {
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  if (!src) return;
  const wrap = document.getElementById('imageZoom');
  const img = document.getElementById('imageZoomImg');
  if (!wrap || !img) return;
  img.src = src;
  wrap.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeImageZoom(ev) {
  const wrap = document.getElementById('imageZoom');
  const img = document.getElementById('imageZoomImg');
  if (!wrap || !img) return;
  if (ev && ev.target !== wrap) return;
  wrap.classList.remove('show');
  img.src = '';
  document.body.style.overflow = '';
}

// ========================================================
//  UTILS
// ========================================================
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function soloGroup(btn) {
  const keepCard = btn.closest('.group-card');
  document.querySelectorAll('#searchResults .group-card').forEach(card => {
    if (card === keepCard) return;
    card.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
      hiddenItems.add(`${rowEl.dataset.store}:${rowEl.dataset.product}`);
    });
  });
  renderGroupCards(allGroups);
}

function dismissGroup(btn) {
  const card = btn.closest('.group-card');
  if (!card) return;

  // Hide all products in this card
  card.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
    hiddenItems.add(`${rowEl.dataset.store}:${rowEl.dataset.product}`);
  });

  // Animate card out, then re-render
  card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
  card.style.opacity    = '0';
  card.style.transform  = 'scale(0.95)';
  setTimeout(() => renderGroupCards(allGroups), 220);
}

function dismissItem(btn, storeId, productId) {
  hiddenItems.add(`${storeId}:${productId}`);
  const wrapper     = btn.closest('.row-wrapper');
  const rowEl       = wrapper?.querySelector('.group-row');
  const combinedCard = btn.closest('.group-card--combined');

  if (!wrapper || !rowEl) {
    combinedCard ? rebuildCombinedCard(btn) : renderGroupCards(allGroups);
    return;
  }

  rowEl.style.transition = 'transform 0.22s ease';
  rowEl.style.transform  = 'translateX(-110%)';
  setTimeout(() => {
    const h = wrapper.offsetHeight;
    wrapper.style.overflow   = 'hidden';
    wrapper.style.maxHeight  = h + 'px';
    wrapper.style.transition = 'max-height 0.22s ease';
    requestAnimationFrame(() => { wrapper.style.maxHeight = '0'; });
    setTimeout(() => {
      if (combinedCard) {
        wrapper.remove();
        rebuildCombinedCard(combinedCard.querySelector('.card-back-btn'));
      } else {
        renderGroupCards(allGroups);
      }
    }, 220);
  }, 220);
}

// ── Swipe-to-dismiss ──────────────────────────────────────────────────────────
function addSwipeListeners(rowEl, storeId, productId) {
  let startX = 0, startY = 0, currentX = 0;
  let active = false, horizontal = null;
  const wrapper = rowEl.closest('.row-wrapper');

  rowEl.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return; // knoppen zelf afhandelen
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    startX = e.clientX;
    startY = e.clientY;
    currentX = 0;
    active = true;
    horizontal = null;
    rowEl.setPointerCapture(e.pointerId);
  });

  rowEl.addEventListener('pointermove', e => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (horizontal === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      horizontal = Math.abs(dx) > Math.abs(dy);
    }

    if (horizontal && dx < 0) {
      e.preventDefault();
      currentX = dx;
      rowEl.style.transition = 'none';
      rowEl.style.transform  = `translateX(${currentX}px)`;
    }
  });

  const finish = () => {
    if (!active) return;
    active = false;

    if (horizontal && currentX < -80) {
      rowEl.style.transition = 'transform 0.22s ease';
      rowEl.style.transform  = 'translateX(-110%)';
      hiddenItems.add(`${storeId}:${productId}`);

      // Collapse de wrapper, dan herbereken winners
      setTimeout(() => {
        const h = wrapper.offsetHeight;
        wrapper.style.overflow   = 'hidden';
        wrapper.style.maxHeight  = h + 'px';
        wrapper.style.transition = 'max-height 0.22s ease';
        requestAnimationFrame(() => { wrapper.style.maxHeight = '0'; });
        setTimeout(() => renderGroupCards(allGroups), 220);
      }, 220);
    } else {
      rowEl.style.transition = 'transform 0.2s ease';
      rowEl.style.transform  = '';
    }
    currentX = 0;
    horizontal = null;
  };

  rowEl.addEventListener('pointerup', finish);
  rowEl.addEventListener('pointercancel', finish);
}

function normName(str) {
  return String(str ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Berekent pricePerUnit als die ontbreekt maar unit + price aanwezig zijn
function fillPricePerUnit(p) {
  if (p.pricePerUnit || p.price === null || p.price <= 0) return;
  const unit = String(p.unit ?? '');
  let kg = null;

  const kgM = unit.match(/(\d+[.,]?\d*)\s*kg/i);
  if (kgM) kg = parseFloat(kgM[1].replace(',', '.'));

  if (!kg) {
    const gM = unit.match(/(\d+[.,]?\d*)\s*g(?:ram)?\b/i);
    if (gM) kg = parseFloat(gM[1].replace(',', '.')) / 1000;
  }

  if (kg && kg > 0) {
    p.pricePerUnit = `€\u202f${(p.price / kg).toFixed(2).replace('.', ',')} per kg`;
  }
}

// ── Product grouping helpers ──────────────────────────────────────────────────
const STORE_PREFIX_RE = /^(albert\s+heijn|jumbo|ah)\s+/i;

function stripStorePrefix(name) {
  return name.replace(STORE_PREFIX_RE, '').trim();
}

function stripWeightSuffix(name) {
  return name
    .replace(/[\s-]+\d+\s*[x×]\s*\d+\s*(?:cups?|koffiecups?|capsules?|pods?|pads?|stuks?|st\.?)\.?\s*$/i, '')
    .replace(/,?\s*\d[\d,.]*\s*[x×]\s*[\d,.]+\s*(?:g|gr|gram|kg|ml|cl|l)\.?\s*$/i, '')
    .replace(/,?\s*\d[\d,.]*\s*(g|gr|gram|kg|kilo|ml|cl|l|liter|stuks?|st\.?)\.?\s*$/i, '')
    .replace(/,?\s*\d+\s*(?:tabletten?|tabs?|tablet)\.?\s*$/i, '')
    .replace(/,?\s*\d+\s*cups?\.?\s*$/i, '')
    .replace(/,?\s*\d+\s*(?:capsules?|pods?|pads?)\.?\s*$/i, '')
    .replace(/,?\s*(tros|bos|zak|doos|pak|blik|fles|pot|rol|stuk)\.?\s*$/i, '')
    .replace(/\s+[x×]\s*$/i, '')
    .trim();
}

// Mooie weergave van genormaliseerde hoeveelheid: "1000ml" → "1 liter", "1000g" → "1 kg"
function formatQuantity(qty) {
  const m = qty.match(/^(\d+)(ml|g|st)$/);
  if (!m) return qty;
  const val = parseInt(m[1]), unit = m[2];
  if (unit === 'ml') {
    if (val >= 1000) {
      const l = val / 1000;
      return (Number.isInteger(l) ? l : l.toFixed(1).replace('.', ',')) + ' liter';
    }
    return val + ' ml';
  }
  if (unit === 'g') {
    if (val >= 1000) {
      const kg = val / 1000;
      return (Number.isInteger(kg) ? kg : kg.toFixed(1).replace('.', ',')) + ' kg';
    }
    return val + ' g';
  }
  if (unit === 'st') return val + (val === 1 ? ' stuk' : ' stuks');
  return qty;
}

// Zoekt compound patronen overal in de tekst (niet alleen aan het begin)
function extractCompoundQty(text) {
  if (!text) return null;
  // "3 x 16 cups" → 48st
  const stSt = text.match(/(\d+)\s*[x×]\s*(\d+)\s*(?:cups?|koffiecups?|capsules?|pods?|pads?|stuks?|st\.?|tabletten?|tabs?|tablet)\b/i);
  if (stSt) return Math.round(parseInt(stSt[1]) * parseInt(stSt[2])) + 'st';
  // "3 x 250 ml" → 750ml
  const mlMl = text.match(/(\d+)\s*[x×]\s*([\d,.]+)\s*(ml|cl|l|liter)\b/i);
  if (mlMl) {
    let vol = parseFloat(mlMl[2].replace(',', '.'));
    const u = mlMl[3].toLowerCase();
    if (u === 'l' || u === 'liter') vol *= 1000;
    else if (u === 'cl') vol *= 10;
    return Math.round(parseInt(mlMl[1]) * vol) + 'ml';
  }
  // "16 capsules", "30 cups" ergens in de naam → stuks
  const single = text.match(/\b(\d+)\s+(?:cups?|koffiecups?|capsules?|pods?|pads?|tabletten?|tabs?|tablet)\b/i);
  if (single) return Math.round(parseInt(single[1])) + 'st';
  return null;
}

// Normaliseert hoeveelheid naar canonieke eenheid (gram of ml) als integer string,
// zodat "1 liter", "1000 ml" en "1 l" allemaal "1000ml" opleveren.
// Geeft null terug als er geen hoeveelheid te vinden is.
function normalizeQuantity(text) {
  if (!text) return null;
  // Compound vloeibaar: "3 x 250 ml", "2 x 1 l" → optellen tot totaal volume
  const compoundMl = text.match(/^(\d+)\s*[x×]\s*([\d,.]+)\s*(ml|cl|l|liter)\b/i);
  if (compoundMl) {
    const count = parseInt(compoundMl[1]);
    let vol = parseFloat(compoundMl[2].replace(',', '.'));
    const u = compoundMl[3].toLowerCase();
    if (u === 'l' || u === 'liter') vol *= 1000;
    else if (u === 'cl') vol *= 10;
    return Math.round(count * vol) + 'ml';
  }
  // Compound stuks × stuks: "3 x 16 cups", "3 x 16 koffiecups" → vermenigvuldigen
  const compoundSt = text.match(/^(\d+)\s*[x×]\s*(\d+)\s*(?:cups?|koffiecups?|capsules?|pods?|pads?|stuks?|st\.?)\b/i);
  if (compoundSt) return Math.round(parseInt(compoundSt[1]) * parseInt(compoundSt[2])) + 'st';
  const compoundTabs = text.match(/^(\d+)\s*[x×]\s*(\d+)\s*(?:tabletten?|tabs?|tablet)\b/i);
  if (compoundTabs) return Math.round(parseInt(compoundTabs[1]) * parseInt(compoundTabs[2])) + 'st';

  // Compound droog/stuks: "16 x 7 g" → stuks tellen (capsules e.d.)
  const compoundG = text.match(/^(\d+)\s*[x×]\s*[\d,.]+\s*(?:g|gr|gram|kg)\b/i)
    || text.match(/^(\d+)\s+cups?\b/i)
    || text.match(/^(\d+)\s+(?:capsules?|pods?|pads?|tabletten?|tabs?|tablet)\b/i);
  if (compoundG) return Math.round(parseInt(compoundG[1])) + 'st';

  const m = text.match(/([\d,.]+)\s*(g|gr|gram|kg|kilo|ml|cl|l|liter|stuks?|st\.?|capsules?|pods?|pads?|tabletten?|tabs?|tablet)\b/i);
  if (!m) return null;
  let val  = parseFloat(m[1].replace(',', '.'));
  const u  = m[2].toLowerCase().replace(/\./, '');
  if      (u === 'kg' || u === 'kilo') { val = Math.round(val * 1000); return val + 'g'; }
  else if (u === 'g'  || u === 'gr' || u === 'gram') { return Math.round(val) + 'g'; }
  else if (u === 'l'  || u === 'liter') { val = Math.round(val * 1000); return val + 'ml'; }
  else if (u === 'cl')  { return Math.round(val * 10) + 'ml'; }
  else if (u === 'ml')  { return Math.round(val) + 'ml'; }
  else if (u.startsWith('st') || u.startsWith('cap') || u.startsWith('pod') || u.startsWith('pad') || u.startsWith('tab') || u.startsWith('tablet')) { return Math.round(val) + 'st'; }
  return null;
}

function getGroupName(rawName) {
  const name = stripStorePrefix(rawName);
  return stripWeightSuffix(name);
}

// Woorden die niet bijdragen aan productidentiteit (verpakkingstype, marketingtermen)
const GROUP_STOPWORDS = new Set([
  'capsules', 'capsule', 'pads', 'pods', 'cups',
  'sterkte', 'intensity', 'intensiteit',
  'original', 'origineel', 'classic', 'klassiek',
  'natural', 'naturel', 'select', 'selection',
  'bodied', 'spicy', 'full', 'rich',
]);

function productGroupKey(groupName) {
  const GROUP_ALIASES = { bio: 'biologisch' };
  return splitKeyTokens(groupName, GROUP_ALIASES)
    .sort()
    .join('');
}

function splitKeyTokens(text, aliases = {}) {
  return String(text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map(w => {
      if (/^\d+%$/.test(w)) return w.replace('%', 'pct');
      if (w.endsWith('+')) return w.replace(/[^a-z0-9]/g, '') + 'plus';
      return w.replace(/[^a-z0-9]/g, '');
    })
    .filter(w => w.length > 1 && !GROUP_STOPWORDS.has(w) && !/^\d+$/.test(w)
               && ![...GROUP_STOPWORDS].some(sw => w.endsWith(sw)))
    .map(w => aliases[w] ?? w)
    .map(w => w.replace(/e$/, ''))
    .filter(Boolean);
}

function productFamilyKey(groupName, queryText) {
  const aliases = { bio: 'biologisch' };
  const nameTokens = splitKeyTokens(groupName, aliases);
  const queryTokens = new Set(splitKeyTokens(queryText, aliases));
  const overlap = [...new Set(nameTokens.filter(t => queryTokens.has(t)))];
  const minOverlap = queryTokens.size <= 2 ? 1 : 2;
  if (overlap.length >= minOverlap) {
    return 'q:' + overlap.sort().join('');
  }
  return 'n:' + nameTokens.sort().join('');
}

// ========================================================
//  COMPARE BY UNIT (⚖)
// ========================================================
const combinedOverrides = new Map();

function calcCombinedLabel(products) {
  const unitTypes = new Set(products.map(p => {
    const ov = combinedOverrides.get(`${p.store.id}:${p.id}`);
    if (ov) return ov.type;
    const qty = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
    if (!qty) return null;
    return qty.endsWith('st') ? 'st' : qty.endsWith('ml') ? 'ml' : 'g';
  }).filter(Boolean));
  return unitTypes.size > 1    ? 'ALLE MATEN'
    : unitTypes.has('ml') ? 'PER 100 ML'
    : unitTypes.has('g')  ? 'PER 100 G'
    : 'PER STUK';
} // "storeId:productId" → { type: 'st'|'g'|'ml', count: number }

function rebuildCombinedCard(el) {
  const card = el.closest('.group-card--combined');
  if (!card || !card._combinedProducts) return;
  const visibleProducts = card._combinedProducts.filter(p => !hiddenItems.has(`${p.store.id}:${p.id}`));
  card.querySelector('.group-rows').innerHTML = buildCombinedRows(visibleProducts);
  card.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
    addSwipeListeners(rowEl, rowEl.dataset.store, rowEl.dataset.product);
  });
  const labelEl = card.querySelector('.card-combined-label');
  if (labelEl) labelEl.textContent = calcCombinedLabel(visibleProducts);
}

function promptMoveSection(storeId, productId, fromType, el) {
  const key = `${storeId}:${productId}`;
  // Als al overridden: terugzetten
  if (combinedOverrides.has(key)) {
    combinedOverrides.delete(key);
    rebuildCombinedCard(el);
    return;
  }
  // Bepaal vraag op basis van richting en aanwezige secties
  let toType = 'st';
  let question = 'Hoeveel stuks zitten er in dit product?';
  if (fromType === 'st') {
    const card = el.closest('.group-card--combined');
    const products = card?._combinedProducts ?? [];
    const hasMl = products.some(p => {
      const q = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
      return q && q.endsWith('ml');
    });
    toType = hasMl ? 'ml' : 'g';
    question = toType === 'ml'
      ? 'Hoeveel ml zit er in totaal in dit product?'
      : 'Hoeveel gram zit er in totaal in dit product?';
  }

  const answer = prompt(question);
  if (!answer) return;
  const n = parseFloat(answer.replace(',', '.'));
  if (!n || n <= 0) return;

  combinedOverrides.set(key, { type: toType, count: n });
  rebuildCombinedCard(el);
}

function buildCombinedRows(products) {
  function getUnitType(p) {
    const ov = combinedOverrides.get(`${p.store.id}:${p.id}`);
    if (ov) return ov.type;
    const qty = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
    if (!qty) return null;
    if (qty.endsWith('st'))  return 'st';
    if (qty.endsWith('ml')) return 'ml';
    return 'g';
  }

  function getUnitPrice(p, type) {
    const ov  = combinedOverrides.get(`${p.store.id}:${p.id}`);
    const qty = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
    if (!p.price) return { value: null, label: '' };

    if (type === 'st') {
      // Ofwel eigen qty (al stuks), ofwel override-count als omrekening van g→st
      const origType = qty?.endsWith('st') ? 'st' : qty?.endsWith('ml') ? 'ml' : 'g';
      let count;
      if (ov && origType !== 'st') {
        // override bevat aantal stuks
        count = ov.count;
      } else {
        count = qty ? parseInt(qty) : null;
      }
      if (!count) return { value: null, label: '' };
      return { value: p.price / count, label: `€\u202f${(p.price / count).toFixed(3).replace('.', ',')}/st` };
    }
    if (type === 'g') {
      let grams;
      if (ov && qty?.endsWith('st')) {
        // override bevat totaal gram in dit product
        grams = ov.count;
      } else {
        grams = qty ? parseInt(qty) : null;
      }
      if (!grams) return { value: null, label: '' };
      return { value: p.price / grams * 100, label: `€\u202f${(p.price / grams * 100).toFixed(2).replace('.', ',')}/100\u202fg` };
    }
    if (type === 'ml') {
      let ml;
      if (ov && qty?.endsWith('st')) {
        // override bevat totaal ml in dit product
        ml = ov.count;
      } else {
        ml = qty ? parseInt(qty) : null;
      }
      if (!ml) return { value: null, label: '' };
      return { value: p.price / ml * 100, label: `€\u202f${(p.price / ml * 100).toFixed(2).replace('.', ',')}/100\u202fml` };
    }
    return { value: null, label: '' };
  }

  function renderSection(sectionProducts, type, label, showMoveBtn) {
    const sorted = [...sectionProducts].sort((a, b) =>
      (getUnitPrice(a, type).value ?? Infinity) - (getUnitPrice(b, type).value ?? Infinity)
    );
    const prices = sorted.map(p => getUnitPrice(p, type).value).filter(v => v !== null);
    const minVal = prices.length ? Math.min(...prices) : null;

    const rows = sorted.map(p => {
      const { value: unitVal, label: unitLabel } = getUnitPrice(p, type);
      const isWinner  = unitVal !== null && minVal !== null && Math.abs(unitVal - minVal) < 0.0001;
      const pctMore   = (!isWinner && unitVal !== null && minVal !== null && minVal > 0)
        ? Math.round((unitVal - minVal) / minVal * 100) : null;
      const qty       = extractCompoundQty(p.name) || normalizeQuantity(p.unit) || normalizeQuantity(p.name);
      const u         = qty ? formatQuantity(qty) : p.unit;
      const listQty   = getListQty(p.store.id, p.id);
      const ov        = combinedOverrides.get(`${p.store.id}:${p.id}`);
      const isOv      = ov != null;
      const ovLabel   = isOv ? (ov.type === 'st' ? `${ov.count} stuks` : (ov.type === 'ml' ? `${ov.count} ml totaal` : `${ov.count} g totaal`)) : null;
      const moveTitle = isOv ? 'Terugzetten naar originele sectie' : (type === 'st' ? 'Verplaats naar andere eenheid' : 'Verplaats naar per stuk');

      return `
        <div class="row-wrapper">
          <div class="delete-bg"><span>Verwijderen</span></div>
          <div class="group-row${isWinner ? ' group-row--winner' : ''}"
               data-store="${p.store.id}" data-product="${esc(p.id)}">
            <div class="group-row-img">
              ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onpointerdown="event.stopPropagation()" onclick="openImageZoom(event,'${esc(p.image)}')" onerror="this.style.display='none'">` : ''}
              ${isWinner ? '<div class="winner-badge">✓</div>' : ''}
            </div>
            <div class="group-row-info">
              <div class="badges-row">
                <span class="store-badge" style="background:${p.store.color}">${esc(p.store.name)}</span>
                ${p.bonusLabel ? `<span class="bonus-badge">${esc(p.bonusLabel)}</span>` : ''}
              </div>
              <div class="group-row-name" style="cursor:pointer" onclick="searchByName('${esc(stripWeightSuffix(p.name))}')">${esc(stripWeightSuffix(p.name))}</div>
              ${u ? `<div class="group-row-weight">${esc(u)}${ovLabel ? ` <span class="group-row-weight-ov">(${esc(ovLabel)})</span>` : ''}</div>` : ''}
            </div>
            <div class="group-row-pricing">
              <div class="group-row-price">
                ${p.priceOriginal != null ? `<span class="price-original">€\u202f${p.priceOriginal.toFixed(2).replace('.', ',')}</span>` : ''}
                ${p.price !== null ? '€\u202f' + p.price.toFixed(2).replace('.', ',') : '–'}
              </div>
              <div class="group-row-pkg${isWinner ? ' group-row-pkg--winner' : ''}">
                ${unitLabel}
                ${pctMore !== null ? `<span class="pct-more">+${pctMore}%</span>` : ''}
              </div>
            </div>
            <div class="row-actions">
              ${(showMoveBtn || isOv) ? `<button class="move-section-btn${isOv ? ' move-section-btn--active' : ''}"
                      title="${moveTitle}"
                      onclick="promptMoveSection('${p.store.id}','${esc(p.id)}','${type}',this)">
                ${isOv ? '↩' : '↕'}
              </button>` : ''}
              ${listQty > 0 ? `
                <div class="qty-control">
                  <button onclick="removeFromList('${p.store.id}', '${esc(p.id)}')">−</button>
                  <span class="qty-value">${listQty}</span>
                  <button onclick="addToList('${p.store.id}', '${esc(p.id)}')">+</button>
                </div>
              ` : `
                <button class="add-btn" title="Voeg toe aan lijst"
                        onclick="addToList('${p.store.id}', '${esc(p.id)}')">+</button>
              `}
              <button class="dismiss-btn" title="Verwijder uit resultaten"
                      onclick="dismissItem(this, '${p.store.id}', '${esc(p.id)}')">✕</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return (label ? `<div class="combined-section-label">${label}</div>` : '') + rows;
  }

  const byType = { st: [], g: [], ml: [] };
  products.forEach(p => {
    const t = getUnitType(p);
    if (t) byType[t].push(p);
  });

  const multiSection = [byType.st, byType.g, byType.ml].filter(a => a.length).length > 1;
  const sections = [];
  if (byType.st.length)  sections.push(renderSection(byType.st,  'st',  multiSection ? 'Per stuk'   : '', multiSection));
  if (byType.g.length)   sections.push(renderSection(byType.g,   'g',   multiSection ? 'Per 100 g'  : '', multiSection));
  if (byType.ml.length)  sections.push(renderSection(byType.ml,  'ml',  multiSection ? 'Per 100 ml' : '', multiSection));

  return sections.join('<div class="combined-section-divider"></div>');
}

function compareByUnit(btn) {
  const sourceCard = btn.closest('.group-card');
  const sourceGroup = cardGroupMap.get(sourceCard);
  if (!sourceGroup) return;
  const targetFamilyKey = sourceGroup.yFamilyKey;

  // Find all visible cards in this family
  const relatedCards = [];
  document.querySelectorAll('#searchResults .group-card:not(.group-card--combined)').forEach(card => {
    const group = cardGroupMap.get(card);
    if (group && group.yFamilyKey === targetFamilyKey) relatedCards.push(card);
  });
  if (!relatedCards.length) return;

  // Collect all non-hidden products from matching groups
  const allProducts = [];
  allGroups.filter(g => g.yFamilyKey === targetFamilyKey).forEach(g => {
    g.products.forEach(p => {
      if (!hiddenItems.has(`${p.store.id}:${p.id}`)) allProducts.push(p);
    });
  });

  const combinedLabel = calcCombinedLabel(allProducts);

  // Verberg ALLE kaarten (ook niet-familie), sla de familie-baseKey op voor herstel
  const allCards = [...document.querySelectorAll('#searchResults .group-card:not(.group-card--combined)')];
  allCards.forEach(card => card.classList.add('group-card--hidden'));

  // Build combined card and insert at top of results
  const el = document.getElementById('searchResults');
  const combinedCard = document.createElement('div');
  combinedCard.className = 'group-card group-card--combined';
  combinedCard.dataset.familyKey = targetFamilyKey;
  combinedCard.innerHTML = `
    <div class="group-card-header">
      <div class="card-title"><span class="card-qty-label">${esc(sourceGroup.displayName.toUpperCase())}</span><span class="card-combined-label">${combinedLabel}</span></div>
      <div class="card-header-actions">
        <button class="card-back-btn" onclick="restoreFromCombined(this)" title="Terug naar losse kaarten">↩</button>
        <button class="card-close-btn" onclick="dismissGroup(this)" title="Verberg groep">✕</button>
      </div>
    </div>
    <div class="group-rows">${buildCombinedRows(allProducts)}</div>`;

  combinedCard._combinedProducts = allProducts;

  combinedCard.querySelectorAll('.group-row[data-store]').forEach(rowEl => {
    addSwipeListeners(rowEl, rowEl.dataset.store, rowEl.dataset.product);
  });

  el.insertBefore(combinedCard, el.firstChild);
}

function restoreFromCombined(btn) {
  const combinedCard = btn.closest('.group-card--combined');
  if (!combinedCard) return;
  const familyKey = combinedCard.dataset.familyKey;

  // Herstel alleen de familie-kaarten, laat de rest verborgen
  document.querySelectorAll('#searchResults .group-card--hidden').forEach(card => {
    const group = cardGroupMap.get(card);
    if (group && group.yFamilyKey === familyKey) {
      card.classList.remove('group-card--hidden');
    }
  });
  combinedCard.remove();
}

// ========================================================
//  RETRY HELPER
// ========================================================
function searchByName(name) {
  // Beperk tot 4 woorden zodat Jumbo's zoekmachine niet de mist ingaat
  const trimmed = name.split(/\s+/).slice(0, 4).join(' ');
  document.getElementById('searchInput').value = trimmed;
  triggerSearch();
}

async function retryDetect() {
  useLocalServer = false;
  const input = document.getElementById('searchInput').value.trim();
  if (input) triggerSearch();
  else showToast('Server gevonden! Typ een zoekterm om te beginnen.');
}

// ========================================================
//  INIT
// ========================================================
loadState();
updateBadge();
renderStoreManager();
// Pre-check server in background so first search is faster
detectServer();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeImageZoom();
});

try {
  if (localStorage.getItem(BETA_BANNER_KEY) === '1') {
    const banner = document.getElementById('betaBanner');
    if (banner) banner.style.display = 'none';
  }
} catch (_) {}
