/**
 * debug_v3b.ts - doEntry内のどのフィルターでブロックされるか特定
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";

const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const MIN_CANDLES_FOR_SIGNAL = 30;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const BOARD_SCORE_THRESHOLD = 1;
const VOLUME_UNAVAILABLE_RATIO = 0.9;

function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }

const raw = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260617.json", "utf8"));
for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot); }

const sorted = raw
  .filter((c: any) => ALLOWED_SYMBOLS.has(c.symbol))
  .filter((c: any) => { const ct = c.candleTime as string; return !(ct >= "11:30" && ct < "12:30"); })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

const buffers = new Map<string, CandleWithSignal[]>();
let boardBlocked = 0, atrBlocked = 0, exposureBlocked = 0, volumeBlocked = 0, entered = 0;
let totalAttempts = 0;

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
  if (sig.type !== "buy" && sig.type !== "sell") continue;
  if (sig.reason?.includes("VWAPクロス上抜け")) continue;
  if (sig.reason?.startsWith("ダウ理論: 直近高値更新")) continue;
  if (sig.reason?.startsWith("大台超え")) continue;
  if (sig.reason?.startsWith("大台割れ")) continue;
  if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) continue;
  if (sig.type === "sell") {
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100;
    if (priceChangeRatio >= 0.2) continue;
  }

  // This is a "direct entry" candidate (not dow/round)
  totalAttempts++;
  
  // boardScore check (null snapshot → 1, threshold = 1)
  // 1 >= 1 → passes
  const brScore = 1; // no boardSnapshot
  if (brScore < BOARD_SCORE_THRESHOLD) { boardBlocked++; continue; }
  
  // ATR filter
  const shares = calcShares(close); const amount = close * shares;
  if (buffer.length >= ATR_FILTER_PERIOD + 1) {
    const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
    const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
    if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { atrBlocked++; continue; }
  }
  
  // Exposure check
  if (amount > MAX_TOTAL_EXPOSURE) { exposureBlocked++; continue; }
  
  // Volume check
  if (checkVolumeUnavailable(buffer)) { volumeBlocked++; continue; }
  
  entered++;
  if (entered <= 5) {
    console.log(`  Entry: ${symbol} ${candleTime} ${sig.type} ${sig.reason} price=${close} shares=${shares} amount=${amount}`);
  }
}

console.log(`\n=== 6/17 直接エントリー分析 ===`);
console.log(`直接エントリー候補: ${totalAttempts}`);
console.log(`板読みブロック: ${boardBlocked}`);
console.log(`ATRブロック: ${atrBlocked}`);
console.log(`エクスポージャーブロック: ${exposureBlocked}`);
console.log(`出来高ブロック: ${volumeBlocked}`);
console.log(`エントリー成功: ${entered}`);
console.log(`MAX_TOTAL_EXPOSURE: ${MAX_TOTAL_EXPOSURE.toLocaleString()}円`);
