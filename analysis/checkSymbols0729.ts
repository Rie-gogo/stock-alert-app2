import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // Check which symbols have candles today
  const [rows] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt 
    FROM rt_candles 
    WHERE tradeDate = '2026-07-29'
    GROUP BY symbol
    ORDER BY symbol
  `);
  
  console.log("=== 本日(7/29)の銘柄別受信数 ===");
  for (const r of rows as any[]) {
    console.log(`${r.symbol}: ${r.cnt}本`);
  }
  
  // Also check yesterday (7/28)
  const [rows2] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt 
    FROM rt_candles 
    WHERE tradeDate = '2026-07-28'
    GROUP BY symbol
    ORDER BY symbol
  `);
  
  console.log("\n=== 昨日(7/28)の銘柄別受信数 ===");
  for (const r of rows2 as any[]) {
    console.log(`${r.symbol}: ${r.cnt}本`);
  }

  // Check 7/27
  const [rows3] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt 
    FROM rt_candles 
    WHERE tradeDate = '2026-07-27'
    GROUP BY symbol
    ORDER BY symbol
  `);
  
  console.log("\n=== 7/27の銘柄別受信数 ===");
  for (const r of rows3 as any[]) {
    console.log(`${r.symbol}: ${r.cnt}本`);
  }

  process.exit(0);
}
main();
