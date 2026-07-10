/**
 * バックテスト期間(6/19-7/3)のJX金属(5016)とレーザーテック(6920)の成績分析
 * + 除外した場合の全体損益比較
 */
import mysql from "mysql2/promise";

const EXCLUDE_SYMBOLS = ['5016', '6920'];
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get available dates in the 6/19-7/3 range
const [dates] = await conn.query(`
  SELECT DISTINCT tradeDate as d
  FROM rt_trades
  WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-03'
    AND action IN ('sell', 'cover') AND pnl IS NOT NULL
  ORDER BY d
`);
const dateList = dates.map(r => r.d);
console.log(`=== バックテスト期間: ${dateList[0]} 〜 ${dateList[dateList.length-1]}（${dateList.length}営業日）===\n`);

// Get all exit trades in that period
const [allExits] = await conn.query(`
  SELECT symbol, symbolName, action, pnl, tradeDate, tradeTime, price, shares, reason
  FROM rt_trades
  WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-03'
    AND action IN ('sell', 'cover') AND pnl IS NOT NULL
  ORDER BY tradeDate, tradeTime
`);

// Separate excluded vs remaining
const excludedExits = allExits.filter(t => EXCLUDE_SYMBOLS.includes(t.symbol));
const remainingExits = allExits.filter(t => !EXCLUDE_SYMBOLS.includes(t.symbol));

// Summary function
function summarize(label, arr) {
  if (arr.length === 0) { console.log(`${label}: 取引なし`); return { pnl: 0, count: 0, wins: 0 }; }
  const wins = arr.filter(t => Number(t.pnl) > 0);
  const losses = arr.filter(t => Number(t.pnl) <= 0);
  const totalPnl = arr.reduce((s, t) => s + Number(t.pnl), 0);
  const grossProfit = wins.reduce((s, t) => s + Number(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';
  const avgWin = wins.length > 0 ? Math.round(wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length) : 0;
  const avgLoss = losses.length > 0 ? Math.round(losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length) : 0;
  console.log(`${label}: ${arr.length}件, 勝率${(wins.length/arr.length*100).toFixed(1)}% (${wins.length}勝${losses.length}敗), PF=${pf}`);
  console.log(`  損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円, 平均利益: +${avgWin.toLocaleString()}円, 平均損失: ${avgLoss.toLocaleString()}円`);
  return { pnl: totalPnl, count: arr.length, wins: wins.length };
}

console.log("=== 全体サマリー ===");
const allResult = summarize("全銘柄合計", allExits);
const remainResult = summarize("除外後(15銘柄)", remainingExits);
const excludeResult = summarize("除外銘柄のみ", excludedExits);

console.log(`\n改善額: ${(-excludeResult.pnl) >= 0 ? '+' : ''}${(-excludeResult.pnl).toLocaleString()}円`);

// Per-symbol breakdown for excluded symbols
console.log("\n=== 除外銘柄の詳細 ===");
for (const sym of EXCLUDE_SYMBOLS) {
  const symExits = excludedExits.filter(t => t.symbol === sym);
  const name = symExits[0]?.symbolName || sym;
  console.log(`\n--- ${sym} (${name}) ---`);
  
  const buyExits = symExits.filter(t => t.action === 'sell');
  const shortExits = symExits.filter(t => t.action === 'cover');
  
  if (buyExits.length > 0) summarize(`  BUY`, buyExits);
  if (shortExits.length > 0) summarize(`  SHORT`, shortExits);
  
  // Show each trade
  console.log(`  全取引:`);
  for (const t of symExits) {
    const pnl = Number(t.pnl);
    console.log(`    ${t.tradeDate} ${t.tradeTime} ${t.action} @${t.price} x${t.shares} PnL=${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  }
}

// Daily breakdown comparison
console.log("\n=== 日別比較 ===");
console.log("  日付       | 全体        | 除外後      | 除外銘柄分  | 差分");
console.log("  -----------|-------------|-------------|-------------|--------");
for (const d of dateList) {
  const dayAll = allExits.filter(t => t.tradeDate === d);
  const dayRemain = remainingExits.filter(t => t.tradeDate === d);
  const dayExclude = excludedExits.filter(t => t.tradeDate === d);
  
  const pnlAll = dayAll.reduce((s, t) => s + Number(t.pnl), 0);
  const pnlRemain = dayRemain.reduce((s, t) => s + Number(t.pnl), 0);
  const pnlExclude = dayExclude.reduce((s, t) => s + Number(t.pnl), 0);
  const diff = pnlRemain - pnlAll;
  
  console.log(`  ${d} | ${pnlAll >= 0 ? '+' : ''}${pnlAll.toLocaleString().padStart(9)}円 | ${pnlRemain >= 0 ? '+' : ''}${pnlRemain.toLocaleString().padStart(9)}円 | ${pnlExclude >= 0 ? '+' : ''}${pnlExclude.toLocaleString().padStart(9)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
}

// Also check exposure impact during this period
console.log("\n=== 証拠金枠への影響（エントリー時exposure）===");
const [allEntries] = await conn.query(`
  SELECT tradeDate, symbol, action, price, shares, tradeTime, amount
  FROM rt_trades
  WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-03'
    AND action IN ('buy', 'short')
  ORDER BY tradeDate, tradeTime
`);

// Replay to find peak exposure per day
const MAX_TOTAL_EXPOSURE = 8_910_000;
for (const d of dateList) {
  const dayTrades = await conn.query(`
    SELECT symbol, action, price, shares, tradeTime, amount
    FROM rt_trades
    WHERE tradeDate = ? AND action IN ('buy', 'short', 'sell', 'cover')
    ORDER BY tradeTime
  `, [d]);
  
  const openPos = new Map();
  let peakAll = 0;
  let peakWithout = 0;
  
  for (const t of dayTrades[0]) {
    const amt = Number(t.amount) || Number(t.price) * Number(t.shares);
    if (t.action === 'buy' || t.action === 'short') {
      openPos.set(t.symbol, { amount: amt, excluded: EXCLUDE_SYMBOLS.includes(t.symbol) });
    } else {
      openPos.delete(t.symbol);
    }
    
    let totalExp = 0, expWithout = 0;
    for (const [sym, pos] of openPos) {
      totalExp += pos.amount;
      if (!pos.excluded) expWithout += pos.amount;
    }
    if (totalExp > peakAll) peakAll = totalExp;
    if (expWithout > peakWithout) peakWithout = expWithout;
  }
  
  if (peakAll > MAX_TOTAL_EXPOSURE * 0.7) {
    console.log(`  ${d}: ピーク${(peakAll/10000).toFixed(0)}万円 (除外後: ${(peakWithout/10000).toFixed(0)}万円) / 上限891万円 ${peakAll > MAX_TOTAL_EXPOSURE * 0.9 ? '⚠️接近' : ''}`);
  }
}

await conn.end();
process.exit(0);
