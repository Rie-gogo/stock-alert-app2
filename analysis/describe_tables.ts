import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  
  console.log("=== rt_trades ===");
  const [cols1] = await conn.execute("DESCRIBE rt_trades");
  for (const c of cols1 as any[]) console.log(`  ${c.Field} ${c.Type}`);

  console.log("\n=== rt_daily_summaries ===");
  const [cols2] = await conn.execute("DESCRIBE rt_daily_summaries");
  for (const c of cols2 as any[]) console.log(`  ${c.Field} ${c.Type}`);

  await conn.end();
}
main();
