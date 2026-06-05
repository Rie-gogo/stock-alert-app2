/**
 * jq_sweep_filters.ts
 * ①ギャップアップ率フィルター（gapUpShortBlockPercent）
 * ②ショートエントリー最小RSI（shortMinRsi）
 * の2パラメータをスイープして60日バックテストで効果を検証する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_sweep_filters.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null;
  flow: number | null; slope: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++)
    result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return result;
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    if (i < data.length - 1) {
      ag = (ag * (period - 1) + gains[i]) / period;
      al = (al * (period - 1) + losses[i]) / period;
    }
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
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time),
    open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) {
      const prev = candles[i - SLOPE_LOOKBACK].ma25;
      if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev;
    }
  });
  return candles;
}

// ---- スイープ対象パラメータ ----
// ① gapUpShortBlockPercent: 当日始値が前日終値より X% 以上高い場合はショート禁止
//    undefined = 無効（現行）
const GAP_UP_VALUES: (number | undefined)[] = [undefined, 0.5, 1.0, 1.5, 2.0, 3.0];

// ② shortMinRsi: ショートエントリー時の最小RSI（これ未満ならショート禁止）
//    現行は 55（SHORT_RSI_MIN）。さらに引き上げて検証
const SHORT_MIN_RSI_VALUES: (number | undefined)[] = [undefined, 55, 60, 65, 70];

// ---- 組み合わせ生成 ----
interface SweepCase {
  label: string;
  gapUp: number | undefined;
  shortMinRsi: number | undefined;
}
const SWEEP_CASES: SweepCase[] = [];
for (const g of GAP_UP_VALUES) {
  for (const r of SHORT_MIN_RSI_VALUES) {
    const label = `gap=${g ?? 'off'}_rsi=${r ?? 'off'}`;
    SWEEP_CASES.push({ label, gapUp: g, shortMinRsi: r });
  }
}

async function runBacktest(sweepCase: SweepCase, allDays: string[], byTicker: Map<string, Map<string, JqBar[]>>): Promise<{
  label: string;
  totalProfit: number;
  avgPerDay: number;
  winRate: number;
  posDays: number;
  negDays: number;
  tradedDays: number;
  daysOver15k: number;
  best: number;
  worst: number;
  median: number;
}> {
  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;
  const dailyProfits: number[] = [];

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    // 前日終値マップ（gapUp計算用）
    const prevDayCloseMap = new Map<string, number>();

    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;

    // 前日終値を計算（当日の前の日付）
    const dayIdx = allDays.indexOf(day);
    if (dayIdx > 0 && sweepCase.gapUp !== undefined) {
      const prevDay = allDays[dayIdx - 1];
      for (const s of TARGET_STOCKS) {
        const prevBars = byTicker.get(s.symbol)?.get(prevDay);
        if (prevBars && prevBars.length > 0) {
          const sorted = [...prevBars].sort((a, b) => b.Time.localeCompare(a.Time));
          prevDayCloseMap.set(s.symbol, sorted[0].C);
        }
      }
    }

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      const open = cs[0]?.open ?? 0;
      return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
    });
    const marketBiasByProgress = (p: number): number => {
      let sum = 0, cnt = 0;
      for (const series of ratioSeries) {
        if (!series.length) continue;
        const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1))));
        sum += series[idx]; cnt++;
      }
      return cnt > 0 ? sum / cnt : 0;
    };
    const dayStats = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 };
    });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;

      const overrides: Parameters<typeof simulateStockReal>[10] = {
        shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
        lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
      };
      if (sweepCase.gapUp !== undefined) {
        overrides.gapUpShortBlockPercent = sweepCase.gapUp;
        const prevClose = prevDayCloseMap.get(s.symbol);
        if (prevClose !== undefined) overrides.prevDayClose = prevClose;
      }
      if (sweepCase.shortMinRsi !== undefined) {
        overrides.shortMinRsi = sweepCase.shortMinRsi;
      }

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasByProgress,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides
      );
      if (!res) continue;
      dayProfit += res.profitAmount;
      dayWin += res.winCount;
      dayLoss += res.lossCount;
    }

    grandTotal += dayProfit;
    grandWin += dayWin;
    grandLoss += dayLoss;
    if (dayProfit > 0) posDays++;
    else if (dayProfit < 0) negDays++;
    dailyProfits.push(Math.round(dayProfit));
  }

  const tradedDays = dailyProfits.length;
  const avgPerDay = tradedDays > 0 ? grandTotal / tradedDays : 0;
  const winRate = (grandWin + grandLoss) > 0 ? grandWin / (grandWin + grandLoss) : 0;
  const sorted = [...dailyProfits].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const best = Math.max(...dailyProfits);
  const worst = Math.min(...dailyProfits);
  const daysOver15k = dailyProfits.filter(p => p >= 15000).length;

  return {
    label: sweepCase.label,
    totalProfit: Math.round(grandTotal),
    avgPerDay: Math.round(avgPerDay),
    winRate,
    posDays,
    negDays,
    tradedDays,
    daysOver15k,
    best,
    worst,
    median,
  };
}

async function main() {
  console.log("=== フィルタースイープ バックテスト ===");
  console.log(`対象: ${SWEEP_CASES.length} ケース × 60日\n`);

  const dataDir = path.join(process.cwd(), "analysis", "jq_data");

  // データ読み込み
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`missing ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  // 共通の日付リスト（全銘柄に存在する日）
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys())
    .filter(d => (dayCount.get(d) ?? 0) >= 5)
    .sort()
    .slice(-60); // 直近60日

  console.log(`対象日数: ${allDays.length} (${allDays[0]} ~ ${allDays[allDays.length - 1]})\n`);

  // ベースライン（フィルターなし）を最初に実行
  const baseline = SWEEP_CASES.find(c => c.gapUp === undefined && c.shortMinRsi === undefined)!;
  console.log("ベースライン実行中...");
  const baseResult = await runBacktest(baseline, allDays, byTicker);
  console.log(`ベースライン: 合計=${baseResult.totalProfit.toLocaleString()}円 平均=${baseResult.avgPerDay.toLocaleString()}円/日 勝率=${(baseResult.winRate * 100).toFixed(1)}%\n`);

  // 全ケース実行
  const results = [baseResult];
  for (const c of SWEEP_CASES) {
    if (c.label === baseline.label) continue; // ベースラインはスキップ
    process.stdout.write(`  ${c.label}... `);
    const r = await runBacktest(c, allDays, byTicker);
    const diff = r.totalProfit - baseResult.totalProfit;
    const diffStr = diff >= 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
    console.log(`合計=${r.totalProfit.toLocaleString()}円 (${diffStr}円) 平均=${r.avgPerDay.toLocaleString()}円/日 勝率=${(r.winRate * 100).toFixed(1)}%`);
    results.push(r);
  }

  // 結果ソート（合計損益降順）
  const sorted = [...results].sort((a, b) => b.totalProfit - a.totalProfit);

  console.log("\n\n===== スイープ結果ランキング（合計損益順） =====");
  console.log("順位  ケース                         合計損益      平均/日   勝率    +日/-日  15k超え日");
  console.log("─".repeat(95));
  sorted.forEach((r, i) => {
    const diff = r.totalProfit - baseResult.totalProfit;
    const diffStr = r.label === baseline.label ? "(ベース)" : (diff >= 0 ? `(+${diff.toLocaleString()})` : `(${diff.toLocaleString()})`);
    const mark = r.label === baseline.label ? "★" : (diff > 0 ? "▲" : "▼");
    console.log(
      `${String(i + 1).padStart(2)}  ${mark} ${r.label.padEnd(30)} ${r.totalProfit.toLocaleString().padStart(10)}円 ${r.avgPerDay.toLocaleString().padStart(8)}円  ${(r.winRate * 100).toFixed(1).padStart(5)}%  ${r.posDays}/${r.negDays}  ${r.daysOver15k}/${r.tradedDays}  ${diffStr}`
    );
  });

  // CSV出力
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["label,gapUp,shortMinRsi,totalProfit,avgPerDay,winRate,posDays,negDays,tradedDays,daysOver15k,best,worst,median,diffFromBaseline"];
  for (const r of results) {
    const c = SWEEP_CASES.find(x => x.label === r.label)!;
    const diff = r.totalProfit - baseResult.totalProfit;
    csvRows.push([
      r.label, c.gapUp ?? "off", c.shortMinRsi ?? "off",
      r.totalProfit, r.avgPerDay, (r.winRate * 100).toFixed(1),
      r.posDays, r.negDays, r.tradedDays, r.daysOver15k,
      r.best, r.worst, r.median, diff
    ].join(","));
  }
  const csvPath = path.join(outDir, "sweep_filters.csv");
  fs.writeFileSync(csvPath, csvRows.join("\n"), "utf8");
  console.log(`\nCSV出力: ${csvPath}`);

  // 最良ケースのサマリー
  const best = sorted[0];
  if (best.label !== baseline.label) {
    console.log(`\n最良ケース: ${best.label}`);
    console.log(`  合計損益: ${best.totalProfit.toLocaleString()}円 (ベース比 +${(best.totalProfit - baseResult.totalProfit).toLocaleString()}円)`);
    console.log(`  平均/日:  ${best.avgPerDay.toLocaleString()}円`);
    console.log(`  勝率:     ${(best.winRate * 100).toFixed(1)}%`);
  } else {
    console.log("\n最良ケース: ベースライン（フィルターなし）が最も優秀でした");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
