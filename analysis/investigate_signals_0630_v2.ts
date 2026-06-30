/**
 * Detailed investigation: Why does detectSignals return 0 signals for 6/30?
 * 
 * We know dead crosses and breakouts exist in the data.
 * The issue must be in one of the filters:
 * 1. ADX filter (横ばい相場)
 * 2. Confirmation bar filter (price vs MA5 direction)
 * 3. evaluateConfirmation shouldNotify=false (weak confidence)
 * 4. Regime filter (isSignalAllowedInRegime)
 * 5. isStrongDown/isStrongUp guard
 * 
 * This script will trace each filter to find where candidates are being killed.
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';
import { evaluateConfirmation, trailingAvgVolume, priceMomentum } from '../server/signalConfirmation';

// Import internal helpers we need - replicate the key logic
function calcADX(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  const len = highs.length;
  const adx: (number | null)[] = new Array(len).fill(null);
  if (len < period * 2) return adx;
  
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  
  for (let i = 1; i < len; i++) {
    const h = highs[i], l = lows[i], pc = closes[i-1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - highs[i-1];
    const downMove = lows[i-1] - l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  // Smoothed TR, +DM, -DM
  let smoothTR = tr.slice(0, period).reduce((a,b) => a+b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a,b) => a+b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a,b) => a+b, 0);
  
  const dx: number[] = [];
  
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dxVal = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dx.push(dxVal);
  }
  
  if (dx.length < period) return adx;
  
  let adxVal = dx.slice(0, period).reduce((a,b) => a+b, 0) / period;
  adx[period * 2] = adxVal;
  
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    const idx = i + period + 1;
    if (idx < len) adx[idx] = adxVal;
  }
  
  return adx;
}

function ma25Slope(ma25Series: (number | null)[], i: number, lookback = 5): number | null {
  if (i < lookback) return null;
  const curr = ma25Series[i];
  const past = ma25Series[i - lookback];
  if (curr === null || past === null || past === 0) return null;
  return ((curr - past) / past) * 100;
}

function dayChangeRatio(close: number, dayOpen: number | null): number | null {
  if (dayOpen === null || dayOpen === 0) return null;
  return ((close - dayOpen) / dayOpen) * 100;
}

type IntradayRegime = "up" | "down" | "neutral";

function classifyIntradayRegime(ctx: { slope: number | null; dayChange: number | null }): IntradayRegime {
  const { slope, dayChange } = ctx;
  if (slope === null && dayChange === null) return "neutral";
  const slopeUp = slope !== null && slope > 0.02;
  const slopeDown = slope !== null && slope < -0.02;
  const changeUp = dayChange !== null && dayChange > 0.2;
  const changeDown = dayChange !== null && dayChange < -0.2;
  if (slopeUp && changeUp) return "up";
  if (slopeDown && changeDown) return "down";
  if (slopeUp || changeUp) return "up";
  if (slopeDown || changeDown) return "down";
  return "neutral";
}

function isSignalAllowedInRegime(type: string, regime: IntradayRegime): boolean {
  if (type === "warn") return true;
  if (regime === "down" && type === "buy") return false;
  if (regime === "up" && type === "sell") return false;
  return true;
}

async function main() {
  const db = await getDb();
  const today = '2026-06-30';
  const sym = '6526'; // This had a trade in production, so we know a signal existed
  
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
  
  console.log(`=== ${sym} (${candles.length} candles) ===`);
  
  // Build buffer
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  const adx = calcADX(highs, lows, closes);
  
  const dayOpen = candles[0]?.open ?? null;
  
  // Track filter reasons
  let totalCandidates = 0;
  let filteredByRegime = 0;
  let filteredByADX = 0;
  let filteredByConfirmBar = 0;
  let filteredByWeakConfidence = 0;
  let passedAll = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const c5 = ma5[i], c25 = ma25[i], p5 = ma5[i-1], p25 = ma25[i-1];
    const cRsi = rsi[i], cBbu = bb[i]?.upper ?? null, cBbl = bb[i]?.lower ?? null;
    
    if (c5 === null || c25 === null || p5 === null || p25 === null ||
        cRsi === null || cBbu === null || cBbl === null) continue;
    
    const isStrongDown = c5 < c25 && c.close < c5;
    const isStrongUp = c5 > c25 && c.close >= c5;
    
    // Check for dead cross
    let candidate: { type: string; reason: string } | null = null;
    
    const maDiv = c25 !== 0 ? Math.abs(c5 - c25) / c25 * 100 : 0;
    
    // Buy signals
    if (!isStrongDown) {
      if (p5 <= p25 && c5 > c25 && maDiv >= 0.1) {
        candidate = { type: "buy", reason: "ゴールデンクロス" };
      }
    }
    
    // Sell signals
    if (!candidate && !isStrongUp) {
      // Dead cross check
      if (p5 >= p25 && c5 < c25 && maDiv >= 0.1) {
        candidate = { type: "sell", reason: "デッドクロス" };
      }
    }
    
    if (!candidate) continue;
    totalCandidates++;
    
    // Regime filter
    const slope = ma25Slope(ma25.map(v => v ?? null), i);
    const dayChange = dayChangeRatio(c.close, dayOpen);
    const regime = classifyIntradayRegime({ slope, dayChange });
    
    if (!isSignalAllowedInRegime(candidate.type, regime)) {
      filteredByRegime++;
      if (totalCandidates <= 5) {
        console.log(`  [${c.time}] ${candidate.reason} → BLOCKED by regime (${regime})`);
      }
      continue;
    }
    
    // ADX filter
    const adxVal = adx[i];
    const isGcDcSignal = candidate.reason.includes("クロス");
    if (isGcDcSignal && (adxVal === null || adxVal < 20)) {
      filteredByADX++;
      if (totalCandidates <= 10) {
        console.log(`  [${c.time}] ${candidate.reason} → BLOCKED by ADX (${adxVal?.toFixed(1) ?? 'null'} < 20)`);
      }
      continue;
    }
    
    // Confirmation bar filter
    if (candidate.reason.includes("ゴールデンクロス") && c.close < c5) {
      filteredByConfirmBar++;
      if (totalCandidates <= 10) {
        console.log(`  [${c.time}] ${candidate.reason} → BLOCKED by confirm bar (close ${c.close} < MA5 ${c5})`);
      }
      continue;
    }
    if (candidate.reason.includes("デッドクロス") && c.close > c5) {
      filteredByConfirmBar++;
      if (totalCandidates <= 10) {
        console.log(`  [${c.time}] ${candidate.reason} → BLOCKED by confirm bar (close ${c.close} > MA5 ${c5})`);
      }
      continue;
    }
    
    // Confidence filter
    const conf = evaluateConfirmation({
      type: candidate.type as any,
      close: c.close,
      volume: c.volume,
      avgVolume: trailingAvgVolume(volumes, i, 10),
      ma5: c5,
      ma25: c25,
      momentum: priceMomentum(closes, i, 3),
      regime,
    });
    
    if (!conf.shouldNotify) {
      filteredByWeakConfidence++;
      if (totalCandidates <= 10) {
        console.log(`  [${c.time}] ${candidate.reason} → BLOCKED by weak confidence (score:${conf.score}, ${conf.summary})`);
      }
      continue;
    }
    
    passedAll++;
    console.log(`  [${c.time}] ${candidate.reason} → PASSED (${conf.confidence}, ${conf.summary})`);
  }
  
  console.log(`\n--- Summary for ${sym} (MA cross signals only) ---`);
  console.log(`Total candidates (raw MA crosses): ${totalCandidates}`);
  console.log(`  Filtered by regime: ${filteredByRegime}`);
  console.log(`  Filtered by ADX < 20: ${filteredByADX}`);
  console.log(`  Filtered by confirm bar: ${filteredByConfirmBar}`);
  console.log(`  Filtered by weak confidence: ${filteredByWeakConfidence}`);
  console.log(`  PASSED all filters: ${passedAll}`);
  
  // Also check the isStrongDown guard
  let strongDownBlocked = 0;
  for (let i = 1; i < candles.length; i++) {
    const c5 = ma5[i], c25 = ma25[i], p5 = ma5[i-1], p25 = ma25[i-1];
    if (c5 === null || c25 === null || p5 === null || p25 === null) continue;
    const isStrongDown = c5 < c25 && candles[i].close < c5;
    // Would be a golden cross but blocked by isStrongDown
    if (isStrongDown && p5 <= p25 && c5 > c25) {
      strongDownBlocked++;
    }
  }
  console.log(`\n  GC blocked by isStrongDown: ${strongDownBlocked}`);
  
  // Check what the production system recorded for 6526 on 6/30
  const [trades] = await db.execute(sql`
    SELECT * FROM rt_trades WHERE tradeDate = ${today} AND symbol = ${sym}
  `);
  console.log(`\n--- Production trades for ${sym} on ${today} ---`);
  for (const t of trades as any[]) {
    console.log(`  ${t.entryTime} ${t.side} entry:${t.entryPrice} exit:${t.exitPrice} pnl:${t.pnl} reason:${t.signalReason}`);
  }
  
  process.exit(0);
}
main();
