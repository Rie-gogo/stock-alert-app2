import { getDb } from '../server/db';
import { rtCandles } from '../drizzle/schema';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Get candle counts per date
  const rows = await db.select({
    tradeDate: rtCandles.tradeDate,
    symbol: rtCandles.symbol,
    cnt: sql<number>`COUNT(*)`,
  }).from(rtCandles).groupBy(rtCandles.tradeDate, rtCandles.symbol).orderBy(rtCandles.tradeDate, rtCandles.symbol);
  
  const byDate: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const d = r.tradeDate;
    const s = r.symbol;
    if (byDate[d] === undefined) byDate[d] = {};
    byDate[d][s] = Number(r.cnt);
  }
  
  console.log("=== rt_candles data per date ===");
  for (const date of Object.keys(byDate).sort()) {
    const syms = byDate[date];
    const total = Object.values(syms).reduce((a, b) => a + b, 0);
    console.log(`${date}: ${Object.keys(syms).length} symbols, ${total} candles`);
    for (const [sym, cnt] of Object.entries(syms).sort()) {
      console.log(`    ${sym}: ${cnt} candles`);
    }
  }
  
  // Now check round number break detection on each date
  console.log("\n=== Round number break detection per date ===");
  
  const WARMUP = 10;
  const ATR_BLOCK = 0.0012;
  const SLOPE_THRESHOLD = 0.0002;
  
  for (const date of Object.keys(byDate).sort()) {
    let signalCount = 0;
    let skippedATR = 0;
    let skippedSlope = 0;
    let skippedVol = 0;
    let skippedMaintained = 0;
    let skippedNoBreak = 0;
    
    for (const symbol of Object.keys(byDate[date])) {
      // Get candles for this symbol/date
      const candles = await db.select().from(rtCandles)
        .where(sql`${rtCandles.tradeDate} = ${date} AND ${rtCandles.symbol} = ${symbol}`)
        .orderBy(rtCandles.candleTime);
      
      if (candles.length < 30) continue;
      
      // Compute ATR
      const bars = candles.map(c => ({
        close: Number(c.close), high: Number(c.high), low: Number(c.low),
        open: Number(c.open), volume: Number(c.volume), time: c.candleTime,
      }));
      
      // Simple ATR calculation
      for (let i = 1; i < bars.length; i++) {
        const tr = Math.max(
          bars[i].high - bars[i].low,
          Math.abs(bars[i].high - bars[i-1].close),
          Math.abs(bars[i].low - bars[i-1].close)
        );
        if (i < 14) {
          (bars[i] as any).atr = tr;
        } else if (i === 14) {
          let sum = 0;
          for (let j = 1; j <= 14; j++) sum += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j-1].close), Math.abs(bars[j].low - bars[j-1].close));
          (bars[i] as any).atr = sum / 14;
        } else {
          (bars[i] as any).atr = ((bars[i-1] as any).atr * 13 + tr) / 14;
        }
      }
      
      for (let i = WARMUP; i < bars.length; i++) {
        const curr = bars[i];
        const prev = bars[i - 1];
        const atrRatio = (curr as any).atr ? (curr as any).atr / curr.close : 0;
        
        if (atrRatio < ATR_BLOCK) { skippedATR++; continue; }
        
        // Slope
        const lookback = Math.min(5, i);
        const slope = (curr.close - bars[i - lookback].close) / bars[i - lookback].close / lookback;
        if (slope > SLOPE_THRESHOLD * 3) { skippedSlope++; continue; }
        
        // Volume
        let volSum = 0;
        for (let j = Math.max(0, i - 10); j < i; j++) volSum += bars[j].volume;
        const avgVol = volSum / Math.min(10, i);
        if (curr.volume < avgVol * 0.8) { skippedVol++; continue; }
        
        // Round number break
        const roundUnit = curr.close >= 10000 ? 100 : curr.close >= 1000 ? 100 : 10;
        const prevRound = Math.ceil(prev.close / roundUnit) * roundUnit;
        const currRoundNum = Math.ceil(curr.close / roundUnit) * roundUnit;
        
        if (currRoundNum < prevRound && curr.close < prevRound - roundUnit * 0.1) {
          let maintained = true;
          for (let j = Math.max(0, i - 4); j < i; j++) {
            if (bars[j].close > prevRound) { maintained = false; break; }
          }
          if (maintained && slope <= 0) {
            signalCount++;
          } else {
            skippedMaintained++;
          }
        } else {
          skippedNoBreak++;
        }
      }
    }
    
    console.log(`${date}: ${signalCount} signals (skipped: ATR=${skippedATR}, slope=${skippedSlope}, vol=${skippedVol}, maintained=${skippedMaintained}, noBreak=${skippedNoBreak})`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
