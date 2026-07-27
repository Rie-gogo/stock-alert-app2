import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 2 });
  const db = drizzle(pool);

  // Get all candles for 8035 today
  const candles = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = '8035' AND tradeDate = '2026-07-24' ORDER BY candleTime ASC`);
  const rows = candles[0] as any[];
  console.log("Total candles:", rows.length);
  console.log("First:", rows[0]?.candleTime, "O:" + rows[0]?.open, "C:" + rows[0]?.close);
  console.log("Last:", rows[rows.length - 1]?.candleTime, "O:" + rows[rows.length - 1]?.open, "C:" + rows[rows.length - 1]?.close);

  // Simulate isBullish with new MA20 slope logic
  const MA_PERIOD = 20;
  const SLOPE_THRESHOLD = -0.03;
  const FALLBACK_THRESHOLD = 0.2;

  console.log("\n=== isBullish simulation (MA20 slope) ===");
  console.log("Time     | Close   | isBullish | Method               | Signal?");

  let firstShortAllowed = "";
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const close = Number(c.close);
    const time = c.candleTime;

    let isBullish: boolean;
    let method: string;

    if (i < 2) {
      isBullish = false;
      method = "too_few";
    } else if (i < MA_PERIOD + 1) {
      const openPrice = Number(rows[0].open);
      const ratio = (close - openPrice) / openPrice * 100;
      isBullish = ratio >= FALLBACK_THRESHOLD;
      method = `fallback(${ratio.toFixed(2)}%)`;
    } else {
      const currentSlice = rows.slice(i - MA_PERIOD + 1, i + 1).map((r: any) => Number(r.close));
      const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / MA_PERIOD;
      const prevSlice = rows.slice(i - MA_PERIOD, i).map((r: any) => Number(r.close));
      const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / MA_PERIOD;
      const slope = (currentMA - prevMA) / prevMA * 100;
      isBullish = slope > SLOPE_THRESHOLD;
      method = `slope(${slope.toFixed(4)}%)`;
    }

    // Check if this is a round level break (大台割れ)
    let roundBreak = false;
    if (i > 0) {
      const prevClose = Number(rows[i - 1].close);
      const step = close >= 10000 ? 100 : 10;
      const prevLevel = Math.floor(prevClose / step) * step;
      const currLevel = Math.floor(close / step) * step;
      if (currLevel < prevLevel) roundBreak = true;
    }

    if (time >= "09:09" && time <= "10:30") {
      const bull = isBullish ? "YES" : "NO ";
      const sig = roundBreak ? "★大台割れ" : "";
      console.log(`${time} | ${String(close).padStart(7)} | ${bull}       | ${method.padEnd(20)} | ${sig}`);
    }

    if (isBullish === false && firstShortAllowed === "" && time >= "09:30") {
      firstShortAllowed = time;
    }
  }

  console.log("\nSHORT初回許可時刻:", firstShortAllowed || "(終日禁止)");

  // Also check: was there a signal that was actually generated?
  // The key question: did the production server have the NEW code or OLD code?
  // The checkpoint was saved at 01:08 UTC (10:08 JST) - AFTER the drop started
  // So during the actual drop (09:09-10:08), the OLD code was running!
  console.log("\n=== 重要: デプロイタイミング ===");
  console.log("MA20傾き方式のチェックポイント保存: 2026-07-24 01:08 UTC (JST 10:08)");
  console.log("8035の急落開始: 09:09 JST (00:09 UTC)");
  console.log("→ 急落時は旧コード（始値比0.2%方式）が稼働していた可能性が高い");

  // Simulate OLD isBullish for comparison
  console.log("\n=== 旧isBullish (始値比0.2%) シミュレーション ===");
  const openPrice = Number(rows[0].open); // 64080
  let oldFirstShortAllowed = "";
  for (let i = 0; i < rows.length; i++) {
    const close = Number(rows[i].close);
    const time = rows[i].candleTime;
    const ratio = (close - openPrice) / openPrice * 100;
    const oldIsBullish = ratio >= 0.2;
    if (oldIsBullish === false && oldFirstShortAllowed === "" && time >= "09:30") {
      oldFirstShortAllowed = time;
    }
  }
  console.log("旧方式SHORT初回許可時刻:", oldFirstShortAllowed || "(終日禁止)");
  console.log("始値:", openPrice, "→ 始値比+0.2% =", Math.round(openPrice * 1.002));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
