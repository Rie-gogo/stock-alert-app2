import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get today's date (JST = UTC+9)
const now = new Date();
const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const today = jst.toISOString().slice(0, 10);
console.log(`=== リアルタイムシミュレーション日次レポート: ${today} ===\n`);

// Check if today is a weekday
const dayOfWeek = jst.getDay();
if (dayOfWeek === 0 || dayOfWeek === 6) {
  console.log("本日は休日のため取引なし。");
  // Check most recent trading day
  const [recent] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate DESC LIMIT 5
  `);
  console.log("直近の取引日:", recent.map(r => r.tradeDate).join(', '));
  if (recent.length > 0) {
    console.log(`\n最新取引日 ${recent[0].tradeDate} のデータを表示します:\n`);
    // Use the most recent trading day
    var reportDate = recent[0].tradeDate;
  }
} else {
  var reportDate = today;
}

// Get trades for the report date
const [trades] = await conn.query(`
  SELECT id, symbol, symbolName, action, price, shares, pnl, tradeTime, reason, amount
  FROM rt_trades
  WHERE tradeDate = ?
  ORDER BY tradeTime
`, [reportDate]);

if (trades.length === 0) {
  console.log(`${reportDate} の取引データがありません。`);
  // Check what dates have data
  const [dates] = await conn.query(`
    SELECT DISTINCT tradeDate, COUNT(*) as cnt FROM rt_trades GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 10
  `);
  console.log("\n利用可能な取引日:");
  for (const d of dates) console.log(`  ${d.tradeDate}: ${d.cnt}件`);
  await conn.end();
  process.exit(0);
}

console.log(`取引レコード: ${trades.length}件 (${reportDate})\n`);

// Separate entries and exits
const entries = trades.filter(t => t.action === 'buy' || t.action === 'short');
const exits = trades.filter(t => t.action === 'sell' || t.action === 'cover');

// Calculate stats
const wins = exits.filter(t => Number(t.pnl) > 0);
const losses = exits.filter(t => Number(t.pnl) <= 0);
const totalPnl = exits.reduce((s, t) => s + Number(t.pnl), 0);
const grossProfit = wins.reduce((s, t) => s + Number(t.pnl), 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0));
const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';
const winRate = exits.length > 0 ? (wins.length / exits.length * 100).toFixed(1) : '0';

console.log("=== 1) サマリー ===");
console.log(`  取引件数: ${exits.length}件 (エントリー${entries.length}件, 決済${exits.length}件)`);
console.log(`  勝率: ${winRate}% (${wins.length}勝${losses.length}敗)`);
console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
console.log(`  総利益: +${grossProfit.toLocaleString()}円`);
console.log(`  総損失: -${grossLoss.toLocaleString()}円`);
console.log(`  PF: ${pf}`);
if (wins.length > 0) console.log(`  平均利益: +${Math.round(grossProfit / wins.length).toLocaleString()}円`);
if (losses.length > 0) console.log(`  平均損失: -${Math.round(grossLoss / losses.length).toLocaleString()}円`);

// Symbol breakdown
console.log("\n=== 2) 銘柄別損益 ===");
const symbolPnl = {};
for (const t of exits) {
  const key = `${t.symbol}(${t.symbolName})`;
  if (!symbolPnl[key]) symbolPnl[key] = { pnl: 0, count: 0, wins: 0 };
  symbolPnl[key].pnl += Number(t.pnl);
  symbolPnl[key].count++;
  if (Number(t.pnl) > 0) symbolPnl[key].wins++;
}
const sorted = Object.entries(symbolPnl).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, data] of sorted) {
  console.log(`  ${sym}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.count}件, ${data.wins}勝${data.count - data.wins}敗)`);
}

// Signal/reason breakdown
console.log("\n=== 3) シグナル別成績 ===");
const signalPnl = {};
for (const t of entries) {
  // Extract signal type from reason
  let signalType = 'その他';
  if (t.reason) {
    if (t.reason.includes('大台')) signalType = '大台割れ/回復';
    else if (t.reason.includes('ダウ理論')) signalType = 'ダウ理論';
    else if (t.reason.includes('BB')) signalType = 'BB';
    else if (t.reason.includes('RSI')) signalType = 'RSI';
    else signalType = t.reason.substring(0, 20);
  }
  
  // Find corresponding exit
  const exit = exits.find(e => e.symbol === t.symbol && e.tradeTime > t.tradeTime);
  if (exit) {
    if (!signalPnl[signalType]) signalPnl[signalType] = { pnl: 0, count: 0, wins: 0 };
    signalPnl[signalType].pnl += Number(exit.pnl);
    signalPnl[signalType].count++;
    if (Number(exit.pnl) > 0) signalPnl[signalType].wins++;
  }
}
for (const [sig, data] of Object.entries(signalPnl).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const wr = (data.wins / data.count * 100).toFixed(0);
  console.log(`  ${sig}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.count}件, 勝率${wr}%)`);
}

// Trade timeline
console.log("\n=== 4) 取引タイムライン ===");
for (const t of trades) {
  const pnlStr = t.pnl ? `PnL=${Number(t.pnl) >= 0 ? '+' : ''}${Number(t.pnl).toLocaleString()}円` : '';
  const reasonStr = t.reason ? t.reason.substring(0, 60) : '';
  console.log(`  ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.action} @${Number(t.price).toLocaleString()} x${t.shares} ${pnlStr}`);
  if (reasonStr) console.log(`    → ${reasonStr}`);
}

// Daily summary from rt_daily_summaries
console.log("\n=== 5) デイリーサマリー (rt_daily_summaries) ===");
const [summary] = await conn.query(`
  SELECT * FROM rt_daily_summaries WHERE tradeDate = ?
`, [reportDate]);
if (summary.length > 0) {
  const s = summary[0];
  console.log(`  取引日: ${s.tradeDate}`);
  console.log(`  総損益: ${s.totalPnl}円`);
  console.log(`  取引数: ${s.tradeCount}`);
  console.log(`  勝ち: ${s.winCount}, 負け: ${s.lossCount}`);
  console.log(`  受信足数: ${s.candlesReceived}`);
} else {
  console.log("  サマリーレコードなし");
}

// Special notes
console.log("\n=== 6) 特記事項 ===");
const stopLosses = exits.filter(t => t.reason && t.reason.includes('損切り'));
if (stopLosses.length > 0) {
  console.log(`  損切り: ${stopLosses.length}件 / ${exits.length}件 (${(stopLosses.length/exits.length*100).toFixed(0)}%)`);
  const slTotal = stopLosses.reduce((s, t) => s + Number(t.pnl), 0);
  console.log(`  損切り合計: ${slTotal.toLocaleString()}円`);
}
const forcedClose = exits.filter(t => t.reason && t.reason.includes('強制'));
if (forcedClose.length > 0) {
  console.log(`  大引け強制決済: ${forcedClose.length}件`);
}

await conn.end();
