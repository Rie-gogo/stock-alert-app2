import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.query(
  `SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = '6981' AND tradeDate = '2026-07-15' AND candleTime >= '09:30' AND candleTime <= '10:30' ORDER BY candleTime ASC`
);

console.log("--- 09:30〜10:30 の値動き ---");
for (const r of rows) {
  const bar = Number(r.close) >= Number(r.open) ? "陽" : "陰";
  console.log(`${r.candleTime} O:${r.open} H:${r.high} L:${r.low} C:${r.close} V:${r.volume} [${bar}]`);
}

// スイングハイ検出（lookback=2）
const candles = rows.map(r => ({ time: r.candleTime, high: Number(r.high), low: Number(r.low), close: Number(r.close), open: Number(r.open) }));

console.log("\n--- スイングハイ（lookback=2）---");
for (let i = 2; i < candles.length - 2; i++) {
  const c = candles[i];
  if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
    console.log(`  ${c.time} HIGH: ${c.high}`);
  }
}

// 10:24時点（エントリー判定時）のスイングハイを確認
console.log("\n--- 10:24時点のスイングハイ（全期間 09:00〜10:24）---");
const [allRows] = await conn.query(
  `SELECT candleTime, open, high, low, close FROM rt_candles WHERE symbol = '6981' AND tradeDate = '2026-07-15' AND candleTime <= '10:24' ORDER BY candleTime ASC`
);
const allCandles = allRows.map(r => ({ time: r.candleTime, high: Number(r.high), low: Number(r.low), close: Number(r.close), open: Number(r.open) }));

const swingHighs = [];
for (let i = 2; i < allCandles.length - 2; i++) {
  const c = allCandles[i];
  if (c.high > allCandles[i-1].high && c.high > allCandles[i-2].high && c.high > allCandles[i+1].high && c.high > allCandles[i+2].high) {
    swingHighs.push({ time: c.time, price: c.high });
  }
}

for (const sh of swingHighs) {
  console.log(`  ${sh.time} HIGH: ${sh.price}`);
}

// 連続切り下げカウント
console.log("\n--- 連続切り下げ（末尾から遡る）---");
let count = 0;
for (let i = swingHighs.length - 1; i > 0; i--) {
  if (swingHighs[i].price < swingHighs[i-1].price) {
    count++;
    console.log(`  ${swingHighs[i].time}(${swingHighs[i].price}) < ${swingHighs[i-1].time}(${swingHighs[i-1].price}) → LH+1`);
  } else {
    console.log(`  ${swingHighs[i].time}(${swingHighs[i].price}) >= ${swingHighs[i-1].time}(${swingHighs[i-1].price}) → 切り下げ途切れ`);
    break;
  }
}
console.log(`連続LH: ${count}`);

// 10:24時点の条件確認
const lastCandle = allCandles[allCandles.length - 1];
const prevCandle = allCandles[allCandles.length - 2];
const openPrice = allCandles[0].open;
console.log(`\n--- 10:24時点の条件 ---`);
console.log(`始値: ${openPrice}`);
console.log(`現在値: ${lastCandle.close}`);
console.log(`始値 > 現在値: ${openPrice > lastCandle.close}`);
console.log(`前足: ${prevCandle.time} C:${prevCandle.close} O:${prevCandle.open} [${prevCandle.close >= prevCandle.open ? "陽" : "陰"}]`);
console.log(`今足: ${lastCandle.time} C:${lastCandle.close} O:${lastCandle.open} [${lastCandle.close >= lastCandle.open ? "陽" : "陰"}]`);
console.log(`陰線転換(前足陽+今足陰): ${prevCandle.close >= prevCandle.open && lastCandle.close < lastCandle.open}`);

// 10:10〜10:25の間の値動きを見る
console.log("\n--- 問題の核心: 10:10以降の値動き ---");
console.log("10:10にTP利確(8,801)後、価格が反発している局面で");
console.log("「3山切り下げ」が成立するのは、09:00〜10:10の古いスイングハイを参照しているため");
console.log("10:10以降に新たな上昇トレンドが始まっている場合、過去の山は無効では？");

await conn.end();
