import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { detectSignals, calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';

async function main() {
  const db = await getDb();
  const today = '2026-06-30';
  
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  
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
    
    console.log(`\n=== ${sym} (${candles.length} candles) ===`);
    
    // Build buffer with MA/RSI/BB
    const closes = candles.map(c => c.close);
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const rsi = calcRSI(closes, 14);
    const bb = calcBollinger(closes, 20, 2);
    
    const buf = candles.map((c, i) => ({
      ...c,
      ma5: ma5[i] ?? null,
      ma25: ma25[i] ?? null,
      rsi: rsi[i] ?? null,
      bbUpper: bb[i]?.upper ?? null,
      bbLower: bb[i]?.lower ?? null,
      bbMiddle: bb[i]?.middle ?? null,
      signal: null as any,
    }));
    
    const withSignals = detectSignals(buf);
    const signalCandles = withSignals.filter(c => c.signal !== null && c.signal !== undefined);
    
    const buys = signalCandles.filter(c => c.signal?.type === 'buy');
    const sells = signalCandles.filter(c => c.signal?.type === 'sell');
    
    console.log(`  Signals: ${signalCandles.length} (buy:${buys.length}, sell:${sells.length})`);
    
    for (const s of signalCandles.slice(0, 8)) {
      console.log(`  ${s.time} | ${s.signal?.type} | ${s.signal?.name} | conf:${s.signal?.confidence}`);
    }
    if (signalCandles.length > 8) {
      console.log(`  ... and ${signalCandles.length - 8} more`);
    }
    
    // Count dead crosses manually
    let deadCrossCount = 0;
    let goldenCrossCount = 0;
    for (let i = 1; i < ma5.length; i++) {
      if (ma5[i] !== null && ma25[i] !== null && ma5[i-1] !== null && ma25[i-1] !== null) {
        if ((ma5[i] as number) < (ma25[i] as number) && (ma5[i-1] as number) >= (ma25[i-1] as number)) {
          deadCrossCount++;
        }
        if ((ma5[i] as number) > (ma25[i] as number) && (ma5[i-1] as number) <= (ma25[i-1] as number)) {
          goldenCrossCount++;
        }
      }
    }
    console.log(`  MA crosses: dead=${deadCrossCount}, golden=${goldenCrossCount}`);
    
    // Check Dow theory signals manually - look for new lows/highs
    let newHighCount = 0;
    let newLowCount = 0;
    for (let i = 20; i < candles.length; i++) {
      const lookback = candles.slice(i - 20, i);
      const maxHigh = Math.max(...lookback.map(c => c.high));
      const minLow = Math.min(...lookback.map(c => c.low));
      if (candles[i].high > maxHigh) newHighCount++;
      if (candles[i].low < minLow) newLowCount++;
    }
    console.log(`  20-bar breakouts: new highs=${newHighCount}, new lows=${newLowCount}`);
  }
  
  process.exit(0);
}
main();
