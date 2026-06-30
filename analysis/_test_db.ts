import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const result = await db!.execute(sql`SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = '2026-06-29'`);
  console.log("type:", typeof result);
  console.log("isArray:", Array.isArray(result));
  console.log("keys:", Object.keys(result));
  console.log("result[0]:", (result as any)[0]);
  // Try accessing rows
  const rows = (result as any).rows || (result as any)[0] || result;
  console.log("rows type:", typeof rows, Array.isArray(rows));
  if (Array.isArray(rows)) {
    console.log("rows[0]:", rows[0]);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
