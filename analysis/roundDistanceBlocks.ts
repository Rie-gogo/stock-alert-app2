import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Check if there's a signal_history table or if it's only in-memory
  console.log("■ signalHistory は in-memory のみか DB 保存か確認");
  
  // Check rt_trades for any round_distance_block action
  const r1 = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt
    FROM rt_trades 
    WHERE reason LIKE '%大台乖離率%'
    GROUP BY tradeDate
    ORDER BY tradeDate DESC
    LIMIT 20
  `);
  console.log("\n■ rt_trades内の大台乖離率関連レコード:");
  for (const row of (r1 as any)[0]) {
    console.log(`  ${row.tradeDate}: ${row.cnt}件`);
  }

  // Check if there's a signal_history table
  const r2 = await db.execute(sql`SHOW TABLES LIKE '%signal%'`);
  console.log("\n■ signal関連テーブル:");
  for (const row of (r2 as any)[0]) {
    console.log(`  ${JSON.stringify(row)}`);
  }

  // Check if signalHistory is persisted anywhere
  const r3 = await db.execute(sql`SHOW TABLES LIKE '%history%'`);
  console.log("\n■ history関連テーブル:");
  for (const row of (r3 as any)[0]) {
    console.log(`  ${JSON.stringify(row)}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
