import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT * FROM rt_score0_blocks
    WHERE symbol = '285A' AND trade_date = '2026-08-17'
    ORDER BY candle_time
  `);
  const blocks = (rows as any)[0] as any[];
  console.log(`8/17 285Aのスコア0ブロック: ${blocks.length}件`);
  for (const block of blocks) {
    console.log(JSON.stringify(block));
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
