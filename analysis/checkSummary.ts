import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
async function main() {
  const db = await getDb();
  const r = await db.execute(sql`SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-27'`);
  const rows = (r as any)[0];
  if (rows.length > 0) {
    console.log("Daily summary columns:");
    console.log(JSON.stringify(rows[0], null, 2));
  } else {
    console.log("No summary for 7/27");
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
