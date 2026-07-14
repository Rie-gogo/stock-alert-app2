/**
 * 285A「始値からの上昇率フィルター」効果検証
 * 
 * 始値から一定%以上上昇した場合、買い(LONG)エントリーを禁止する
 * 逆に、始値から一定%以上下落した場合、売り(SHORT)エントリーを禁止する
 */
import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

console.log("=== 285A 始値からの乖離率フィルター検証 ===\n");

// 各日の285A始値を取得
async function getOpenPrice(day) {
  const [rows] = await conn.query(
    `SELECT close as openPrice FROM rt_candles 
     WHERE symbol='285A' AND tradeDate=? ORDER BY candleTime ASC LIMIT 1`,
    [day]
  );
  return rows.length > 0 ? Number(rows[0].openPrice) : null;
}

// 各日の285A取引を取得
async function get285ATrades(day) {
  const [rows] = await conn.query(
    `SELECT t1.tradeTime as entryTime, t1.price as entryPrice, t1.side, t1.reason,
            t2.tradeTime as exitTime, t2.price as exitPrice, t2.pnl
     FROM rt_trades t1
     JOIN rt_trades t2 ON t2.symbol='285A' AND t2.tradeDate=? 
       AND t2.side = t1.side
       AND ((t1.action='buy' AND t2.action='sell') OR (t1.action='short' AND t2.action='cover'))
       AND t2.id > t1.id
     WHERE t1.symbol='285A' AND t1.tradeDate=?
       AND (t1.action='buy' OR t1.action='short')
     ORDER BY t1.id`,
    [day, day]
  );
  return rows;
}

// 全取引の始値乖離率を計算
const allTrades = [];

for (const day of days) {
  const openPrice = await getOpenPrice(day);
  const trades = await get285ATrades(day);
  
  for (const t of trades) {
    const entryPrice = Number(t.entryPrice);
    const deviation = ((entryPrice - openPrice) / openPrice) * 100;
    const direction = t.side === "long" ? "LONG" : "SHORT";
    const pnl = Number(t.pnl);
    
    allTrades.push({
      day,
      entryTime: t.entryTime,
      direction,
      entryPrice,
      openPrice,
      deviation: deviation.toFixed(2),
      pnl,
      reason: t.reason?.substring(0, 40),
    });
  }
}

console.log("--- 全285A取引の始値乖離率 ---\n");
console.log("日付       | 時刻  | 方向  | 始値    | エントリー | 乖離率  | PnL");
console.log("-".repeat(90));
for (const t of allTrades) {
  const devStr = (Number(t.deviation) >= 0 ? "+" : "") + t.deviation + "%";
  const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString() + "円";
  const flag = (t.direction === "LONG" && Number(t.deviation) > 0) ? " ←買い上昇中" :
               (t.direction === "SHORT" && Number(t.deviation) < 0) ? " ←売り下落中" : "";
  console.log(`${t.day} | ${t.entryTime} | ${t.direction.padEnd(5)} | ${t.openPrice} | ${t.entryPrice.toFixed(0).padStart(6)} | ${devStr.padStart(7)} | ${pnlStr.padStart(12)}${flag}`);
}

// フィルター閾値ごとの効果を計算
console.log("\n\n--- フィルター閾値別の効果 ---");
console.log("「始値から+X%以上上昇時のLONG禁止」+「始値から-X%以上下落時のSHORT禁止」\n");

const thresholds = [2, 3, 4, 5, 6, 7, 8];

console.log("閾値  | ブロック件数 | ブロックPnL合計 | 残取引PnL合計 | 全取引PnL合計 | 効果");
console.log("-".repeat(85));

const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

for (const th of thresholds) {
  const blocked = allTrades.filter(t => 
    (t.direction === "LONG" && Number(t.deviation) >= th) ||
    (t.direction === "SHORT" && Number(t.deviation) <= -th)
  );
  const remaining = allTrades.filter(t => 
    !((t.direction === "LONG" && Number(t.deviation) >= th) ||
      (t.direction === "SHORT" && Number(t.deviation) <= -th))
  );
  
  const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
  const remainingPnl = remaining.reduce((s, t) => s + t.pnl, 0);
  const effect = -blockedPnl; // ブロックしたことによる改善
  
  console.log(`${th}%`.padEnd(6) + `| ${blocked.length}件`.padEnd(12) + `| ${(blockedPnl >= 0 ? "+" : "") + blockedPnl.toLocaleString()}円`.padEnd(16) + `| ${(remainingPnl >= 0 ? "+" : "") + remainingPnl.toLocaleString()}円`.padEnd(14) + `| ${(totalPnl >= 0 ? "+" : "") + totalPnl.toLocaleString()}円`.padEnd(14) + `| ${(effect >= 0 ? "+" : "") + effect.toLocaleString()}円`);
  
  if (blocked.length > 0) {
    for (const b of blocked) {
      console.log(`       → ${b.day} ${b.entryTime} ${b.direction} @${b.entryPrice.toFixed(0)} (乖離${b.deviation}%) PnL:${b.pnl.toLocaleString()}円`);
    }
  }
}

// LONGのみのフィルター（SHORTは制限なし）
console.log("\n\n--- LONGのみフィルター（始値から+X%以上でLONG禁止、SHORTは制限なし）---\n");

console.log("閾値  | ブロック件数 | ブロックPnL合計 | 効果");
console.log("-".repeat(60));

for (const th of thresholds) {
  const blocked = allTrades.filter(t => 
    t.direction === "LONG" && Number(t.deviation) >= th
  );
  
  const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
  const effect = -blockedPnl;
  
  console.log(`${th}%`.padEnd(6) + `| ${blocked.length}件`.padEnd(12) + `| ${(blockedPnl >= 0 ? "+" : "") + blockedPnl.toLocaleString()}円`.padEnd(16) + `| ${(effect >= 0 ? "+" : "") + effect.toLocaleString()}円`);
  
  if (blocked.length > 0) {
    for (const b of blocked) {
      console.log(`       → ${b.day} ${b.entryTime} ${b.direction} @${b.entryPrice.toFixed(0)} (乖離+${b.deviation}%) PnL:${b.pnl.toLocaleString()}円`);
    }
  }
}

await conn.end();
