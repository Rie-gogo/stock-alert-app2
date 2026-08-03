import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';
async function main() {
  const db = await getDb();
  const [cols] = await db.execute(sql`SHOW COLUMNS FROM rt_daily_summaries`);
  console.log("=== COLUMNS ===");
  for (const c of cols as any[]) console.log(`  ${c.Field} (${c.Type})`);
  const [rows] = await db.execute(sql`SELECT * FROM rt_daily_summaries WHERE tradeDate >= '2026-07-24' ORDER BY tradeDate ASC`);
  console.log("\n=== WEEKLY DATA ===");
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
main().catch(console.error);
