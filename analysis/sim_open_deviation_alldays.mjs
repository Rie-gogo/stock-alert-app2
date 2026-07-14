/**
 * 全取引日で「始値+4%以上上昇時のLONGエントリーブロック」を検証
 * 利益取引がブロックされないか確認
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const THRESHOLD = 0.04; // 4%

// 全取引日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate ASC`
);
const days = dayRows.map(r => r.tradeDate);

console.log(`=== 始値+4%以上上昇時LONGブロック 全期間検証 ===`);
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

let totalBlocked = 0;
let totalBlockedPnl = 0;
let totalWins = 0;
let totalWinPnl = 0;
let totalLosses = 0;
let totalLossPnl = 0;
const allBlocked = [];

for (const day of days) {
  const trades = await getTradesForDay(day);
  const openPrices = await getOpenPrices(day);
  
  for (const t of trades) {
    const openPrice = openPrices.get(t.symbol);
    if (!openPrice) continue;
    
    const deviation = (t.entryPrice - openPrice) / openPrice;
    
    if (t.direction === "long" && deviation >= THRESHOLD) {
      totalBlocked++;
      totalBlockedPnl += t.pnl;
      if (t.pnl > 0) {
        totalWins++;
        totalWinPnl += t.pnl;
      } else {
        totalLosses++;
        totalLossPnl += t.pnl;
      }
      allBlocked.push({
        day, symbol: t.symbol, entryTime: t.entryTime,
        entryPrice: t.entryPrice, openPrice,
        deviation: (deviation * 100).toFixed(2), pnl: t.pnl,
        reason: t.reason?.substring(0, 50),
      });
    }
  }
}

console.log(`ブロック対象取引: ${totalBlocked}件`);
console.log(`  利益取引: ${totalWins}件 (合計 +${totalWinPnl.toLocaleString()}円)`);
console.log(`  損失取引: ${totalLosses}件 (合計 ${totalLossPnl.toLocaleString()}円)`);
console.log(`  合計PnL: ${(totalBlockedPnl >= 0 ? "+" : "") + totalBlockedPnl.toLocaleString()}円`);
console.log(`  フィルター効果: ${(totalBlockedPnl <= 0 ? "+" : "-") + Math.abs(totalBlockedPnl).toLocaleString()}円\n`);

// 全件リスト
console.log("=== 全ブロック対象取引 ===\n");
console.log("日付       | 時刻  | 銘柄  | 始値    | Entry   | 乖離   | PnL         | 勝敗");
console.log("-".repeat(90));
for (const b of allBlocked) {
  const result = b.pnl > 0 ? "★WIN" : b.pnl === 0 ? "EVEN" : "LOSS";
  console.log(
    `${b.day} | ${b.entryTime} | ${b.symbol.padEnd(5)} | ${b.openPrice.toFixed(0).padStart(7)} | ${b.entryPrice.toFixed(0).padStart(7)} | +${b.deviation.padStart(5)}% | ${(b.pnl >= 0 ? "+" : "") + b.pnl.toLocaleString().padStart(10)}円 | ${result}`
  );
}

// 利益取引があれば詳細表示
if (totalWins > 0) {
  console.log(`\n\n⚠️ 利益取引がブロックされます！ 詳細:\n`);
  for (const b of allBlocked.filter(x => x.pnl > 0)) {
    console.log(`  ${b.day} ${b.entryTime} ${b.symbol} LONG @${b.entryPrice.toFixed(0)} (乖離+${b.deviation}%) → +${b.pnl.toLocaleString()}円`);
    console.log(`    理由: ${b.reason}`);
  }
}

await conn.end();
