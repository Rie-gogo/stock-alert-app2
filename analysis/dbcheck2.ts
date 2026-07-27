import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  // Check what actions exist
  const r1 = await db.execute(sql`SELECT DISTINCT action FROM rt_trades LIMIT 10`);
  console.log("Actions:", JSON.stringify((r1 as any)[0]));
  
  // Check total count and date range
  const r2 = await db.execute(sql`SELECT MIN(tradeDate) as minD, MAX(tradeDate) as maxD, COUNT(*) as cnt FROM rt_trades`);
  console.log("Date range:", JSON.stringify((r2 as any)[0]));
  
  // Check recent entries
  const r3 = await db.execute(sql`SELECT tradeDate, COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-14' GROUP BY tradeDate ORDER BY tradeDate`);
  console.log("Trades by date (7/14+):", JSON.stringify((r3 as any)[0]));
  
  // Check what's in 7/14
  const r4 = await db.execute(sql`SELECT tradeDate, tradeTime, symbol, side, action, SUBSTRING(reason, 1, 80) as reason FROM rt_trades WHERE tradeDate = '2026-07-14' LIMIT 10`);
  console.log("7/14 trades:", JSON.stringify((r4 as any)[0]));
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
