import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  // Check how entries and exits are paired
  const trades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, shares, pnl, reason
    FROM rt_trades 
    WHERE tradeDate = '2026-06-18' AND symbol = '5803'
    ORDER BY tradeTime
  `);
  console.log('=== 5803 on 6/18 ===');
  for (const t of (trades as any)[0]) {
    console.log(`  ${t.tradeTime} | ${t.action} | ¥${t.price} | pnl=${t.pnl} | ${t.reason?.substring(0, 60)}`);
  }
  process.exit(0);
}
main().catch(console.error);
