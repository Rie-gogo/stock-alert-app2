import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Total count
  const total = await db.execute(sql`SELECT COUNT(*) as cnt FROM rt_3peak_signals`);
  console.log(`rt_3peak_signals 総レコード数: ${(total as any)[0][0].cnt}`);
  
  // Date range
  const range = await db.execute(sql`SELECT MIN(tradeDate) as minD, MAX(tradeDate) as maxD FROM rt_3peak_signals`);
  console.log(`日付範囲: ${(range as any)[0][0].minD} ~ ${(range as any)[0][0].maxD}`);
  
  // Count by date
  const byDate = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt 
    FROM rt_3peak_signals 
    GROUP BY tradeDate 
    ORDER BY tradeDate
  `);
  console.log(`\n=== 日別シグナル数 ===`);
  for (const r of (byDate as any)[0]) {
    console.log(`  ${r.tradeDate}: ${r.cnt}件`);
  }
  
  // Count by symbol (all time)
  const bySymbol = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt 
    FROM rt_3peak_signals 
    GROUP BY symbol 
    ORDER BY cnt DESC
  `);
  console.log(`\n=== 銘柄別シグナル数（全期間） ===`);
  for (const r of (bySymbol as any)[0]) {
    console.log(`  ${r.symbol}: ${r.cnt}件`);
  }
  
  // Check 7/17 specifically for 8035
  const jul17 = await db.execute(sql`
    SELECT symbol, direction_3peak, signalTime, entryPrice, virtualPnl, exit_reason_3peak
    FROM rt_3peak_signals 
    WHERE tradeDate = '2026-07-17'
    ORDER BY signalTime
  `);
  console.log(`\n=== 7/17のシグナル詳細 ===`);
  for (const r of (jul17 as any)[0]) {
    console.log(`  ${r.signalTime} | ${r.symbol} | ${r.direction_3peak} | entry=${r.entryPrice} | PnL=${r.virtualPnl} | ${r.exit_reason_3peak}`);
  }
  
  // Check 7/15
  const jul15 = await db.execute(sql`
    SELECT symbol, direction_3peak, signalTime, entryPrice, virtualPnl, exit_reason_3peak
    FROM rt_3peak_signals 
    WHERE tradeDate = '2026-07-15'
    ORDER BY signalTime
  `);
  console.log(`\n=== 7/15のシグナル詳細 ===`);
  for (const r of (jul15 as any)[0]) {
    console.log(`  ${r.signalTime} | ${r.symbol} | ${r.direction_3peak} | entry=${r.entryPrice} | PnL=${r.virtualPnl} | ${r.exit_reason_3peak}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
