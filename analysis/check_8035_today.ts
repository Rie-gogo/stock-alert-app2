import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL!);
  const db = drizzle(pool);

  // Get today's signal history for 8035
  const signals = await db.execute(sql`
    SELECT * FROM rt_signal_history
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY signalTime ASC
  `);
  console.log("=== 8035 東京エレクトロン シグナル履歴 (7/23) ===");
  console.log(`件数: ${(signals[0] as any[]).length}`);
  for (const s of (signals[0] as any[])) {
    console.log(`${s.signalTime} | ${s.direction} | ${s.signalType} | entry=${s.entryPrice} | status=${s.status} | reason=${s.reason || ''}`);
  }

  // Check candle data around 09:30-10:30 for 8035
  const candles = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
      AND candleTime BETWEEN '09:00' AND '10:30'
    ORDER BY candleTime ASC
  `);
  console.log("\n=== 8035 1分足データ 09:00-10:30 ===");
  for (const c of (candles[0] as any[])) {
    console.log(`${c.candleTime} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }

  // Check score0 blocks for 8035
  const score0 = await db.execute(sql`
    SELECT * FROM rt_score0_blocks
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY signalTime ASC
  `);
  console.log(`\n=== 8035 スコア0ブロック: ${(score0[0] as any[]).length}件 ===`);
  for (const s of (score0[0] as any[])) {
    console.log(`${s.signalTime} | ${s.direction} | ${s.signalType} | price=${s.price} | boardScore=${s.boardScore} | confidence=${s.confidence}`);
  }

  // Check rt_trades for 8035 today
  const rtTrades = await db.execute(sql`
    SELECT * FROM rt_trades
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY entryTime ASC
  `);
  console.log(`\n=== 8035 本日の取引: ${(rtTrades[0] as any[]).length}件 ===`);
  for (const t of (rtTrades[0] as any[])) {
    console.log(`${t.entryTime}-${t.exitTime} | ${t.direction} | entry=${t.entryPrice} exit=${t.exitPrice} | ${t.exitReason} | pnl=${t.pnl}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
