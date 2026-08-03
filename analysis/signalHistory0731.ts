import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Check if there's a signal history table
  const [tables] = await db.execute(sql`SHOW TABLES LIKE 'rt_signal%'`);
  console.log("Signal tables:", JSON.stringify(tables));
  
  // Look at the actual entry trades to understand timing
  const [trades] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    ORDER BY tradeTime ASC
  `);
  console.log("\n=== 6857 trades ===");
  for (const t of trades as any[]) {
    console.log(`  ${t.id} | ${t.tradeTime} | ${t.action} | @${t.price} | ${t.reason}`);
  }
  
  process.exit(0);
}
main().catch(console.error);
