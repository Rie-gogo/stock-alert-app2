import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
async function main() {
  const db = await getDb();
  // Check candle time range for today
  const r1 = await db.execute(sql`
    SELECT MIN(candleTime) as firstTime, MAX(candleTime) as lastTime, 
           COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols
    FROM rt_candles WHERE tradeDate = '2026-07-27'
  `);
  const c = (r1 as any)[0][0];
  console.log(`7/27 candles: ${c.cnt} (${c.symbols} symbols), ${c.firstTime} - ${c.lastTime}`);
  
  // Check if there are any trades at all for today
  const r2 = await db.execute(sql`
    SELECT * FROM rt_trades WHERE tradeDate = '2026-07-27'
  `);
  console.log(`\n7/27 trades: ${(r2 as any)[0].length} records`);
  
  // Check daily summary for today
  const r3 = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-27'
  `);
  const summaries = (r3 as any)[0];
  console.log(`\n7/27 daily summary: ${summaries.length} records`);
  if (summaries.length > 0) {
    const s = summaries[0];
    console.log(`  dailyPnl: ${s.dailyPnl}, tradeCount: ${s.tradeCount}, winRate: ${s.winRate}`);
  }

  // Check current time in JST
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  console.log(`\nCurrent JST: ${jst.toISOString().replace('T', ' ').slice(0, 19)}`);
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
