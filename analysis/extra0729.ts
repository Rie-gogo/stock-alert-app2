import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Check candle time range
  const [timeRange] = await db.execute(sql`
    SELECT MIN(candleTime) as minTime, MAX(candleTime) as maxTime 
    FROM rt_candles WHERE tradeDate = '2026-07-29'
  `);
  console.log("受信時間帯:", (timeRange as any[])[0]);

  // Check if there are any trades in the last few days
  const [recentTrades] = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt, SUM(pnl) as totalPnl
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-28'
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  console.log("\n直近の取引:");
  for (const r of recentTrades as any[]) {
    console.log(`  ${r.tradeDate}: ${r.cnt}件, 損益=${Number(r.totalPnl).toLocaleString()}円`);
  }

  // Check current time (JST)
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  console.log(`\n現在時刻(JST): ${jst.toISOString().replace('T', ' ').substring(0, 19)}`);
  console.log(`現在時刻(UTC): ${now.toISOString()}`);

  // Check the daily summary fields
  const [summaryFields] = await db.execute(sql`
    SHOW COLUMNS FROM rt_daily_summaries
  `);
  console.log("\n【rt_daily_summaries カラム一覧】");
  for (const r of summaryFields as any[]) {
    console.log(`  ${r.Field} (${r.Type})`);
  }

  process.exit(0);
}
main();
