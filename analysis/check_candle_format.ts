import mysql from "mysql2/promise";

async function main() {
  const dbUrl = new URL(process.env.DATABASE_URL!.replace(/\?ssl=.*$/, ""));
  const conn = await mysql.createConnection({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port || "4000"),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
  });

  const [rows] = await conn.query(
    `SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = '8035' AND tradeDate = '2026-08-07' ORDER BY candleTime LIMIT 5`
  );
  console.log("Sample candle data:");
  console.log(JSON.stringify(rows, null, 2));
  
  const [countRows] = await conn.query(
    `SELECT COUNT(*) as cnt FROM rt_candles WHERE symbol = '8035' AND tradeDate = '2026-08-07'`
  );
  console.log("\nTotal candles for 8035 on 2026-08-07:", (countRows as any)[0].cnt);
  
  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
