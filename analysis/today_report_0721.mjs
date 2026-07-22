import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 3peak signals
const [peaks] = await conn.execute("SELECT * FROM rt_3peak_signals WHERE tradeDate = '2026-07-21' ORDER BY signalTime");
console.log("=== 3peak signals (7/21) ===");
for (const p of peaks) {
  console.log(`  ${p.symbol} ${p.signalType} @${p.signalTime} entry=${p.entryPrice} tp=${p.tpPrice} sl=${p.slPrice} status=${p.status} exit=${p.exitPrice} pnl=${p.pnl}`);
}

// Check for blocked signals (from candles data - look for round distance blocks)
// We need to check what signals were generated but blocked
const [candles6981] = await conn.execute(
  "SELECT candleTime, open, high, low, close FROM rt_candles WHERE symbol = '6981' AND tradeDate = '2026-07-21' AND candleTime BETWEEN '10:40' AND '10:50' ORDER BY candleTime"
);
console.log("\n=== 6981 candles around trade time (10:40-10:50) ===");
for (const c of candles6981) {
  console.log(`  ${c.candleTime} O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
}

// Check entry details - round distance
const entryPrice = 7443;
const roundLevel = 7500;
const divergence = Math.abs(entryPrice - roundLevel) / roundLevel;
console.log(`\n=== 6981 エントリー分析 ===`);
console.log(`  エントリー価格: ${entryPrice}円`);
console.log(`  大台: ${roundLevel}円`);
console.log(`  乖離率: ${(divergence * 100).toFixed(2)}% (閾値0.8%以下で通過)`);
console.log(`  判定: ${divergence <= 0.008 ? '通過' : 'ブロック'}`);

// Check other symbols that might have been blocked today
const activeSymbols = ['8035', '6857', '6976', '6526', '5803', '6981', '285A'];
console.log("\n=== アクティブ銘柄の本日の値動き ===");
for (const sym of activeSymbols) {
  const [first] = await conn.execute(
    "SELECT open FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-21' ORDER BY candleTime ASC LIMIT 1", [sym]
  );
  const [last] = await conn.execute(
    "SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = '2026-07-21' ORDER BY candleTime DESC LIMIT 1", [sym]
  );
  if (first.length > 0 && last.length > 0) {
    const o = Number(first[0].open);
    const c = Number(last[0].close);
    const chg = ((c - o) / o * 100).toFixed(2);
    console.log(`  ${sym}: 始値=${o} 終値=${c} 変動=${chg}%`);
  }
}

await conn.end();
