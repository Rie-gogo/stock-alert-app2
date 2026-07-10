import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [cols] = await conn.query('DESCRIBE order_instructions');
console.log(cols.map(c => `${c.Field} ${c.Type}`).join('\n'));
await conn.end();
