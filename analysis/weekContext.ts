import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Recent daily summaries
  const summaries = await db.execute(sql`
    SELECT tradeDate, totalPnl, tradesCount, winCount, lossCount, candlesReceived
    FROM rt_daily_summaries 
    WHERE tradeDate >= '2026-07-21'
    ORDER BY tradeDate
  `);
  console.log('=== 直近のデイリーサマリー ===');
  console.log('日付       | 総PnL    | 取引数 | 勝 | 負 | 受信足数');
  console.log('-----------|---------|--------|----|----|--------');
  for (const r of (summaries as any)[0]) {
    console.log(`${r.tradeDate} | ${String(r.totalPnl).padStart(7)} | ${String(r.tradesCount).padStart(6)} | ${String(r.winCount).padStart(2)} | ${String(r.lossCount).padStart(2)} | ${r.candlesReceived}`);
  }
  
  // Score0 blocks for today (trading halts)
  const blocks = await db.execute(sql`
    SELECT * FROM rt_score0_blocks WHERE tradeDate = '2026-07-29'
  `);
  const blockRows = (blocks as any)[0] || [];
  console.log(`\n=== 7/29 score0ブロック（取引停止期間） ===`);
  console.log(`件数: ${blockRows.length}`);
  if (blockRows.length > 0) {
    // Check schema first
    const schema = await db.execute(sql`DESCRIBE rt_score0_blocks`);
    console.log('スキーマ:');
    for (const r of (schema as any)[0]) {
      console.log(`  ${r.Field} (${r.Type})`);
    }
    console.log('\nデータ:');
    for (const b of blockRows.slice(0, 10)) {
      console.log(`  ${JSON.stringify(b)}`);
    }
  }
  
  // Auto trade daily for today
  const autoTrade = await db.execute(sql`
    SELECT * FROM auto_trade_daily WHERE tradeDate = '2026-07-29'
  `);
  const autoRows = (autoTrade as any)[0] || [];
  console.log(`\n=== 7/29 auto_trade_daily ===`);
  console.log(`件数: ${autoRows.length}`);
  if (autoRows.length > 0) {
    for (const a of autoRows) {
      console.log(`  ${JSON.stringify(a)}`);
    }
  }

  // Recent week's trades summary by day
  console.log('\n\n=== 直近1週間のトレード詳細 ===');
  const weekTrades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, side, boardSignal, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-21'
    ORDER BY tradeDate, tradeTime
  `);
  let currentDate = '';
  let dayPnl = 0;
  for (const t of (weekTrades as any)[0]) {
    if (t.tradeDate !== currentDate) {
      if (currentDate) console.log(`  → 日計PnL: ${dayPnl}円`);
      currentDate = t.tradeDate;
      dayPnl = 0;
      console.log(`\n[${currentDate}]`);
    }
    if (t.pnl) dayPnl += Number(t.pnl);
    console.log(`  ${t.tradeTime} | ${t.symbol} | ${t.action} | ${t.side} | ¥${t.price} | PnL=${t.pnl || '-'} | ${t.boardSignal || ''}`);
  }
  if (currentDate) console.log(`  → 日計PnL: ${dayPnl}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
