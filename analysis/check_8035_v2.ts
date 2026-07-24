import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL || "");
  const db = drizzle(pool);

  // List tables
  const tables = await db.execute(sql`SHOW TABLES`);
  console.log("Tables:", (tables[0] as any[]).map(r => Object.values(r)[0]).join(", "));

  // Check candle data for 8035 today
  const candles = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
      AND candleTime BETWEEN '09:00' AND '10:30'
    ORDER BY candleTime ASC
  `);
  console.log(`\n=== 8035 1分足 09:00-10:30 (${(candles[0] as any[]).length}件) ===`);
  for (const c of (candles[0] as any[])) {
    console.log(`${c.candleTime} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }

  // Check rt_trades for 8035
  const rtTrades = await db.execute(sql`
    SELECT *
    FROM rt_trades
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY entryTime ASC
  `);
  console.log(`\n=== 8035 本日の取引: ${(rtTrades[0] as any[]).length}件 ===`);
  for (const t of (rtTrades[0] as any[])) {
    console.log(JSON.stringify(t));
  }

  // Check if 8035 is in TARGET_STOCKS or excluded
  const alerts = await db.execute(sql`
    SELECT *
    FROM rt_alerts
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY alertTime ASC
  `);
  console.log(`\n=== 8035 アラート: ${(alerts[0] as any[]).length}件 ===`);
  for (const a of (alerts[0] as any[])) {
    console.log(`${a.alertTime} | ${a.alertType} | ${a.direction} | price=${a.price} | msg=${a.message}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
