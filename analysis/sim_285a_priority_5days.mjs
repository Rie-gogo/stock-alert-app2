/**
 * キオクシア優先ルール 5日間シミュレーション
 * 
 * ルール: 285Aのエントリーシグナルが発生した時点で、
 * 保有中の他銘柄ポジションを全て強制決済し、285Aにエントリーする。
 * 
 * 比較:
 * - 実績（現行ルール）
 * - キオクシア優先ルール適用後
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

// 285AのTP/SL設定
const TP_PCT = 0.03; // 3%
const SL_PCT = 0.01; // 1%

console.log("=== キオクシア優先ルール 5日間シミュレーション ===");
console.log(`ルール: 285Aエントリーシグナル発生時に他銘柄を強制決済→285Aエントリー`);
console.log(`285A設定: TP=${(TP_PCT*100).toFixed(1)}% / SL=${(SL_PCT*100).toFixed(1)}%\n`);

// 取引をペアに組み立てる
async function getTradesForDay(day) {
  const [rows] = await conn.query(
    `SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
     FROM rt_trades WHERE tradeDate = ? ORDER BY id ASC`,
    [day]
  );
  
  const positions = [];
  const openMap = new Map(); // symbol -> entry record
  
  for (const r of rows) {
    const key = r.symbol + "_" + r.side;
    if ((r.action === "buy" && r.side === "long") || (r.action === "short" && r.side === "short")) {
      if (!openMap.has(key)) {
        openMap.set(key, r);
      }
    } else if ((r.action === "sell" && r.side === "long") || (r.action === "cover" && r.side === "short")) {
      if (openMap.has(key)) {
        const entry = openMap.get(key);
        openMap.delete(key);
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

// 285Aのエントリーシグナル発生タイミングを特定
// エントリーシグナル = 実際にエントリーされた時刻（rt_tradesのbuy/shortレコード）
async function get285AEntryTimes(day) {
  const [rows] = await conn.query(
    `SELECT tradeTime, price, action, side, reason FROM rt_trades 
     WHERE symbol = '285A' AND tradeDate = ? AND (action = 'buy' OR action = 'short')
     ORDER BY tradeTime ASC`,
    [day]
  );
  return rows.map(r => ({
    time: r.tradeTime,
    price: Number(r.price),
    direction: r.side,
    reason: r.reason,
  }));
}

// 特定時刻の285Aの価格を取得
async function get285APriceAt(day, time) {
  const [rows] = await conn.query(
    `SELECT close FROM rt_candles WHERE symbol = '285A' AND tradeDate = ? AND candleTime = ?`,
    [day, time]
  );
  return rows.length > 0 ? Number(rows[0].close) : null;
}

// 特定時刻の任意銘柄の価格を取得
async function getPriceAt(symbol, day, time) {
  const [rows] = await conn.query(
    `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = ? AND candleTime = ?`,
    [symbol, day, time]
  );
  return rows.length > 0 ? Number(rows[0].close) : null;
}

// 285Aのエントリー後のTP/SL結果をシミュレート
async function simulate285AEntry(day, entryTime, entryPrice, direction) {
  const tp = direction === "long" ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
  const sl = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  
  const [candles] = await conn.query(
    `SELECT candleTime as time, open, high, low, close FROM rt_candles 
     WHERE symbol = '285A' AND tradeDate = ? AND candleTime > ?
     ORDER BY candleTime ASC`,
    [day, entryTime]
  );
  
  for (const c of candles) {
    if (direction === "long") {
      if (c.low <= sl) {
        return { exitTime: c.time, exitPrice: sl, pnl: Math.round((sl - entryPrice) * 100), result: "SL" };
      }
      if (c.high >= tp) {
        return { exitTime: c.time, exitPrice: tp, pnl: Math.round((tp - entryPrice) * 100), result: "TP" };
      }
    } else {
      if (c.high >= sl) {
        return { exitTime: c.time, exitPrice: sl, pnl: Math.round((entryPrice - sl) * 100), result: "SL" };
      }
      if (c.low <= tp) {
        return { exitTime: c.time, exitPrice: tp, pnl: Math.round((entryPrice - tp) * 100), result: "TP" };
      }
    }
  }
  
  // 大引け決済
  if (candles.length > 0) {
    const lastPrice = candles[candles.length - 1].close;
    const pnl = direction === "long" 
      ? Math.round((lastPrice - entryPrice) * 100)
      : Math.round((entryPrice - lastPrice) * 100);
    return { exitTime: candles[candles.length - 1].time, exitPrice: lastPrice, pnl, result: "大引け" };
  }
  
  return { exitTime: entryTime, exitPrice: entryPrice, pnl: 0, result: "データなし" };
}

// ===== メインシミュレーション =====
let totalActual = 0;
let totalSimulated = 0;

const dailyResults = [];

for (const day of days) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`【${day}】`);
  console.log(`${"=".repeat(60)}`);
  
  const trades = await getTradesForDay(day);
  const entries285A = await get285AEntryTimes(day);
  
  const actualDayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  
  console.log(`\n実績: ${trades.length}件, PnL=${actualDayPnl.toLocaleString()}円`);
  for (const t of trades) {
    console.log(`  ${t.entryTime}〜${t.exitTime} | ${t.symbol} ${t.direction} @${t.entryPrice}→${t.exitPrice} | PnL:${t.pnl.toLocaleString()}円`);
  }
  
  if (entries285A.length === 0) {
    console.log(`\n  → 285Aエントリーなし → 変更なし`);
    totalActual += actualDayPnl;
    totalSimulated += actualDayPnl;
    dailyResults.push({ day, actual: actualDayPnl, simulated: actualDayPnl, diff: 0, detail: "285Aエントリーなし" });
    continue;
  }
  
  console.log(`\n285Aエントリーシグナル:`);
  for (const e of entries285A) {
    console.log(`  ${e.time} | ${e.direction} @${e.price} | ${e.reason?.substring(0, 50)}`);
  }
  
  // シミュレーション: 各285Aエントリー時点で他銘柄を強制決済
  console.log(`\n--- キオクシア優先ルール適用 ---`);
  
  let simDayPnl = 0;
  const processedTrades = new Set(); // 処理済み取引のインデックス
  const forcedCloses = []; // 強制決済された取引
  const kioxiaResults = []; // 285Aの新しい結果
  
  for (const entry285A of entries285A) {
    console.log(`\n  ★285Aシグナル @${entry285A.time} (${entry285A.direction} @${entry285A.price}):`);
    
    // この時点で保有中の他銘柄ポジション
    const conflicting = trades.filter(t => 
      t.symbol !== "285A" && 
      t.entryTime <= entry285A.time && 
      t.exitTime >= entry285A.time &&
      !processedTrades.has(trades.indexOf(t))
    );
    
    if (conflicting.length > 0) {
      console.log(`    保有中の他銘柄ポジション（強制決済対象）:`);
      for (const c of conflicting) {
        const priceAtTime = await getPriceAt(c.symbol, day, entry285A.time);
        let forcedPnl = 0;
        if (priceAtTime) {
          forcedPnl = c.direction === "long"
            ? Math.round((priceAtTime - c.entryPrice) * c.shares)
            : Math.round((c.entryPrice - priceAtTime) * c.shares);
        }
        console.log(`      ${c.symbol} ${c.direction} @${c.entryPrice}x${c.shares} → 強制決済@${priceAtTime} | 強制決済PnL:${forcedPnl.toLocaleString()}円 (本来PnL:${c.pnl.toLocaleString()}円)`);
        
        forcedCloses.push({
          symbol: c.symbol,
          originalPnl: c.pnl,
          forcedPnl,
          diff: forcedPnl - c.pnl,
        });
        
        simDayPnl += forcedPnl;
        processedTrades.add(trades.indexOf(c));
      }
    } else {
      console.log(`    保有中の他銘柄ポジション: なし`);
    }
    
    // 285Aエントリーのシミュレーション（同じ価格でエントリー）
    const simResult = await simulate285AEntry(day, entry285A.time, entry285A.price, entry285A.direction);
    console.log(`    285Aエントリー: ${entry285A.direction} @${entry285A.price} → ${simResult.result} @${simResult.exitPrice?.toFixed(0)} (${simResult.exitTime}) PnL:${simResult.pnl.toLocaleString()}円`);
    
    kioxiaResults.push({
      entryTime: entry285A.time,
      ...simResult,
    });
    
    simDayPnl += simResult.pnl;
    
    // 実績の285A取引を処理済みにする
    const actual285ATrade = trades.find(t => t.symbol === "285A" && t.entryTime === entry285A.time);
    if (actual285ATrade) {
      processedTrades.add(trades.indexOf(actual285ATrade));
    }
    
    // 285Aエントリー後に開始される他銘柄取引は、285Aポジション保有中はブロック
    // （証拠金制限により同時保有不可と仮定）
    // → 285A決済後の取引は通常通り
  }
  
  // 処理されていない取引（285Aと競合しなかった取引）の損益を加算
  // ただし、強制決済された銘柄の「後続取引」（同一銘柄の再エントリー）は除外しない
  // 285Aポジション保有中にエントリーされる取引は失われる
  const unprocessed = trades.filter((t, idx) => !processedTrades.has(idx));
  
  // 285Aポジション保有期間を計算
  const kioxiaHoldingPeriods = kioxiaResults.map((kr, i) => ({
    start: entries285A[i].time,
    end: kr.exitTime,
  }));
  
  for (const t of unprocessed) {
    // この取引のエントリー時刻が285Aポジション保有中かチェック
    const blockedByKioxia = kioxiaHoldingPeriods.some(p => 
      t.entryTime >= p.start && t.entryTime <= p.end
    );
    
    if (blockedByKioxia && t.symbol !== "285A") {
      console.log(`    [ブロック] ${t.symbol} ${t.direction} @${t.entryTime} → 285A保有中のためエントリー不可 (失われるPnL:${t.pnl.toLocaleString()}円)`);
    } else {
      simDayPnl += t.pnl;
    }
  }
  
  const diff = simDayPnl - actualDayPnl;
  console.log(`\n  【結果】実績: ${actualDayPnl.toLocaleString()}円 → シミュレーション: ${simDayPnl.toLocaleString()}円 (差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  
  totalActual += actualDayPnl;
  totalSimulated += simDayPnl;
  dailyResults.push({ day, actual: actualDayPnl, simulated: simDayPnl, diff });
}

// ===== サマリー =====
console.log(`\n\n${"=".repeat(60)}`);
console.log(`【5日間サマリー】`);
console.log(`${"=".repeat(60)}\n`);

console.log("日別比較:");
console.log("日付        | 実績        | シミュレーション | 差分");
console.log("-".repeat(65));
for (const r of dailyResults) {
  console.log(`${r.day} | ${r.actual.toLocaleString().padStart(10)}円 | ${r.simulated.toLocaleString().padStart(10)}円 | ${(r.diff >= 0 ? "+" : "") + r.diff.toLocaleString()}円`);
}
console.log("-".repeat(65));
const totalDiff = totalSimulated - totalActual;
console.log(`合計        | ${totalActual.toLocaleString().padStart(10)}円 | ${totalSimulated.toLocaleString().padStart(10)}円 | ${(totalDiff >= 0 ? "+" : "") + totalDiff.toLocaleString()}円`);
console.log(`\n改善率: ${totalActual !== 0 ? ((totalDiff / Math.abs(totalActual)) * 100).toFixed(1) : "N/A"}%`);

await conn.end();
