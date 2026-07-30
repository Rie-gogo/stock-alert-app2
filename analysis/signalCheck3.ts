import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Check rt_trades - this might be where the actual signals/trades are recorded
  const totalTrades = await db.execute(sql`SELECT COUNT(*) as cnt FROM rt_trades`);
  console.log(`rt_trades 総レコード数: ${(totalTrades as any)[0][0].cnt}`);
  
  const tradeRange = await db.execute(sql`SELECT MIN(tradeDate) as minD, MAX(tradeDate) as maxD FROM rt_trades`);
  console.log(`日付範囲: ${(tradeRange as any)[0][0].minD} ~ ${(tradeRange as any)[0][0].maxD}`);
  
  // Count by symbol
  const bySymbol = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt 
    FROM rt_trades 
    GROUP BY symbol 
    ORDER BY cnt DESC
  `);
  console.log(`\n=== rt_trades 銘柄別件数（全期間） ===`);
  for (const r of (bySymbol as any)[0]) {
    console.log(`  ${r.symbol}: ${r.cnt}件`);
  }
  
  // Count by date (recent)
  const byDate = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt 
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-14'
    GROUP BY tradeDate 
    ORDER BY tradeDate
  `);
  console.log(`\n=== rt_trades 日別件数（7/14以降） ===`);
  for (const r of (byDate as any)[0]) {
    console.log(`  ${r.tradeDate}: ${r.cnt}件`);
  }
  
  // Check 7/17 for 8035
  const jul17 = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-17'
    ORDER BY tradeTime
  `);
  console.log(`\n=== 7/17のrt_trades詳細 ===`);
  for (const r of (jul17 as any)[0]) {
    console.log(`  ${r.tradeTime} | ${r.symbol} | ${r.action} | ${r.side} | price=${r.price} | pnl=${r.pnl || '-'} | ${r.boardSignal || ''} | ${(r.reason || '').slice(0, 50)}`);
  }
  
  // Check 7/15
  const jul15 = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-15'
    ORDER BY tradeTime
  `);
  console.log(`\n=== 7/15のrt_trades詳細 ===`);
  for (const r of (jul15 as any)[0]) {
    console.log(`  ${r.tradeTime} | ${r.symbol} | ${r.action} | ${r.side} | price=${r.price} | pnl=${r.pnl || '-'} | ${r.boardSignal || ''} | ${(r.reason || '').slice(0, 50)}`);
  }
  
  // Check 7/28 and 7/29
  const jul28 = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-28'
    ORDER BY tradeTime
  `);
  console.log(`\n=== 7/28のrt_trades詳細 ===`);
  for (const r of (jul28 as any)[0]) {
    console.log(`  ${r.tradeTime} | ${r.symbol} | ${r.action} | ${r.side} | price=${r.price} | pnl=${r.pnl || '-'} | ${r.boardSignal || ''} | ${(r.reason || '').slice(0, 50)}`);
  }
  
  const jul29 = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-29'
    ORDER BY tradeTime
  `);
  console.log(`\n=== 7/29のrt_trades詳細 ===`);
  const jul29Rows = (jul29 as any)[0] || [];
  if (jul29Rows.length === 0) {
    console.log(`  (なし)`);
  } else {
    for (const r of jul29Rows) {
      console.log(`  ${r.tradeTime} | ${r.symbol} | ${r.action} | ${r.side} | price=${r.price} | pnl=${r.pnl || '-'} | ${r.boardSignal || ''}`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
