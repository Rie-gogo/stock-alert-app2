import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: true },
});

// Get the last 5 distinct trade dates
const [dates] = await conn.query(`
  SELECT DISTINCT DATE_FORMAT(createdAt, '%Y-%m-%d') as d
  FROM rt_trades
  WHERE action IN ('sell', 'cover') AND pnl IS NOT NULL
  ORDER BY d DESC
  LIMIT 5
`);
const dateList = dates.map(r => r.d);
console.log(`=== 対象期間: ${dateList[dateList.length-1]} 〜 ${dateList[0]}（${dateList.length}営業日）===\n`);

const startDate = dateList[dateList.length - 1];

// Get all exit trades in that period
const [trades] = await conn.query(`
  SELECT symbol, symbolName, action, pnl, DATE_FORMAT(createdAt, '%Y-%m-%d') as tradeDate
  FROM rt_trades
  WHERE action IN ('sell', 'cover')
    AND pnl IS NOT NULL
    AND DATE_FORMAT(createdAt, '%Y-%m-%d') >= ?
  ORDER BY symbol
`, [startDate]);

const buyExits = trades.filter(t => t.action === "sell");
const shortExits = trades.filter(t => t.action === "cover");

// Overall BUY vs SHORT
function summarize(label, arr) {
  if (arr.length === 0) { console.log(`${label}: 取引なし`); return; }
  const wins = arr.filter(t => t.pnl > 0);
  const totalPnl = arr.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const losses = arr.filter(t => t.pnl <= 0);
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  console.log(`${label}: ${arr.length}件, 勝率${(wins.length/arr.length*100).toFixed(1)}% (${wins.length}勝${losses.length}敗), 損益${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円, 平均利益+${Math.round(avgWin).toLocaleString()}円, 平均損失${Math.round(avgLoss).toLocaleString()}円`);
}

summarize("買い（BUY）全体", buyExits);
summarize("売り（SHORT）全体", shortExits);

// Symbol breakdown - combined
console.log("\n=== 銘柄別損益（合計）===");
const allBySymbol = {};
for (const t of trades) {
  const key = `${t.symbol} (${t.symbolName})`;
  if (!allBySymbol[key]) allBySymbol[key] = { pnl: 0, count: 0, wins: 0, buyPnl: 0, buyCount: 0, buyWins: 0, shortPnl: 0, shortCount: 0, shortWins: 0 };
  allBySymbol[key].pnl += t.pnl;
  allBySymbol[key].count++;
  if (t.pnl > 0) allBySymbol[key].wins++;
  if (t.action === "sell") { allBySymbol[key].buyPnl += t.pnl; allBySymbol[key].buyCount++; if (t.pnl > 0) allBySymbol[key].buyWins++; }
  else { allBySymbol[key].shortPnl += t.pnl; allBySymbol[key].shortCount++; if (t.pnl > 0) allBySymbol[key].shortWins++; }
}
const allSorted = Object.entries(allBySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, info] of allSorted) {
  const wr = (info.wins/info.count*100).toFixed(0);
  const buyStr = info.buyCount > 0 ? `買:${info.buyPnl >= 0 ? '+' : ''}${info.buyPnl.toLocaleString()}円(${info.buyCount}件,${(info.buyWins/info.buyCount*100).toFixed(0)}%)` : "買:なし";
  const shortStr = info.shortCount > 0 ? `売:${info.shortPnl >= 0 ? '+' : ''}${info.shortPnl.toLocaleString()}円(${info.shortCount}件,${(info.shortWins/info.shortCount*100).toFixed(0)}%)` : "売:なし";
  console.log(`  ${sym}: 合計${info.pnl >= 0 ? '+' : ''}${info.pnl.toLocaleString()}円 (${info.count}件, 勝率${wr}%) | ${buyStr} | ${shortStr}`);
}

// Daily breakdown
console.log("\n=== 日別損益 ===");
for (const d of dateList.sort()) {
  const dayTrades = trades.filter(t => t.tradeDate === d);
  const dayBuy = dayTrades.filter(t => t.action === "sell");
  const dayShort = dayTrades.filter(t => t.action === "cover");
  const buyPnl = dayBuy.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = dayShort.reduce((s, t) => s + t.pnl, 0);
  const totalPnl = buyPnl + shortPnl;
  console.log(`  ${d}: 合計${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円 | 買:${buyPnl >= 0 ? '+' : ''}${buyPnl.toLocaleString()}円(${dayBuy.length}件) | 売:${shortPnl >= 0 ? '+' : ''}${shortPnl.toLocaleString()}円(${dayShort.length}件)`);
}

await conn.end();
