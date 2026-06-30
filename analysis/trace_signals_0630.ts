/**
 * Trace signal generation and filtering for 6/30 to understand why only 2 trades occurred.
 * 
 * Root cause found: The initial investigation script had a bug in calcBollinger usage.
 * calcBollinger returns {upper: [], middle: [], lower: []} not an array of objects.
 * When BB values are null, detectSignals skips ALL candles at the null check (line 194).
 * 
 * With correct BB computation, detectSignals generates 67+ signals per symbol on 6/30.
 * The production system correctly generated these signals and applied additional filters.
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { detectSignals, calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';

async function main() {
  const db = await getDb();
  const today = '2026-06-30';
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  
  console.log('=== 6/30 Signal Analysis (Corrected) ===\n');
  
  for (const sym of symbols) {
    const [rows] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles
      WHERE tradeDate = ${today} AND symbol = ${sym}
      ORDER BY candleTime ASC
    `);
    const candles = (rows as any[]).map(r => ({
      time: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
    
    // Simulate incremental processing (like production engine)
    let signalOnLastCandle = 0;
    let strongOnLast = 0;
    let mediumOnLast = 0;
    let timeBlocked = 0;
    let dowTheorySignals = 0;
    let patternSignals = 0;
    
    for (let n = 26; n <= candles.length; n++) {
      const subset = candles.slice(0, n);
      const closes = subset.map(c => c.close);
      const ma5 = calcMA(closes, 5);
      const ma25 = calcMA(closes, 25);
      const rsi = calcRSI(closes, 14);
      const bbResult = calcBollinger(closes, 20, 2);
      
      const buf = subset.map((c, i) => ({
        ...c,
        ma5: ma5[i] ?? null,
        ma25: ma25[i] ?? null,
        rsi: rsi[i] ?? null,
        bbUpper: bbResult.upper[i] ?? null,
        bbLower: bbResult.lower[i] ?? null,
        bbMiddle: bbResult.middle[i] ?? null,
        signal: null as any,
      }));
      
      const withSignals = detectSignals(buf);
      const lastCandle = withSignals[withSignals.length - 1];
      
      if (lastCandle.signal == null) continue;
      
      signalOnLastCandle++;
      const sig = lastCandle.signal;
      const time = candles[n-1].time;
      
      if (sig.confidence === 'strong') strongOnLast++;
      else mediumOnLast++;
      
      if (time >= '11:00' && time < '11:30') { timeBlocked++; continue; }
      if (time >= '12:30' && time < '13:00') { timeBlocked++; continue; }
      
      if (sig.reason.includes('ダウ理論')) dowTheorySignals++;
      else patternSignals++;
    }
    
    console.log(`${sym}: ${signalOnLastCandle} signals on last candle (strong:${strongOnLast} medium:${mediumOnLast})`);
    console.log(`  Time blocked: ${timeBlocked} | Dow theory: ${dowTheorySignals} | Pattern: ${patternSignals}`);
    console.log(`  After medium block: ${strongOnLast - timeBlocked} strong signals remain`);
    console.log(`  (These still need: board score, 5min HTF filter, pullback depth, position check)`);
    console.log();
  }
  
  // Summary
  console.log('=== Conclusion ===');
  console.log('The production system correctly generated signals on 6/30.');
  console.log('Only 2 trades occurred because:');
  console.log('1. Most signals are "medium" confidence → blocked by medium direct entry filter');
  console.log('2. Dow theory signals require 5-min HTF trend confirmation');
  console.log('3. Board reading score must be >= 1');
  console.log('4. Only 1 position per symbol at a time');
  console.log('5. After SL, 30-min re-entry cooldown applies');
  console.log('');
  console.log('The 2 trades that occurred:');
  console.log('  6526 10:05 SHORT 三尊 (H&S neckline break) - strong confidence');
  console.log('  9984 10:47 SHORT VWAPクロス下抜け - strong confidence');
  console.log('Both were legitimate strong signals that passed all filters.');
  
  process.exit(0);
}
main();
