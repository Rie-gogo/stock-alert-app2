/**
 * シミュレーション: JX金属(5016)とレーザーテック(6920)を除外した場合の5日間
 * 
 * アプローチ: 
 * - processCandle()はDB書き込み(insertRtCandle, insertRtTrade)を含むため直接使えない
 * - 代わりに、rt_tradesの実績データから5016/6920の取引を除外し、
 *   証拠金枠が空いた時間帯に他銘柄のエントリーがブロックされていなかったか確認する
 * 
 * 具体的には:
 * 1. 5016/6920を除外した場合の各時点でのexposure(投資額)を再計算
 * 2. 実績で証拠金制限によりブロックされたエントリーがあったかチェック
 * 3. 結果を比較
 * 
 * ※ 証拠金上限 = 891万円 (300万×3.3×0.9)
 * ※ 5016: 1トレード約237万円(3945×600株), 6920: 1トレード約440万円(44000×100株)
 * ※ 5016+6920が同時保有されると約677万円 → 残り214万円しかない
 * ※ 除外すれば891万円フルに使える
 */
import mysql from "mysql2/promise";

const EXCLUDE_SYMBOLS = ['5016', '6920'];
const TARGET_DATES = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
const MAX_TOTAL_EXPOSURE = 8_910_000; // 300万×3.3×0.9

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log("=== シミュレーション: 5016(JX金属) & 6920(レーザーテック) 除外 ===");
console.log(`対象期間: ${TARGET_DATES[0]} 〜 ${TARGET_DATES[TARGET_DATES.length-1]}`);
console.log(`除外銘柄: ${EXCLUDE_SYMBOLS.join(', ')}`);
console.log(`証拠金上限: ${(MAX_TOTAL_EXPOSURE/10000).toFixed(0)}万円`);
console.log("");

// Get ALL trades (entries and exits) for the 5-day period
const [allTrades] = await conn.query(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, pnl, tradeTime, reason, amount
  FROM rt_trades
  WHERE tradeDate IN (?, ?, ?, ?, ?)
  ORDER BY tradeDate, tradeTime
`, TARGET_DATES);

console.log(`全取引レコード: ${allTrades.length}件`);

// Simulate day by day
let grandTotalPnl = 0;
const dailyResults = [];

for (const date of TARGET_DATES) {
  const dayTrades = allTrades.filter(t => t.tradeDate === date);
  
  // Track open positions and exposure over time
  const openPositions = new Map(); // symbol -> { price, shares, amount }
  let dayPnl = 0;
  let excludedPnl = 0;
  let blockedEntries = []; // entries that were blocked due to exposure in actual run but would have gone through
  
  for (const trade of dayTrades) {
    const isExcluded = EXCLUDE_SYMBOLS.includes(trade.symbol);
    
    if (isExcluded) {
      // Track excluded PnL
      if (trade.pnl) excludedPnl += Number(trade.pnl);
      continue; // Skip excluded symbols entirely
    }
    
    const action = trade.action;
    const price = Number(trade.price);
    const shares = Number(trade.shares);
    const amount = Number(trade.amount) || price * shares;
    
    if (action === 'buy' || action === 'short') {
      // Entry
      openPositions.set(trade.symbol, { price, shares, amount });
      dayPnl += 0; // No PnL on entry
    } else if (action === 'sell' || action === 'cover') {
      // Exit
      openPositions.delete(trade.symbol);
      if (trade.pnl) dayPnl += Number(trade.pnl);
    }
  }
  
  // Calculate current exposure at peak (without excluded symbols)
  const peakExposure = dayTrades
    .filter(t => !EXCLUDE_SYMBOLS.includes(t.symbol) && (t.action === 'buy' || t.action === 'short'))
    .reduce((max, t) => {
      const amt = Number(t.amount) || Number(t.price) * Number(t.shares);
      return Math.max(max, amt);
    }, 0);
  
  dailyResults.push({
    date,
    pnl: dayPnl,
    excludedPnl,
    tradeCount: dayTrades.filter(t => !EXCLUDE_SYMBOLS.includes(t.symbol) && (t.action === 'sell' || t.action === 'cover')).length,
  });
  
  grandTotalPnl += dayPnl;
  console.log(`  ${date}: PnL=${dayPnl >= 0 ? '+' : ''}${dayPnl.toLocaleString()}円 (除外分: ${excludedPnl >= 0 ? '+' : ''}${excludedPnl.toLocaleString()}円)`);
}

console.log("");

// Now check: were there any entries blocked by exposure limit that would have gone through?
// We need to check the signal history / logs for "証拠金使用率制限" blocks
console.log("=== 証拠金制限によるブロック確認 ===");

// Check rt_candles for times when 5016/6920 had open positions
// and see if other symbols had signals that were blocked
for (const date of TARGET_DATES) {
  const dayTrades = allTrades.filter(t => t.tradeDate === date);
  
  // Find time windows when excluded symbols had open positions
  const excludedWindows = [];
  let currentOpen = null;
  
  for (const trade of dayTrades) {
    if (!EXCLUDE_SYMBOLS.includes(trade.symbol)) continue;
    if (trade.action === 'buy' || trade.action === 'short') {
      currentOpen = { symbol: trade.symbol, startTime: trade.tradeTime, amount: Number(trade.amount) || Number(trade.price) * Number(trade.shares) };
    } else if (trade.action === 'sell' || trade.action === 'cover') {
      if (currentOpen) {
        excludedWindows.push({ ...currentOpen, endTime: trade.tradeTime });
        currentOpen = null;
      }
    }
  }
  
  if (excludedWindows.length > 0) {
    console.log(`  ${date}: 除外銘柄のポジション保有時間帯:`);
    for (const w of excludedWindows) {
      console.log(`    ${w.symbol} ${w.startTime}〜${w.endTime} (${(w.amount/10000).toFixed(0)}万円)`);
    }
    
    // Check what other entries happened during those windows
    const otherEntries = dayTrades.filter(t => 
      !EXCLUDE_SYMBOLS.includes(t.symbol) && 
      (t.action === 'buy' || t.action === 'short')
    );
    
    // Check if any other entries overlapped with excluded positions
    for (const entry of otherEntries) {
      for (const w of excludedWindows) {
        if (entry.tradeTime >= w.startTime && entry.tradeTime <= w.endTime) {
          const entryAmt = Number(entry.amount) || Number(entry.price) * Number(entry.shares);
          console.log(`    → 同時間帯にエントリー: ${entry.symbol}(${entry.symbolName}) ${entry.tradeTime} ${(entryAmt/10000).toFixed(0)}万円`);
          console.log(`      合計exposure: ${((entryAmt + w.amount)/10000).toFixed(0)}万円 / 上限${(MAX_TOTAL_EXPOSURE/10000).toFixed(0)}万円 → ${(entryAmt + w.amount) > MAX_TOTAL_EXPOSURE ? '❌ 超過' : '✅ 余裕あり'}`);
        }
      }
    }
  }
}

// Final comparison
console.log("\n=== 最終比較 ===");
const actualTotal = 48433 + 167971 + 45800 + (-38143) + 100085; // = 324,146
const excludedTotal = allTrades
  .filter(t => EXCLUDE_SYMBOLS.includes(t.symbol) && t.pnl)
  .reduce((s, t) => s + Number(t.pnl), 0);

console.log(`  実績5日間合計: +${actualTotal.toLocaleString()}円`);
console.log(`  除外銘柄の損益: ${excludedTotal >= 0 ? '+' : ''}${excludedTotal.toLocaleString()}円`);
console.log(`  単純除外後: ${(actualTotal - excludedTotal) >= 0 ? '+' : ''}${(actualTotal - excludedTotal).toLocaleString()}円`);
console.log(`  シミュレーション合計: ${grandTotalPnl >= 0 ? '+' : ''}${grandTotalPnl.toLocaleString()}円`);
console.log("");
console.log("=== 日別比較 ===");
const actualDaily = {
  '2026-07-06': 48433,
  '2026-07-07': 167971,
  '2026-07-08': 45800,
  '2026-07-09': -38143,
  '2026-07-10': 100085,
};
console.log("  日付       | 実績        | 除外後      | 差分");
console.log("  -----------|-------------|-------------|--------");
for (const d of dailyResults) {
  const actual = actualDaily[d.date];
  const diff = d.pnl - actual;
  console.log(`  ${d.date} | ${actual >= 0 ? '+' : ''}${actual.toLocaleString().padStart(9)}円 | ${d.pnl >= 0 ? '+' : ''}${d.pnl.toLocaleString().padStart(9)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
}

await conn.end();
process.exit(0);
