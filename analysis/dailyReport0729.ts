import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const todayStr = '2026-07-29';
  
  console.log(`=== ${todayStr} リアルタイムシミュレーション結果 ===\n`);

  // 1. rt_trades for today
  const trades = await db.execute(sql`
    SELECT symbol, symbolName, action, tradeTime, price, shares, amount, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = ${todayStr}
    ORDER BY tradeTime
  `);
  const tradeRows = (trades as any)[0] || [];
  console.log(`本日のトレード数: ${tradeRows.length}件`);
  
  if (tradeRows.length > 0) {
    console.log('\n--- トレード詳細 ---');
    for (const t of tradeRows) {
      console.log(`  ${t.tradeTime} | ${t.symbol}(${t.symbolName}) | ${t.action} | ${t.side} | price=${t.price} | shares=${t.shares} | pnl=${t.pnl || '-'} | ${t.boardSignal || ''} | ${(t.reason || '').slice(0, 80)}`);
    }
  }
  
  // 2. rt_daily_summaries for today
  const dailySummary = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${todayStr}
  `);
  const summaryRows = (dailySummary as any)[0] || [];
  console.log(`\nデイリーサマリー: ${summaryRows.length}件`);
  if (summaryRows.length > 0) {
    for (const d of summaryRows) {
      console.log(JSON.stringify(d, null, 2));
    }
  }
  
  // 3. Check rt_daily_summaries schema
  const schema = await db.execute(sql`DESCRIBE rt_daily_summaries`);
  console.log('\n--- rt_daily_summaries スキーマ ---');
  for (const r of (schema as any)[0]) {
    console.log(`  ${r.Field} (${r.Type})`);
  }
  
  // 4. Compare with yesterday (7/28)
  console.log('\n\n=== 比較: 7/28のトレード ===');
  const yesterdayTrades = await db.execute(sql`
    SELECT symbol, symbolName, action, tradeTime, price, shares, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-28'
    ORDER BY tradeTime
  `);
  const yRows = (yesterdayTrades as any)[0] || [];
  console.log(`7/28トレード数: ${yRows.length}件`);
  for (const t of yRows) {
    console.log(`  ${t.tradeTime} | ${t.symbol}(${t.symbolName}) | ${t.action} | ${t.side} | price=${t.price} | pnl=${t.pnl || '-'} | ${t.boardSignal || ''} | ${(t.reason || '').slice(0, 60)}`);
  }
  
  // 5. Check order_instructions for today
  const orders = await db.execute(sql`
    SELECT * FROM order_instructions WHERE tradeDate = ${todayStr}
  `);
  const orderRows = (orders as any)[0] || [];
  console.log(`\n\n=== 7/29 order_instructions ===`);
  console.log(`件数: ${orderRows.length}`);
  if (orderRows.length > 0) {
    for (const o of orderRows) {
      console.log(JSON.stringify(o, null, 2));
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
