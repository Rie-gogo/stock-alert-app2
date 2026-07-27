import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL!);

async function main() {
  // The result is [rows, fields] - need to access [0]
  const result = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt, COUNT(DISTINCT symbol) as syms
    FROM rt_candles
    WHERE tradeDate >= '2026-07-17'
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  // drizzle-orm execute returns rows directly as array
  console.log("Type:", typeof result, Array.isArray(result));
  console.log("Result:", JSON.stringify(result).substring(0, 500));
  
  const sample = await db.execute(sql`
    SELECT symbol, tradeDate, candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-17'
    LIMIT 3
  `);
  console.log("\nSample:", JSON.stringify(sample).substring(0, 500));
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
