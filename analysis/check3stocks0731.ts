import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const symbols = ['285A', '6976', '6981'];
  
  for (const sym of symbols) {
    const [count] = await db.execute(sql`
      SELECT COUNT(*) as cnt, MIN(candleTime) as first_bar, MAX(candleTime) as last_bar
      FROM rt_candles
      WHERE tradeDate = '2026-07-31' AND symbol = ${sym}
    `);
    console.log(`${sym}: ${JSON.stringify((count as any[])[0])}`);
  }
  
  // Also check if 285A had any trades
  const [trades285A] = await db.execute(sql`
    SELECT * FROM rt_trades WHERE tradeDate = '2026-07-31' AND symbol = '285A'
  `);
  console.log(`\n285A trades: ${(trades285A as any[]).length}`);
  
  // Check the daily summary for these 3
  const [summaries] = await db.execute(sql`
    SELECT symbol, totalBars, firstBar, lastBar
    FROM rt_daily_summaries
    WHERE tradeDate = '2026-07-31' AND symbol IN ('285A', '6976', '6981')
  `);
  console.log(`\nDaily summaries:`);
  for (const s of summaries as any[]) {
    console.log(`  ${s.symbol}: bars=${s.totalBars} first=${s.firstBar} last=${s.lastBar}`);
  }
  
  process.exit(0);
}
main().catch(console.error);
