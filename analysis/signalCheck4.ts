import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // rt_trades by date with symbol breakdown (recent 10 days)
  const byDateSymbol = await db.execute(sql`
    SELECT tradeDate, symbol, 
           SUM(CASE WHEN action IN ('buy','short') THEN 1 ELSE 0 END) as entries,
           SUM(CASE WHEN action IN ('sell','cover') THEN 1 ELSE 0 END) as exits,
           SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as totalPnl
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-14'
    GROUP BY tradeDate, symbol
    ORDER BY tradeDate, symbol
  `);
  
  console.log(`=== 直近のrt_trades（エントリー/決済）日別・銘柄別 ===\n`);
  let currentDate = '';
  for (const r of (byDateSymbol as any)[0]) {
    if (r.tradeDate !== currentDate) {
      currentDate = r.tradeDate;
      console.log(`\n[${currentDate}]`);
    }
    console.log(`  ${r.symbol}: エントリー${r.entries}回, 決済${r.exits}回, PnL=${r.totalPnl}`);
  }
  
  // Now check: on days with no trades, was there data received?
  console.log(`\n\n=== 7/27と7/29のデータ受信比較 ===`);
  
  const jul27candles = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt FROM rt_candles WHERE tradeDate = '2026-07-27' GROUP BY symbol ORDER BY symbol
  `);
  console.log(`\n7/27 受信銘柄:`);
  for (const r of (jul27candles as any)[0]) {
    console.log(`  ${r.symbol}: ${r.cnt}本`);
  }
  
  const jul29candles = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt FROM rt_candles WHERE tradeDate = '2026-07-29' GROUP BY symbol ORDER BY symbol
  `);
  console.log(`\n7/29 受信銘柄:`);
  for (const r of (jul29candles as any)[0]) {
    console.log(`  ${r.symbol}: ${r.cnt}本`);
  }

  // Check 7/27 trades
  const jul27trades = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl, side, boardSignal, reason
    FROM rt_trades WHERE tradeDate = '2026-07-27' ORDER BY tradeTime
  `);
  console.log(`\n=== 7/27のrt_trades ===`);
  const jul27Rows = (jul27trades as any)[0] || [];
  if (jul27Rows.length === 0) {
    console.log(`  (なし)`);
  } else {
    for (const r of jul27Rows) {
      console.log(`  ${r.tradeTime} | ${r.symbol} | ${r.action} | ${r.side} | price=${r.price} | pnl=${r.pnl || '-'} | ${r.boardSignal || ''}`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
