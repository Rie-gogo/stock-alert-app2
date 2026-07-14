import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [cols] = await conn.query("DESCRIBE rt_trades");
console.log("rt_trades columns:", cols.map(c => c.Field).join(", "));
const [sample] = await conn.query("SELECT * FROM rt_trades LIMIT 1");
if (sample.length > 0) console.log("Sample:", JSON.stringify(sample[0], null, 2));

const [cols2] = await conn.query("DESCRIBE rt_candles");
console.log("\nrt_candles columns:", cols2.map(c => c.Field).join(", "));
await conn.end();
