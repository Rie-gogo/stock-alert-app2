import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
import { writeFileSync } from 'fs';

const url = process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// rt_candlesテーブルの構造を確認
const [desc] = await conn.execute("DESCRIBE rt_candles");
console.log("Columns:", desc.map(d => d.Field).join(", "));

// 本日のローソク足を取得
const [candles] = await conn.execute(
  "SELECT * FROM rt_candles WHERE tradeDate = '2026-06-22' ORDER BY symbol, candleTime ASC"
);
console.log(`Candles count: ${candles.length}`);

writeFileSync('/home/ubuntu/rt_candles_20260622.json', JSON.stringify(candles, null, 2));
console.log("Exported to /home/ubuntu/rt_candles_20260622.json");

await conn.end();
process.exit(0);
