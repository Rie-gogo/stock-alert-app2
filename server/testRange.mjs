import "dotenv/config";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

async function callDataApi(apiId, options) {
  const baseUrl = FORGE_URL.endsWith("/") ? FORGE_URL : `${FORGE_URL}/`;
  const fullUrl = new URL("webdevtoken.v1.WebDevService/CallApi", baseUrl).toString();
  const resp = await fetch(fullUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({ apiId, ...options }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

// 複数のinterval/rangeの組み合わせをテスト
const tests = [
  { interval: "5m", range: "1mo" },
  { interval: "5m", range: "2mo" },
  { interval: "5m", range: "3mo" },
  { interval: "2m", range: "1mo" },
  { interval: "1m", range: "7d" },
];

for (const t of tests) {
  try {
    const raw = await callDataApi("YahooFinance/get_stock_chart", {
      query: { symbol: "9984.T", region: "JP", interval: t.interval, range: t.range },
    });
    const data = raw.jsonData ? JSON.parse(raw.jsonData) : (raw.data ?? raw);
    const result = data?.chart?.result?.[0];
    if (!result) { console.log(`${t.interval}/${t.range}: NO RESULT`); continue; }
    const ts = result.timestamp ?? [];
    // ユニークな日付を数える
    const days = new Set(ts.map(x => new Date(x*1000).toISOString().slice(0,10)));
    console.log(`${t.interval}/${t.range}: ${ts.length} bars, ${days.size} unique days`);
  } catch (e) {
    console.log(`${t.interval}/${t.range}: ERROR ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 400));
}
