import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  // Get first 3 entries to debug
  const entries = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, shares, pnl, reason
    FROM rt_trades 
    WHERE reason LIKE '%大台確認%'
      AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
    LIMIT 3
  `);
  const entryRows = (entries as any)[0];
  for (const entry of entryRows) {
    console.log(`\n=== ${entry.tradeDate} ${entry.tradeTime} ${entry.symbol} ${entry.action} ===`);
    console.log(`  price=${entry.price}, pnl=${entry.pnl}, shares=${entry.shares}`);
    console.log(`  reason: ${entry.reason}`);
  }
  process.exit(0);
}
main().catch(console.error);
