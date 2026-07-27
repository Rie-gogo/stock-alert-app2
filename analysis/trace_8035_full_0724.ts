/**
 * 8035 完全シグナルトレース - detectSignals()の出力を全て表示
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { detectSignals } from "../server/routers/stockData";

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 2 });
  const db = drizzle(pool);

  const result = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = '8035' AND tradeDate = '2026-07-24' ORDER BY candleTime ASC`);
  const rows = (result[0] as any[]).map(r => ({
    time: r.candleTime as string,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  console.log(`Total candles: ${rows.length}`);
  console.log(`Range: ${rows[0]?.time} - ${rows[rows.length-1]?.time}`);
  console.log(`Open: ${rows[0]?.open}, Low: ${Math.min(...rows.map(r=>r.low))}, Close: ${rows[rows.length-1]?.close}\n`);

  // Build buffer progressively and run detectSignals
  const buffer: any[] = [];
  let signalCount = 0;
  
  for (const row of rows) {
    buffer.push({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    });

    if (buffer.length < 5) continue; // Need minimum data
    if (row.time < "09:30") continue; // Only show after entry time

    // Run detectSignals on the full buffer
    const withSignals = detectSignals([...buffer]);
    const latest = withSignals[withSignals.length - 1];
    
    if (latest.signal) {
      signalCount++;
      console.log(`[${row.time}] ${latest.signal.type.toUpperCase()} | ${latest.signal.confidence || 'N/A'} | ${latest.signal.reason}`);
    }
  }

  console.log(`\n=== Total signals after 09:30: ${signalCount} ===`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
