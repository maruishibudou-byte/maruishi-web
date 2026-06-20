const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/*
 * 価格マスタ（フォールバック用）
 * SHEETS_PRODUCTS_URL が未設定の場合のみ使用。
 * スプレッドシート設定後はここを変更しなくてよい。
 */
const PRICE_MASTER_FALLBACK = {
  'シャインマスカット':       3800,
  'キタサキレッド':           3500,
  '巨峰':                    2800,
  'ナガノパープル':           3800,
  '旬のぶどう 2房セット':     6800,
  'ギフトボックス 3房セット': 9800,
};

/* 価格キャッシュ（5分） */
let _priceCache = null;
let _priceCacheTime = 0;

/* Google Sheets CSV パーサー */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCells(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCells(lines[i]);
    if (cells.every(c => !c.trim())) continue;
    rows.push(Object.fromEntries(headers.map((h, j) => [h, (cells[j] || '').trim()])));
  }
  return rows;
}

function splitCells(line) {
  const cells = []; let cell = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/* 価格マスタ取得（Sheets 優先、失敗時はフォールバック） */
async function getPriceMaster() {
  const url = process.env.SHEETS_PRODUCTS_URL;
  if (!url) return PRICE_MASTER_FALLBACK;

  const now = Date.now();
  if (_priceCache && now - _priceCacheTime < 300_000) return _priceCache;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseCSV(await res.text())
      .filter(r => r.name && r.price && r.active?.toUpperCase() !== 'FALSE');

    const prices = {};
    for (const r of rows) prices[r.name] = parseInt(r.price, 10);

    _priceCache = prices;
    _priceCacheTime = now;
    console.log('[Sheets] 価格取得成功:', Object.keys(prices).length, '件');
    return prices;
  } catch (err) {
    console.warn('[Sheets] 価格取得失敗、フォールバック使用:', err.message);
    return _priceCache || PRICE_MASTER_FALLBACK;
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { items, shipping } = JSON.parse(event.body);

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('カートが空です');
    }

    /* スプレッドシートから最新価格を取得 */
    const PRICE_MASTER = await getPriceMaster();

    let amount = 0;
    const lineItems = [];

    for (const item of items) {
      const serverPrice = PRICE_MASTER[item.name];
      if (!serverPrice) throw new Error(`商品が見つかりません: ${item.name}`);

      const qty = parseInt(item.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        throw new Error(`数量が不正です: ${item.name}`);
      }

      amount += serverPrice * qty;
      lineItems.push(`${item.name} × ${qty}`);
    }

    /* JPY は最小通貨単位が 1円 */
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'jpy',
      automatic_payment_methods: { enabled: true },
      metadata: {
        items:         lineItems.join(', '),
        total:         `¥${amount.toLocaleString('ja-JP')}`,
        store:         'まるいし葡萄園',
        ship_name:     shipping?.name  || '',
        ship_zip:      shipping?.zip   || '',
        ship_addr:     `${shipping?.pref || ''}${shipping?.addr1 || ''}${shipping?.addr2 ? ' ' + shipping.addr2 : ''}`,
        ship_tel:      shipping?.tel   || '',
        delivery_date: shipping?.date  || '未指定',
      },
      statement_descriptor_suffix: 'MARUISHI',
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ clientSecret: paymentIntent.client_secret }),
    };

  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
