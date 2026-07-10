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

// Get all exit trades (with PnL) from the last 20 trading days
const [trades] = await conn.query(`
  SELECT t.*, 
    DATE_FORMAT(t.createdAt, '%Y-%m-%d') as tradeDate,
    DATE_FORMAT(t.createdAt, '%H:%i') as tradeTime
  FROM rt_trades t
  WHERE t.action IN ('sell', 'cover')
    AND t.pnl IS NOT NULL
    AND t.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  ORDER BY t.createdAt ASC
`);

// Separate BUY exits (sell) vs SHORT exits (cover)
const buyExits = trades.filter(t => t.action === "sell");   // BUY→SELL = long position closed
const shortExits = trades.filter(t => t.action === "cover"); // SHORT→COVER = short position closed

function summarize(label, arr) {
  if (arr.length === 0) return console.log(`${label}: 取引なし`);
  const wins = arr.filter(t => t.pnl > 0);
  const losses = arr.filter(t => t.pnl <= 0);
  const totalPnl = arr.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = totalPnl / arr.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const maxWin = Math.max(...arr.map(t => t.pnl));
  const maxLoss = Math.min(...arr.map(t => t.pnl));
  
  console.log(`\n=== ${label} ===`);
  console.log(`  取引数: ${arr.length}件`);
  console.log(`  勝率: ${(wins.length / arr.length * 100).toFixed(1)}% (${wins.length}勝${losses.length}敗)`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  平均損益: ${avgPnl >= 0 ? '+' : ''}${Math.round(avgPnl).toLocaleString()}円`);
  console.log(`  平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  console.log(`  平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  console.log(`  最大利益: +${maxWin.toLocaleString()}円`);
  console.log(`  最大損失: ${maxLoss.toLocaleString()}円`);
  console.log(`  プロフィットファクター: ${losses.length > 0 ? (wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2) : '∞'}`);
}

summarize("買い（BUY→SELL）", buyExits);
summarize("売り（SHORT→COVER）", shortExits);

// By signal type (reason) for BUY only
console.log("\n\n=== 買いシグナル別成績 ===");

// Get entry trades to match with exits
const [entryTrades] = await conn.query(`
  SELECT t.*,
    DATE_FORMAT(t.createdAt, '%Y-%m-%d') as tradeDate,
    DATE_FORMAT(t.createdAt, '%H:%i') as tradeTime
  FROM rt_trades t
  WHERE t.action IN ('buy', 'short')
    AND t.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  ORDER BY t.createdAt ASC
`);

// Match entries to exits by symbol and date
const buyEntries = entryTrades.filter(t => t.action === "buy");
const shortEntries = entryTrades.filter(t => t.action === "short");

// For each buy exit, find the corresponding entry to get the signal reason
const buyPairs = [];
for (const exit of buyExits) {
  const exitDate = exit.tradeDate;
  const matchingEntry = buyEntries.find(e => 
    e.symbol === exit.symbol && e.tradeDate === exitDate
  );
  if (matchingEntry) {
    buyPairs.push({ entry: matchingEntry, exit, pnl: exit.pnl });
  }
}

// Group by signal pattern
const signalGroups = {};
for (const pair of buyPairs) {
  const reason = pair.entry.reason || "不明";
  // Extract main signal type
  let signalType = "その他";
  if (reason.includes("大台確認")) signalType = "大台確認(BUY)";
  else if (reason.includes("逆三尊") || reason.includes("インバースH&S")) signalType = "逆三尊(BUY)";
  else if (reason.includes("ダブルボトム")) signalType = "ダブルボトム(BUY)";
  else if (reason.includes("三尊")) signalType = "三尊(BUY)";
  else if (reason.includes("VWAP")) signalType = "VWAP(BUY)";
  
  if (!signalGroups[signalType]) signalGroups[signalType] = [];
  signalGroups[signalType].push(pair);
}

for (const [signal, pairs] of Object.entries(signalGroups).sort((a,b) => b[1].length - a[1].length)) {
  const wins = pairs.filter(p => p.pnl > 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log(`  ${signal}: ${pairs.length}件, 勝率${(wins.length/pairs.length*100).toFixed(0)}%, 損益${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
}

// Same for SHORT
console.log("\n=== 売りシグナル別成績 ===");
const shortPairs = [];
for (const exit of shortExits) {
  const exitDate = exit.tradeDate;
  const matchingEntry = shortEntries.find(e => 
    e.symbol === exit.symbol && e.tradeDate === exitDate
  );
  if (matchingEntry) {
    shortPairs.push({ entry: matchingEntry, exit, pnl: exit.pnl });
  }
}

const shortSignalGroups = {};
for (const pair of shortPairs) {
  const reason = pair.entry.reason || "不明";
  let signalType = "その他";
  if (reason.includes("大台確認")) signalType = "大台確認(SHORT)";
  else if (reason.includes("三尊") && !reason.includes("逆三尊")) signalType = "三尊(SHORT)";
  else if (reason.includes("ダブルトップ")) signalType = "ダブルトップ(SHORT)";
  else if (reason.includes("VWAP")) signalType = "VWAP(SHORT)";
  
  if (!shortSignalGroups[signalType]) shortSignalGroups[signalType] = [];
  shortSignalGroups[signalType].push(pair);
}

for (const [signal, pairs] of Object.entries(shortSignalGroups).sort((a,b) => b[1].length - a[1].length)) {
  const wins = pairs.filter(p => p.pnl > 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log(`  ${signal}: ${pairs.length}件, 勝率${(wins.length/pairs.length*100).toFixed(0)}%, 損益${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
}

// Time-of-day analysis for BUY
console.log("\n\n=== 買い: 時間帯別成績 ===");
const buyByHour = {};
for (const pair of buyPairs) {
  const hour = pair.entry.tradeTime.split(":")[0];
  if (!buyByHour[hour]) buyByHour[hour] = [];
  buyByHour[hour].push(pair);
}
for (const [hour, pairs] of Object.entries(buyByHour).sort()) {
  const wins = pairs.filter(p => p.pnl > 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log(`  ${hour}時台: ${pairs.length}件, 勝率${(wins.length/pairs.length*100).toFixed(0)}%, 損益${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
}

// Holding time analysis
console.log("\n\n=== 買い: 保有時間別成績 ===");
const holdingBuckets = { "5分以内": [], "5-15分": [], "15-30分": [], "30-60分": [], "60分超": [] };
for (const pair of buyPairs) {
  const entryTime = new Date(pair.entry.createdAt);
  const exitTime = new Date(pair.exit.createdAt);
  const holdMin = (exitTime - entryTime) / 60000;
  if (holdMin <= 5) holdingBuckets["5分以内"].push(pair);
  else if (holdMin <= 15) holdingBuckets["5-15分"].push(pair);
  else if (holdMin <= 30) holdingBuckets["15-30分"].push(pair);
  else if (holdMin <= 60) holdingBuckets["30-60分"].push(pair);
  else holdingBuckets["60分超"].push(pair);
}
for (const [bucket, pairs] of Object.entries(holdingBuckets)) {
  if (pairs.length === 0) continue;
  const wins = pairs.filter(p => p.pnl > 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log(`  ${bucket}: ${pairs.length}件, 勝率${(wins.length/pairs.length*100).toFixed(0)}%, 損益${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
}

// Daily BUY performance
console.log("\n\n=== 買い: 日別損益推移 ===");
const buyByDate = {};
for (const pair of buyPairs) {
  const d = pair.exit.tradeDate;
  if (!buyByDate[d]) buyByDate[d] = { pnl: 0, count: 0, wins: 0 };
  buyByDate[d].pnl += pair.pnl;
  buyByDate[d].count++;
  if (pair.pnl > 0) buyByDate[d].wins++;
}
let cumBuyPnl = 0;
for (const [date, info] of Object.entries(buyByDate).sort()) {
  cumBuyPnl += info.pnl;
  console.log(`  ${date}: ${info.pnl >= 0 ? '+' : ''}${info.pnl.toLocaleString()}円 (${info.count}件, ${info.wins}勝) 累計: ${cumBuyPnl >= 0 ? '+' : ''}${cumBuyPnl.toLocaleString()}円`);
}

await conn.end();
