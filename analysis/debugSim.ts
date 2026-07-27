import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL!);

async function main() {
  // Check candle count
  const rows = await db.execute(sql`
    SELECT DATE(candleTime) as d, COUNT(*) as cnt, COUNT(DISTINCT symbol) as syms
    FROM rt_candles
    WHERE candleTime >= '2026-07-17'
    GROUP BY DATE(candleTime)
    ORDER BY d
  `);
  console.log("Candle data:");
  console.log(rows.slice(0, 10));
  
  // Check a single row structure
  const sample = await db.execute(sql`
    SELECT * FROM rt_candles WHERE DATE(candleTime) = '2026-07-17' LIMIT 3
  `);
  console.log("\nSample rows:");
  console.log(sample.slice(0, 3));
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
