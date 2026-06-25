import { TARGET_STOCKS } from '../shared/stocks';
import * as fs from 'fs';
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from '../server/routers/stockData';
import { calcATR } from '../server/intradayRegime';

const ALLOWED = new Set(TARGET_STOCKS.map(s => s.symbol));
const data = JSON.parse(fs.readFileSync('/tmp/rt_candles_20260617.json', 'utf8'));
for (const c of data) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); }

const sym = '6920';
const symData = data.filter((c: any) => c.symbol === sym && ALLOWED.has(c.symbol))
  .filter((c: any) => {
    const t = c.candleTime;
    return !(t >= '11:30' && t < '12:30');
  })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : 1);

console.log(`${sym} candles after filter: ${symData.length}`);

const buffer: CandleWithSignal[] = [];
let atrFilterBlocked = 0;
let atrFilterPassed = 0;
let signalButFiltered = 0;
let signalAndPassed = 0;

for (const candle of symData) {
  const c4s: CandleWithSignal = { time: `${candle.tradeDate}T${candle.candleTime}:00`, dayKey: candle.tradeDate, timestamp: 0, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buffer.push(c4s);
  const closes = buffer.map(c => c.close);
  const li = buffer.length - 1;
  const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
  buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

  if (candle.candleTime < '09:30' || buffer.length < 30) continue;

  // Check signal
  const withSignals = detectSignals(buffer);
  const latest = withSignals[withSignals.length - 1];
  buffer[buffer.length - 1] = latest;
  
  if (!latest.signal) continue;

  // Check ATR filter
  if (buffer.length >= 8) {
    const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
    const atr = calcATR(h, l, cl, 7);
    const latestATR = atr[atr.length - 1];
    if (latestATR !== null && candle.close > 0) {
      const ratio = latestATR / candle.close;
      if (ratio < 0.0012) {
        atrFilterBlocked++;
        signalButFiltered++;
      } else {
        atrFilterPassed++;
        signalAndPassed++;
        if (signalAndPassed <= 5) {
          console.log(`  PASS: ${candle.candleTime} ${latest.signal.type} ATR_ratio=${(ratio*100).toFixed(4)}% reason=${latest.signal.reason?.substring(0,50)}`);
        }
      }
    }
  }
}
console.log(`\n${sym}: signals with ATR pass: ${signalAndPassed}, ATR blocked: ${signalButFiltered}`);

// Now check what sim_bc_only does differently - it uses boardSnapshot=null which returns score=1
// The issue might be in the sweep script's logic flow
// Let's check if the sweep has a bug in the 'continue' after position check

// Actually, let's just run the sweep's simulateDay on 6/17 with debug
console.log('\n--- Running sweep simulateDay logic manually ---');
const sorted = data
  .filter((c: any) => ALLOWED.has(c.symbol))
  .filter((c: any) => {
    const t = c.candleTime;
    return !(t >= '11:30' && t < '12:30');
  })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

console.log('Total sorted candles:', sorted.length);

// Check: does the sweep skip candles because of 'continue' in position check?
// The issue: when existingPos check does 'continue', it skips the entry logic
// But if no position exists, it should fall through to entry logic
// Let me trace through the first few signals

const buffers2 = new Map<string, CandleWithSignal[]>();
let entryAttempts = 0;
let boardBlocked = 0;
let exposureBlocked = 0;
let volumeBlocked = 0;
let slTimeBlocked = 0;
let atrBlocked2 = 0;
let entered = 0;

for (const candle of sorted) {
  const { symbol, candleTime, open, high, low, close, volume } = candle;
  if (!buffers2.has(symbol)) buffers2.set(symbol, []);
  const buf = buffers2.get(symbol) as CandleWithSignal[];
  const c4s: CandleWithSignal = { time: `${candle.tradeDate}T${candleTime}:00`, dayKey: candle.tradeDate, timestamp: 0, open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buf.push(c4s);
  const closes = buf.map(c => c.close); const li = buf.length - 1;
  const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
  buf[li].ma5 = ma5S[li]; buf[li].ma25 = ma25S[li]; buf[li].rsi = rsiS[li]; buf[li].bbUpper = bbS.upper[li]; buf[li].bbMiddle = bbS.middle[li]; buf[li].bbLower = bbS.lower[li];

  if (candleTime < '09:30' || candleTime >= '15:15') continue;
  if (buf.length < 30) continue;

  const withSignals = detectSignals(buf);
  const latest = withSignals[withSignals.length - 1];
  buf[buf.length - 1] = latest;
  if (!latest.signal) continue;

  entryAttempts++;
  
  // Board score (null snapshot → returns 1, threshold is 1 → passes)
  // ATR filter
  if (buf.length >= 8) {
    const h = buf.map(c => c.high); const l = buf.map(c => c.low); const cl = buf.map(c => c.close);
    const atr = calcATR(h, l, cl, 7);
    const latestATR = atr[atr.length - 1];
    if (latestATR !== null && close > 0 && (latestATR / close) < 0.0012) {
      atrBlocked2++;
      continue;
    }
  }
  entered++;
  if (entered <= 3) console.log(`  Entry: ${symbol} ${candleTime} ${latest.signal.type} ${latest.signal.reason?.substring(0,40)}`);
}
console.log(`\nEntry attempts (signals): ${entryAttempts}`);
console.log(`ATR blocked: ${atrBlocked2}`);
console.log(`Would enter: ${entered}`);
