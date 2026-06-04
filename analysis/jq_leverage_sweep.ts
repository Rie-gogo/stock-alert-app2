/**
 * jq_leverage_sweep.ts
 * 信用取引レバレッジ別バックテスト
 *
 * 現在のシステムは「元金の49%を建玉」として計算しているが、
 * 信用取引では元金の3.3倍まで取引可能。
 * レバレッジ1.0〜3.3倍のスイープで最適な倍率を検証する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_leverage_sweep.ts
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

interface DayResult {
  date: string;
  profit: number;
  win: number;
  loss: number;
}

function runBacktest(
  allDays: string[],
  byTicker: Map<string, Map<string, JqBar[]>>,
  leverageMultiplier: number,  // 1.0 = 現状, 2.0 = 2倍, 3.3 = フルレバ
  initialCapital: number = 3_000_000
): {
  totalProfit: number; win: number; loss: number; posDays: number; negDays: number; days: number;
  maxWinDay: number; maxLossDay: number;
  monthAgg: Map<string, { profit: number; win: number; loss: number; days: number; posDays: number }>;
  dailyResults: DayResult[];
} {
  // レバレッジを反映した実効資本
  const effectiveCapital = initialCapital * leverageMultiplier;
  const BASE: SimOverrides = { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE };

  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;
  let maxWinDay = 0, maxLossDay = 0;
  const monthAgg = new Map<string, { profit: number; win: number; loss: number; days: number; posDays: number }>();
  const dailyResults: DayResult[] = [];

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
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, effectiveCapital, 70, 30, 2.0, rangeBound, 1.0, BASE);
      if (!res) continue;
      dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
    }

    grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
    if (dayProfit > 0) posDays++; else if (dayProfit < 0) negDays++;
    if (dayProfit > maxWinDay) maxWinDay = dayProfit;
    if (dayProfit < maxLossDay) maxLossDay = dayProfit;

    dailyResults.push({ date: day, profit: dayProfit, win: dayWin, loss: dayLoss });

    const ma = monthAgg.get(month) ?? { profit: 0, win: 0, loss: 0, days: 0, posDays: 0 };
    ma.profit += dayProfit; ma.win += dayWin; ma.loss += dayLoss; ma.days++;
    if (dayProfit > 0) ma.posDays++;
    monthAgg.set(month, ma);
  }

  return { totalProfit: Math.round(grandTotal), win: grandWin, loss: grandLoss, posDays, negDays, days: allDays.length, maxWinDay: Math.round(maxWinDay), maxLossDay: Math.round(maxLossDay), monthAgg, dailyResults };
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
  console.log(`元金: 300万円`);
  console.log();

  // レバレッジスイープ: 1.0（現状）, 1.5, 2.0, 2.5, 3.0, 3.3（フルレバ）
  const leverages = [1.0, 1.5, 2.0, 2.5, 3.0, 3.3];
  const results: { leverage: number; result: ReturnType<typeof runBacktest> }[] = [];

  for (const lev of leverages) {
    process.stdout.write(`[sweep] leverage=${lev}x... `);
    const result = runBacktest(allDays, byTicker, lev, 3_000_000);
    results.push({ leverage: lev, result });
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    const avg = Math.round(result.totalProfit / result.days);
    console.log(`${result.totalProfit.toLocaleString()}円 avg=${avg.toLocaleString()}円 wr=${wr.toFixed(1)}% pos=${result.posDays}日 neg=${result.negDays}日 maxLoss=${result.maxLossDay.toLocaleString()}円`);
  }

  console.log("\n===== 信用取引レバレッジ別シミュレーション結果 =====");
  console.log("元金300万円, 137営業日（2025年11月〜2026年5月）");
  console.log();
  console.log("倍率\t実効資本\t半年損益\t日平均\t\t1月損益\t\t最悪日損失\t目標15k達成日");

  for (const { leverage, result } of results) {
    const effectiveCapital = (300 * leverage).toFixed(0);
    const avg = Math.round(result.totalProfit / result.days);
    const janProfit = result.monthAgg.get("2026-01")?.profit ?? 0;
    const days15k = result.dailyResults.filter(d => d.profit >= 15000).length;
    console.log(`${leverage}x\t${effectiveCapital}万円\t\t${result.totalProfit.toLocaleString()}円\t${avg.toLocaleString()}円\t\t${Math.round(janProfit).toLocaleString()}円\t\t${result.maxLossDay.toLocaleString()}円\t\t${days15k}日`);
  }

  console.log("\n===== 月別損益（レバレッジ別） =====");
  const months = Array.from(results[0].result.monthAgg.keys()).sort();
  console.log(["月", ...leverages.map(l => `${l}x`)].join("\t\t"));
  for (const m of months) {
    const row = [m, ...results.map(r => {
      const ma = r.result.monthAgg.get(m);
      if (!ma) return "N/A";
      const avg = Math.round(ma.profit / ma.days);
      return `${Math.round(ma.profit).toLocaleString()}円(日均${avg.toLocaleString()}円)`;
    })].join("\t");
    console.log(row);
  }

  // CSVに保存
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  
  const csvLines = ["leverage,effectiveCapital,totalProfit,avgPerDay,jan2026,maxLossDay,days15k,posDays,negDays,winRate"];
  for (const { leverage, result } of results) {
    const effectiveCapital = 300 * leverage;
    const avg = Math.round(result.totalProfit / result.days);
    const janProfit = Math.round(result.monthAgg.get("2026-01")?.profit ?? 0);
    const days15k = result.dailyResults.filter(d => d.profit >= 15000).length;
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    csvLines.push(`${leverage},${effectiveCapital},${result.totalProfit},${avg},${janProfit},${result.maxLossDay},${days15k},${result.posDays},${result.negDays},${wr.toFixed(1)}`);
  }
  fs.writeFileSync(path.join(outDir, "leverage_sweep.csv"), csvLines.join("\n") + "\n");
  console.log("\n✅ leverage_sweep.csv に保存しました");
}

main();
