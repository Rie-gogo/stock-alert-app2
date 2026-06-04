/**
 * stockPerformanceRanking.ts
 * 全20銘柄（TARGET_STOCKS）の損益・勝率・PFをJ-Quants 60営業日で集計し、
 * SIMULATION_STOCKS（現在の10銘柄）との比較および入れ替え候補を特定する。
 *
 * jq_backtest.ts と同一のシミュレーション呼び出しパターンを使用。
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/stockPerformanceRanking.ts
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

  // 現在のSIMULATION_STOCKSの銘柄コード
  const currentSimStocks = new Set(['3436', '3778', '6981', '6758', '8306', '8035', '6857', '6920', '7011', '9984']);

  // 銘柄ごとに日別バー配列を構築
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`[ranking] missing ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[ranking] Days: ${allDays.length} (${allDays[0]} .. ${allDays[allDays.length - 1]})`);

  // 銘柄別集計
  const symbolAgg = new Map<string, {
    name: string; sector: string; profit: number; win: number; loss: number; trades: number;
    totalWinProfit: number; totalLossAmount: number;
  }>();
  for (const s of TARGET_STOCKS) {
    symbolAgg.set(s.symbol, { name: s.name, sector: s.sector, profit: 0, win: 0, loss: 0, trades: 0, totalWinProfit: 0, totalLossAmount: 0 });
  }

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;

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

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE, longStopLossPercent: LONG_STOP_LOSS_PERCENT }
      );
      if (!res) continue;

      const agg = symbolAgg.get(s.symbol)!;
      agg.profit += res.profitAmount;
      agg.win += res.winCount;
      agg.loss += res.lossCount;
      agg.trades += res.tradesCount;

      // 取引ペアリングで平均利益・損失を計算
      let open: { price: number; shares: number } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          open = { price: t.price, shares: t.shares };
        } else if ((t.type === "sell" || t.type === "cover") && open) {
          const profit = t.profit ?? 0;
          if (profit > 0) agg.totalWinProfit += profit;
          else agg.totalLossAmount += Math.abs(profit);
          open = null;
        }
      }
    }
  }

  // 損益順にソート
  const results = Array.from(symbolAgg.entries())
    .map(([symbol, agg]) => ({
      symbol,
      ...agg,
      winRate: agg.trades > 0 ? (agg.win / agg.trades) * 100 : 0,
      avgProfit: agg.win > 0 ? agg.totalWinProfit / agg.win : 0,
      avgLoss: agg.loss > 0 ? agg.totalLossAmount / agg.loss : 0,
      profitFactor: agg.totalLossAmount > 0 ? agg.totalWinProfit / agg.totalLossAmount : (agg.totalWinProfit > 0 ? 999 : 0),
      inCurrentSim: currentSimStocks.has(symbol),
    }))
    .sort((a, b) => b.profit - a.profit);

  console.log("\n=== 全銘柄パフォーマンスランキング（J-Quants 60営業日） ===\n");
  console.log(`${"順".padEnd(3)} ${"銘柄コード+名".padEnd(24)} ${"セクター".padEnd(12)} ${"現在"} ${"総損益".padStart(11)} ${"取引".padStart(5)} ${"勝率".padStart(7)} ${"PF".padStart(5)} ${"平均利益".padStart(9)} ${"平均損失".padStart(9)}`);
  console.log("-".repeat(105));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = String(i + 1).padEnd(3);
    const name = `${r.symbol} ${r.name}`.padEnd(24);
    const sector = r.sector.padEnd(12);
    const current = r.inCurrentSim ? "★" : " ";
    const profit = `${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円`.padStart(11);
    const trades = String(r.trades).padStart(5);
    const winRate = `${r.winRate.toFixed(1)}%`.padStart(7);
    const pf = r.profitFactor.toFixed(2).padStart(5);
    const avgP = `+${Math.round(r.avgProfit).toLocaleString()}`.padStart(9);
    const avgL = `-${Math.round(r.avgLoss).toLocaleString()}`.padStart(9);
    console.log(`${rank} ${name} ${sector} ${current}  ${profit} ${trades} ${winRate} ${pf} ${avgP} ${avgL}`);
  }

  // 現在のSIMULATION_STOCKSの合計
  const simResults = results.filter(r => r.inCurrentSim);
  const simTotal = simResults.reduce((sum, r) => sum + r.profit, 0);
  const allTotal = results.reduce((sum, r) => sum + r.profit, 0);
  console.log(`\n現在のSIMULATION_STOCKS（10銘柄）合計: ${simTotal >= 0 ? "+" : ""}${Math.round(simTotal).toLocaleString()}円`);
  console.log(`全20銘柄合計: ${allTotal >= 0 ? "+" : ""}${Math.round(allTotal).toLocaleString()}円`);

  // 低パフォーマンス銘柄（現在のSIM内）
  const simSorted = simResults.sort((a, b) => a.profit - b.profit);
  console.log("\n=== 現在のSIMULATION_STOCKS（損益ワースト順） ===");
  for (const r of simSorted) {
    const tag = r.profit < 0 ? " ← 入れ替え候補" : "";
    console.log(`  ${r.symbol} ${r.name}: ${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円 (勝率${r.winRate.toFixed(1)}%, ${r.trades}取引, PF${r.profitFactor.toFixed(2)})${tag}`);
  }

  // 非SIMULATION_STOCKSの上位銘柄（入れ替え候補）
  const nonSimTop = results.filter(r => !r.inCurrentSim).slice(0, 10);
  console.log("\n=== SIMULATION_STOCKSに含まれていない銘柄（損益上位） ===");
  for (const r of nonSimTop) {
    console.log(`  ${r.symbol} ${r.name}: ${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円 (勝率${r.winRate.toFixed(1)}%, ${r.trades}取引, PF${r.profitFactor.toFixed(2)})`);
  }

  // 入れ替えシミュレーション（ワースト銘柄を上位候補に入れ替えた場合の差分）
  console.log("\n=== 入れ替えシミュレーション（差分） ===");
  const worstSim = simSorted[0]; // 最もパフォーマンスが低い現在のSIM銘柄
  for (const candidate of nonSimTop.slice(0, 5)) {
    const diff = candidate.profit - worstSim.profit;
    console.log(`  ${worstSim.symbol}(${Math.round(worstSim.profit).toLocaleString()}円) → ${candidate.symbol} ${candidate.name}(${Math.round(candidate.profit).toLocaleString()}円): 差分 ${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円`);
  }
}

main();
