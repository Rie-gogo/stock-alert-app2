/**
 * jq_highvol_sweep.ts
 * 超高ボラ日閾値（HIGH_VOL_DAY_THRESHOLD）のスイープ
 *
 * 現在: 8% → 1月の急落相場（値幅6〜7%）を捕捉できていない
 * 目的: 閾値を下げることで1月の損失を防ぎつつ、他月の利益を維持できるか検証
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_highvol_sweep.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  SimOverrides,
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

function runBacktest(
  allDays: string[],
  byTicker: Map<string, Map<string, JqBar[]>>,
  overrides: SimOverrides
): {
  totalProfit: number; win: number; loss: number; posDays: number; negDays: number; days: number;
  monthAgg: Map<string, { profit: number; win: number; loss: number; days: number; posDays: number }>;
} {
  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;
  const monthAgg = new Map<string, { profit: number; win: number; loss: number; days: number; posDays: number }>();

  for (const day of allDays) {
    const month = day.slice(0, 7);
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
      if (!res) continue;
      dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
    }

    grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
    if (dayProfit > 0) posDays++; else if (dayProfit < 0) negDays++;

    const ma = monthAgg.get(month) ?? { profit: 0, win: 0, loss: 0, days: 0, posDays: 0 };
    ma.profit += dayProfit; ma.win += dayWin; ma.loss += dayLoss; ma.days++;
    if (dayProfit > 0) ma.posDays++;
    monthAgg.set(month, ma);
  }

  return { totalProfit: Math.round(grandTotal), win: grandWin, loss: grandLoss, posDays, negDays, days: allDays.length, monthAgg };
}

function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`missing ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`Days: ${allDays.length} (${allDays[0]} .. ${allDays[allDays.length - 1]})`);

  const BASE: SimOverrides = { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE };

  // highVolDayThreshold のスイープ（%単位で指定）
  const thresholds = [8, 7, 6, 5, 4, 3];  // 現在は8%

  const results: { threshold: number; result: ReturnType<typeof runBacktest> }[] = [];

  for (const thresh of thresholds) {
    process.stdout.write(`[sweep] highVol=${thresh}%... `);
    const overrides: SimOverrides = { ...BASE, highVolDayThreshold: thresh };
    const result = runBacktest(allDays, byTicker, overrides);
    results.push({ threshold: thresh, result });
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    const avg = Math.round(result.totalProfit / result.days);
    console.log(`${result.totalProfit.toLocaleString()}円 avg=${avg.toLocaleString()}円 wr=${wr.toFixed(1)}% pos=${result.posDays}日 neg=${result.negDays}日`);
  }

  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });

  // 月別詳細
  const monthCsvRows = ["threshold,month,profit,avgPerDay,posDays,days"];
  for (const { threshold, result } of results) {
    for (const [m, ma] of Array.from(result.monthAgg.entries()).sort()) {
      const avg = ma.days > 0 ? Math.round(ma.profit / ma.days) : 0;
      monthCsvRows.push([threshold, m, Math.round(ma.profit), avg, ma.posDays, ma.days].join(","));
    }
  }
  fs.writeFileSync(path.join(outDir, "highvol_sweep_monthly.csv"), monthCsvRows.join("\n"), "utf8");

  const baseline = results[0].result.totalProfit;
  console.log("\n===== 超高ボラ日閾値スイープ結果 =====");
  console.log(`ベースライン(8%): ${baseline.toLocaleString()}円`);
  for (const { threshold, result } of results) {
    const improvement = result.totalProfit - baseline;
    const avg = Math.round(result.totalProfit / result.days);
    const sign = improvement >= 0 ? "✅" : "❌";
    console.log(`${sign} ${threshold}%: ${result.totalProfit.toLocaleString()}円 (${improvement >= 0 ? '+' : ''}${improvement.toLocaleString()}円) 日平均${avg.toLocaleString()}円 pos=${result.posDays}日 neg=${result.negDays}日`);
  }

  // 月別詳細表示
  console.log("\n===== 月別損益（閾値別） =====");
  const months = Array.from(results[0].result.monthAgg.keys()).sort();
  const header = ["月", ...results.map(r => `${r.threshold}%`)].join("\t");
  console.log(header);
  for (const m of months) {
    const row = [m, ...results.map(r => {
      const ma = r.result.monthAgg.get(m);
      if (!ma) return "N/A";
      return `${Math.round(ma.profit).toLocaleString()}円`;
    })].join("\t");
    console.log(row);
  }

  console.log(`\nCSVs written to ${outDir}`);
}

main();
