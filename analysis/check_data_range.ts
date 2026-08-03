import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);
  const [rows] = await conn.execute(
    "SELECT MIN(tradeDate) as minDate, MAX(tradeDate) as maxDate, COUNT(DISTINCT tradeDate) as days FROM rt_candles"
  );
  console.log("Data range:", JSON.stringify(rows));
  
  const [dates] = await conn.execute(
    "SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate"
  );
  console.log("All dates:", JSON.stringify(dates));
  await conn.end();
}
main().catch(console.error);
