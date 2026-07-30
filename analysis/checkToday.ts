import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const todayStr = '2026-07-29';
  
  console.log(`=== ${todayStr} (JST) のシグナル・トレード状況 ===\n`);

  // 3peak signals
  const signals = await db.execute(sql`
    SELECT symbol, direction_3peak, signalTime, entryPrice, exitPrice, exitTime, 
           exit_reason_3peak, virtualPnl, shares, holdBars
    FROM rt_3peak_signals 
    WHERE tradeDate = ${todayStr}
    ORDER BY signalTime DESC
  `);
  const sigRows = (signals as any)[0] || [];
  console.log(`3Peakシグナル数: ${sigRows.length}`);
  if (sigRows.length > 0) {
    for (const s of sigRows) {
      console.log(`  ${s.signalTime} | ${s.symbol} | ${s.direction_3peak} | entry=${s.entryPrice} | exit=${s.exitPrice}(${s.exitTime}) | ${s.exit_reason_3peak} | PnL=${s.virtualPnl}`);
    }
  }
  console.log('');

  // Trades
  const trades = await db.execute(sql`
    SELECT symbol, symbolName, action, price, shares, amount, pnl, reason, tradeTime, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = ${todayStr}
    ORDER BY tradeTime DESC
  `);
  const tradeRows = (trades as any)[0] || [];
  console.log(`本日のトレード数: ${tradeRows.length}`);
  if (tradeRows.length > 0) {
    for (const t of tradeRows) {
      console.log(`  ${t.tradeTime} | ${t.symbol}(${t.symbolName}) | ${t.action} | price=${t.price} | shares=${t.shares} | pnl=${t.pnl || '-'} | ${t.reason || ''}`);
    }
  }
  console.log('');

  // Candle reception summary
  const candles = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as first_t, MAX(candleTime) as last_t
    FROM rt_candles 
    WHERE tradeDate = ${todayStr}
    GROUP BY symbol
    ORDER BY symbol
  `);
  const candleRows = (candles as any)[0] || [];
  console.log(`本日のデータ受信銘柄数: ${candleRows.length}`);
  for (const c of candleRows) {
    console.log(`  ${c.symbol}: ${c.cnt}本 (${c.first_t} ~ ${c.last_t})`);
  }
  console.log('');

  // Daily summary
  const daily = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE trade_date = ${todayStr}
  `);
  const dailyRows = (daily as any)[0] || [];
  console.log(`デイリーサマリー: ${dailyRows.length}件`);
  if (dailyRows.length > 0) {
    for (const d of dailyRows) {
      console.log(`  ${JSON.stringify(d).slice(0, 200)}`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
