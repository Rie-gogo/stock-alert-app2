import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.query(`SHOW TABLES`);
for (const r of rows) console.log(Object.values(r)[0]);
await conn.end();
