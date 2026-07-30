import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Get full date range
  const dateRange = await db.execute(sql`
    SELECT MIN(tradeDate) as minDate, MAX(tradeDate) as maxDate, COUNT(DISTINCT tradeDate) as days
    FROM rt_trades
  `);
  console.log('データ範囲:', (dateRange as any)[0][0]);
  
  // Get all 大台確認 entries with their exits across all dates
  const entries = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, shares, pnl, reason, side
    FROM rt_trades 
    WHERE reason LIKE '%大台確認%'
      AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
  `);
  const entryRows = (entries as any)[0];
  console.log(`\n大台確認エントリー総数: ${entryRows.length}件\n`);
  
  console.log('=== ROUND_LEVEL_CONFIRM_BARS: 5→3 全期間シミュレーション ===\n');
  console.log('前提: 確認バーが2本短縮 → エントリーが2分早くなる');
  console.log('      2分前の終値でエントリーし、同じ損切り/利確幅(%)を適用\n');
  
  let totalCurrentPnl = 0;
  let totalSimPnl = 0;
  let tradeCount = 0;
  let improvedCount = 0;
  let worsenedCount = 0;
  let strongTrendCount = 0;
  let pullbackCount = 0;
  let strongTrendCurrentPnl = 0;
  let strongTrendSimPnl = 0;
  let pullbackCurrentPnl = 0;
  let pullbackSimPnl = 0;
  
  const dailyResults: Record<string, { current: number; sim: number; trades: number }> = {};
  
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
    
    if (!dailyResults[date]) dailyResults[date] = { current: 0, sim: 0, trades: 0 };
    totalCurrentPnl += actualPnl;
    dailyResults[date].current += actualPnl;
    dailyResults[date].trades++;
    tradeCount++;
    
    // Get candle 2 bars before entry
    const prevCandles = await db.execute(sql`
      SELECT candleTime, close FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${symbol} AND candleTime < ${entryTime}
      ORDER BY candleTime DESC LIMIT 3
    `);
    const prevRows = (prevCandles as any)[0];
    
    const simEntryPrice = prevRows.length >= 2 ? Number(prevRows[1].close) : entryPrice;
    const simEntryTime = prevRows.length >= 2 ? prevRows[1].candleTime : entryTime;
    
    // Determine exit type and calculate sim PnL
    const isStopLoss = exit.reason.includes('損切り');
    const isTakeProfit = exit.reason.includes('利確');
    
    let simExitPrice: number;
    let simExitReason: string;
    
    // Get candles after sim entry for simulation
    const afterCandles = await db.execute(sql`
      SELECT candleTime, open, high, low, close FROM rt_candles 
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime >= ${simEntryTime}
      ORDER BY candleTime LIMIT 80
    `);
    const afterRows = (afterCandles as any)[0];
    
    if (isStopLoss) {
      const stopPct = Math.abs(exitPrice - entryPrice) / entryPrice;
      const stopLine = side === 'long' 
        ? simEntryPrice * (1 - stopPct)
        : simEntryPrice * (1 + stopPct);
      
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
        // Check if TP would be hit instead
        const tpPct = stopPct * 3; // assume 3:1 ratio as approximation
        const tpLine = side === 'long'
          ? simEntryPrice * (1 + tpPct)
          : simEntryPrice * (1 - tpPct);
        let hitTp = false;
        for (const c of afterRows) {
          if (side === 'long' && Number(c.high) >= tpLine) {
            simExitPrice = tpLine;
            simExitReason = '利確';
            hitTp = true;
            break;
          }
          if (side === 'short' && Number(c.low) <= tpLine) {
            simExitPrice = tpLine;
            simExitReason = '利確';
            hitTp = true;
            break;
          }
        }
        if (!hitTp) {
          // Use exit time price
          const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
          simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : simEntryPrice;
          simExitReason = '時間切れ';
        }
      }
    } else if (isTakeProfit) {
      const tpPct = Math.abs(exitPrice - entryPrice) / entryPrice;
      const tpLine = side === 'long'
        ? simEntryPrice * (1 + tpPct)
        : simEntryPrice * (1 - tpPct);
      
      let hitTp = false;
      for (const c of afterRows) {
        if (side === 'long' && Number(c.high) >= tpLine) {
          simExitPrice = tpLine;
          simExitReason = '利確';
          hitTp = true;
          break;
        }
        if (side === 'short' && Number(c.low) <= tpLine) {
          simExitPrice = tpLine;
          simExitReason = '利確';
          hitTp = true;
          break;
        }
      }
      if (!hitTp) {
        // Check if stop would be hit
        const stopPct = tpPct / 3;
        const stopLine = side === 'long'
          ? simEntryPrice * (1 - stopPct)
          : simEntryPrice * (1 + stopPct);
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
          const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
          simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : exitPrice;
          simExitReason = '時間切れ';
        }
      }
    } else {
      // Other exit: use same exit time
      const exitTimeCandle = afterRows.find((c: any) => c.candleTime >= exit.tradeTime);
      simExitPrice = exitTimeCandle ? Number(exitTimeCandle.close) : exitPrice;
      simExitReason = exit.reason.substring(0, 15);
    }
    
    // Calculate sim PnL
    const shares = Number(entry.shares) || 100;
    const simPnlTrade = side === 'long' 
      ? Math.round((simExitPrice! - simEntryPrice) * shares)
      : Math.round((simEntryPrice - simExitPrice!) * shares);
    
    totalSimPnl += simPnlTrade;
    dailyResults[date].sim += simPnlTrade;
    
    if (simPnlTrade > actualPnl) improvedCount++;
    if (simPnlTrade < actualPnl) worsenedCount++;
    
    if (isStrongTrend) {
      strongTrendCount++;
      strongTrendCurrentPnl += actualPnl;
      strongTrendSimPnl += simPnlTrade;
    } else if (isPullback) {
      pullbackCount++;
      pullbackCurrentPnl += actualPnl;
      pullbackSimPnl += simPnlTrade;
    }
    
    const diff = simPnlTrade - actualPnl;
    if (Math.abs(diff) > 5000) {
      const tag = isStrongTrend ? '強トレンド' : isPullback ? '押し目確認' : 'その他';
      console.log(`[${tag}] ${date} ${entryTime} | ${symbol} ${side.toUpperCase()} | 現行:${actualPnl.toLocaleString()}円 → 3本:${simPnlTrade.toLocaleString()}円 (${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円) [${simExitReason!}]`);
    }
  }
  
  // Daily summary
  const sortedDates = Object.keys(dailyResults).sort();
  console.log('\n=== 日別サマリー ===\n');
  console.log('日付         | 現行(5本)    | 改善(3本)    | 差分         | 件数');
  console.log('-------------|-------------|-------------|-------------|-----');
  for (const d of sortedDates) {
    const s = dailyResults[d];
    const diff = s.sim - s.current;
    console.log(`${d} | ${s.current.toLocaleString().padStart(11)}円 | ${s.sim.toLocaleString().padStart(11)}円 | ${(diff >= 0 ? '+' : '') + diff.toLocaleString()}円`.padEnd(60) + `| ${s.trades}件`);
  }
  
  console.log('\n=== 種別別サマリー ===\n');
  console.log(`強トレンドエントリー: ${strongTrendCount}件`);
  console.log(`  現行PnL: ${strongTrendCurrentPnl.toLocaleString()}円 | 3本PnL: ${strongTrendSimPnl.toLocaleString()}円 | 差分: ${(strongTrendSimPnl - strongTrendCurrentPnl >= 0 ? '+' : '') + (strongTrendSimPnl - strongTrendCurrentPnl).toLocaleString()}円`);
  console.log(`押し目確認エントリー: ${pullbackCount}件`);
  console.log(`  現行PnL: ${pullbackCurrentPnl.toLocaleString()}円 | 3本PnL: ${pullbackSimPnl.toLocaleString()}円 | 差分: ${(pullbackSimPnl - pullbackCurrentPnl >= 0 ? '+' : '') + (pullbackSimPnl - pullbackCurrentPnl).toLocaleString()}円`);
  
  console.log('\n=== 総合結果 ===\n');
  console.log(`対象期間: ${sortedDates[0]} 〜 ${sortedDates[sortedDates.length - 1]}`);
  console.log(`大台確認エントリー総数: ${tradeCount}件`);
  console.log(`改善: ${improvedCount}件 | 悪化: ${worsenedCount}件 | 同等: ${tradeCount - improvedCount - worsenedCount}件`);
  console.log(`\n現行（CONFIRM_BARS=5）: 総PnL = ${totalCurrentPnl.toLocaleString()}円`);
  console.log(`改善（CONFIRM_BARS=3）: 総PnL = ${totalSimPnl.toLocaleString()}円`);
  console.log(`差分: ${(totalSimPnl - totalCurrentPnl >= 0 ? '+' : '') + (totalSimPnl - totalCurrentPnl).toLocaleString()}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
