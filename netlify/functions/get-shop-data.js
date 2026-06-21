/* ウェブへの公開で発行される e/ 形式のURL（認証不要） */
const PUBLISHED_EID = '2PACX-1vRyF-8O07kNwpvuLkv7FdK9XC3aUZSeKLSqrwMy-KxRCIfabKEVmRgUpJW6j3rfFNfVs8wk1m7xrQVH';
const SHEET_GIDS = { '商品': 0, '送料': 858027081, '設定': 34377454 };

function csvUrl(sheet) {
  return `https://docs.google.com/spreadsheets/d/e/${PUBLISHED_EID}/pub?output=csv&gid=${SHEET_GIDS[sheet] ?? 0}`;
}

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

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

exports.handler = async () => {
  try {
    const fetchOpts = {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NetlifyBot/1.0)' },
      signal: AbortSignal.timeout(10000),
    };
    const [r1, r2, r3] = await Promise.all([
      fetch(csvUrl('商品'), fetchOpts),
      fetch(csvUrl('設定'), fetchOpts),
      fetch(csvUrl('送料'), fetchOpts),
    ]);

    if (!r1.ok) throw new Error(`商品シート取得失敗: HTTP ${r1.status}`);

    const products = parseCSV(await r1.text())
      .filter(r => r.name && r.price && r.active?.toUpperCase() !== 'FALSE');

    const settings = {};
    if (r2.ok) {
      for (const row of parseCSV(await r2.text())) {
        if (row.key) settings[row.key] = row.value;
      }
    }

    const shippingRates = {};
    if (r3.ok) {
      for (const row of parseCSV(await r3.text())) {
        const fee = parseInt(row.fee);
        if (!fee) continue;
        row.prefectures?.split(',').forEach(p => { shippingRates[p.trim()] = fee; });
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ products, settings, shippingRates }),
    };
  } catch (err) {
    console.error('[get-shop-data]', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
