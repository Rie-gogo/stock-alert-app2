/**
 * jq_margin_backtest.ts
 * 元金300万円・信用取引（レバレッジ3倍）・5銘柄ポートフォリオ共有 バックテスト
 *
 * 【現実に即したシミュレーション設計】
 * - 元金（証拠金）: 300万円（1つの口座）
 * - 信用取引レバレッジ: 3倍（建玉上限 = 元金 × 3 = 900万円）
 * - 5銘柄で資金を共有（同時保有は最大3銘柄まで）
 * - 1銘柄あたりの建玉上限: 建玉余力の49%（通常銘柄）
 * - 信用取引コスト: 日歩（デイトレは当日中に決済するため0円）
 * - 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_margin_backtest.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import { calcVWAP } from "../server/vwap";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// 信用取引パラメータ
// ============================================================
const INITIAL_EQUITY = 5_000_000;   // 元金（証拠金）: 500万円
const LEVERAGE = 3;                  // 信用取引レバレッジ: 3倍
const MAX_CONCURRENT_STOCKS = 3;     // 同時保有銘柄数の上限（ポートフォリオルール）
const LOT_RATIO_NORMAL = 0.49;       // 1回エントリーに使う建玉余力の割合（通常銘柄）
const LOT_RATIO_SMALL = 0.05;        // 低相性銘柄の建玉比率（極小）

// 低相性銘柄（本番と同じ設定）
const HIGH_VOL_SYMBOLS = new Set([
  "9984", "4568", "6526", "9107", "6723", "5803", "8316", "7203", "5016",
  "7011", "8306", "6758"
]);

// バックテスト対象銘柄（5銘柄）
const BT_STOCKS = [
  { symbol: "6967", name: "新光電気工業" },
  { symbol: "6976", name: "太陽誘電" },
  { symbol: "6981", name: "村田製作所" },
  { symbol: "3778", name: "さくらインターネット" },
  { symbol: "3436", name: "SUMCO" },
  { symbol: "6966", name: "三井ハイテック" },
  { symbol: "6963", name: "ローム" },
  { symbol: "6920", name: "レーザーテック" },
  { symbol: "2379", name: "ディップ" },
  { symbol: "6857", name: "アドバンテスト" },
  { symbol: "4063", name: "信越化学工業" },
  { symbol: "8035", name: "東京エレクトロン" },
  { symbol: "6861", name: "キーエンス" },
  { symbol: "6594", name: "日本電産" },
  { symbol: "6702", name: "富士通" },
  { symbol: "6723", name: "ルネサスエレクトロニクス" },
  { symbol: "6758", name: "ソニーグループ" },
  { symbol: "7011", name: "三菱重工業" },
  { symbol: "8306", name: "三菱UFJ FG" },
  { symbol: "9984", name: "ソフトバンクグループ" },
];

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null;
  flow: number | null; slope: number | null; vwap: number | null;
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
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time),
    open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null, vwap: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const vwapSeries = calcVWAP(candles);
  candles.forEach((c, i) => { c.vwap = vwapSeries[i]; });
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");

  // 利用可能な銘柄データを読み込む
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`[margin-bt] missing ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[margin-bt] Days found: ${allDays.length} (${allDays[0]} .. ${allDays[allDays.length - 1]})`);
  console.log(`[margin-bt] 元金: ${INITIAL_EQUITY.toLocaleString()}円 / レバレッジ: ${LEVERAGE}倍 / 建玉上限: ${(INITIAL_EQUITY * LEVERAGE).toLocaleString()}円`);

  // ============================================================
  // 信用取引の資金管理
  // ============================================================
  // 元金300万円 × 3倍 = 建玉上限900万円
  // 1銘柄あたりの建玉 = 建玉余力 × LOT_RATIO
  // 同時保有上限 = MAX_CONCURRENT_STOCKS（3銘柄）
  // デイトレなので日歩（金利）は0円
  //
  // 実装方針:
  //   各銘柄を simulateStockReal で独立シミュレーション（本番と同じロジック）
  //   ただし capitalPerStock = 建玉上限 / MAX_CONCURRENT_STOCKS = 900万円 / 3 = 300万円/銘柄
  //   → 1銘柄あたり最大300万円 × 49% = 約147万円の建玉（現行と同じ）
  //
  //   【現行との違い】
  //   現行: 各銘柄が独立した300万円の財布を持つ（合計1500万円相当）
  //   今回: 300万円の元金を3倍レバで運用 → 建玉上限900万円を3銘柄で分割
  //         → 1銘柄あたりの建玉上限 = 900万円 / 3 = 300万円
  //   ※ 建玉上限は同じ300万円だが、元手は300万円（現行の1/5）
  //
  //   損益は同じでも「元金に対するリターン率」が5倍になる

  // 1銘柄あたりの割当資金（建玉上限）
  const capitalPerStock = (INITIAL_EQUITY * LEVERAGE) / MAX_CONCURRENT_STOCKS;
  console.log(`[margin-bt] 1銘柄あたり建玉上限: ${capitalPerStock.toLocaleString()}円`);

  const dailyRows: string[] = ["date,marketEfficiency,rangeBoundDay,totalProfit,winCount,lossCount,winRate,equity"];
  const symbolAgg = new Map<string, { name: string; profit: number; win: number; loss: number; trades: number }>();
  const reasonAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const dailyProfits: { date: string; profit: number }[] = [];

  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;
  let runningEquity = INITIAL_EQUITY; // 元金の累積変動

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) { continue; }

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
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      // capitalPerStock = 300万円（元金300万×3倍÷3銘柄）を各銘柄に割り当て
      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasByProgress,
        capitalPerStock,   // ← 信用取引: 1銘柄あたりの建玉上限
        70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;
      dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      const agg = symbolAgg.get(s.symbol) ?? { name: s.name, profit: 0, win: 0, loss: 0, trades: 0 };
      agg.profit += res.profitAmount; agg.win += res.winCount; agg.loss += res.lossCount; agg.trades += res.tradesCount;
      symbolAgg.set(s.symbol, agg);

      let open: { time: string; price: number; shares: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") open = { time: t.time, price: t.price, shares: t.shares, type: t.type };
        else if ((t.type === "sell" || t.type === "cover") && open) {
          const profit = t.profit ?? 0;
          const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
          const reasonKey = (sig?.reason ?? "").split("(")[0].trim() || "不明";
          const ra = reasonAgg.get(reasonKey) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          ra.profit += profit; ra.count++; if (profit > 0) ra.win++; else ra.loss++; reasonAgg.set(reasonKey, ra);
          open = null;
        }
      }
    }

    runningEquity += dayProfit;
    const wr = (dayWin + dayLoss) > 0 ? dayWin / (dayWin + dayLoss) : 0;
    dailyRows.push([day, eff.toFixed(3), String(rangeBound), Math.round(dayProfit), dayWin, dayLoss, wr.toFixed(3), Math.round(runningEquity)].join(","));
    dailyProfits.push({ date: day, profit: Math.round(dayProfit) });
    grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
    if (dayProfit > 0) posDays++; else if (dayProfit < 0) negDays++;
    console.log(`[margin-bt] ${day}: profit=${Math.round(dayProfit)} equity=${Math.round(runningEquity).toLocaleString()} win=${dayWin} loss=${dayLoss}`);
  }

  const outDir = path.join(process.cwd(), "analysis", "jq_margin_out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "daily.csv"), dailyRows.join("\n"), "utf8");

  const symRows = ["symbol,name,profit,win,loss,trades,winRate"];
  for (const [sym, a] of Array.from(symbolAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr2 = a.trades > 0 ? a.win / a.trades : 0;
    symRows.push([sym, a.name, Math.round(a.profit), a.win, a.loss, a.trades, wr2.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_symbol.csv"), symRows.join("\n"), "utf8");

  const reasonRows = ["reason,profit,win,loss,count,winRate"];
  for (const [r, a] of Array.from(reasonAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr2 = a.count > 0 ? a.win / a.count : 0;
    reasonRows.push([`"${r}"`, Math.round(a.profit), a.win, a.loss, a.count, wr2.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_reason.csv"), reasonRows.join("\n"), "utf8");

  const tradedDays = dailyProfits.length;
  const avg = tradedDays > 0 ? grandTotal / tradedDays : 0;
  const overallWr = (grandWin + grandLoss) > 0 ? grandWin / (grandWin + grandLoss) : 0;
  const profitsArr = dailyProfits.map(d => d.profit);
  const best = Math.max(...profitsArr), worst = Math.min(...profitsArr);
  const daysOver15k = profitsArr.filter(p => p >= 15000).length;
  const medianDay = [...profitsArr].sort((a, b) => a - b)[Math.floor(profitsArr.length / 2)];
  const finalEquity = runningEquity;
  const totalReturn = ((finalEquity - INITIAL_EQUITY) / INITIAL_EQUITY * 100);
  const annualizedReturn = totalReturn * (250 / tradedDays); // 年率換算（250営業日）

  console.log("\n===== 信用取引デイトレ バックテスト SUMMARY =====");
  console.log(`【資金設定】元金: ${INITIAL_EQUITY.toLocaleString()}円 / レバレッジ: ${LEVERAGE}倍 / 建玉上限: ${(INITIAL_EQUITY * LEVERAGE).toLocaleString()}円`);
  console.log(`【期間】Traded days: ${tradedDays}日`);
  console.log(`【損益】Total profit: ${Math.round(grandTotal).toLocaleString()} yen`);
  console.log(`【損益】Avg/day: ${Math.round(avg).toLocaleString()} yen`);
  console.log(`【損益】Median/day: ${medianDay.toLocaleString()} yen`);
  console.log(`【勝率】Win/Loss trades: ${grandWin}/${grandLoss}  winRate: ${(overallWr * 100).toFixed(1)}%`);
  console.log(`【日次】Positive days: ${posDays}, Negative days: ${negDays}`);
  console.log(`【日次】Best day: ${best.toLocaleString()}, Worst day: ${worst.toLocaleString()}`);
  console.log(`【日次】Days >= 15000 yen: ${daysOver15k}/${tradedDays} (${(daysOver15k / tradedDays * 100).toFixed(1)}%)`);
  console.log(`【資産推移】元金: ${INITIAL_EQUITY.toLocaleString()}円 → 最終: ${Math.round(finalEquity).toLocaleString()}円`);
  console.log(`【リターン】${totalReturn.toFixed(1)}% (年率換算: ${annualizedReturn.toFixed(1)}%)`);
  console.log(`\n[margin-bt] CSVs written to ${outDir}`);
}

main();
