import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL || "");
  const db = drizzle(pool);

  // 1. Check rt_trades for 8035 today
  const trades = await db.execute(sql`
    SELECT tradeTime, action, side, price, pnl, reason
    FROM rt_trades WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    ORDER BY tradeTime ASC
  `);
  console.log(`8035 trades today: ${(trades[0] as any[]).length}`);
  for (const t of (trades[0] as any[])) {
    console.log(`  ${t.tradeTime} ${t.action} ${t.side} @${t.price} pnl=${t.pnl} | ${(t.reason || "").substring(0, 80)}`);
  }

  // 2. Check candle data around 68000 break (09:55-10:20)
  const candles = await db.execute(sql`
    SELECT candleTime, close FROM rt_candles
    WHERE symbol = '8035' AND tradeDate = '2026-07-23'
    AND candleTime BETWEEN '09:55' AND '10:20'
    ORDER BY candleTime ASC
  `);
  console.log(`\n8035 candles 09:55-10:20:`);
  for (const c of (candles[0] as any[])) {
    const close = Number(c.close);
    console.log(`  ${c.candleTime} close=${close} (level=${Math.floor(close / 100) * 100})`);
  }

  // 3. Check score0 blocks for 8035 today
  try {
    const score0 = await db.execute(sql`
      SELECT candleTime, side, signalReason, entryPrice, boardScore
      FROM rt_score0_blocks WHERE symbol = '8035' AND tradeDate = '2026-07-23'
      ORDER BY candleTime ASC
    `);
    console.log(`\n8035 score0 blocks: ${(score0[0] as any[]).length}`);
    for (const s of (score0[0] as any[])) {
      console.log(`  ${s.candleTime} ${s.side} @${s.entryPrice} score=${s.boardScore} | ${(s.signalReason || "").substring(0, 100)}`);
    }
  } catch (e: any) {
    console.log(`\nrt_score0_blocks: ${e.cause?.sqlMessage || e.message}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
