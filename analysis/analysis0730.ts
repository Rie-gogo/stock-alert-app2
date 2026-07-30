import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Check the candle data around the entry times to understand market context
  // All entries were between 10:02-10:38, all in buy_pressure (long)
  // Check if there was a gap-up open that reversed
  
  console.log('=== 7/30 寄付き〜10:40の値動き分析 ===\n');
  
  const symbols = ['285A', '8035', '6981', '6976'];
  
  for (const sym of symbols) {
    const candles = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles 
      WHERE tradeDate = '2026-07-30' AND symbol = ${sym}
        AND candleTime >= '08:50' AND candleTime <= '11:00'
      ORDER BY candleTime
      LIMIT 30
    `);
    const rows = (candles as any)[0] || [];
    console.log(`[${sym}] 寄付き〜11:00:`);
    
    if (rows.length > 0) {
      const openPrice = Number(rows[0].open);
      let highOfDay = 0;
      let lowAfterHigh = Infinity;
      let highTime = '';
      
      for (const c of rows) {
        const h = Number(c.high);
        const l = Number(c.low);
        if (h > highOfDay) { highOfDay = h; highTime = c.candleTime; }
      }
      
      // Find the close at 10:40 (around exit time)
      const at1040 = rows.find((r: any) => r.candleTime === '10:40' || r.candleTime === '10:38');
      const closeAt1040 = at1040 ? Number(at1040.close) : 0;
      
      console.log(`  始値: ¥${openPrice} | 高値: ¥${highOfDay}(${highTime}) | 10:40頃: ¥${closeAt1040}`);
      console.log(`  寄付きからの変動: 高値まで+${((highOfDay/openPrice - 1)*100).toFixed(2)}% | 10:40時点${((closeAt1040/openPrice - 1)*100).toFixed(2)}%`);
      
      // Show key candles
      for (const c of rows.slice(0, 15)) {
        console.log(`    ${c.candleTime} | O=${c.open} H=${c.high} L=${c.low} C=${c.close} | Vol=${c.volume}`);
      }
    }
    console.log('');
  }
  
  // Check how many times buy_pressure signal has been losing recently
  console.log('\n=== buy_pressure シグナルの直近成績 ===');
  const bpTrades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, reason
    FROM rt_trades 
    WHERE boardSignal = 'buy_pressure' AND tradeDate >= '2026-07-14'
    ORDER BY tradeDate, tradeTime
  `);
  const bpRows = (bpTrades as any)[0] || [];
  let bpWins = 0, bpLosses = 0, bpTotalPnl = 0;
  for (const t of bpRows) {
    if (t.pnl) {
      const p = Number(t.pnl);
      bpTotalPnl += p;
      if (p > 0) bpWins++; else bpLosses++;
    }
  }
  console.log(`  期間: 7/14〜7/30`);
  console.log(`  エントリー数: ${(bpRows.filter((r: any) => r.action === 'buy' || r.action === 'short')).length}回`);
  console.log(`  勝: ${bpWins} / 負: ${bpLosses} | 勝率: ${((bpWins/(bpWins+bpLosses))*100).toFixed(1)}%`);
  console.log(`  累計PnL: ${bpTotalPnl.toLocaleString()}円`);
  
  // Check sell_pressure for comparison
  console.log('\n=== sell_pressure シグナルの直近成績 ===');
  const spTrades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, reason
    FROM rt_trades 
    WHERE boardSignal = 'sell_pressure' AND tradeDate >= '2026-07-14'
    ORDER BY tradeDate, tradeTime
  `);
  const spRows = (spTrades as any)[0] || [];
  let spWins = 0, spLosses = 0, spTotalPnl = 0;
  for (const t of spRows) {
    if (t.pnl) {
      const p = Number(t.pnl);
      spTotalPnl += p;
      if (p > 0) spWins++; else spLosses++;
    }
  }
  console.log(`  エントリー数: ${(spRows.filter((r: any) => r.action === 'buy' || r.action === 'short')).length}回`);
  console.log(`  勝: ${spWins} / 負: ${spLosses} | 勝率: ${((spWins/(spWins+spLosses))*100).toFixed(1)}%`);
  console.log(`  累計PnL: ${spTotalPnl.toLocaleString()}円`);

  // Check neutral signal
  console.log('\n=== neutral シグナルの直近成績 ===');
  const nTrades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, reason
    FROM rt_trades 
    WHERE boardSignal = 'neutral' AND tradeDate >= '2026-07-14'
    ORDER BY tradeDate, tradeTime
  `);
  const nRows = (nTrades as any)[0] || [];
  let nWins = 0, nLosses = 0, nTotalPnl = 0;
  for (const t of nRows) {
    if (t.pnl) {
      const p = Number(t.pnl);
      nTotalPnl += p;
      if (p > 0) nWins++; else nLosses++;
    }
  }
  console.log(`  エントリー数: ${(nRows.filter((r: any) => r.action === 'buy' || r.action === 'short')).length}回`);
  console.log(`  勝: ${nWins} / 負: ${nLosses} | 勝率: ${nWins+nLosses > 0 ? ((nWins/(nWins+nLosses))*100).toFixed(1) : '-'}%`);
  console.log(`  累計PnL: ${nTotalPnl.toLocaleString()}円`);

  // Holding time analysis for today
  console.log('\n\n=== 7/30 保有時間分析 ===');
  const todayTrades = await db.execute(sql`
    SELECT symbol, action, tradeTime, price, pnl
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30'
    ORDER BY tradeTime
  `);
  const tRows = (todayTrades as any)[0] || [];
  const entries: any[] = [];
  for (const t of tRows) {
    if (t.action === 'buy' || t.action === 'short') {
      entries.push(t);
    } else {
      const entry = entries.find(e => e.symbol === t.symbol);
      if (entry) {
        const entryMin = parseInt(entry.tradeTime.split(':')[0]) * 60 + parseInt(entry.tradeTime.split(':')[1]);
        const exitMin = parseInt(t.tradeTime.split(':')[0]) * 60 + parseInt(t.tradeTime.split(':')[1]);
        const holdMin = exitMin - entryMin;
        console.log(`  ${entry.symbol}: ${entry.tradeTime}→${t.tradeTime} (${holdMin}分) | PnL=${t.pnl}`);
        entries.splice(entries.indexOf(entry), 1);
      }
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
