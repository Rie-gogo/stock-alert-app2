/**
 * 完全再シミュレーション: JX金属(5016)とレーザーテック(6920)を除外
 * 
 * processCandle()はDB書き込みを含むため直接使えない。
 * 代わりに、以下のアプローチで「新規エントリーの可能性」を検証する:
 * 
 * 1. 各日の全取引を時系列で再生
 * 2. 除外銘柄のポジションが保有されていた時間帯を特定
 * 3. その時間帯の合計exposure（除外銘柄込み）が上限に近かったか確認
 * 4. もし上限に近い状態で他銘柄のシグナルが出ていたら、それが「追加エントリー」候補
 * 
 * ただし、実際のシグナル検出はprocessCandle内部で行われるため、
 * 「証拠金制限でブロックされたエントリー」を直接検出するには
 * サーバーログ or シグナル履歴を確認する必要がある。
 * 
 * ここでは、各時点のexposureを再計算し、
 * 除外銘柄がなければ追加エントリーが可能だったかを判定する。
 */
import mysql from "mysql2/promise";

const EXCLUDE_SYMBOLS = ['5016', '6920'];
const TARGET_DATES = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
const MAX_TOTAL_EXPOSURE = 8_910_000;

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get ALL trades for the period
const [allTrades] = await conn.query(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, pnl, tradeTime, reason, amount
  FROM rt_trades
  WHERE tradeDate IN (?, ?, ?, ?, ?)
  ORDER BY tradeDate, tradeTime
`, TARGET_DATES);

console.log("=== 完全再シミュレーション: 5016 & 6920 除外時のexposure分析 ===\n");

for (const date of TARGET_DATES) {
  const dayTrades = allTrades.filter(t => t.tradeDate === date);
  
  // Replay trades and track exposure at each point
  const openPositions = new Map(); // symbol -> { price, shares, amount, time }
  const events = []; // timeline of exposure changes
  
  for (const trade of dayTrades) {
    const action = trade.action;
    const price = Number(trade.price);
    const shares = Number(trade.shares);
    const amount = Number(trade.amount) || price * shares;
    const isExcluded = EXCLUDE_SYMBOLS.includes(trade.symbol);
    
    if (action === 'buy' || action === 'short') {
      openPositions.set(trade.symbol, { price, shares, amount, time: trade.tradeTime, excluded: isExcluded });
    } else if (action === 'sell' || action === 'cover') {
      openPositions.delete(trade.symbol);
    }
    
    // Calculate current exposure with and without excluded symbols
    let exposureAll = 0;
    let exposureExcluded = 0;
    let exposureRemaining = 0;
    for (const [sym, pos] of openPositions) {
      exposureAll += pos.amount;
      if (EXCLUDE_SYMBOLS.includes(sym)) {
        exposureExcluded += pos.amount;
      } else {
        exposureRemaining += pos.amount;
      }
    }
    
    events.push({
      time: trade.tradeTime,
      symbol: trade.symbol,
      action,
      amount,
      exposureAll,
      exposureExcluded,
      exposureRemaining,
      headroomWithExcluded: MAX_TOTAL_EXPOSURE - exposureAll,
      headroomWithoutExcluded: MAX_TOTAL_EXPOSURE - exposureRemaining,
      isExcluded,
    });
  }
  
  // Find moments where exposure was high (>70% of limit) with excluded symbols
  const highExposureMoments = events.filter(e => 
    e.exposureAll > MAX_TOTAL_EXPOSURE * 0.7 && e.exposureExcluded > 0
  );
  
  console.log(`[${date}] 取引数: ${dayTrades.length}件`);
  
  // Show exposure timeline for entries only
  const entryEvents = events.filter(e => e.action === 'buy' || e.action === 'short');
  if (entryEvents.length > 0) {
    console.log(`  エントリー時のexposure状況:`);
    for (const e of entryEvents) {
      const marker = e.isExcluded ? '❌除外' : '✅残留';
      const pct = (e.exposureAll / MAX_TOTAL_EXPOSURE * 100).toFixed(0);
      const headroom = ((MAX_TOTAL_EXPOSURE - e.exposureAll + e.amount) / 10000).toFixed(0); // headroom before this entry
      console.log(`    ${e.time} ${marker} ${e.symbol} ${(e.amount/10000).toFixed(0)}万円 | 合計exposure: ${(e.exposureAll/10000).toFixed(0)}万円(${pct}%) | 除外分: ${(e.exposureExcluded/10000).toFixed(0)}万円`);
    }
  }
  
  // Check if any entry was close to the limit
  const nearLimitEntries = entryEvents.filter(e => 
    !e.isExcluded && e.exposureAll > MAX_TOTAL_EXPOSURE * 0.8
  );
  if (nearLimitEntries.length > 0) {
    console.log(`  ⚠️ 証拠金上限に接近したエントリー: ${nearLimitEntries.length}件`);
  }
  
  // Check peak exposure
  const peakExposure = Math.max(...events.map(e => e.exposureAll), 0);
  const peakWithout = Math.max(...events.map(e => e.exposureRemaining), 0);
  console.log(`  ピークexposure: ${(peakExposure/10000).toFixed(0)}万円 (除外なし: ${(peakWithout/10000).toFixed(0)}万円) / 上限${(MAX_TOTAL_EXPOSURE/10000).toFixed(0)}万円`);
  console.log(`  除外銘柄がなければ追加余力: ${((MAX_TOTAL_EXPOSURE - peakWithout)/10000).toFixed(0)}万円`);
  console.log("");
}

// Now the key question: did the exposure limit actually block any entries?
// The exposure limit is checked in enterPosition(). If exposure + new amount > 891万, entry is blocked.
// Let's check if this ever happened by looking at the max simultaneous positions
console.log("=== 同時保有ポジション分析 ===");
for (const date of TARGET_DATES) {
  const dayTrades = allTrades.filter(t => t.tradeDate === date);
  const openPositions = new Set();
  let maxSimultaneous = 0;
  let maxSimultaneousTime = '';
  
  for (const trade of dayTrades) {
    if (trade.action === 'buy' || trade.action === 'short') {
      openPositions.add(trade.symbol);
    } else {
      openPositions.delete(trade.symbol);
    }
    if (openPositions.size > maxSimultaneous) {
      maxSimultaneous = openPositions.size;
      maxSimultaneousTime = trade.tradeTime;
    }
  }
  console.log(`  ${date}: 最大同時保有 ${maxSimultaneous}銘柄 (${maxSimultaneousTime})`);
}

console.log("\n=== 結論 ===");
const excludedPnl = allTrades
  .filter(t => EXCLUDE_SYMBOLS.includes(t.symbol) && t.pnl)
  .reduce((s, t) => s + Number(t.pnl), 0);
const actualTotal = 324146;
const simTotal = actualTotal - excludedPnl;

console.log(`実績合計: +${actualTotal.toLocaleString()}円`);
console.log(`除外銘柄損益: ${excludedPnl >= 0 ? '+' : ''}${excludedPnl.toLocaleString()}円 (5016: -23,433円, 6920: -88,710円)`);
console.log(`除外後合計: ${simTotal >= 0 ? '+' : ''}${simTotal.toLocaleString()}円`);
console.log(`改善額: +${(-excludedPnl).toLocaleString()}円 (${((-excludedPnl)/actualTotal*100).toFixed(1)}%改善)`);
console.log("");
console.log("※ 証拠金制限によるブロックが発生していなかった場合、");
console.log("  除外による追加エントリーは発生せず、単純に損失分が消える効果のみとなります。");

await conn.end();
process.exit(0);
