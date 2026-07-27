import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-07-24";

  // Check the entry details
  console.log("■ 本日のエントリー詳細");
  const r1 = await db.execute(sql`
    SELECT tradeTime, symbol, symbolName, action, price, shares, amount, reason, side, boardSignal
    FROM rt_trades WHERE tradeDate = ${today} AND (action = 'buy' OR action = 'short')
    ORDER BY tradeTime
  `);
  const entries = (r1 as any)[0];
  for (const e of entries) {
    console.log(`  ${e.tradeTime} ${e.action.toUpperCase()} ${e.symbol}(${e.symbolName}) @${Number(e.price).toLocaleString()} x${e.shares}株`);
    console.log(`    金額: ${Number(e.amount).toLocaleString()}円`);
    console.log(`    理由: ${e.reason}`);
    console.log(`    板シグナル: ${e.boardSignal || 'なし'}`);
  }

  // Check exits
  console.log("\n■ 本日の決済詳細");
  const r2 = await db.execute(sql`
    SELECT tradeTime, symbol, symbolName, action, price, shares, amount, pnl, reason, side
    FROM rt_trades WHERE tradeDate = ${today} AND (action = 'sell' OR action = 'cover')
    ORDER BY tradeTime
  `);
  const exits = (r2 as any)[0];
  for (const e of exits) {
    console.log(`  ${e.tradeTime} ${e.action.toUpperCase()} ${e.symbol}(${e.symbolName}) @${Number(e.price).toLocaleString()} x${e.shares}株`);
    console.log(`    損益: ${Number(e.pnl).toLocaleString()}円`);
    console.log(`    理由: ${e.reason}`);
  }

  // Check if market was open today (candle data received after 15:00)
  const r3 = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM rt_candles 
    WHERE tradeDate = ${today} AND candleTime >= '15:00'
  `);
  const afterClose = (r3 as any)[0][0];
  console.log(`\n■ 市場データ確認`);
  console.log(`  15:00以降のローソク足: ${afterClose.cnt}本 (市場閉場確認)`);

  // Check 5803 price action today
  const r4 = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles WHERE tradeDate = ${today} AND symbol = '5803'
    AND candleTime BETWEEN '09:35' AND '10:00'
    ORDER BY candleTime
  `);
  const candles = (r4 as any)[0];
  console.log(`\n■ 5803(フジクラ) 09:35-10:00 の値動き`);
  for (const c of candles) {
    console.log(`  ${c.candleTime} O:${Number(c.open)} H:${Number(c.high)} L:${Number(c.low)} C:${Number(c.close)} V:${c.volume}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
