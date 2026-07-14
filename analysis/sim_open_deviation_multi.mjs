/**
 * 全銘柄「始値+X%以上上昇時のLONGエントリーブロック」10日間シミュレーション
 * 閾値: 3%, 4%, 4.5%, 5% を比較
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const THRESHOLDS = [0.03, 0.04, 0.045, 0.05];

// 直近10営業日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate DESC LIMIT 10`
);
const days = dayRows.map(r => r.tradeDate).reverse();

console.log(`=== 始値乖離LONGブロック 閾値比較シミュレーション ===`);
console.log(`対象: 全銘柄 LONG`);
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
        });
      }
    }
  }
  return positions;
}

// 全取引データを事前に取得
const allData = [];
for (const day of days) {
  const trades = await getTradesForDay(day);
  const openPrices = await getOpenPrices(day);
  allData.push({ day, trades, openPrices });
}

const totalActual = allData.reduce((s, d) => s + d.trades.reduce((ss, t) => ss + t.pnl, 0), 0);

// 各閾値でシミュレーション
for (const threshold of THRESHOLDS) {
  const pct = (threshold * 100).toFixed(1);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`【閾値: +${pct}%】`);
  console.log(`${"=".repeat(70)}`);
  
  let totalFiltered = 0;
  let totalBlockedCount = 0;
  let totalBlockedPnl = 0;
  const blocked = [];
  const dailyResults = [];
  
  for (const { day, trades, openPrices } of allData) {
    const actualDayPnl = trades.reduce((s, t) => s + t.pnl, 0);
    let filteredDayPnl = 0;
    let dayBlocked = 0;
    let dayBlockedPnl = 0;
    
    for (const t of trades) {
      const openPrice = openPrices.get(t.symbol);
      if (!openPrice) { filteredDayPnl += t.pnl; continue; }
      
      const deviation = (t.entryPrice - openPrice) / openPrice;
      
      if (t.direction === "long" && deviation >= threshold) {
        dayBlocked++;
        dayBlockedPnl += t.pnl;
        blocked.push({
          day, symbol: t.symbol, entryTime: t.entryTime,
          entryPrice: t.entryPrice, openPrice,
          deviation: (deviation * 100).toFixed(2), pnl: t.pnl,
        });
      } else {
        filteredDayPnl += t.pnl;
      }
    }
    
    dailyResults.push({ day, actual: actualDayPnl, filtered: filteredDayPnl, blocked: dayBlocked, blockedPnl: dayBlockedPnl });
    totalFiltered += filteredDayPnl;
    totalBlockedCount += dayBlocked;
    totalBlockedPnl += dayBlockedPnl;
  }
  
  // 日別表
  console.log("\n日付        | 実績        | フィルター後  | 差分        | ブロック");
  console.log("-".repeat(75));
  for (const r of dailyResults) {
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
  
  // ブロック取引詳細
  const wins = blocked.filter(b => b.pnl > 0);
  const losses = blocked.filter(b => b.pnl <= 0);
  console.log(`\nブロック取引: ${blocked.length}件 (利益${wins.length}件: ${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円 / 損失${losses.length}件: ${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString()}円)`);
  
  console.log("\n  日付       | 時刻  | 銘柄  | 始値    | Entry   | 乖離   | PnL");
  console.log("  " + "-".repeat(72));
  for (const b of blocked) {
    console.log(
      `  ${b.day} | ${b.entryTime} | ${b.symbol.padEnd(5)} | ${b.openPrice.toFixed(0).padStart(6)} | ${b.entryPrice.toFixed(0).padStart(6)} | +${b.deviation.padStart(5)}% | ${(b.pnl >= 0 ? "+" : "") + b.pnl.toLocaleString()}円`
    );
  }
}

// === 最終比較サマリー ===
console.log(`\n\n${"=".repeat(70)}`);
console.log(`【閾値比較サマリー】`);
console.log(`${"=".repeat(70)}\n`);
console.log("閾値  | ブロック件数 | 利益ブロック | 損失ブロック | 改善額      | 改善率");
console.log("-".repeat(75));

for (const threshold of THRESHOLDS) {
  const pct = (threshold * 100).toFixed(1);
  const blocked = [];
  
  for (const { day, trades, openPrices } of allData) {
    for (const t of trades) {
      const openPrice = openPrices.get(t.symbol);
      if (!openPrice) continue;
      const deviation = (t.entryPrice - openPrice) / openPrice;
      if (t.direction === "long" && deviation >= threshold) {
        blocked.push(t);
      }
    }
  }
  
  const wins = blocked.filter(b => b.pnl > 0);
  const losses = blocked.filter(b => b.pnl <= 0);
  const blockedPnl = blocked.reduce((s, b) => s + b.pnl, 0);
  const improvement = -blockedPnl;
  const improvementPct = ((improvement / Math.abs(totalActual)) * 100).toFixed(1);
  
  console.log(
    `+${pct}% | ${String(blocked.length).padStart(5)}件    | ${String(wins.length).padStart(4)}件(${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(8)}円) | ${String(losses.length).padStart(4)}件(${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(9)}円) | ${(improvement >= 0 ? "+" : "") + improvement.toLocaleString().padStart(9)}円 | ${improvementPct}%`
  );
}

await conn.end();
