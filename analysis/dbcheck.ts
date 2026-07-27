import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-14' AND action = 'entry'
  `);
  console.log("result type:", typeof result);
  console.log("isArray:", Array.isArray(result));
  console.log("keys:", Object.keys(result));
  console.log("result[0]:", JSON.stringify((result as any)[0]).substring(0, 200));
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    console.log("Nested array format, result[0][0]:", JSON.stringify((result as any)[0][0]));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
