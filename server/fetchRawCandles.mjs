import "dotenv/config";
import fs from "fs";

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const STOCKS = [
  { symbol: "6526", ticker: "6526.T", name: "ソシオネクスト" },
  { symbol: "6920", ticker: "6920.T", name: "レーザーテック" },
  { symbol: "6857", ticker: "6857.T", name: "アドバンテスト" },
  { symbol: "9107", ticker: "9107.T", name: "川崎汽船" },
  { symbol: "8306", ticker: "8306.T", name: "三菱UFJ FG" },
  { symbol: "9984", ticker: "9984.T", name: "ソフトバンクグループ" },
  { symbol: "8035", ticker: "8035.T", name: "東京エレクトロン" },
  { symbol: "7011", ticker: "7011.T", name: "三菱重工業" },
  { symbol: "4568", ticker: "4568.T", name: "第一三共" },
  { symbol: "3778", ticker: "3778.T", name: "さくらインターネット" },
];

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
  const json = await resp.json();
  return json;
}

const out = {};
for (const stock of STOCKS) {
  try {
    const raw = await callDataApi("YahooFinance/get_stock_chart", {
      query: { symbol: stock.ticker, region: "JP", interval: "1m", range: "1d" },
    });
    // raw may be wrapped; find chart
    const data = raw.jsonData ? JSON.parse(raw.jsonData) : (raw.data ?? raw);
    const result = data?.chart?.result?.[0];
    if (!result) {
      console.log(`${stock.symbol}: no result`);
      out[stock.symbol] = null;
      continue;
    }
    const ts = result.timestamp ?? [];
    const q = result.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.close[i] == null) continue;
      const d = new Date(ts[i] * 1000);
      const jstHour = (d.getUTCHours() + 9) % 24;
      const time = `${String(jstHour).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      candles.push({
        time, timestamp: ts[i] * 1000,
        open: q.open[i], high: q.high[i] ?? q.open[i], low: q.low[i] ?? q.open[i],
        close: q.close[i], volume: q.volume[i] ?? 0,
      });
    }
    out[stock.symbol] = { name: stock.name, candles };
    console.log(`${stock.symbol} ${stock.name}: ${candles.length} candles`);
  } catch (e) {
    console.log(`${stock.symbol}: ERROR ${e.message}`);
    out[stock.symbol] = null;
  }
  await new Promise((r) => setTimeout(r, 400));
}

fs.writeFileSync("/home/ubuntu/raw_candles.json", JSON.stringify(out, null, 2));
console.log("Saved raw candles");
