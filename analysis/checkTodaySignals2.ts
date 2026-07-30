import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // List all tables
  const tables = await db.execute(sql`SHOW TABLES`);
  const tableRows = (tables as any)[0] || tables;
  console.log("=== テーブル一覧 ===");
  for (const t of tableRows) {
    console.log(`  ${Object.values(t)[0]}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
