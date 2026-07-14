/**
 * 始値乖離LONGブロック 3パターン比較（全期間）
 * ① 5% 全日
 * ② 午後のみ(13:00以降) 4%
 * ③ 午後のみ(13:00以降) 5%
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const PATTERNS = [
  { name: "① 5% 全日", threshold: 0.05, pmOnly: false },
  { name: "② 午後4% (13:00以降)", threshold: 0.04, pmOnly: true },
  { name: "③ 午後5% (13:00以降)", threshold: 0.05, pmOnly: true },
];

// 全取引日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate ASC`
);
const days = dayRows.map(r => r.tradeDate);

console.log(`=== 始値乖離LONGブロック パターン比較 ===`);
console.log(`期間: ${days[0]} 〜 ${days[days.length-1]} (${days.length}営業日)\n`);

// 各日の各銘柄の始値を取得
async function getOpenPrices(day) {
  const [rows] = await conn.query(
    `SELECT c.symbol, c.open as openPrice
     FROM rt_candles c
     INNER JOIN (
       SELECT symbol, MIN(candleTime) as firstTime
       FROM rt_candles WHERE tradeDate = ?
       GROUP BY symbol
     ) f ON c.symbol = f.symbol AND c.candleTime = f.firstTime AND c.tradeDate = ?`,
    [day, day]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.symbol, Number(r.openPrice));
  }
  return map;
}

// 取引をペアに組み立てる
async function getTradesForDay(day) {
  const [rows] = await conn.query(
    `SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
     FROM rt_trades WHERE tradeDate = ? ORDER BY id ASC`,
    [day]
  );
  
  const positions = [];
  const openMap = new Map();
  
  for (const r of rows) {
    if ((r.action === "buy" && r.side === "long") || (r.action === "short" && r.side === "short")) {
      const entryKey = r.symbol + "_" + r.side;
      if (!openMap.has(entryKey)) {
        openMap.set(entryKey, r);
      }
    } else if ((r.action === "sell" && r.side === "long") || (r.action === "cover" && r.side === "short")) {
      const entryKey = r.symbol + "_" + r.side;
      if (openMap.has(entryKey)) {
        const entry = openMap.get(entryKey);
        openMap.delete(entryKey);
        positions.push({
          symbol: r.symbol,
          direction: r.side === "long" ? "long" : "short",
          entryTime: entry.tradeTime,
          exitTime: r.tradeTime,
          entryPrice: Number(entry.price),
          exitPrice: Number(r.price),
          shares: Number(entry.shares),
          pnl: Number(r.pnl),
          reason: entry.reason,
        });
      }
    }
  }
  return positions;
}

// 全データ事前取得
const allData = [];
for (const day of days) {
  const trades = await getTradesForDay(day);
  const openPrices = await getOpenPrices(day);
  allData.push({ day, trades, openPrices });
}

const totalActual = allData.reduce((s, d) => s + d.trades.reduce((ss, t) => ss + t.pnl, 0), 0);
console.log(`実績合計: ${totalActual.toLocaleString()}円\n`);

// 各パターンでシミュレーション
for (const pattern of PATTERNS) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`【${pattern.name}】`);
  console.log(`${"=".repeat(80)}`);
  
  let totalFiltered = 0;
  let totalBlockedCount = 0;
  let totalBlockedPnl = 0;
  const blocked = [];
  const dailyResults = [];
  
  for (const { day, trades, openPrices } of allData) {
    const actualDayPnl = trades.reduce((s, t) => s + t.pnl, 0);
    let filteredDayPnl = 0;
    let dayBlocked = 0;
    
    for (const t of trades) {
      const openPrice = openPrices.get(t.symbol);
      if (!openPrice) { filteredDayPnl += t.pnl; continue; }
      
      const deviation = (t.entryPrice - openPrice) / openPrice;
      
      // 午後のみフィルターの場合、13:00未満は通過
      const isAfternoon = t.entryTime >= "13:00";
      const shouldBlock = t.direction === "long" 
        && deviation >= pattern.threshold
        && (!pattern.pmOnly || isAfternoon);
      
      if (shouldBlock) {
        dayBlocked++;
        totalBlockedPnl += t.pnl;
        blocked.push({
          day, symbol: t.symbol, entryTime: t.entryTime,
          entryPrice: t.entryPrice, openPrice,
          deviation: (deviation * 100).toFixed(2), pnl: t.pnl,
          reason: t.reason?.substring(0, 50),
        });
      } else {
        filteredDayPnl += t.pnl;
      }
    }
    
    dailyResults.push({ day, actual: actualDayPnl, filtered: filteredDayPnl, blocked: dayBlocked });
    totalFiltered += filteredDayPnl;
    totalBlockedCount += dayBlocked;
  }
  
  // 日別表
  console.log("\n日付        | 実績        | フィルター後  | 差分        | ブロック");
  console.log("-".repeat(75));
  for (const r of dailyResults) {
    if (r.blocked === 0) continue; // ブロックがある日のみ表示
    const diff = r.filtered - r.actual;
    console.log(
      `${r.day} | ${r.actual.toLocaleString().padStart(10)}円 | ${r.filtered.toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + diff.toLocaleString().padStart(9)}円 | ${r.blocked}件`
    );
  }
  console.log("-".repeat(75));
  const totalDiff = totalFiltered - totalActual;
  console.log(
    `合計        | ${totalActual.toLocaleString().padStart(10)}円 | ${totalFiltered.toLocaleString().padStart(10)}円 | ${(totalDiff >= 0 ? "+" : "") + totalDiff.toLocaleString().padStart(9)}円 | ${totalBlockedCount}件`
  );
  console.log(`改善率: ${((totalDiff / Math.abs(totalActual)) * 100).toFixed(1)}%`);
  
  // ブロック取引の勝敗
  const wins = blocked.filter(b => b.pnl > 0);
  const losses = blocked.filter(b => b.pnl <= 0);
  console.log(`\nブロック取引: ${blocked.length}件`);
  console.log(`  利益: ${wins.length}件 (+${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円)`);
  console.log(`  損失: ${losses.length}件 (${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円)`);
  console.log(`  勝率: ${blocked.length > 0 ? ((wins.length / blocked.length) * 100).toFixed(1) : 0}%`);
  
  // 全件リスト
  console.log("\n  日付       | 時刻  | 銘柄  | 始値    | Entry   | 乖離   | PnL         | 勝敗");
  console.log("  " + "-".repeat(85));
  for (const b of blocked) {
    const result = b.pnl > 0 ? "★WIN" : b.pnl === 0 ? "EVEN" : "LOSS";
    console.log(
      `  ${b.day} | ${b.entryTime} | ${b.symbol.padEnd(5)} | ${b.openPrice.toFixed(0).padStart(6)} | ${b.entryPrice.toFixed(0).padStart(6)} | +${b.deviation.padStart(5)}% | ${(b.pnl >= 0 ? "+" : "") + b.pnl.toLocaleString().padStart(10)}円 | ${result}`
    );
  }
}

// === 最終比較 ===
console.log(`\n\n${"=".repeat(80)}`);
console.log(`【最終比較サマリー】`);
console.log(`${"=".repeat(80)}\n`);
console.log("パターン              | ブロック | 利益ブロック      | 損失ブロック       | ネット効果   | 改善率");
console.log("-".repeat(100));

for (const pattern of PATTERNS) {
  const blocked = [];
  for (const { day, trades, openPrices } of allData) {
    for (const t of trades) {
      const openPrice = openPrices.get(t.symbol);
      if (!openPrice) continue;
      const deviation = (t.entryPrice - openPrice) / openPrice;
      const isAfternoon = t.entryTime >= "13:00";
      const shouldBlock = t.direction === "long" 
        && deviation >= pattern.threshold
        && (!pattern.pmOnly || isAfternoon);
      if (shouldBlock) blocked.push(t);
    }
  }
  
  const wins = blocked.filter(b => b.pnl > 0);
  const losses = blocked.filter(b => b.pnl <= 0);
  const blockedPnl = blocked.reduce((s, b) => s + b.pnl, 0);
  const improvement = -blockedPnl;
  const improvementPct = ((improvement / Math.abs(totalActual)) * 100).toFixed(1);
  
  console.log(
    `${pattern.name.padEnd(21)} | ${String(blocked.length).padStart(4)}件 | ${String(wins.length).padStart(2)}件(+${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(8)}円) | ${String(losses.length).padStart(2)}件(${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(9)}円) | ${(improvement >= 0 ? "+" : "") + improvement.toLocaleString().padStart(9)}円 | ${improvementPct}%`
  );
}

await conn.end();
