import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get the last 10 trading days
const [days] = await conn.query(`
  SELECT DISTINCT tradeDate FROM rt_trades
  WHERE tradeDate >= '2026-07-01'
  ORDER BY tradeDate ASC
`);
console.log(`対象日数: ${days.length}日 (${days[0].tradeDate} 〜 ${days[days.length-1].tradeDate})\n`);

const MAX_EXPOSURE = 8910000; // 891万円

// For each day, simulate the "285A priority" rule
let grandTotalActual = 0;
let grandTotalPriority = 0;
let dayResults = [];

for (const dayRow of days) {
  const date = dayRow.tradeDate;
  
  // Get all trades for this day
  const [trades] = await conn.query(`
    SELECT symbol, action, tradeTime, price, shares, pnl, reason
    FROM rt_trades
    WHERE tradeDate = ?
    ORDER BY tradeTime ASC
  `, [date]);
  
  // Actual PnL
  const exits = trades.filter(t => t.action === 'sell' || t.action === 'cover');
  const actualPnl = exits.reduce((s, t) => s + Number(t.pnl), 0);
  
  // Now simulate priority rule:
  // When 285A has a signal but is blocked by exposure, force-close other positions
  // We need to check: was there a 285A entry that was delayed?
  
  // Get all 285A entries
  const entries285A = trades.filter(t => t.symbol === '285A' && (t.action === 'buy' || t.action === 'short'));
  
  // For each 285A entry, check if there were other positions open at that time
  // and if earlier signals existed that were blocked
  
  // Get candle data for 285A to find potential earlier signals (大台超え)
  const [candles285A] = await conn.query(`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = ? AND symbol = '285A'
    ORDER BY candleTime ASC
  `, [date]);
  
  if (candles285A.length === 0) {
    dayResults.push({ date, actualPnl, priorityPnl: actualPnl, diff: 0, note: '285Aデータなし' });
    grandTotalActual += actualPnl;
    grandTotalPriority += actualPnl;
    continue;
  }
  
  // Find potential 大台超え signals for 285A (round number breakouts maintained for 5 candles)
  const roundLevels = [];
  for (let l = 60000; l <= 85000; l += 100) {
    roundLevels.push(l);
  }
  
  // Find 大台超え with 5-candle confirmation
  const potentialSignals = [];
  for (let i = 5; i < candles285A.length; i++) {
    const c = candles285A[i];
    const time = c.candleTime;
    
    // Check each 1000-yen level (major round numbers)
    for (let level = 60000; level <= 85000; level += 1000) {
      // Did we just cross above this level and maintain for 5 candles?
      if (Number(c.close) > level) {
        // Check if 5 consecutive candles maintained above level
        let maintained = true;
        let firstCross = null;
        for (let j = i - 4; j <= i; j++) {
          if (Number(candles285A[j].close) <= level) {
            maintained = false;
            break;
          }
        }
        // Check that candle before the 5 was below
        if (maintained && i >= 5 && Number(candles285A[i - 5].close) <= level) {
          // This is a valid 大台超え signal at time of candle i-4 (first candle above)
          // But the confirmation happens at candle i (5th candle)
          potentialSignals.push({
            time: candles285A[i].candleTime,
            level,
            price: Number(candles285A[i].close),
            direction: 'buy'
          });
        }
      }
      // Short direction (below level)
      if (Number(c.close) < level) {
        let maintained = true;
        for (let j = i - 4; j <= i; j++) {
          if (Number(candles285A[j].close) >= level) {
            maintained = false;
            break;
          }
        }
        if (maintained && i >= 5 && Number(candles285A[i - 5].close) >= level) {
          potentialSignals.push({
            time: candles285A[i].candleTime,
            level,
            price: Number(candles285A[i].close),
            direction: 'short'
          });
        }
      }
    }
  }
  
  // Deduplicate - only keep first signal per level per direction
  const seenLevels = new Set();
  const uniqueSignals = potentialSignals.filter(s => {
    const key = `${s.level}_${s.direction}`;
    if (seenLevels.has(key)) return false;
    seenLevels.add(key);
    return true;
  });
  
  // Now check: for each potential 285A signal, was there a position blocking it?
  // Reconstruct position timeline
  let priorityPnl = actualPnl;
  let note = '';
  
  if (entries285A.length > 0 && uniqueSignals.length > 0) {
    // Find the actual first 285A entry time
    const actualFirstEntry = entries285A[0];
    
    // Find earliest potential signal that could have been an entry
    // (must be before the actual entry and in same direction)
    const earlierSignals = uniqueSignals.filter(s => 
      s.time < actualFirstEntry.tradeTime && 
      s.direction === (actualFirstEntry.action === 'buy' ? 'buy' : 'short')
    );
    
    if (earlierSignals.length > 0) {
      const earliestSignal = earlierSignals[0];
      
      // Check if there were other positions at that time
      const positionsAtSignal = new Map();
      for (const t of trades) {
        if (t.tradeTime > earliestSignal.time) break;
        if (t.action === 'buy' || t.action === 'short') {
          positionsAtSignal.set(t.symbol, { price: Number(t.price), shares: Number(t.shares), action: t.action });
        } else {
          positionsAtSignal.delete(t.symbol);
        }
      }
      
      let exposureAtSignal = 0;
      for (const [sym, pos] of positionsAtSignal) {
        exposureAtSignal += pos.price * pos.shares;
      }
      
      const needed285A = earliestSignal.price * 100;
      
      if (exposureAtSignal + needed285A > MAX_EXPOSURE && positionsAtSignal.size > 0) {
        // 285A was blocked! With priority rule, we'd force-close others
        
        // Calculate what we lose by force-closing others
        let forcedClosePnl = 0;
        const forcedCloseDetails = [];
        
        for (const [sym, pos] of positionsAtSignal) {
          if (sym === '285A') continue;
          // Find the price at the time of forced close (use the candle at that time for that symbol)
          const [symCandle] = await conn.query(`
            SELECT close FROM rt_candles
            WHERE tradeDate = ? AND symbol = ? AND candleTime = ?
          `, [date, sym, earliestSignal.time]);
          
          if (symCandle.length > 0) {
            const closePrice = Number(symCandle[0].close);
            let pnl;
            if (pos.action === 'buy') {
              pnl = (closePrice - pos.price) * pos.shares;
            } else {
              pnl = (pos.price - closePrice) * pos.shares;
            }
            forcedClosePnl += pnl;
            forcedCloseDetails.push({ sym, pnl, closePrice, entryPrice: pos.price });
          }
        }
        
        // Calculate what 285A would have earned with earlier entry
        // Use SL 1.0% and TP 3.0%
        const entryPrice = earliestSignal.price;
        const sl = earliestSignal.direction === 'buy' ? entryPrice * 0.99 : entryPrice * 1.01;
        const tp = earliestSignal.direction === 'buy' ? entryPrice * 1.03 : entryPrice * 0.97;
        
        // Simulate from entry time
        let earlyEntryPnl = 0;
        let earlyExitTime = '';
        let earlyExitReason = '';
        const startIdx = candles285A.findIndex(c => c.candleTime >= earliestSignal.time);
        
        for (let i = startIdx + 1; i < candles285A.length; i++) {
          const c = candles285A[i];
          if (earliestSignal.direction === 'buy') {
            if (Number(c.low) <= sl) {
              earlyEntryPnl = (sl - entryPrice) * 100;
              earlyExitTime = c.candleTime;
              earlyExitReason = '損切り';
              break;
            }
            if (Number(c.high) >= tp) {
              earlyEntryPnl = (tp - entryPrice) * 100;
              earlyExitTime = c.candleTime;
              earlyExitReason = '利確';
              break;
            }
          } else {
            if (Number(c.high) >= sl) {
              earlyEntryPnl = (entryPrice - sl) * 100;
              earlyExitTime = c.candleTime;
              earlyExitReason = '損切り';
              break;
            }
            if (Number(c.low) <= tp) {
              earlyEntryPnl = (entryPrice - tp) * 100;
              earlyExitTime = c.candleTime;
              earlyExitReason = '利確';
              break;
            }
          }
        }
        
        // If no exit, use close price (forced exit at end of day)
        if (earlyExitTime === '' && candles285A.length > 0) {
          const lastCandle = candles285A[candles285A.length - 1];
          if (earliestSignal.direction === 'buy') {
            earlyEntryPnl = (Number(lastCandle.close) - entryPrice) * 100;
          } else {
            earlyEntryPnl = (entryPrice - Number(lastCandle.close)) * 100;
          }
          earlyExitTime = lastCandle.candleTime;
          earlyExitReason = '大引け';
        }
        
        // Also need to subtract the actual 285A trades PnL (since we're replacing them)
        const actual285APnl = exits.filter(t => t.symbol === '285A').reduce((s, t) => s + Number(t.pnl), 0);
        
        // Also subtract the actual PnL of the force-closed positions (they would have been closed early)
        const actualForcedSymPnl = exits.filter(t => positionsAtSignal.has(t.symbol) && t.symbol !== '285A').reduce((s, t) => s + Number(t.pnl), 0);
        
        // Priority PnL = actual total - actual285A - actualForcedSym + forcedClosePnl + earlyEntryPnl
        priorityPnl = actualPnl - actual285APnl - actualForcedSymPnl + forcedClosePnl + earlyEntryPnl;
        
        note = `早期エントリー@${earliestSignal.time}(${earliestSignal.level}円超え) → ${earlyExitReason}@${earlyExitTime} PnL:${Math.round(earlyEntryPnl).toLocaleString()}円 | 強制決済: ${forcedCloseDetails.map(d => `${d.sym}:${Math.round(d.pnl).toLocaleString()}`).join(',')} | 実際285A: ${Math.round(actual285APnl).toLocaleString()}円`;
      } else {
        note = '285Aブロックなし（証拠金余力あり）';
      }
    } else {
      note = '実際のエントリーより早いシグナルなし';
    }
  } else if (uniqueSignals.length === 0) {
    note = '285Aシグナルなし';
  } else {
    note = '285Aエントリーなし';
  }
  
  dayResults.push({ date, actualPnl, priorityPnl, diff: priorityPnl - actualPnl, note });
  grandTotalActual += actualPnl;
  grandTotalPriority += priorityPnl;
}

// Print results
console.log("=== キオクシア優先ルール 10日間シミュレーション ===\n");
console.log("日付       | 実績        | 優先ルール  | 差分        | 備考");
console.log("-".repeat(120));
for (const r of dayResults) {
  const actual = `${r.actualPnl >= 0 ? '+' : ''}${Math.round(r.actualPnl).toLocaleString()}円`.padStart(11);
  const priority = `${r.priorityPnl >= 0 ? '+' : ''}${Math.round(r.priorityPnl).toLocaleString()}円`.padStart(11);
  const diff = `${r.diff >= 0 ? '+' : ''}${Math.round(r.diff).toLocaleString()}円`.padStart(11);
  console.log(`${r.date} | ${actual} | ${priority} | ${diff} | ${r.note}`);
}
console.log("-".repeat(120));
console.log(`合計       | ${grandTotalActual >= 0 ? '+' : ''}${Math.round(grandTotalActual).toLocaleString()}円`.padEnd(25) + `| ${grandTotalPriority >= 0 ? '+' : ''}${Math.round(grandTotalPriority).toLocaleString()}円`.padEnd(25) + `| ${(grandTotalPriority - grandTotalActual) >= 0 ? '+' : ''}${Math.round(grandTotalPriority - grandTotalActual).toLocaleString()}円`);
console.log(`\n改善額: ${(grandTotalPriority - grandTotalActual) >= 0 ? '+' : ''}${Math.round(grandTotalPriority - grandTotalActual).toLocaleString()}円`);

await conn.end();
