import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { rtTrades } from "./drizzle/schema.ts";
import { eq, and, like } from "drizzle-orm";

const connection = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(connection);

// Check if there are any blocked trades logged on 7/13
const blocked = await db.select().from(rtTrades)
  .where(and(
    eq(rtTrades.tradeDate, '2026-07-13'),
    like(rtTrades.reason, '%フィルター%')
  ));

console.log(`=== 7/13 フィルターブロック記録 ===`);
console.log(`Count: ${blocked.length}`);
for (const t of blocked) {
  console.log(`[${t.tradeTime}] ${t.symbol} ${t.action} | ${t.reason}`);
}

await connection.end();
process.exit(0);
