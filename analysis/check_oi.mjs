import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || "3306"),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: true },
});

const [rows] = await conn.query("SELECT * FROM order_instructions WHERE tradeDate = ? LIMIT 8", ["2026-07-09"]);
for (const r of rows) {
  console.log(`ID=${r.id} | ${r.symbol}(${r.symbolName}) | side=${r.oi_side} | type=${r.oi_instruction_type} | qty=${r.qty} | status=${r.oi_status} | refPrice=${r.referencePrice} | rtTradeId=${r.rtTradeId}`);
}
await conn.end();
process.exit(0);
