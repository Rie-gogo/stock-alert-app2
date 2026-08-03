import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30'
    ORDER BY tradeTime ASC, id ASC
  `);
  
  console.log("Type:", typeof result);
  console.log("Is array:", Array.isArray(result));
  console.log("Length:", (result as any).length);
  
  // Check if it's [rows, fields] tuple
  if (Array.isArray(result) && result.length === 2) {
    console.log("Rows type:", typeof result[0]);
    console.log("Rows length:", (result[0] as any[]).length);
    if ((result[0] as any[]).length > 0) {
      console.log("First row:", JSON.stringify(result[0][0]));
    }
  } else {
    // Maybe it's just rows
    const rows = result as any[];
    console.log("Rows count:", rows.length);
    if (rows.length > 0) {
      console.log("First row:", JSON.stringify(rows[0]));
    }
  }
  
  process.exit(0);
}
main().catch(console.error);
