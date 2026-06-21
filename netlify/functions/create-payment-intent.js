const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/* 都道府県別送料（スプレッドシートの「送料」シートと同内容） */
const SHIPPING_RATES = {
  '北海道': 1800,
  '青森': 1400, '岩手': 1400, '宮城': 1400, '秋田': 1400, '山形': 1400, '福島': 1400,
  '茨城': 1200, '栃木': 1200, '群馬': 1200, '埼玉': 1200, '千葉': 1200, '東京': 1200, '神奈川': 1200, '山梨': 1200,
  '新潟': 1200, '長野': 1200,
  '富山': 1100, '石川': 1100, '福井': 1100,
  '岐阜': 1100, '静岡': 1100, '愛知': 1100, '三重': 1100,
  '滋賀': 1200, '京都': 1200, '大阪': 1200, '兵庫': 1200, '奈良': 1200, '和歌山': 1200,
  '鳥取': 1300, '島根': 1300, '岡山': 1300, '広島': 1300, '山口': 1300,
  '徳島': 1300, '香川': 1300, '愛媛': 1300, '高知': 1300,
  '福岡': 1500, '佐賀': 1500, '長崎': 1500, '熊本': 1500, '大分': 1500, '宮崎': 1500, '鹿児島': 1500,
  '沖縄': 2200,
};
const FREE_SHIPPING_MIN = 10000;

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

    let subtotal = 0;
    const lineItems = [];

    for (const item of items) {
      const serverPrice = PRICE_MASTER[item.name];
      if (!serverPrice) throw new Error(`商品が見つかりません: ${item.name}`);

      const qty = parseInt(item.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        throw new Error(`数量が不正です: ${item.name}`);
      }

      subtotal += serverPrice * qty;
      lineItems.push(`${item.name} × ${qty}`);
    }

    /* 送料計算（都道府県別・FREE_SHIPPING_MIN 以上は無料） */
    const prefRaw  = shipping?.pref || '';
    const prefKey  = prefRaw.replace(/[県都府]$/, ''); // "青森県"→"青森" / "東京都"→"東京"
    const shippingFee = (subtotal >= FREE_SHIPPING_MIN || !prefKey)
      ? 0
      : (SHIPPING_RATES[prefKey] ?? 0);
    const amount = subtotal + shippingFee;

    /* JPY は最小通貨単位が 1円 */
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'jpy',
      automatic_payment_methods: { enabled: true },
      metadata: {
        items:         lineItems.join(', '),
        subtotal:      `¥${subtotal.toLocaleString('ja-JP')}`,
        shipping_fee:  shippingFee === 0 ? '無料' : `¥${shippingFee.toLocaleString('ja-JP')}`,
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
