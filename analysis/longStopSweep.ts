/**
 * longStopSweep.ts
 * ロング専用損切り幅を0.3%〜3.0%でスイープし、最適値を特定する。
 * J-Quants 60営業日データを使用。
 * ショートは既に SHORT_STOP_LOSS_PERCENT=0.55% で固定済み。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/longStopSweep.ts
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

  // データを1回だけ読み込む
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[longStop] Days: ${allDays.length}`);

  // 各日のコンテキストを事前計算
  interface DayContext {
    candleMap: Map<string, RealCandle[]>;
    marketBiasAt: (p: number) => number;
    rangeBound: boolean;
  }
  const dayContexts = new Map<string, DayContext>();
  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;
    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasAt = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    dayContexts.set(day, { candleMap, marketBiasAt, rangeBound: isRangeBoundDay(eff) });
  }

  // ロング損切り幅のスイープ: 0.3%〜3.0%（細かい刻みで）
  const stopLevels = [0.3, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];

  interface StopResult {
    stop: number;
    totalProfit: number;
    avgPerDay: number;
    medianPerDay: number;
    winRate: number;
    posDays: number;
    negDays: number;
    worstDay: number;
    daysOver15k: number;
  }

  const results: StopResult[] = [];

  for (const stop of stopLevels) {
    // ショートは固定（SHORT_STOP_LOSS_PERCENT=0.55%）、ロングのみスイープ
    const overrides: SimOverrides = {
      shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
      lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
      longStopLossPercent: stop,
    };
    let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;
    let worstDay = 0, daysOver15k = 0, tradedDays = 0;
    const dailyProfits: number[] = [];

    for (const day of allDays) {
      const ctx = dayContexts.get(day);
      if (!ctx) continue;
      tradedDays++;
      let dayProfit = 0, dayWin = 0, dayLoss = 0;
      for (const s of TARGET_STOCKS) {
        const candles = ctx.candleMap.get(s.symbol); if (!candles) continue;
        const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, ctx.marketBiasAt, 3_000_000, 70, 30, 2.0, ctx.rangeBound, 1.0, overrides);
        if (!res) continue;
        dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      }
      grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
      dailyProfits.push(Math.round(dayProfit));
      if (dayProfit > 0) posDays++;
      else if (dayProfit < 0) { negDays++; if (dayProfit < worstDay) worstDay = dayProfit; }
      if (dayProfit >= 15000) daysOver15k++;
    }

    const sorted = [...dailyProfits].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const winRate = (grandWin + grandLoss) > 0 ? grandWin / (grandWin + grandLoss) : 0;

    results.push({ stop, totalProfit: Math.round(grandTotal), avgPerDay: Math.round(grandTotal / tradedDays), medianPerDay: Math.round(median), winRate, posDays, negDays, worstDay: Math.round(worstDay), daysOver15k });
    console.log(`[longStop] stop=${stop.toFixed(2)}% total=${Math.round(grandTotal).toString().padStart(9)} avg=${Math.round(grandTotal/tradedDays).toString().padStart(7)} median=${Math.round(median).toString().padStart(8)} wr=${(winRate*100).toFixed(1)}% pos=${posDays} neg=${negDays} worst=${Math.round(worstDay).toString().padStart(9)} 15k=${daysOver15k}`);
  }

  const best = results.reduce((a, b) => a.totalProfit > b.totalProfit ? a : b);
  console.log(`\n====== ロング損切り幅スイープ結果 ======`);
  console.log(`${"損切り幅".padEnd(8)} ${"総損益".padStart(10)} ${"日平均".padStart(8)} ${"中央値".padStart(8)} ${"勝率".padStart(7)} ${"最悪日".padStart(10)} ${"15k+日".padStart(7)}`);
  console.log("-".repeat(70));
  for (const r of results) {
    const marker = r.stop === best.stop ? " ★最良" : "";
    console.log(`${(r.stop.toFixed(2) + "%").padEnd(8)} ${r.totalProfit.toString().padStart(10)} ${r.avgPerDay.toString().padStart(8)} ${r.medianPerDay.toString().padStart(8)} ${(r.winRate*100).toFixed(1).padStart(6)}% ${r.worstDay.toString().padStart(10)} ${r.daysOver15k.toString().padStart(7)}${marker}`);
  }

  // CSV保存
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["stopPercent,totalProfit,avgPerDay,medianPerDay,winRate,posDays,negDays,worstDay,daysOver15k"];
  for (const r of results) {
    csvRows.push([r.stop, r.totalProfit, r.avgPerDay, r.medianPerDay, r.winRate.toFixed(4), r.posDays, r.negDays, r.worstDay, r.daysOver15k].join(","));
  }
  fs.writeFileSync(path.join(outDir, "long_stop_sweep.csv"), csvRows.join("\n"), "utf8");
  console.log(`\n[longStop] Best long stop: ${best.stop}% (Total: ${best.totalProfit.toLocaleString()}円)`);
}

main();
