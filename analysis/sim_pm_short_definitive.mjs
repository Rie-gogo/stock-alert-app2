/**
 * 午後安値圏フィルター（SHORT版）最終確定シミュレーション
 * 全期間・全取引を対象に、-2%〜-6%の閾値を0.5%刻みで比較
 * 
 * 重要: 昨日と今日のシミュレーションで結果が異なった原因を特定するため、
 * 取引の取得方法を2通りで実施:
 *   A) rt_trades から実際のペアを組み立てる方法（今日の方法）
 *   B) 全SHORTエントリーのうち午後のものだけを対象にする方法
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 全取引日を取得
const [dayRows] = await conn.query(
  `SELECT DISTINCT tradeDate FROM rt_trades ORDER BY tradeDate ASC`
);
const days = dayRows.map(r => r.tradeDate);

console.log(`=== 午後安値圏フィルター(SHORT) 最終確定シミュレーション ===`);
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
      const entryKey = r.symbol + "_" + r.side + "_" + r.id;
      openMap.set(entryKey, r);
    } else if ((r.action === "sell" && r.side === "long") || (r.action === "cover" && r.side === "short")) {
      // マッチする最初のオープンポジションを探す
      let matchKey = null;
      for (const [key, entry] of openMap) {
        if (key.startsWith(r.symbol + "_" + r.side + "_")) {
          matchKey = key;
          break;
        }
      }
      if (matchKey) {
        const entry = openMap.get(matchKey);
        openMap.delete(matchKey);
        positions.push({
          symbol: r.symbol,
          direction: r.side,
          entryTime: entry.tradeTime,
          exitTime: r.tradeTime,
          entryPrice: Number(entry.price),
          exitPrice: Number(r.price),
          shares: Number(entry.shares),
          pnl: Number(r.pnl),
          reason: entry.reason,
          exitReason: r.reason,
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

// まず午後SHORTの全体像を把握
let totalPmShorts = 0;
const allPmShorts = [];
for (const { day, trades, openPrices } of allData) {
  for (const t of trades) {
    if (t.direction !== "short") continue;
    if (t.entryTime < "13:00") continue;
    const openPrice = openPrices.get(t.symbol);
    if (!openPrice) continue;
    const deviation = (t.entryPrice - openPrice) / openPrice;
    totalPmShorts++;
    allPmShorts.push({ ...t, day, openPrice, deviation });
  }
}

console.log(`午後SHORT取引 合計: ${totalPmShorts}件`);
console.log(`  勝ち: ${allPmShorts.filter(t => t.pnl > 0).length}件 (+${allPmShorts.filter(t => t.pnl > 0).reduce((s,t) => s + t.pnl, 0).toLocaleString()}円)`);
console.log(`  負け: ${allPmShorts.filter(t => t.pnl <= 0).length}件 (${allPmShorts.filter(t => t.pnl <= 0).reduce((s,t) => s + t.pnl, 0).toLocaleString()}円)`);
console.log(`  合計PnL: ${allPmShorts.reduce((s,t) => s + t.pnl, 0).toLocaleString()}円\n`);

// 乖離率分布
console.log("--- 午後SHORT 乖離率分布 ---");
const buckets = [
  { label: "0% 〜 -2%", min: -0.02, max: 0 },
  { label: "-2% 〜 -3%", min: -0.03, max: -0.02 },
  { label: "-3% 〜 -4%", min: -0.04, max: -0.03 },
  { label: "-4% 〜 -5%", min: -0.05, max: -0.04 },
  { label: "-5% 〜 -6%", min: -0.06, max: -0.05 },
  { label: "-6% 〜 -8%", min: -0.08, max: -0.06 },
  { label: "-8% 〜 -10%", min: -0.10, max: -0.08 },
  { label: "-10%以下", min: -1, max: -0.10 },
];
for (const b of buckets) {
  const inBucket = allPmShorts.filter(t => t.deviation > b.min && t.deviation <= b.max);
  if (inBucket.length === 0) continue;
  const wins = inBucket.filter(t => t.pnl > 0);
  const pnl = inBucket.reduce((s,t) => s + t.pnl, 0);
  console.log(`  ${b.label.padEnd(12)}: ${String(inBucket.length).padStart(3)}件 | 勝率${((wins.length/inBucket.length)*100).toFixed(0).padStart(3)}% | PnL ${(pnl >= 0 ? "+" : "") + pnl.toLocaleString().padStart(10)}円`);
}

// 閾値比較
const THRESHOLDS = [-0.02, -0.025, -0.03, -0.035, -0.04, -0.045, -0.05, -0.055, -0.06];

console.log(`\n\n${"=".repeat(100)}`);
console.log(`【閾値比較サマリー】`);
console.log(`${"=".repeat(100)}\n`);
console.log("閾値   | ブロック | 勝率  | 利益ブロック       | 損失ブロック       | ネット効果    | 通過勝率");
console.log("-".repeat(105));

const results = [];
for (const threshold of THRESHOLDS) {
  const blocked = allPmShorts.filter(t => t.deviation <= threshold);
  const passed = allPmShorts.filter(t => t.deviation > threshold);
  const wins = blocked.filter(b => b.pnl > 0);
  const losses = blocked.filter(b => b.pnl <= 0);
  const blockedPnl = blocked.reduce((s, b) => s + b.pnl, 0);
  const improvement = -blockedPnl;
  const passedWins = passed.filter(p => p.pnl > 0);
  const pct = (threshold * 100).toFixed(1);
  
  results.push({ threshold, blocked: blocked.length, wins: wins.length, losses: losses.length, improvement, winPnl: wins.reduce((s,b)=>s+b.pnl,0), lossPnl: losses.reduce((s,b)=>s+b.pnl,0), passedWinRate: passed.length > 0 ? (passedWins.length / passed.length * 100) : 0 });
  
  console.log(
    `${pct.padStart(5)}% | ${String(blocked.length).padStart(4)}件 | ${((wins.length/Math.max(blocked.length,1))*100).toFixed(0).padStart(3)}% | ${String(wins.length).padStart(2)}件(+${wins.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(8)}円) | ${String(losses.length).padStart(2)}件(${losses.reduce((s,b)=>s+b.pnl,0).toLocaleString().padStart(9)}円) | ${(improvement >= 0 ? "+" : "") + improvement.toLocaleString().padStart(9)}円 | ${(passed.length > 0 ? (passedWins.length / passed.length * 100).toFixed(1) : "N/A").padStart(5)}%`
  );
}

// 最適閾値の特定
const best = results.reduce((a, b) => a.improvement > b.improvement ? a : b);
console.log(`\n★ 最適閾値: ${(best.threshold * 100).toFixed(1)}% (ネット効果: +${best.improvement.toLocaleString()}円)`);

// 各閾値の詳細（利益ブロック一覧）
console.log(`\n\n${"=".repeat(100)}`);
console.log(`【各閾値で追加ブロックされる利益取引の詳細】`);
console.log(`${"=".repeat(100)}\n`);

for (let i = 0; i < THRESHOLDS.length - 1; i++) {
  const curr = THRESHOLDS[i];
  const next = THRESHOLDS[i + 1];
  // currでブロックされるがnextでは通過する取引
  const additionalBlocked = allPmShorts.filter(t => t.deviation <= curr && t.deviation > next);
  const additionalWins = additionalBlocked.filter(t => t.pnl > 0);
  if (additionalWins.length > 0) {
    console.log(`${(curr*100).toFixed(1)}%で追加ブロック（${(next*100).toFixed(1)}%では通過）:`);
    for (const w of additionalWins) {
      console.log(`  ${w.day} ${w.entryTime} ${w.symbol} SHORT @${w.entryPrice.toFixed(0)} (乖離${(w.deviation*100).toFixed(1)}%) → +${w.pnl.toLocaleString()}円`);
    }
    console.log("");
  }
}

await conn.end();
