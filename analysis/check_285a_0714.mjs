import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 7/14の285A取引
const [trades] = await conn.query(
  `SELECT tradeTime, action, side, price, pnl, reason FROM rt_trades WHERE symbol='285A' AND tradeDate='2026-07-14' ORDER BY id`
);
console.log("=== 7/14 285A取引 ===");
console.table(trades);

// エントリー1: 10:29 BUY → 11:00 SELL (SL)
console.log("\n=== エントリー1周辺 (10:25〜11:05) ===");
const [c1] = await conn.query(
  `SELECT candleTime as time, open, high, low, close FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime BETWEEN '10:25' AND '11:05'
   ORDER BY candleTime`
);
for (const c of c1) {
  const entryPrice = 67460;
  const sl = Math.round(entryPrice * 0.99); // 66785
  const tp = Math.round(entryPrice * 1.03); // 69484
  const marker = Number(c.low) <= sl ? " ★SL HIT" : Number(c.high) >= tp ? " ★TP HIT" : "";
  console.log(`  ${c.time} | O:${c.open} H:${c.high} L:${c.low} C:${c.close}${marker}`);
}

// エントリー2: 14:36 BUY → 14:41 SELL (SL)
console.log("\n=== エントリー2周辺 (14:30〜14:50) ===");
const [c2] = await conn.query(
  `SELECT candleTime as time, open, high, low, close FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime BETWEEN '14:30' AND '14:50'
   ORDER BY candleTime`
);
for (const c of c2) {
  const entryPrice = 69610;
  const sl = Math.round(entryPrice * 0.99); // 68914
  const tp = Math.round(entryPrice * 1.03); // 71698
  const marker = Number(c.low) <= sl ? " ★SL HIT" : Number(c.high) >= tp ? " ★TP HIT" : "";
  console.log(`  ${c.time} | O:${c.open} H:${c.high} L:${c.low} C:${c.close}${marker}`);
}

// 全体の値動き（日中高値・安値）
console.log("\n=== 7/14 285A 日中サマリー ===");
const [summary] = await conn.query(
  `SELECT MIN(low) as dayLow, MAX(high) as dayHigh, 
   (SELECT close FROM rt_candles WHERE symbol='285A' AND tradeDate='2026-07-14' ORDER BY candleTime ASC LIMIT 1) as openPrice,
   (SELECT close FROM rt_candles WHERE symbol='285A' AND tradeDate='2026-07-14' ORDER BY candleTime DESC LIMIT 1) as closePrice
   FROM rt_candles WHERE symbol='285A' AND tradeDate='2026-07-14'`
);
console.table(summary);

// 10:29エントリー後の最大逆行と最大順行
console.log("\n=== エントリー1 (10:29 LONG @67460) 後の値動き ===");
const [after1] = await conn.query(
  `SELECT candleTime as time, high, low FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime >= '10:29'
   ORDER BY candleTime`
);
let maxAdverse1 = 0, maxFavor1 = 0;
for (const c of after1) {
  const adverse = 67460 - Number(c.low);
  const favor = Number(c.high) - 67460;
  if (adverse > maxAdverse1) maxAdverse1 = adverse;
  if (favor > maxFavor1) maxFavor1 = favor;
}
console.log(`  最大逆行(MAE): ${maxAdverse1}円 (${(maxAdverse1/67460*100).toFixed(2)}%)`);
console.log(`  最大順行(MFE): ${maxFavor1}円 (${(maxFavor1/67460*100).toFixed(2)}%)`);
console.log(`  SL: ${Math.round(67460*0.01)}円 (1%)`);

// 14:36エントリー後の最大逆行と最大順行
console.log("\n=== エントリー2 (14:36 LONG @69610) 後の値動き ===");
const [after2] = await conn.query(
  `SELECT candleTime as time, high, low FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime >= '14:36'
   ORDER BY candleTime`
);
let maxAdverse2 = 0, maxFavor2 = 0;
for (const c of after2) {
  const adverse = 69610 - Number(c.low);
  const favor = Number(c.high) - 69610;
  if (adverse > maxAdverse2) maxAdverse2 = adverse;
  if (favor > maxFavor2) maxFavor2 = favor;
}
console.log(`  最大逆行(MAE): ${maxAdverse2}円 (${(maxAdverse2/69610*100).toFixed(2)}%)`);
console.log(`  最大順行(MFE): ${maxFavor2}円 (${(maxFavor2/69610*100).toFixed(2)}%)`);
console.log(`  SL: ${Math.round(69610*0.01)}円 (1%)`);

// エントリー後にTPに到達したか確認
console.log("\n=== エントリー1: SL後にTPレベルに到達したか ===");
const tp1 = Math.round(67460 * 1.03); // 69484
const [reachTP1] = await conn.query(
  `SELECT candleTime as time, high FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime > '11:00' AND high >= ?
   ORDER BY candleTime LIMIT 1`,
  [tp1]
);
if (reachTP1.length > 0) {
  console.log(`  → ${reachTP1[0].time}にTP水準(${tp1})到達 (high=${reachTP1[0].high})`);
} else {
  console.log(`  → TP水準(${tp1})には未到達`);
}

console.log("\n=== エントリー2: SL後にTPレベルに到達したか ===");
const tp2 = Math.round(69610 * 1.03); // 71698
const [reachTP2] = await conn.query(
  `SELECT candleTime as time, high FROM rt_candles 
   WHERE symbol='285A' AND tradeDate='2026-07-14' AND candleTime > '14:41' AND high >= ?
   ORDER BY candleTime LIMIT 1`,
  [tp2]
);
if (reachTP2.length > 0) {
  console.log(`  → ${reachTP2[0].time}にTP水準(${tp2})到達 (high=${reachTP2[0].high})`);
} else {
  console.log(`  → TP水準(${tp2})には未到達`);
}

// 日中の大きな流れ
console.log("\n=== 7/14 285A 30分足サマリー ===");
const [bars30] = await conn.query(
  `SELECT 
    CONCAT(LPAD(HOUR(STR_TO_DATE(candleTime, '%H:%i')), 2, '0'), ':', 
           LPAD(FLOOR(MINUTE(STR_TO_DATE(candleTime, '%H:%i'))/30)*30, 2, '0')) as period,
    MIN(low) as low, MAX(high) as high,
    SUBSTRING_INDEX(GROUP_CONCAT(close ORDER BY candleTime ASC), ',', 1) as open_price,
    SUBSTRING_INDEX(GROUP_CONCAT(close ORDER BY candleTime DESC), ',', 1) as close_price
   FROM rt_candles WHERE symbol='285A' AND tradeDate='2026-07-14'
   GROUP BY period ORDER BY period`
);
for (const b of bars30) {
  console.log(`  ${b.period} | O:${b.open_price} H:${b.high} L:${b.low} C:${b.close_price}`);
}

await conn.end();
