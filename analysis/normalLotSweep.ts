/**
 * normalLotSweep.ts
 * 通常ロット（LOT_NORMAL=0.49）で動く銘柄候補を探す
 *
 * 現在HIGH_VOL_SYMBOLSに含まれていない銘柄（通常ロット対象）を
 * SIMULATION_STOCKSに追加した場合の損益増分を測定する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/normalLotSweep.ts
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

// 現在のHIGH_VOL_SYMBOLS（極小ロット対象）
const HIGH_VOL_SYMBOLS = new Set(["9984", "4568", "6526", "9107", "6723", "5803", "8316", "7203", "5016", "7011", "8306", "6758"]);

// 通常ロット対象銘柄（HIGH_VOL_SYMBOLSに含まれない）
const NORMAL_LOT_SYMBOLS = TARGET_STOCKS.filter(s => !HIGH_VOL_SYMBOLS.has(s.symbol)).map(s => s.symbol);
console.log(`通常ロット対象銘柄: ${NORMAL_LOT_SYMBOLS.join(', ')}`);

async function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");

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
  console.log(`[sweep] Days: ${allDays.length}`);

  // 通常ロット銘柄の損益を個別計算（lotRatio=0.49を強制）
  const symbolProfits = new Map<string, { profit: number; win: number; loss: number; trades: number }>();

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    // 全銘柄のキャンドルを読み込む（市場バイアス計算のため）
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;

    const symsInDay = Array.from(candleMap.keys());
    const ratioSeries = symsInDay.map(sym => {
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
    const dayStats = symsInDay.map(sym => {
      const cs = candleMap.get(sym)!;
      return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 };
    });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    // 通常ロット銘柄のみシミュレーション（lotRatio=0.49を強制）
    for (const sym of NORMAL_LOT_SYMBOLS) {
      const s = TARGET_STOCKS.find(x => x.symbol === sym)!;
      const candles = candleMap.get(sym);
      if (!candles) continue;
      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        {
          shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
          lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
          longStopLossPercent: LONG_STOP_LOSS_PERCENT,
          lotRatio: 0.49, // 通常ロット強制
        }
      );
      if (!res) continue;
      const agg = symbolProfits.get(sym) ?? { profit: 0, win: 0, loss: 0, trades: 0 };
      agg.profit += res.profitAmount;
      agg.win += res.winCount;
      agg.loss += res.lossCount;
      agg.trades += res.tradesCount;
      symbolProfits.set(sym, agg);
    }
  }

  // 結果を損益順にソート
  const results = NORMAL_LOT_SYMBOLS
    .map(sym => {
      const s = TARGET_STOCKS.find(x => x.symbol === sym)!;
      const agg = symbolProfits.get(sym) ?? { profit: 0, win: 0, loss: 0, trades: 0 };
      const winRate = agg.trades > 0 ? (agg.win / agg.trades) * 100 : 0;
      const inCurrentSim = ['3436', '3778', '6981', '6857', '6920', '8035'].includes(sym);
      return { symbol: sym, name: s.name, sector: s.sector, ...agg, winRate, inCurrentSim };
    })
    .sort((a, b) => b.profit - a.profit);

  console.log("\n=== 通常ロット銘柄 損益ランキング（lotRatio=0.49強制） ===");
  console.log(`${"順".padEnd(3)} ${"銘柄".padEnd(26)} ${"セクター".padEnd(14)} ${"現在"} ${"損益".padStart(12)} ${"取引".padStart(5)} ${"勝率".padStart(7)}`);
  console.log("-".repeat(75));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = String(i + 1).padEnd(3);
    const name = `${r.symbol} ${r.name}`.padEnd(26);
    const sector = r.sector.padEnd(14);
    const current = r.inCurrentSim ? "★" : " ";
    const profit = `${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円`.padStart(12);
    const trades = String(r.trades).padStart(5);
    const winRate = `${r.winRate.toFixed(1)}%`.padStart(7);
    console.log(`${rank} ${name} ${sector} ${current}  ${profit} ${trades} ${winRate}`);
  }

  // 現在のSIMULATION_STOCKS（通常ロット銘柄のみ）
  const currentNormalSim = ['3436', '3778', '6981', '6857', '6920', '8035'];
  const currentTotal = currentNormalSim.reduce((sum, sym) => sum + (symbolProfits.get(sym)?.profit ?? 0), 0);
  console.log(`\n現在のSIMULATION_STOCKS（通常ロット6銘柄）合計: ${currentTotal >= 0 ? "+" : ""}${Math.round(currentTotal).toLocaleString()}円`);

  // 入れ替え候補の特定
  const nonCurrentNormal = results.filter(r => !currentNormalSim.includes(r.symbol));
  const currentNormalWorst = results.filter(r => currentNormalSim.includes(r.symbol)).sort((a, b) => a.profit - b.profit);

  console.log("\n=== 入れ替えシミュレーション（通常ロット銘柄間） ===");
  console.log("\n現在の通常ロット銘柄（損益ワースト順）:");
  for (const r of currentNormalWorst) {
    console.log(`  ${r.symbol} ${r.name}: ${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円 (${r.trades}取引, 勝率${r.winRate.toFixed(1)}%)`);
  }

  console.log("\n入れ替え候補（通常ロット、現在のSIMに含まれない）:");
  for (const r of nonCurrentNormal) {
    const diff = r.profit - (currentNormalWorst[0]?.profit ?? 0);
    const tag = diff > 0 ? ` ← +${Math.round(diff).toLocaleString()}円の改善` : "";
    console.log(`  ${r.symbol} ${r.name}: ${r.profit >= 0 ? "+" : ""}${Math.round(r.profit).toLocaleString()}円 (${r.trades}取引, 勝率${r.winRate.toFixed(1)}%)${tag}`);
  }

  // 最良の入れ替え組み合わせ
  console.log("\n=== 最良の入れ替え組み合わせ ===");
  const bestCandidates = nonCurrentNormal.filter(r => r.profit > (currentNormalWorst[0]?.profit ?? 0));
  if (bestCandidates.length === 0) {
    console.log("入れ替えによる改善なし（現在の銘柄構成が最適）");
  } else {
    for (const candidate of bestCandidates) {
      const out = currentNormalWorst[0];
      const diff = candidate.profit - out.profit;
      console.log(`  ${out.symbol}(${out.name}) → ${candidate.symbol}(${candidate.name}): +${Math.round(diff).toLocaleString()}円`);
    }
  }
}

main().catch(console.error);
