/**
 * 全銘柄「始値+5%以上上昇時のLONGエントリーブロック」10日間シミュレーション
 * 
 * ルール: エントリー価格が当日始値から+5%以上上昇している場合、LONGエントリーを禁止
 * (SHORTには適用しない)
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const THRESHOLD = 0.05; // 5%

// 直近10営業日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate DESC LIMIT 10`
);
const days = dayRows.map(r => r.tradeDate).reverse();

console.log(`=== 始値+${(THRESHOLD*100).toFixed(0)}%以上上昇時LONGブロック 10日間シミュレーション ===`);
console.log(`対象: 全銘柄`);
console.log(`期間: ${days[0]} 〜 ${days[days.length-1]} (${days.length}日間)\n`);

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
    const key = r.symbol + "_" + r.side + "_" + r.id;
    if ((r.action === "buy" && r.side === "long") || (r.action === "short" && r.side === "short")) {
      // エントリー
      const entryKey = r.symbol + "_" + r.side;
      if (!openMap.has(entryKey)) {
        openMap.set(entryKey, r);
      }
    } else if ((r.action === "sell" && r.side === "long") || (r.action === "cover" && r.side === "short")) {
      // 決済
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

let totalActual = 0;
let totalFiltered = 0;
let totalBlockedCount = 0;
let totalBlockedPnl = 0;
const dailyResults = [];
const allBlocked = [];

for (const day of days) {
  const trades = await getTradesForDay(day);
  const openPrices = await getOpenPrices(day);
  
  const actualDayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  
  let filteredDayPnl = 0;
  let blockedCount = 0;
  let blockedPnl = 0;
  const dayBlocked = [];
  
  for (const t of trades) {
    const openPrice = openPrices.get(t.symbol);
    if (!openPrice) {
      filteredDayPnl += t.pnl;
      continue;
    }
    
    const deviation = (t.entryPrice - openPrice) / openPrice;
    
    // LONGで始値+5%以上 → ブロック
    if (t.direction === "long" && deviation >= THRESHOLD) {
      blockedCount++;
      blockedPnl += t.pnl;
      dayBlocked.push({
        day,
        symbol: t.symbol,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        openPrice,
        deviation: (deviation * 100).toFixed(2),
        pnl: t.pnl,
      });
    } else {
      filteredDayPnl += t.pnl;
    }
  }
  
  const diff = filteredDayPnl - actualDayPnl;
  dailyResults.push({ day, actual: actualDayPnl, filtered: filteredDayPnl, diff, blockedCount, blockedPnl });
  allBlocked.push(...dayBlocked);
  
  totalActual += actualDayPnl;
  totalFiltered += filteredDayPnl;
  totalBlockedCount += blockedCount;
  totalBlockedPnl += blockedPnl;
}

// === 出力 ===
console.log("日付        | 実績        | フィルター後  | 差分        | ブロック件数 | ブロックPnL");
console.log("-".repeat(95));
for (const r of dailyResults) {
  console.log(
    `${r.day} | ${r.actual.toLocaleString().padStart(10)}円 | ${r.filtered.toLocaleString().padStart(10)}円 | ${(r.diff >= 0 ? "+" : "") + r.diff.toLocaleString().padStart(9)}円 | ${String(r.blockedCount).padStart(5)}件 | ${(r.blockedPnl >= 0 ? "+" : "") + r.blockedPnl.toLocaleString().padStart(9)}円`
  );
}
console.log("-".repeat(95));
const totalDiff = totalFiltered - totalActual;
console.log(
  `合計        | ${totalActual.toLocaleString().padStart(10)}円 | ${totalFiltered.toLocaleString().padStart(10)}円 | ${(totalDiff >= 0 ? "+" : "") + totalDiff.toLocaleString().padStart(9)}円 | ${String(totalBlockedCount).padStart(5)}件 | ${(totalBlockedPnl >= 0 ? "+" : "") + totalBlockedPnl.toLocaleString().padStart(9)}円`
);

console.log(`\n改善率: ${totalActual !== 0 ? ((totalDiff / Math.abs(totalActual)) * 100).toFixed(1) : "N/A"}%`);

// ブロックされた取引の詳細
console.log(`\n\n=== ブロックされた取引一覧 (${allBlocked.length}件) ===\n`);
console.log("日付       | 時刻  | 銘柄  | 始値    | エントリー | 乖離率 | PnL");
console.log("-".repeat(80));
for (const b of allBlocked) {
  console.log(
    `${b.day} | ${b.entryTime} | ${b.symbol.padEnd(5)} | ${b.openPrice.toFixed(0).padStart(7)} | ${b.entryPrice.toFixed(0).padStart(7)} | +${b.deviation}% | ${(b.pnl >= 0 ? "+" : "") + b.pnl.toLocaleString()}円`
  );
}

// ブロックされた取引の勝敗
const wins = allBlocked.filter(b => b.pnl > 0);
const losses = allBlocked.filter(b => b.pnl <= 0);
console.log(`\nブロック取引の内訳: 利益${wins.length}件(${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円) / 損失${losses.length}件(${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円)`);
console.log(`→ ブロックしなければ合計${totalBlockedPnl.toLocaleString()}円 → ブロックにより${totalBlockedPnl <= 0 ? "+" : "-"}${Math.abs(totalBlockedPnl).toLocaleString()}円の効果`);

await conn.end();
