/**
 * キオクシア優先ルール（強制決済版）5日間シミュレーション
 * 
 * rt_trades schema: id, tradeDate, symbol, symbolName, action, price, shares, amount, pnl, reason, tradeTime, side, boardSignal, createdAt
 * rt_candles schema: id, symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot, createdAt
 * 
 * action = "buy"/"sell"/"short"/"cover" (entry/exit pairs)
 * side = "long"/"short"
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

console.log("=== キオクシア優先ルール（強制決済版）5日間シミュレーション ===\n");

// まず各日の取引をペア（エントリー+決済）に組み立てる
async function getTradesForDay(day) {
  const [rows] = await conn.query(
    `SELECT symbol, action, price, shares, pnl, reason, tradeTime, side
     FROM rt_trades WHERE tradeDate = ? ORDER BY tradeTime ASC, id ASC`,
    [day]
  );
  
  // エントリーと決済をペアにする
  const positions = [];
  const openMap = new Map(); // symbol -> entry record
  
  for (const r of rows) {
    if (r.action === "buy" && r.side === "long" && !openMap.has(r.symbol + "_long")) {
      openMap.set(r.symbol + "_long", r);
    } else if (r.action === "short" && r.side === "short" && !openMap.has(r.symbol + "_short")) {
      openMap.set(r.symbol + "_short", r);
    } else if (r.action === "sell" && r.side === "long" && openMap.has(r.symbol + "_long")) {
      const entry = openMap.get(r.symbol + "_long");
      openMap.delete(r.symbol + "_long");
      positions.push({
        symbol: r.symbol,
        direction: "long",
        entryTime: entry.tradeTime,
        exitTime: r.tradeTime,
        entryPrice: Number(entry.price),
        exitPrice: Number(r.price),
        shares: Number(entry.shares),
        pnl: Number(r.pnl),
        reason: entry.reason,
      });
    } else if (r.action === "cover" && r.side === "short" && openMap.has(r.symbol + "_short")) {
      const entry = openMap.get(r.symbol + "_short");
      openMap.delete(r.symbol + "_short");
      positions.push({
        symbol: r.symbol,
        direction: "short",
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
  return positions;
}

// 7/14の詳細シミュレーション
console.log("--- 7/14 詳細分析 ---\n");

const trades0714 = await getTradesForDay("2026-07-14");
console.log("7/14 全ポジション:");
for (const t of trades0714) {
  console.log(`  ${t.entryTime}〜${t.exitTime} | ${t.symbol} ${t.direction} @${t.entryPrice}→${t.exitPrice} | PnL:${t.pnl.toLocaleString()}円 | ${t.reason.substring(0, 30)}`);
}

// 285Aの13:00以降のキャンドルデータ
const [candles285A] = await conn.query(
  `SELECT candleTime as time, open, high, low, close FROM rt_candles 
   WHERE symbol = '285A' AND tradeDate = '2026-07-14' 
   AND candleTime >= '13:00' AND candleTime <= '15:30'
   ORDER BY candleTime ASC`
);

// 66000超えの確認タイミングを特定
let confirmCount = 0;
let confirm3Time = null;
let confirm5Time = null;
let entryPrice3 = null;
let entryPrice5 = null;

for (const c of candles285A) {
  if (c.close >= 66000) {
    confirmCount++;
    if (confirmCount === 3 && !confirm3Time) {
      confirm3Time = c.time;
      entryPrice3 = c.close;
    }
    if (confirmCount === 5 && !confirm5Time) {
      confirm5Time = c.time;
      entryPrice5 = c.close;
    }
  } else {
    confirmCount = 0;
    confirm3Time = null;
    confirm5Time = null;
    entryPrice3 = null;
    entryPrice5 = null;
  }
}

console.log(`\n66000超え 3本確認完了: ${confirm3Time} @${entryPrice3}`);
console.log(`66000超え 5本確認完了: ${confirm5Time} @${entryPrice5}`);

// その時点で保有中の他銘柄ポジション
const conflictsAt3 = trades0714.filter(t => 
  t.symbol !== "285A" && t.entryTime <= confirm3Time && t.exitTime >= confirm3Time
);
const conflictsAt5 = trades0714.filter(t => 
  t.symbol !== "285A" && t.entryTime <= confirm5Time && t.exitTime >= confirm5Time
);

console.log(`\n3本確認時(${confirm3Time})の保有ポジション:`);
for (const c of conflictsAt3) {
  // そのタイミングでの含み損益を計算
  const [priceAtTime] = await conn.query(
    `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-14' AND candleTime = ?`,
    [c.symbol, confirm3Time]
  );
  let unrealizedPnl = 0;
  if (priceAtTime.length > 0) {
    unrealizedPnl = c.direction === "long"
      ? (priceAtTime[0].close - c.entryPrice) * c.shares
      : (c.entryPrice - priceAtTime[0].close) * c.shares;
  }
  console.log(`  ${c.symbol} ${c.direction} @${c.entryPrice} x${c.shares} | 含み損益:${unrealizedPnl.toLocaleString()}円 | 最終PnL:${c.pnl.toLocaleString()}円`);
}

console.log(`\n5本確認時(${confirm5Time})の保有ポジション:`);
for (const c of conflictsAt5) {
  const [priceAtTime] = await conn.query(
    `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-14' AND candleTime = ?`,
    [c.symbol, confirm5Time]
  );
  let unrealizedPnl = 0;
  if (priceAtTime.length > 0) {
    unrealizedPnl = c.direction === "long"
      ? (priceAtTime[0].close - c.entryPrice) * c.shares
      : (c.entryPrice - priceAtTime[0].close) * c.shares;
  }
  console.log(`  ${c.symbol} ${c.direction} @${c.entryPrice} x${c.shares} | 含み損益:${unrealizedPnl.toLocaleString()}円 | 最終PnL:${c.pnl.toLocaleString()}円`);
}

// シナリオ計算: 5本確認時に他銘柄を強制決済 → 285Aエントリー
console.log("\n\n=== シナリオ比較 ===");

// シナリオA: 3本確認(confirm3Time)で強制決済→285Aエントリー
if (entryPrice3) {
  const tp = entryPrice3 * 1.03;
  const sl = entryPrice3 * 0.99;
  
  let result = "大引け決済";
  let exitPrice = candles285A[candles285A.length - 1]?.close ?? entryPrice3;
  
  for (const c of candles285A) {
    if (c.time <= confirm3Time) continue;
    if (c.low <= sl) {
      result = `SLヒット (${c.time})`;
      exitPrice = sl;
      break;
    }
    if (c.high >= tp) {
      result = `TP利確 (${c.time})`;
      exitPrice = tp;
      break;
    }
  }
  
  const pnl285A = Math.round((exitPrice - entryPrice3) * 100);
  
  // 強制決済される他銘柄の損益
  let forcedLiqPnl = 0;
  for (const c of conflictsAt3) {
    const [priceAtTime] = await conn.query(
      `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-14' AND candleTime = ?`,
      [c.symbol, confirm3Time]
    );
    if (priceAtTime.length > 0) {
      const unrealized = c.direction === "long"
        ? (priceAtTime[0].close - c.entryPrice) * c.shares
        : (c.entryPrice - priceAtTime[0].close) * c.shares;
      forcedLiqPnl += unrealized;
    }
  }
  
  // 強制決済後にエントリーされなくなる取引の利益を差し引く
  // (confirm3Time以降にエントリーする他銘柄取引)
  const missedTrades = trades0714.filter(t => 
    t.symbol !== "285A" && t.entryTime > confirm3Time
  );
  let missedPnl = missedTrades.reduce((s, t) => s + t.pnl, 0);
  
  console.log(`\nシナリオA: ${confirm3Time}に強制決済→285A BUY @${entryPrice3}`);
  console.log(`  285A結果: ${result} | PnL: ${pnl285A.toLocaleString()}円`);
  console.log(`  強制決済の損益: ${forcedLiqPnl.toLocaleString()}円 (本来の最終PnL: ${conflictsAt3.reduce((s,c)=>s+c.pnl,0).toLocaleString()}円)`);
  console.log(`  失われる後続取引: ${missedTrades.length}件 PnL: ${missedPnl.toLocaleString()}円`);
  console.log(`    ${missedTrades.map(t => `${t.symbol}(${t.pnl.toLocaleString()}円)`).join(", ")}`);
  
  // 実績の285A PnL
  const actual285APnl = trades0714.filter(t => t.symbol === "285A").reduce((s, t) => s + t.pnl, 0);
  
  const netChange = pnl285A + forcedLiqPnl - conflictsAt3.reduce((s,c)=>s+c.pnl,0) - missedPnl - actual285APnl;
  console.log(`\n  ★ネット改善額: ${netChange.toLocaleString()}円`);
  console.log(`    = 285A新PnL(${pnl285A.toLocaleString()}) + 強制決済PnL(${forcedLiqPnl.toLocaleString()}) - 強制決済銘柄の本来PnL(${conflictsAt3.reduce((s,c)=>s+c.pnl,0).toLocaleString()}) - 失われる後続(${missedPnl.toLocaleString()}) - 実績285A(${actual285APnl.toLocaleString()})`);
}

// シナリオB: 5本確認(confirm5Time)で強制決済→285Aエントリー
if (entryPrice5) {
  const tp = entryPrice5 * 1.03;
  const sl = entryPrice5 * 0.99;
  
  let result = "大引け決済";
  let exitPrice = candles285A[candles285A.length - 1]?.close ?? entryPrice5;
  
  for (const c of candles285A) {
    if (c.time <= confirm5Time) continue;
    if (c.low <= sl) {
      result = `SLヒット (${c.time})`;
      exitPrice = sl;
      break;
    }
    if (c.high >= tp) {
      result = `TP利確 (${c.time})`;
      exitPrice = tp;
      break;
    }
  }
  
  const pnl285A = Math.round((exitPrice - entryPrice5) * 100);
  
  let forcedLiqPnl = 0;
  for (const c of conflictsAt5) {
    const [priceAtTime] = await conn.query(
      `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-14' AND candleTime = ?`,
      [c.symbol, confirm5Time]
    );
    if (priceAtTime.length > 0) {
      const unrealized = c.direction === "long"
        ? (priceAtTime[0].close - c.entryPrice) * c.shares
        : (c.entryPrice - priceAtTime[0].close) * c.shares;
      forcedLiqPnl += unrealized;
    }
  }
  
  const missedTrades = trades0714.filter(t => 
    t.symbol !== "285A" && t.entryTime > confirm5Time
  );
  let missedPnl = missedTrades.reduce((s, t) => s + t.pnl, 0);
  
  console.log(`\nシナリオB: ${confirm5Time}に強制決済→285A BUY @${entryPrice5}`);
  console.log(`  285A結果: ${result} | PnL: ${pnl285A.toLocaleString()}円`);
  console.log(`  強制決済の損益: ${forcedLiqPnl.toLocaleString()}円 (本来の最終PnL: ${conflictsAt5.reduce((s,c)=>s+c.pnl,0).toLocaleString()}円)`);
  console.log(`  失われる後続取引: ${missedTrades.length}件 PnL: ${missedPnl.toLocaleString()}円`);
  console.log(`    ${missedTrades.map(t => `${t.symbol}(${t.pnl.toLocaleString()}円)`).join(", ")}`);
  
  const actual285APnl = trades0714.filter(t => t.symbol === "285A").reduce((s, t) => s + t.pnl, 0);
  
  const netChange = pnl285A + forcedLiqPnl - conflictsAt5.reduce((s,c)=>s+c.pnl,0) - missedPnl - actual285APnl;
  console.log(`\n  ★ネット改善額: ${netChange.toLocaleString()}円`);
}

// 他の日の分析（285Aがブロックされたケースがあるか）
console.log("\n\n=== 他の日の285Aブロック状況 ===");
for (const day of days.filter(d => d !== "2026-07-14")) {
  const trades = await getTradesForDay(day);
  const t285 = trades.filter(t => t.symbol === "285A");
  
  if (t285.length === 0) {
    console.log(`${day}: 285A取引なし`);
    continue;
  }
  
  // 285Aエントリー時に他銘柄がいたか
  for (const t of t285) {
    const conflicts = trades.filter(tr => 
      tr.symbol !== "285A" && tr.entryTime <= t.entryTime && tr.exitTime >= t.entryTime
    );
    if (conflicts.length > 0) {
      const conflictExposure = conflicts.reduce((s, c) => s + c.entryPrice * c.shares, 0);
      const kioxiaExposure = t.entryPrice * t.shares;
      console.log(`${day} ${t.entryTime}: 285A @${t.entryPrice}x${t.shares}(${kioxiaExposure.toLocaleString()}円) 競合: ${conflicts.map(c => `${c.symbol}(${(c.entryPrice*c.shares).toLocaleString()}円)`).join(", ")} 合計: ${(conflictExposure+kioxiaExposure).toLocaleString()}円 ${conflictExposure+kioxiaExposure > 8910000 ? "★証拠金超過" : "余力あり"}`);
    } else {
      console.log(`${day} ${t.entryTime}: 285A エントリー時に競合なし`);
    }
  }
}

// 5日間合計の比較
console.log("\n\n=== 5日間 日別損益比較 ===");
let totalActual = 0;

for (const day of days) {
  const trades = await getTradesForDay(day);
  const dayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  totalActual += dayPnl;
  console.log(`${day}: ${dayPnl.toLocaleString()}円 (${trades.length}件)`);
}
console.log(`合計: ${totalActual.toLocaleString()}円`);

await conn.end();
