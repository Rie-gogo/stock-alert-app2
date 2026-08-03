import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';
async function main() {
  const db = await getDb();
  const [rows] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as firstTime, MAX(candleTime) as lastTime
    FROM rt_candles
    WHERE tradeDate = '2026-07-31'
    GROUP BY symbol
    ORDER BY cnt DESC
  `);
  console.log("=== 7/31 受信状況 ===");
  let total = 0;
  for (const r of rows as any[]) {
    total += Number(r.cnt);
    console.log(`  ${r.symbol}: ${r.cnt}本 (${r.firstTime} ~ ${r.lastTime})`);
  }
  console.log(`\n  合計: ${total}本 / ${(rows as any[]).length}銘柄`);
  
  const allActive = ['285A','5803','6526','6758','6857','6920','6976','6981','8035','8316'];
  const received = (rows as any[]).map((r: any) => r.symbol);
  const missingActive = allActive.filter(s => !received.includes(s));
  console.log(`\n  アクティブ銘柄で未受信: ${missingActive.length > 0 ? missingActive.join(', ') : 'なし'}`);
  
  process.exit(0);
}
main().catch(console.error);
