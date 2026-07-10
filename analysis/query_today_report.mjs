import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const url = new URL(DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || "3306"),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: true },
});

const today = "2026-07-10";

// 1. Daily summary
const [summaries] = await conn.query(
  "SELECT * FROM rt_daily_summaries WHERE tradeDate = ?",
  [today]
);
console.log("=== Daily Summary ===");
if (summaries.length > 0) {
  const s = summaries[0];
  console.log(`  総損益: ${Number(s.totalPnl).toLocaleString()}円`);
  console.log(`  取引数: ${s.tradesCount}件 (勝${s.winCount} / 負${s.lossCount})`);
  console.log(`  勝率: ${s.tradesCount > 0 ? ((s.winCount / s.tradesCount) * 100).toFixed(1) : 0}%`);
  console.log(`  受信足数: ${s.candlesReceived}`);
}

// 2. All trades today
const [trades] = await conn.query(
  "SELECT * FROM rt_trades WHERE tradeDate = ? ORDER BY createdAt ASC",
  [today]
);
console.log(`\n=== 全取引 (${trades.length}件) ===`);

// action: buy/short = entry, sell/cover = exit
const entries = trades.filter((t) => t.action === "buy" || t.action === "short");
const exits = trades.filter((t) => t.action === "sell" || t.action === "cover");

console.log(`  エントリー: ${entries.length}件, 決済: ${exits.length}件`);

// PnL by exit
let totalPnl = 0;
let wins = 0;
let losses = 0;
const bySymbol = {};
const byReason = {};

for (const exit of exits) {
  const pnl = Number(exit.pnl) || 0;
  totalPnl += pnl;
  if (pnl > 0) wins++;
  else losses++;

  // By symbol
  if (!bySymbol[exit.symbol]) bySymbol[exit.symbol] = { pnl: 0, count: 0, wins: 0, name: exit.symbolName };
  bySymbol[exit.symbol].pnl += pnl;
  bySymbol[exit.symbol].count++;
  if (pnl > 0) bySymbol[exit.symbol].wins++;

  // By reason
  const reason = exit.reason ? exit.reason.split(":")[0].trim() : "unknown";
  if (!byReason[reason]) byReason[reason] = { pnl: 0, count: 0, wins: 0 };
  byReason[reason].pnl += pnl;
  byReason[reason].count++;
  if (pnl > 0) byReason[reason].wins++;
}

console.log(`\n=== 成績サマリー ===`);
console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
console.log(`  勝ち: ${wins}件 / 負け: ${losses}件`);
console.log(`  勝率: ${exits.length > 0 ? ((wins / exits.length) * 100).toFixed(1) : 0}%`);

console.log(`\n=== 銘柄別損益 ===`);
const symbolEntries = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, data] of symbolEntries) {
  console.log(
    `  ${sym} (${data.name}): ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${((data.wins / data.count) * 100).toFixed(0)}%)`
  );
}

console.log(`\n=== 決済理由別成績 ===`);
const reasonEntries = Object.entries(byReason).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [reason, data] of reasonEntries) {
  console.log(
    `  ${reason}: ${data.pnl >= 0 ? "+" : ""}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${((data.wins / data.count) * 100).toFixed(0)}%)`
  );
}

// Max drawdown
let runningPnl = 0;
let maxDrawdown = 0;
for (const exit of exits) {
  runningPnl += Number(exit.pnl) || 0;
  if (runningPnl < maxDrawdown) maxDrawdown = runningPnl;
}
console.log(`\n=== リスク指標 ===`);
console.log(`  取引中最大ドローダウン: ${maxDrawdown.toLocaleString()}円`);
console.log(`  最終損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);

// Trade details
console.log(`\n=== 取引詳細 ===`);
for (const t of trades) {
  const pnlStr = t.pnl ? ` PnL=${Number(t.pnl) >= 0 ? "+" : ""}${Number(t.pnl).toLocaleString()}円` : "";
  console.log(`  ${t.tradeTime} ${t.action.toUpperCase()} ${t.symbol}(${t.symbolName}) @${Number(t.price).toLocaleString()}円 ×${t.shares}株${pnlStr}`);
  if (t.reason) console.log(`    理由: ${t.reason.substring(0, 80)}`);
}

// Order instructions check
const [instructions] = await conn.query(
  "SELECT * FROM order_instructions WHERE tradeDate = ? ORDER BY createdAt ASC",
  [today]
);
console.log(`\n=== ドライラン検証 ===`);
console.log(`  発注指示生成数: ${instructions.length}件`);
if (instructions.length > 0) {
  const statusCounts = {};
  for (const i of instructions) {
    statusCounts[i.status] = (statusCounts[i.status] || 0) + 1;
  }
  console.log(`  ステータス内訳: ${JSON.stringify(statusCounts)}`);
  
  // Show instruction details
  for (const i of instructions) {
    console.log(`    ${i.symbol} ${i.side} ${i.orderType} @${i.price || "成行"} ×${i.qty}株 [${i.status}]`);
  }
}

console.log(`\n  シグナル(rt_trades) vs 発注指示(order_instructions): ${trades.length}件 vs ${instructions.length}件`);
if (trades.length === instructions.length) {
  console.log(`  ✅ 一致`);
} else {
  console.log(`  ⚠️ 不一致 (差分: ${Math.abs(trades.length - instructions.length)}件)`);
}

await conn.end();
process.exit(0);
