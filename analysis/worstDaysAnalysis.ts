/**
 * worstDaysAnalysis.ts
 * 最悪日（3/23・4/30・5/14）のトレード内訳を詳細分析する。
 * 損失パターンを特定して改善仮説を立てる。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/worstDaysAnalysis.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  type SimOverrides,
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
  const c2: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = c2.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  c2.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = c2.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  c2.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = c2[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return c2;
}

function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");
  const WORST_DAYS = ["2026-05-14", "2026-03-23", "2026-04-24"];

  // 現在の設定（ロング1.5%、ショート0.55%、昼休み11:20）
  const overrides: SimOverrides = {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
    longStopLossPercent: 1.5,
  };

  // データを読み込む
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  for (const day of WORST_DAYS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`最悪日分析: ${day}`);
    console.log("=".repeat(60));

    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }

    if (candleMap.size < 5) {
      console.log(`  データ不足（${candleMap.size}銘柄）`);
      continue;
    }

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasAt = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    console.log(`  市場効率: ${eff.toFixed(3)} | レンジ相場: ${rangeBound}`);
    console.log(`  市場方向（寄り付き→引け）: ${(marketBiasAt(1) * 100).toFixed(2)}%`);

    // 銘柄別詳細
    const symbolResults: { name: string; symbol: string; profit: number; trades: string[] }[] = [];

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
      if (!res) continue;
      if (res.profitAmount === 0 && res.winCount === 0 && res.lossCount === 0) continue;

      const tradeDetails: string[] = [];
      for (const t of res.trades) {
        if (t.type === "sell" || t.type === "cover") {
          const sign = t.profit >= 0 ? "+" : "";
          tradeDetails.push(`  ${t.time} [${t.type}] ${sign}${Math.round(t.profit).toLocaleString()}円 (${(t.profitRate * 100).toFixed(2)}%)`);
        }
      }
      symbolResults.push({ name: s.name, symbol: s.symbol, profit: res.profitAmount, trades: tradeDetails });
    }

    // 損益順でソート
    symbolResults.sort((a, b) => a.profit - b.profit);

    let dayTotal = 0;
    for (const r of symbolResults) {
      dayTotal += r.profit;
      const sign = r.profit >= 0 ? "+" : "";
      console.log(`\n  [${r.symbol}] ${r.name}: ${sign}${Math.round(r.profit).toLocaleString()}円`);
      for (const t of r.trades) console.log(t);
    }
    console.log(`\n  --- 日合計: ${Math.round(dayTotal).toLocaleString()}円 ---`);

    // 損失の内訳を集計
    let longLoss = 0, shortLoss = 0, longWin = 0, shortWin = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
      if (!res) continue;
      for (const t of res.trades) {
        if (t.type === "sell") { if (t.profit >= 0) longWin += t.profit; else longLoss += t.profit; }
        if (t.type === "cover") { if (t.profit >= 0) shortWin += t.profit; else shortLoss += t.profit; }
      }
    }
    console.log(`\n  損益内訳:`);
    console.log(`    ロング利益: +${Math.round(longWin).toLocaleString()}円`);
    console.log(`    ロング損失: ${Math.round(longLoss).toLocaleString()}円`);
    console.log(`    ショート利益: +${Math.round(shortWin).toLocaleString()}円`);
    console.log(`    ショート損失: ${Math.round(shortLoss).toLocaleString()}円`);
  }
}

main();
