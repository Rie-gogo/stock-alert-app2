import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // 本日のソニー(6758)のトレード
  const [trades] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-31' AND symbol = '6758'
    ORDER BY tradeTime ASC
  `);
  
  console.log("=== 7/31 ソニー(6758) トレード ===\n");
  for (const t of trades as any[]) {
    console.log(`  ${t.tradeTime} | ${t.action} @ ¥${t.price} | ${t.shares}株 | PnL:${t.pnl} | ${t.reason}`);
  }
  if ((trades as any[]).length === 0) {
    console.log("  トレードなし");
  }
  
  // 全銘柄の本日トレード
  console.log("\n=== 7/31 全トレード ===\n");
  const [allTrades] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-31'
    ORDER BY tradeTime ASC
  `);
  
  for (const t of allTrades as any[]) {
    console.log(`  ${t.tradeTime} | ${t.symbol} | ${t.action} @ ¥${t.price} | ${t.shares}株 | PnL:${t.pnl} | ${t.reason?.substring(0, 60)}`);
  }
  if ((allTrades as any[]).length === 0) {
    console.log("  トレードなし");
  }
  
  process.exit(0);
}
main().catch(console.error);
