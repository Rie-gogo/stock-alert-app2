/**
 * debugRanking.ts - デバッグ: 6920（レーザーテック）で1日シミュレーションを実行して取引が出るか確認
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  LONG_STOP_LOSS_PERCENT,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return result;
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = []; const losses: number[] = [];
  for (let i = 1; i < data.length; i++) { const d = data[i] - data[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100; else { const rs = avgGain / avgLoss; result[i] = 100 - 100 / (1 + rs); }
    if (i < data.length - 1) { avgGain = (avgGain * (period - 1) + gains[i]) / period; avgLoss = (avgLoss * (period - 1) + losses[i]) / period; }
  }
  return result;
}
function calcBollinger(data: number[], period = 20, m = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const w = data.slice(i - period + 1, i + 1);
    const avg = w.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    upper[i] = avg + m * std; lower[i] = avg - m * std;
  }
  return { upper, lower };
}
function toTimestamp(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
}
function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14); const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");
  const testSymbol = '6920';
  const testDay = '2026-03-02';
  
  const s = TARGET_STOCKS.find(x => x.symbol === testSymbol)!;
  const fp = path.join(dataDir, `${testSymbol}.json`);
  const allBars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
  const dayBars = allBars.filter(b => b.Date === testDay);
  
  console.log(`${testSymbol} ${testDay}: ${dayBars.length} bars`);
  console.log(`First bar: ${JSON.stringify(dayBars[0])}`);
  
  const candles = barsToCandles(dayBars);
  console.log(`Candles: ${candles.length}`);
  console.log(`First candle: ${JSON.stringify(candles[0])}`);
  console.log(`Last candle: ${JSON.stringify(candles[candles.length-1])}`);
  
  // 市場バイアスを固定値でテスト
  const marketBias = (_p: number) => 0.0;
  
  console.log(`\nSHORT_STOP_LOSS_PERCENT: ${SHORT_STOP_LOSS_PERCENT}`);
  console.log(`LUNCH_EXIT_ALL_MINUTE: ${LUNCH_EXIT_ALL_MINUTE}`);
  console.log(`LONG_STOP_LOSS_PERCENT: ${LONG_STOP_LOSS_PERCENT}`);
  
  const res = simulateStockReal(
    s.symbol, s.ticker, s.name, candles, marketBias, 3_000_000, 70, 30, 2.0, false, 1.0,
    { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE, longStopLossPercent: LONG_STOP_LOSS_PERCENT }
  );
  
  if (!res) {
    console.log("Result: null (simulation returned null)");
    return;
  }
  
  console.log(`\nResult: profitAmount=${res.profitAmount}, tradesCount=${res.tradesCount}, winCount=${res.winCount}, lossCount=${res.lossCount}`);
  console.log(`Trades: ${res.trades.length}`);
  if (res.trades.length > 0) {
    console.log("First trade:", JSON.stringify(res.trades[0]));
  }
}

main();
