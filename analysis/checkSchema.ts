import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const t1 = await db.execute(sql`DESCRIBE rt_3peak_signals`);
  console.log("=== rt_3peak_signals ===");
  for (const r of (t1 as any)[0]) console.log(`  ${r.Field} (${r.Type})`);

  const t2 = await db.execute(sql`DESCRIBE rt_trades`);
  console.log("\n=== rt_trades ===");
  for (const r of (t2 as any)[0]) console.log(`  ${r.Field} (${r.Type})`);

  const t3 = await db.execute(sql`DESCRIBE rt_candles`);
  console.log("\n=== rt_candles ===");
  for (const r of (t3 as any)[0]) console.log(`  ${r.Field} (${r.Type})`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
