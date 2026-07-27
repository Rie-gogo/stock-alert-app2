import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Daily trade counts (entries only)
  console.log("■ 日別エントリー件数 (7/1-7/24)");
  const r1 = await db.execute(sql`
    SELECT tradeDate, 
           COUNT(*) as entries,
           SUM(CASE WHEN action='buy' THEN 1 ELSE 0 END) as buys,
           SUM(CASE WHEN action='short' THEN 1 ELSE 0 END) as shorts
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-24'
    AND (action = 'buy' OR action = 'short')
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  for (const row of (r1 as any)[0]) {
    const marker = row.tradeDate >= '2026-07-17' ? ' ★' : '';
    console.log(`  ${row.tradeDate}: ${row.entries}件 (BUY:${row.buys} SHORT:${row.shorts})${marker}`);
  }

  // Average before/after
  const r2 = await db.execute(sql`
    SELECT 
      CASE WHEN tradeDate < '2026-07-17' THEN 'before' ELSE 'after' END as period,
      COUNT(*) / COUNT(DISTINCT tradeDate) as avgPerDay,
      SUM(CASE WHEN action='buy' THEN 1 ELSE 0 END) / COUNT(DISTINCT tradeDate) as avgBuy,
      SUM(CASE WHEN action='short' THEN 1 ELSE 0 END) / COUNT(DISTINCT tradeDate) as avgShort
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-24'
    AND (action = 'buy' OR action = 'short')
    GROUP BY CASE WHEN tradeDate < '2026-07-17' THEN 'before' ELSE 'after' END
  `);
  console.log("\n■ 平均エントリー件数比較");
  for (const row of (r2 as any)[0]) {
    console.log(`  ${row.period}: ${Number(row.avgPerDay).toFixed(1)}件/日 (BUY:${Number(row.avgBuy).toFixed(1)} SHORT:${Number(row.avgShort).toFixed(1)})`);
  }

  // Check what code changes happened around 7/16
  console.log("\n■ 7/14-7/17のコード変更を確認する必要あり (git log)");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
