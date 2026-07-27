import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // 5803 end of day
  const r = await db.execute(sql`
    SELECT candleTime, close FROM rt_candles 
    WHERE tradeDate = '2026-07-24' AND symbol = '5803'
    AND candleTime IN ('15:25', '15:30', '15:00', '14:00', '13:00', '12:30')
    ORDER BY candleTime
  `);
  console.log("5803 key prices:");
  for (const c of (r as any)[0]) {
    console.log(`  ${c.candleTime}: ${Number(c.close)}`);
  }
  
  // Entry was at 4617, SL hit at 4594 (09:54)
  // Let's see what happened after
  const r2 = await db.execute(sql`
    SELECT MIN(close) as dayLow, MAX(close) as dayHigh, 
           (SELECT close FROM rt_candles WHERE tradeDate = '2026-07-24' AND symbol = '5803' AND candleTime = '15:25') as eodClose
    FROM rt_candles WHERE tradeDate = '2026-07-24' AND symbol = '5803' AND candleTime >= '09:42'
  `);
  const stats = (r2 as any)[0][0];
  console.log(`\n5803 after entry (09:42+):`);
  console.log(`  Entry: 4617`);
  console.log(`  SL hit: 4594 (09:54) → -11,543円`);
  console.log(`  Day high after entry: ${Number(stats.dayHigh)}`);
  console.log(`  Day low after entry: ${Number(stats.dayLow)}`);
  console.log(`  EOD close: ${Number(stats.eodClose)}`);
  console.log(`  If held to EOD: ${((Number(stats.eodClose) - 4617) * 500).toLocaleString()}円`);
  console.log(`  TP target (1.5%): ${(4617 * 1.015).toFixed(0)} = ${4686}`);
  console.log(`  Would TP have hit? Day high ${Number(stats.dayHigh)} vs TP ${4686}: ${Number(stats.dayHigh) >= 4686 ? 'YES' : 'NO'}`);
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
