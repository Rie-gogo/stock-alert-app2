import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
import { writeFileSync } from 'fs';

const url = process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// rt_candle_bufferテーブルがあるか確認
const [tables] = await conn.execute("SHOW TABLES LIKE 'rt_candle%'");
console.log("Candle tables:", tables);

// rt_tradesから本日のデータを取得
const [trades] = await conn.execute(
  "SELECT * FROM rt_trades WHERE tradeDate = '2026-06-22' ORDER BY tradeTime ASC"
);
writeFileSync('/home/ubuntu/rt_trades_20260622.json', JSON.stringify(trades, null, 2));
console.log(`Exported ${trades.length} trades`);

// ローソク足バッファがあるか
const [bufTables] = await conn.execute("SHOW TABLES");
const tableNames = bufTables.map(t => Object.values(t)[0]);
console.log("All tables:", tableNames.filter(t => t.includes('candle') || t.includes('rt_')));

await conn.end();
