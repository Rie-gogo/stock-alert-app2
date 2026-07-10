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

// Get all exit trades with PnL from the last 30 days
const [trades] = await conn.query(`
  SELECT symbol, symbolName, action, pnl
  FROM rt_trades
  WHERE action IN ('sell', 'cover')
    AND pnl IS NOT NULL
    AND createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  ORDER BY symbol
`);

const buyExits = trades.filter(t => t.action === "sell");
const shortExits = trades.filter(t => t.action === "cover");

function groupBySymbol(arr) {
  const map = {};
  for (const t of arr) {
    const key = `${t.symbol} (${t.symbolName})`;
    if (!map[key]) map[key] = { pnl: 0, count: 0, wins: 0 };
    map[key].pnl += t.pnl;
    map[key].count++;
    if (t.pnl > 0) map[key].wins++;
  }
  return Object.entries(map).sort((a, b) => b[1].pnl - a[1].pnl);
}

console.log("=== 銘柄別損益（買い BUY→SELL）===");
const buyBySymbol = groupBySymbol(buyExits);
let buyTotal = 0;
for (const [sym, info] of buyBySymbol) {
  buyTotal += info.pnl;
  console.log(`  ${sym}: ${info.pnl >= 0 ? '+' : ''}${info.pnl.toLocaleString()}円 (${info.count}件, 勝率${(info.wins/info.count*100).toFixed(0)}%)`);
}
console.log(`  合計: ${buyTotal >= 0 ? '+' : ''}${buyTotal.toLocaleString()}円`);

console.log("\n=== 銘柄別損益（売り SHORT→COVER）===");
const shortBySymbol = groupBySymbol(shortExits);
let shortTotal = 0;
for (const [sym, info] of shortBySymbol) {
  shortTotal += info.pnl;
  console.log(`  ${sym}: ${info.pnl >= 0 ? '+' : ''}${info.pnl.toLocaleString()}円 (${info.count}件, 勝率${(info.wins/info.count*100).toFixed(0)}%)`);
}
console.log(`  合計: ${shortTotal >= 0 ? '+' : ''}${shortTotal.toLocaleString()}円`);

console.log("\n=== 銘柄別損益（合計 BUY+SHORT）===");
const allBySymbol = {};
for (const t of trades) {
  const key = `${t.symbol} (${t.symbolName})`;
  if (!allBySymbol[key]) allBySymbol[key] = { pnl: 0, count: 0, wins: 0, buyPnl: 0, buyCount: 0, shortPnl: 0, shortCount: 0 };
  allBySymbol[key].pnl += t.pnl;
  allBySymbol[key].count++;
  if (t.pnl > 0) allBySymbol[key].wins++;
  if (t.action === "sell") { allBySymbol[key].buyPnl += t.pnl; allBySymbol[key].buyCount++; }
  else { allBySymbol[key].shortPnl += t.pnl; allBySymbol[key].shortCount++; }
}
const allSorted = Object.entries(allBySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
console.log(`  ${"銘柄".padEnd(30)} ${"合計損益".padStart(12)} ${"件数".padStart(5)} ${"勝率".padStart(5)} | ${"買い損益".padStart(12)} ${"件".padStart(3)} | ${"売り損益".padStart(12)} ${"件".padStart(3)}`);
console.log("  " + "-".repeat(100));
for (const [sym, info] of allSorted) {
  const wr = (info.wins/info.count*100).toFixed(0) + "%";
  const buyStr = info.buyCount > 0 ? `${info.buyPnl >= 0 ? '+' : ''}${info.buyPnl.toLocaleString()}円` : "-";
  const shortStr = info.shortCount > 0 ? `${info.shortPnl >= 0 ? '+' : ''}${info.shortPnl.toLocaleString()}円` : "-";
  console.log(`  ${sym.padEnd(30)} ${(info.pnl >= 0 ? '+' : '') + info.pnl.toLocaleString() + '円'} (${info.count}件, ${wr}) | 買:${buyStr} (${info.buyCount}) | 売:${shortStr} (${info.shortCount})`);
}

await conn.end();
