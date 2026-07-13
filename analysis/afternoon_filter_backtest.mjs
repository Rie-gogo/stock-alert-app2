import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all PM short entries with their exits in one query
const [pairs] = await conn.query(`
  SELECT 
    e.id as entryId, e.symbol, e.symbolName, e.tradeDate, e.tradeTime as entryTime, e.price as entryPrice, e.shares, e.reason as entryReason,
    x.pnl, x.tradeTime as exitTime, x.reason as exitReason
  FROM rt_trades e
  JOIN rt_trades x ON x.symbol = e.symbol AND x.tradeDate = e.tradeDate AND x.tradeTime > e.tradeTime AND x.action = 'cover'
  WHERE e.action = 'short' AND e.tradeTime >= '13:00'
  AND x.id = (
    SELECT MIN(x2.id) FROM rt_trades x2 
    WHERE x2.symbol = e.symbol AND x2.tradeDate = e.tradeDate AND x2.tradeTime > e.tradeTime AND x2.action = 'cover'
  )
  ORDER BY e.tradeDate, e.tradeTime
`);

// Get opening prices for all relevant symbol+date combos
const symbolDates = [...new Set(pairs.map(p => `${p.symbol}|${p.tradeDate}`))];
const openPrices = {};
for (const sd of symbolDates) {
  const [sym, date] = sd.split('|');
  const [row] = await conn.query(`
    SELECT open FROM rt_candles 
    WHERE symbol = ? AND tradeDate = ? AND candleTime >= '09:00' AND candleTime < '09:05'
    ORDER BY candleTime ASC LIMIT 1
  `, [sym, date]);
  if (row.length) openPrices[sd] = Number(row[0].open);
}

console.log(`=== 安値圏フィルター(-3%) バックテスト ===\n`);
console.log(`午後ショートエントリー総数: ${pairs.length}件\n`);

// Analyze at different thresholds
for (const threshold of [-0.02, -0.025, -0.03, -0.035, -0.04, -0.05]) {
  let filtered = 0, filteredPnl = 0, filteredWins = 0;
  let passed = 0, passedPnl = 0, passedWins = 0;
  
  for (const p of pairs) {
    const key = `${p.symbol}|${p.tradeDate}`;
    const openPrice = openPrices[key];
    if (!openPrice) continue;
    
    const entryPrice = Number(p.entryPrice);
    const dropFromOpen = (entryPrice - openPrice) / openPrice;
    const pnl = Number(p.pnl);
    const isWin = pnl > 0;
    
    if (dropFromOpen <= threshold) {
      filtered++;
      filteredPnl += pnl;
      if (isWin) filteredWins++;
    } else {
      passed++;
      passedPnl += pnl;
      if (isWin) passedWins++;
    }
  }
  
  const totalPnl = filteredPnl + passedPnl;
  const improvement = -filteredPnl;
  console.log(`閾値 ${(threshold*100).toFixed(1)}%: ブロック${filtered}件(勝率${filtered > 0 ? (filteredWins/filtered*100).toFixed(0) : 0}%, PnL${filteredPnl >= 0 ? '+' : ''}${filteredPnl.toLocaleString()}円) | 通過${passed}件(勝率${passed > 0 ? (passedWins/passed*100).toFixed(0) : 0}%) | 改善${improvement >= 0 ? '+' : ''}${improvement.toLocaleString()}円`);
}

// Detailed analysis at -3%
console.log("\n=== -3%閾値の詳細 ===\n");
const filteredTrades = [];
const passedTrades = [];

for (const p of pairs) {
  const key = `${p.symbol}|${p.tradeDate}`;
  const openPrice = openPrices[key];
  if (!openPrice) continue;
  
  const entryPrice = Number(p.entryPrice);
  const dropFromOpen = (entryPrice - openPrice) / openPrice;
  const pnl = Number(p.pnl);
  
  if (dropFromOpen <= -0.03) {
    filteredTrades.push({ ...p, dropPct: (dropFromOpen * 100).toFixed(1), pnl });
  } else {
    passedTrades.push({ ...p, dropPct: (dropFromOpen * 100).toFixed(1), pnl });
  }
}

console.log(`ブロックされる取引: ${filteredTrades.length}件`);
const fWins = filteredTrades.filter(t => t.pnl > 0);
const fLosses = filteredTrades.filter(t => t.pnl <= 0);
const fTotalPnl = filteredTrades.reduce((s, t) => s + t.pnl, 0);
const fGrossProfit = fWins.reduce((s, t) => s + t.pnl, 0);
const fGrossLoss = Math.abs(fLosses.reduce((s, t) => s + t.pnl, 0));
console.log(`  勝率: ${(fWins.length / filteredTrades.length * 100).toFixed(1)}% (${fWins.length}勝${fLosses.length}敗)`);
console.log(`  合計PnL: ${fTotalPnl >= 0 ? '+' : ''}${fTotalPnl.toLocaleString()}円`);
console.log(`  利益合計: +${fGrossProfit.toLocaleString()}円 / 損失合計: -${fGrossLoss.toLocaleString()}円`);
if (fWins.length > 0) console.log(`  ※ 勝ちトレードの利益: +${fGrossProfit.toLocaleString()}円 が失われる`);

console.log(`\n通過する取引: ${passedTrades.length}件`);
const pWins = passedTrades.filter(t => t.pnl > 0);
const pLosses = passedTrades.filter(t => t.pnl <= 0);
const pTotalPnl = passedTrades.reduce((s, t) => s + t.pnl, 0);
console.log(`  勝率: ${(pWins.length / passedTrades.length * 100).toFixed(1)}% (${pWins.length}勝${pLosses.length}敗)`);
console.log(`  合計PnL: ${pTotalPnl >= 0 ? '+' : ''}${pTotalPnl.toLocaleString()}円`);

// Overall system impact
const [totalRow] = await conn.query(`SELECT SUM(pnl) as total FROM rt_trades WHERE pnl IS NOT NULL`);
const totalSystemPnl = Number(totalRow[0].total);
console.log(`\n=== システム全体への影響 ===`);
console.log(`現在の全体PnL: ${totalSystemPnl >= 0 ? '+' : ''}${totalSystemPnl.toLocaleString()}円`);
console.log(`フィルター適用後: ${(totalSystemPnl - fTotalPnl) >= 0 ? '+' : ''}${(totalSystemPnl - fTotalPnl).toLocaleString()}円`);
console.log(`改善額: ${(-fTotalPnl) >= 0 ? '+' : ''}${(-fTotalPnl).toLocaleString()}円 (${((-fTotalPnl) / Math.abs(totalSystemPnl) * 100).toFixed(1)}%改善)`);

// Show the filtered trades
console.log("\n=== ブロックされる取引一覧 ===");
console.log("日付       | 時刻  | 銘柄         | 始値比  | PnL         | 決済理由");
console.log("-----------|-------|--------------|---------|-------------|--------");
for (const t of filteredTrades.sort((a, b) => a.pnl - b.pnl)) {
  const name = (t.symbolName || '').substring(0, 8).padEnd(8);
  console.log(`${t.tradeDate} | ${t.entryTime} | ${t.symbol}(${name}) | ${t.dropPct}% | ${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString().padStart(8)}円 | ${(t.exitReason || '').substring(0, 15)}`);
}

await conn.end();
