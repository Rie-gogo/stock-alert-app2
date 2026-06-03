import 'dotenv/config';

const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;

async function call(query) {
  const baseUrl = forgeApiUrl.endsWith('/') ? forgeApiUrl : forgeApiUrl + '/';
  const fullUrl = new URL('webdevtoken.v1.WebDevService/CallApi', baseUrl).toString();
  const resp = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      authorization: `Bearer ${forgeApiKey}`,
    },
    body: JSON.stringify({ apiId: 'YahooFinance/get_stock_chart', query }),
  });
  const payload = await resp.json().catch(() => ({}));
  let data = payload;
  if (payload && typeof payload === 'object' && 'jsonData' in payload) {
    try { data = JSON.parse(payload.jsonData ?? '{}'); } catch { data = payload.jsonData; }
  }
  return data;
}

const fmt = (ts) => new Date(ts * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const data = await call({ symbol: '9984.T', region: 'JP', interval: '1m', range: '1d' });
const res = data?.chart?.result?.[0];
const meta = res?.meta ?? {};
console.log('now JST       :', new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
console.log('regularMarketTime:', meta.regularMarketTime, meta.regularMarketTime ? fmt(meta.regularMarketTime) : '');
console.log('regularMarketPrice:', meta.regularMarketPrice);
const ts = res?.timestamp ?? [];
console.log('total timestamps:', ts.length);
console.log('last 5 timestamps:');
for (const t of ts.slice(-5)) console.log('  ', t, fmt(t));
const closes = res?.indicators?.quote?.[0]?.close ?? [];
console.log('last 5 closes:', closes.slice(-5));
