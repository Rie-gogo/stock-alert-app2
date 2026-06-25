/**
 * debug_v3e.ts - 09:40の6857のATR値を確認
 * debug_v3c.tsでは09:40にエントリー成功しているが、sweep_v3では失敗
 */
import * as fs from "fs";
import { calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { calcATR } from "../server/intradayRegime";

const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;

const raw = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260617.json", "utf8"));
for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); }

const sorted = raw
  .filter((c: any) => ALLOWED_SYMBOLS.has(c.symbol))
  .filter((c: any) => { const ct = c.candleTime as string; return !(ct >= "11:30" && ct < "12:30"); })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

// Build buffers for 6857 and check ATR at 09:40
const buffer6857: CandleWithSignal[] = [];
for (const candle of sorted) {
  if (candle.symbol !== "6857") continue;
  const { candleTime, open, high, low, close, volume } = candle;
  const tradeDate = candle.tradeDate;
  const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buffer6857.push(c4s);
  
  if (candleTime === "09:40") {
    const h = buffer6857.map(c => c.high);
    const l = buffer6857.map(c => c.low);
    const cl = buffer6857.map(c => c.close);
    const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
    const latestATR = atr[atr.length - 1];
    const atrRatio = latestATR !== null && close > 0 ? latestATR / close : null;
    console.log(`6857 @ 09:40: buffer.length=${buffer6857.length}, close=${close}, ATR=${latestATR?.toFixed(2)}, ATR/price=${atrRatio?.toFixed(6)}, threshold=${ATR_FILTER_THRESHOLD}`);
    console.log(`  passes ATR filter: ${atrRatio !== null && atrRatio >= ATR_FILTER_THRESHOLD}`);
    console.log(`  last 8 candles: ${buffer6857.slice(-8).map(c => `${c.time.split("T")[1].slice(0,5)} H${c.high} L${c.low} C${c.close}`).join(" | ")}`);
  }
}

// Also check 6920 at 09:40
const buffer6920: CandleWithSignal[] = [];
for (const candle of sorted) {
  if (candle.symbol !== "6920") continue;
  const { candleTime, open, high, low, close, volume } = candle;
  const tradeDate = candle.tradeDate;
  const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buffer6920.push(c4s);
  
  if (candleTime === "09:40") {
    const h = buffer6920.map(c => c.high);
    const l = buffer6920.map(c => c.low);
    const cl = buffer6920.map(c => c.close);
    const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
    const latestATR = atr[atr.length - 1];
    const atrRatio = latestATR !== null && close > 0 ? latestATR / close : null;
    console.log(`\n6920 @ 09:40: buffer.length=${buffer6920.length}, close=${close}, ATR=${latestATR?.toFixed(2)}, ATR/price=${atrRatio?.toFixed(6)}, threshold=${ATR_FILTER_THRESHOLD}`);
    console.log(`  passes ATR filter: ${atrRatio !== null && atrRatio >= ATR_FILTER_THRESHOLD}`);
  }
}

// Now check what happens in debug_v3c.ts - the entry at 09:40 was AFTER roundPullback confirmation
// The roundLevelPending was set earlier, then confirmed after 5 bars, then pullback checked
// So the buffer at entry time has MORE candles than just up to 09:40
// Let's trace the exact flow for 6857
console.log("\n\n=== Tracing 6857 大台超え flow ===");
const buf2: CandleWithSignal[] = [];
let roundPending: any = null;
let roundPB: any = null;
for (const candle of sorted) {
  if (candle.symbol !== "6857") continue;
  const { candleTime, open, high, low, close, volume } = candle;
  const tradeDate = candle.tradeDate;
  const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buf2.push(c4s);
  
  if (candleTime < "09:30" || candleTime >= "15:15") continue;
  if (buf2.length < 30) continue;
  
  // Check roundPending
  if (roundPending) {
    const valid = close >= roundPending.level;
    if (valid) {
      roundPending.confirmCount++;
      if (roundPending.confirmCount >= 5) {
        console.log(`  ${candleTime}: 大台確認完了 (level=${roundPending.level}, close=${close})`);
        roundPB = { ...roundPending, signalPrice: close, waitCount: 0, pulledBack: false };
        roundPending = null;
      }
    } else {
      console.log(`  ${candleTime}: 大台確認失敗 (level=${roundPending.level}, close=${close})`);
      roundPending = null;
    }
    continue;
  }
  
  if (roundPB) {
    roundPB.waitCount++;
    if (close < roundPB.level) { console.log(`  ${candleTime}: PB cancelled (close=${close} < level=${roundPB.level})`); roundPB = null; continue; }
    if (roundPB.waitCount > 5) {
      // Entry attempt
      const h = buf2.map(c => c.high); const l = buf2.map(c => c.low); const cl = buf2.map(c => c.close);
      const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
      const latestATR = atr[atr.length - 1];
      const atrRatio = latestATR !== null && close > 0 ? latestATR / close : null;
      console.log(`  ${candleTime}: PB timeout entry attempt. buf=${buf2.length}, ATR=${latestATR?.toFixed(2)}, ratio=${atrRatio?.toFixed(6)}, pass=${atrRatio !== null && atrRatio >= ATR_FILTER_THRESHOLD}`);
      roundPB = null;
      continue;
    }
    if (!roundPB.pulledBack && close < roundPB.signalPrice) { roundPB.pulledBack = true; console.log(`  ${candleTime}: pullback detected (close=${close} < signal=${roundPB.signalPrice})`); }
    if (roundPB.pulledBack && close > roundPB.signalPrice) {
      // Entry attempt
      const h = buf2.map(c => c.high); const l = buf2.map(c => c.low); const cl = buf2.map(c => c.close);
      const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
      const latestATR = atr[atr.length - 1];
      const atrRatio = latestATR !== null && close > 0 ? latestATR / close : null;
      console.log(`  ${candleTime}: PB confirmed entry attempt. buf=${buf2.length}, close=${close}, ATR=${latestATR?.toFixed(2)}, ratio=${atrRatio?.toFixed(6)}, pass=${atrRatio !== null && atrRatio >= ATR_FILTER_THRESHOLD}`);
      roundPB = null;
    }
    continue;
  }
  
  // Check for 大台超え signal (simplified - just check if close crosses round levels)
  // In debug_v3c, the first entry was at 09:40 for "大台超え (30800円突破)"
  // Let's just set roundPending when we detect a cross
  if (!roundPending && !roundPB) {
    const level30800 = 30800;
    if (close >= level30800 && buf2.length > 1 && buf2[buf2.length - 2].close < level30800) {
      console.log(`  ${candleTime}: 大台超え signal detected (30800), close=${close}`);
      roundPending = { direction: "buy", level: level30800, confirmCount: 0, reason: "大台超え (30800円突破)" };
    }
  }
}
