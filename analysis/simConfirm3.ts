import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Get last 10 trading days
  const dates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE tradeDate >= '2026-07-14'
    ORDER BY tradeDate DESC LIMIT 10
  `);
  const tradeDates = (dates as any)[0].map((r: any) => r.tradeDate).reverse();
  console.log('直近10営業日:', tradeDates.join(', '));
  
  // Get all trades that involve 大台確認 in these dates
  const trades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, pnl, reason, side
    FROM rt_trades 
    WHERE tradeDate >= ${tradeDates[0]} AND tradeDate <= ${tradeDates[tradeDates.length - 1]}
    ORDER BY tradeDate, tradeTime
  `);
  const allTrades = (trades as any)[0];
  
  // Separate: 
  // 1. 大台確認(5本維持) entries with "押し目なし・強トレンド" → these would change with CONFIRM_BARS=3
  // 2. 大台確認(5本維持) entries with "押し目確認後" → timing would change (2 min earlier)
  // 3. Other entries → unchanged
  
  // For the simulation, we need to understand:
  // With CONFIRM_BARS=3 instead of 5:
  // - The confirmation completes 2 minutes earlier
  // - The pullback wait starts 2 minutes earlier
  // - If pullback happens within the original 5-bar window, it might now be caught
  // - If strong trend entry happens, it happens 2 minutes earlier (at a lower price in uptrend)
  
  // To properly simulate, we need the candle data around each entry
  console.log('\n=== 大台確認エントリーの分析（直近10日） ===\n');
  
  let currentPnl = 0;
  let simPnl = 0;
  let entryCount = 0;
  let simEntryCount = 0;
  
  const dailySummary: Record<string, { current: number; sim: number; currentTrades: number; simTrades: number }> = {};
  for (const d of tradeDates) {
    dailySummary[d] = { current: 0, sim: 0, currentTrades: 0, simTrades: 0 };
  }
  
  // Process entries
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    const date = t.tradeDate;
    
    if (t.action === 'buy' || t.action === 'short') {
      // Find the corresponding exit
      const exit = allTrades.find((e: any, idx: number) => 
        idx > i && e.tradeDate === date && e.symbol === t.symbol && 
        (e.action === 'sell' || e.action === 'cover')
      );
      if (!exit) continue;
      
      const pnl = exit.pnl ? Number(exit.pnl) : 0;
      currentPnl += pnl;
      entryCount++;
      dailySummary[date].current += pnl;
      dailySummary[date].currentTrades++;
      
      const isRoundLevel = t.reason.includes('大台確認');
      const isStrongTrend = t.reason.includes('押し目なし・強トレンド');
      const isPullback = t.reason.includes('押し目確認後');
      
      if (isRoundLevel && isStrongTrend) {
        // Strong trend entry: with CONFIRM_BARS=3, this would happen 2 min earlier
        // Need to check what the price was 2 minutes before entry
        const entryTime = t.tradeTime;
        const entryPrice = Number(t.price);
        
        // Get candle 2 minutes before entry
        const earlierCandles = await db.execute(sql`
          SELECT candleTime, close FROM rt_candles 
          WHERE tradeDate = ${date} AND symbol = ${t.symbol}
            AND candleTime < ${entryTime}
          ORDER BY candleTime DESC LIMIT 3
        `);
        const earlier = (earlierCandles as any)[0];
        
        // The entry would be 2 minutes earlier (confirmation finishes 2 min sooner)
        // So entry price would be the close of the candle 2 bars before
        let simEntryPrice = entryPrice;
        if (earlier.length >= 2) {
          simEntryPrice = Number(earlier[1].close); // 2 bars earlier
        }
        
        // Calculate new PnL with earlier entry
        // The exit condition (stop loss / take profit) would also shift
        // Stop loss is typically -0.5% from entry
        const stopLoss = simEntryPrice * 0.995;
        const takeProfit = simEntryPrice * 1.03; // 3% target (approximate)
        
        // Get candles after the simulated entry
        const afterCandles = await db.execute(sql`
          SELECT candleTime, open, high, low, close FROM rt_candles 
          WHERE tradeDate = ${date} AND symbol = ${t.symbol}
            AND candleTime >= ${earlier.length >= 2 ? earlier[1].candleTime : entryTime}
          ORDER BY candleTime LIMIT 60
        `);
        const afterRows = (afterCandles as any)[0];
        
        let simExitPrice = simEntryPrice;
        let simResult = 'timeout';
        for (const c of afterRows) {
          if (Number(c.low) <= stopLoss) {
            simExitPrice = stopLoss;
            simResult = '損切り';
            break;
          }
          if (Number(c.high) >= takeProfit) {
            simExitPrice = takeProfit;
            simResult = '利確';
            break;
          }
        }
        if (simResult === 'timeout') {
          // Use last candle close
          simExitPrice = Number(afterRows[afterRows.length - 1]?.close || simEntryPrice);
        }
        
        const side = t.side || (t.action === 'buy' ? 'long' : 'short');
        let simPnlTrade: number;
        if (side === 'long') {
          simPnlTrade = Math.round((simExitPrice - simEntryPrice) * 100); // 100 shares approx
        } else {
          simPnlTrade = Math.round((simEntryPrice - simExitPrice) * 100);
        }
        
        // Actually, let's just use the actual shares from the trade
        const shares = Math.abs(pnl) > 0 ? Math.round(Math.abs(pnl) / Math.abs(Number(exit.price) - entryPrice)) : 100;
        if (side === 'long') {
          simPnlTrade = Math.round((simExitPrice - simEntryPrice) * (shares || 100));
        } else {
          simPnlTrade = Math.round((simEntryPrice - simExitPrice) * (shares || 100));
        }
        
        simPnl += simPnlTrade;
        simEntryCount++;
        dailySummary[date].sim += simPnlTrade;
        dailySummary[date].simTrades++;
        
        console.log(`[強トレンド] ${date} ${entryTime} | ${t.symbol} | ${side}`);
        console.log(`  現行: entry=¥${entryPrice} → PnL=${pnl.toLocaleString()}円`);
        console.log(`  3本確認: entry=¥${simEntryPrice}(2分早) → simPnL=${simPnlTrade.toLocaleString()}円 (${simResult})`);
        console.log('');
      } else if (isRoundLevel && isPullback) {
        // Pullback entry: with CONFIRM_BARS=3, confirmation is 2 min earlier
        // Pullback detection also starts 2 min earlier
        // The pullback might be detected earlier, or might not change
        // For simplicity, assume the pullback entry happens 2 min earlier too
        
        const entryTime = t.tradeTime;
        const entryPrice = Number(t.price);
        
        const earlierCandles = await db.execute(sql`
          SELECT candleTime, close FROM rt_candles 
          WHERE tradeDate = ${date} AND symbol = ${t.symbol}
            AND candleTime < ${entryTime}
          ORDER BY candleTime DESC LIMIT 3
        `);
        const earlier = (earlierCandles as any)[0];
        
        let simEntryPrice = entryPrice;
        if (earlier.length >= 2) {
          simEntryPrice = Number(earlier[1].close);
        }
        
        // For pullback entries, the entry is already at a good price (after pullback)
        // 2 min earlier might mean we catch the pullback earlier or miss it
        // Let's use a simpler model: same exit reason, adjusted for price difference
        const priceDiff = simEntryPrice - entryPrice;
        const side = t.side || (t.action === 'buy' ? 'long' : 'short');
        let simPnlTrade: number;
        if (side === 'long') {
          // Earlier entry in uptrend might be at lower price (better)
          simPnlTrade = pnl - Math.round(priceDiff * (Math.abs(pnl) / Math.abs(Number(exit.price) - entryPrice) || 100));
        } else {
          simPnlTrade = pnl + Math.round(priceDiff * (Math.abs(pnl) / Math.abs(Number(exit.price) - entryPrice) || 100));
        }
        
        simPnl += simPnlTrade;
        simEntryCount++;
        dailySummary[date].sim += simPnlTrade;
        dailySummary[date].simTrades++;
        
        console.log(`[押し目確認] ${date} ${entryTime} | ${t.symbol} | ${side}`);
        console.log(`  現行: entry=¥${entryPrice} → PnL=${pnl.toLocaleString()}円`);
        console.log(`  3本確認: entry=¥${simEntryPrice}(2分早) → simPnL=${simPnlTrade.toLocaleString()}円`);
        console.log('');
      } else {
        // Non-round-level entry: unchanged
        simPnl += pnl;
        simEntryCount++;
        dailySummary[date].sim += pnl;
        dailySummary[date].simTrades++;
      }
    }
  }
  
  console.log('\n=== 日別サマリー ===\n');
  console.log('日付         | 現行PnL      | 3本確認PnL   | 差分');
  console.log('-------------|-------------|-------------|--------');
  for (const d of tradeDates) {
    const s = dailySummary[d];
    const diff = s.sim - s.current;
    console.log(`${d} | ${s.current.toLocaleString().padStart(11)}円 | ${s.sim.toLocaleString().padStart(11)}円 | ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
  }
  
  console.log('\n=== 総合比較 ===\n');
  console.log(`現行（CONFIRM_BARS=5）: ${entryCount}件 | 総PnL = ${currentPnl.toLocaleString()}円`);
  console.log(`改善（CONFIRM_BARS=3）: ${simEntryCount}件 | 総PnL = ${simPnl.toLocaleString()}円`);
  console.log(`差分: ${(simPnl - currentPnl).toLocaleString()}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
