const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/*
 * 価格マスタ（サーバー側で検証）
 * クライアントから送られてくる価格は一切信用しない。
 * 商品を追加・変更したらここも必ず更新する。
 */
const PRICE_MASTER = {
  'シャインマスカット':       3800,
  'キタサキレッド':           3500,
  '巨峰':                    2800,
  'ナガノパープル':           3800,
  '旬のぶどう 2房セット':     6800,
  'ギフトボックス 3房セット': 9800,
};

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  /* OPTIONS プリフライト */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { items } = JSON.parse(event.body);

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('カートが空です');
    }

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

    /* JPY は最小通貨単位が 1円（センなし）→ amount をそのまま渡す */
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'jpy',
      automatic_payment_methods: { enabled: true },
      metadata: {
        items:  lineItems.join(', '),
        total:  `¥${amount.toLocaleString('ja-JP')}`,
        store:  'まるいし葡萄園',
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
