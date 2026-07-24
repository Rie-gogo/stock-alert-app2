import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL || "");
  const db = drizzle(pool);

  // Check rt_trades for 8035 today
  const trades = await db.execute(sql`
    SELECT * FROM rt_trades WHERE symbol = '8035' AND tradeDate = '2026-07-23' ORDER BY tradeTime ASC
  `);
  console.log(`=== 8035 本日の取引: ${(trades[0] as any[]).length}件 ===`);
  for (const t of (trades[0] as any[])) {
    console.log(`${t.tradeTime} | ${t.action} | ${t.side} | price=${t.price} | pnl=${t.pnl} | ${t.reason}`);
  }

  // Check rt_alerts for 8035 today
  try {
    const alerts = await db.execute(sql`
      SELECT * FROM rt_alerts WHERE symbol = '8035' AND tradeDate = '2026-07-23' ORDER BY alertTime ASC
    `);
    console.log(`\n=== 8035 アラート: ${(alerts[0] as any[]).length}件 ===`);
    for (const a of (alerts[0] as any[])) {
      console.log(JSON.stringify(a));
    }
  } catch (e: any) {
    console.log(`\nrt_alerts table error: ${e.cause?.sqlMessage || e.message}`);
  }

  // Check shared/stocks.ts to see if 8035 is in TARGET_STOCKS
  console.log("\n=== 8035 がターゲット銘柄に含まれているか確認 ===");
  const { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } = await import("../shared/stocks.js");
  const is8035Target = TARGET_STOCKS.some((s: any) => s.code === "8035");
  const is8035Excluded = TRADE_EXCLUDED_SYMBOLS.includes("8035");
  console.log(`TARGET_STOCKS に含まれる: ${is8035Target}`);
  console.log(`TRADE_EXCLUDED_SYMBOLS に含まれる: ${is8035Excluded}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
