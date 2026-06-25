/**
 * debug_v3.ts - 6/17で取引0件の原因を特定
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";

const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const MIN_CANDLES_FOR_SIGNAL = 30;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const BOARD_SCORE_THRESHOLD = 1;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;

const raw = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260617.json", "utf8"));
for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot); }

const sorted = raw
  .filter((c: any) => ALLOWED_SYMBOLS.has(c.symbol))
  .filter((c: any) => {
    const ct = c.candleTime as string;
    return !(ct >= "11:30" && ct < "12:30");
  })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

console.log(`Sorted candles: ${sorted.length}`);

const buffers = new Map<string, CandleWithSignal[]>();
let signalCount = 0, buySignals = 0, sellSignals = 0;
let atrBlocked = 0, entryAttempts = 0;
let dowBuyPullback = 0, roundBuy = 0, directBuy = 0, directSell = 0;

for (const candle of sorted) {
  const { symbol, candleTime, open, high, low, close, volume } = candle;
  const tradeDate = candle.tradeDate;
  if (!buffers.has(symbol)) buffers.set(symbol, []);
  const buffer = buffers.get(symbol) as CandleWithSignal[];
  const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buffer.push(c4s);
  const closes = buffer.map(c => c.close); const li = buffer.length - 1;
  const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
  buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

  if (candleTime < "09:30" || candleTime >= "15:15") continue;
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

  const withSignals = detectSignals(buffer);
  const latestSignal = withSignals[withSignals.length - 1];
  buffer[buffer.length - 1] = latestSignal;

  const sig = latestSignal.signal;
  if (!sig) continue;
  signalCount++;
  if (sig.type === "buy") buySignals++;
  if (sig.type === "sell") sellSignals++;

  // Simulate the entry logic from sweep_atr_v3
  if (sig.type === "buy") {
    if (sig.reason?.includes("VWAPクロス上抜け")) continue;
    // boardScore = 1 (no boardSnapshot), threshold = 1 → passes
    
    if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
      const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low));
        if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { dowBuyPullback++; } }
      }
      // This sets pullbackState → no immediate entry
    } else if (sig.reason?.startsWith("大台超え")) {
      roundBuy++;
      // This sets roundLevelPendingState → no immediate entry
    } else {
      // Direct entry attempt
      entryAttempts++;
      if (buffer.length >= ATR_FILTER_PERIOD + 1) {
        const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
        const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
        if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { atrBlocked++; continue; }
      }
      directBuy++;
    }
  }
  if (sig.type === "sell") {
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;
    if (isBullish) continue;
    if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
      const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htf !== "down") continue;
    } else if (sig.reason?.startsWith("大台割れ")) {
      continue; // sets pending state
    }
    entryAttempts++;
    if (buffer.length >= ATR_FILTER_PERIOD + 1) {
      const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
      const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
      if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { atrBlocked++; continue; }
    }
    directSell++;
  }
}

console.log(`Signals: ${signalCount} (buy: ${buySignals}, sell: ${sellSignals})`);
console.log(`ダウ理論→押し目待ち: ${dowBuyPullback}`);
console.log(`大台超え→確認待ち: ${roundBuy}`);
console.log(`直接エントリー試行: ${entryAttempts}`);
console.log(`ATRブロック: ${atrBlocked}`);
console.log(`直接Buy成功: ${directBuy}`);
console.log(`直接Sell成功: ${directSell}`);
console.log(`\n問題: 押し目待ち/大台確認は別ステートマシンで処理されるため、`);
console.log(`sim_bc_only.tsでは後続の足で実際にエントリーが発生する。`);
console.log(`sweep_v3でも同じロジックなので、問題は別にあるはず。`);
