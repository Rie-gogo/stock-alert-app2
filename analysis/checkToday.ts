import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
async function main() {
  const db = await getDb();
  const r1 = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt FROM rt_candles 
    GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 5
  `);
  console.log("Latest candle dates:");
  for (const row of (r1 as any)[0]) {
    console.log(`  ${row.tradeDate}: ${row.cnt} candles`);
  }
  const r2 = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt FROM rt_trades 
    GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 5
  `);
  console.log("\nLatest trade dates:");
  for (const row of (r2 as any)[0]) {
    console.log(`  ${row.tradeDate}: ${row.cnt} trades`);
  }
  const r3 = await db.execute(sql`
    SELECT tradeDate, dailyPnl, tradeCount, winRate FROM rt_daily_summaries 
    ORDER BY tradeDate DESC LIMIT 5
  `);
  console.log("\nLatest daily summaries:");
  for (const row of (r3 as any)[0]) {
    console.log(`  ${row.tradeDate}: PnL=${Number(row.dailyPnl).toLocaleString()}, trades=${row.tradeCount}, WR=${row.winRate}%`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
