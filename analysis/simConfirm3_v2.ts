import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// More accurate simulation: 
// With CONFIRM_BARS=3, confirmation finishes 2 bars earlier.
// This means the pullback wait also starts 2 bars earlier.
// For strong trend entries (pullback timeout), entry happens 2 bars earlier.
// For pullback entries, the pullback detection window shifts 2 bars earlier.
// 
// The key question: what was the price 2 bars before the actual entry?
// If the stock is trending up (for buy), 2 bars earlier = lower price = better entry
// If the stock is trending down (for short), 2 bars earlier = higher price = better entry

async function main() {
  const db = await getDb();
  
  const dates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE tradeDate >= '2026-07-16'
    ORDER BY tradeDate DESC LIMIT 10
  `);
  const tradeDates = (dates as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all 大台確認 entries with their exits
  const entries = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, reason, side, shares
    FROM rt_trades 
    WHERE tradeDate >= ${tradeDates[0]} 
      AND reason LIKE '%大台確認%'
      AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
  `);
  const entryRows = (entries as any)[0];
  
  console.log('=== ROUND_LEVEL_CONFIRM_BARS: 5→3 シミュレーション（直近10日） ===\n');
  console.log('前提: 確認バーが2本短縮 → エントリーが2分早くなる');
  console.log('      2分前の終値でエントリーし、同じ損切り幅(%)を適用\n');
  
  let totalCurrentPnl = 0;
  let totalSimPnl = 0;
  
  const dailyResults: Record<string, { current: number; sim: number }> = {};
  for (const d of tradeDates) dailyResults[d] = { current: 0, sim: 0 };
  
  for (const entry of entryRows) {
    const date = entry.tradeDate;
    const symbol = entry.symbol;
    const entryTime = entry.tradeTime;
    const entryPrice = Number(entry.price);
    const side = entry.action === 'buy' ? 'long' : 'short';
    const isStrongTrend = entry.reason.includes('押し目なし・強トレンド');
    const isPullback = entry.reason.includes('押し目確認後');
    
    // Find exit
    const exitResult = await db.execute(sql`
      SELECT tradeTime, price, pnl, reason FROM rt_trades 
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND action IN ('sell', 'cover') AND tradeTime > ${entryTime}
      ORDER BY tradeTime LIMIT 1
    `);
    const exit = (exitResult as any)[0][0];
    if (!exit) continue;
    
    const exitPrice = Number(exit.price);
    const actualPnl = Number(exit.pnl) || 0;
    totalCurrentPnl += actualPnl;
    dailyResults[date].current += actualPnl;
    
    // Get candle 2 bars before entry
    const prevCandles = await db.execute(sql`
      SELECT candleTime, close FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${symbol} AND candleTime < ${entryTime}
      ORDER BY candleTime DESC LIMIT 3
    `);
    const prevRows = (prevCandles as any)[0];
    
    // 2 bars earlier close price
    const simEntryPrice = prevRows.length >= 2 ? Number(prevRows[1].close) : entryPrice;
    
    // Calculate stop loss distance (% from entry)
    const stopPct = Math.abs(exitPrice - entryPrice) / entryPrice;
    
    // For the sim, apply same stop % from new entry price
    // But actually we should simulate what happens with the new entry price
    // Get candles from sim entry time onwards
    const simEntryTime = prevRows.length >= 2 ? prevRows[1].candleTime : entryTime;
    
    const afterCandles = await db.execute(sql`
      SELECT candleTime, open, high, low, close FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime >= ${simEntryTime}
      ORDER BY candleTime LIMIT 60
    `);
    const afterRows = (afterCandles as any)[0];
    
    // Apply same stop loss % and take profit %
    // From the actual system: stop loss is ~0.5% (varies by symbol)
    // Let's use the actual stop distance
    const isStopLoss = exit.reason.includes('損切り');
    const isTakeProfit = exit.reason.includes('利確');
    
    let simExitPrice: number;
    let simExitReason: string;
    
    if (isStopLoss) {
      // Stop loss: same % distance from new entry
      const stopLine = side === 'long' 
        ? simEntryPrice * (1 - stopPct)
        : simEntryPrice * (1 + stopPct);
      
      // Check if stop is hit
      let hitStop = false;
      for (const c of afterRows) {
        if (side === 'long' && Number(c.low) <= stopLine) {
          simExitPrice = stopLine;
          simExitReason = '損切り';
          hitStop = true;
          break;
        }
        if (side === 'short' && Number(c.high) >= stopLine) {
          simExitPrice = stopLine;
          simExitReason = '損切り';
          hitStop = true;
          break;
        }
      }
      if (!hitStop) {
        // If stop not hit with earlier entry, use actual exit time's price
        const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
        simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : simEntryPrice;
        simExitReason = '時間切れ';
      }
    } else if (isTakeProfit) {
      // Take profit: same % distance from new entry
      const tpLine = side === 'long'
        ? simEntryPrice * (1 + stopPct)
        : simEntryPrice * (1 - stopPct);
      
      // Actually for take profit, use the actual TP ratio
      const tpPct = Math.abs(exitPrice - entryPrice) / entryPrice;
      const tpLineSim = side === 'long'
        ? simEntryPrice * (1 + tpPct)
        : simEntryPrice * (1 - tpPct);
      
      let hitTp = false;
      for (const c of afterRows) {
        if (side === 'long' && Number(c.high) >= tpLineSim) {
          simExitPrice = tpLineSim;
          simExitReason = '利確';
          hitTp = true;
          break;
        }
        if (side === 'short' && Number(c.low) <= tpLineSim) {
          simExitPrice = tpLineSim;
          simExitReason = '利確';
          hitTp = true;
          break;
        }
      }
      if (!hitTp) {
        const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
        simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : simEntryPrice;
        simExitReason = '時間切れ';
      }
    } else {
      // Other exit (forced, time-based): use same exit time
      const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
      simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : exitPrice;
      simExitReason = exit.reason.substring(0, 20);
    }
    
    // Calculate sim PnL using actual shares
    const shares = actualPnl !== 0 ? Math.round(Math.abs(actualPnl) / Math.abs(exitPrice - entryPrice)) : 100;
    const simPnlTrade = side === 'long' 
      ? Math.round((simExitPrice! - simEntryPrice) * shares)
      : Math.round((simEntryPrice - simExitPrice!) * shares);
    
    totalSimPnl += simPnlTrade;
    dailyResults[date].sim += simPnlTrade;
    
    const tag = isStrongTrend ? '強トレンド' : isPullback ? '押し目確認' : 'その他';
    const diff = simPnlTrade - actualPnl;
    console.log(`[${tag}] ${date} ${entryTime} | ${symbol} ${side.toUpperCase()}`);
    console.log(`  現行: ¥${entryPrice} → ¥${exitPrice} | PnL=${actualPnl.toLocaleString()}円 (${exit.reason.substring(0, 15)})`);
    console.log(`  3本:  ¥${simEntryPrice} → ¥${Math.round(simExitPrice!)} | PnL=${simPnlTrade.toLocaleString()}円 (${simExitReason!}) | 差分=${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
    console.log('');
  }
  
  console.log('\n=== 日別サマリー ===\n');
  console.log('日付         | 現行(5本)    | 改善(3本)    | 差分');
  console.log('-------------|-------------|-------------|--------');
  let totalDiff = 0;
  for (const d of tradeDates) {
    const s = dailyResults[d];
    if (s.current === 0 && s.sim === 0) continue;
    const diff = s.sim - s.current;
    totalDiff += diff;
    console.log(`${d} | ${s.current.toLocaleString().padStart(11)}円 | ${s.sim.toLocaleString().padStart(11)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
  }
  
  console.log('\n=== 総合結果 ===\n');
  console.log(`現行（CONFIRM_BARS=5）: 総PnL = ${totalCurrentPnl.toLocaleString()}円`);
  console.log(`改善（CONFIRM_BARS=3）: 総PnL = ${totalSimPnl.toLocaleString()}円`);
  console.log(`差分: ${totalDiff >= 0 ? '+' : ''}${totalDiff.toLocaleString()}円`);
  console.log(`改善率: ${totalCurrentPnl !== 0 ? ((totalDiff / Math.abs(totalCurrentPnl)) * 100).toFixed(1) : '-'}%`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
