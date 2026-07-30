import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Check how entries are split between pullback and strong trend
  const allEntries = await db.execute(sql`
    SELECT tradeDate, symbol, tradeTime, price, pnl, reason
    FROM rt_trades 
    WHERE action IN ('buy', 'short') AND reason LIKE '%大台確認%'
    ORDER BY tradeDate DESC, tradeTime
    LIMIT 50
  `);
  
  let pullbackCount = 0;
  let strongTrendCount = 0;
  let pullbackPnl = 0;
  let strongTrendPnl = 0;
  
  console.log('=== 大台確認エントリーの内訳（直近50件） ===\n');
  
  for (const t of (allEntries as any)[0]) {
    const isPullback = t.reason.includes('押し目確認後');
    const isStrongTrend = t.reason.includes('押し目なし・強トレンド');
    
    // Find the corresponding exit
    const exit = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${t.tradeDate} AND symbol = ${t.symbol} 
        AND action IN ('sell', 'cover') AND tradeTime > ${t.tradeTime}
      ORDER BY tradeTime LIMIT 1
    `);
    const exitPnl = (exit as any)[0]?.[0]?.pnl ? Number((exit as any)[0][0].pnl) : 0;
    
    if (isPullback) {
      pullbackCount++;
      pullbackPnl += exitPnl;
      console.log(`  [押し目確認] ${t.tradeDate} ${t.tradeTime} | ${t.symbol} | ¥${t.price} | PnL=${exitPnl}`);
    } else if (isStrongTrend) {
      strongTrendCount++;
      strongTrendPnl += exitPnl;
      console.log(`  [強トレンド] ${t.tradeDate} ${t.tradeTime} | ${t.symbol} | ¥${t.price} | PnL=${exitPnl}`);
    } else {
      console.log(`  [その他]     ${t.tradeDate} ${t.tradeTime} | ${t.symbol} | ¥${t.price} | PnL=${exitPnl} | ${t.reason.substring(0, 60)}`);
    }
  }
  
  console.log('\n\n=== 集計 ===');
  console.log(`押し目確認後エントリー: ${pullbackCount}回 | 累計PnL: ${pullbackPnl.toLocaleString()}円 | 平均: ${pullbackCount > 0 ? (pullbackPnl/pullbackCount).toFixed(0) : '-'}円`);
  console.log(`強トレンドエントリー:   ${strongTrendCount}回 | 累計PnL: ${strongTrendPnl.toLocaleString()}円 | 平均: ${strongTrendCount > 0 ? (strongTrendPnl/strongTrendCount).toFixed(0) : '-'}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
