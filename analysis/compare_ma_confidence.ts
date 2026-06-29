/**
 * compare_ma_confidence.ts - メモリ効率版
 * 
 * 比較バックテスト: 
 *   A) 現行仕様: MA25 + ウォームアップ10本
 *   B) 新仕様:   MA20 + ウォームアップ100本相当（10:40以降のみ）
 *   + パーフェクトオーダー効果分析
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/compare_ma_confidence.ts
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

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
  vwap: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result[i] = sum / period;
  }
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
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += data[j]; const avg = sum / period;
    let variance = 0; for (let j = i - period + 1; j <= i; j++) variance += (data[j] - avg) ** 2; const std = Math.sqrt(variance / period);
    upper[i] = avg + m * std; lower[i] = avg - m * std;
  }
  return { upper, lower };
}

function toTimestamp(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
}

function buildCandles(bars: JqBar[], maPeriod: number, slopeLookback: number): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null, vwap: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const maMain = calcMA(closes, maPeriod);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = maMain[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const vwapSeries = calcVWAP(candles);
  candles.forEach((c, i) => { c.vwap = vwapSeries[i]; });
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= slopeLookback && c.ma25 !== null) { const prev = candles[i - slopeLookback].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

// パーフェクトオーダー用の追加MA計算
function calcExtraMAs(bars: JqBar[]): { ma5: (number|null)[]; ma20: (number|null)[]; ma60: (number|null)[]; ma100: (number|null)[] } {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const closes = sorted.map(b => b.C);
  return { ma5: calcMA(closes, 5), ma20: calcMA(closes, 20), ma60: calcMA(closes, 60), ma100: calcMA(closes, 100) };
}

// 日別データをストリーミング読み込み
function loadDayData(symbol: string): Map<string, JqBar[]> {
  const fp = path.join(process.cwd(), "analysis", "jq_data", `${symbol}.json`);
  if (!fs.existsSync(fp)) return new Map();
  const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
  const byDay = new Map<string, JqBar[]>();
  for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
  return byDay;
}

function main() {
  console.log("=== 比較バックテスト開始 ===\n");

  // 全日付を収集
  const allDaysSet = new Set<string>();
  const symbolDays = new Map<string, Set<string>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(process.cwd(), "analysis", "jq_data", `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const raw = fs.readFileSync(fp, "utf8");
    const bars = JSON.parse(raw) as JqBar[];
    const days = new Set<string>();
    for (const b of bars) { days.add(b.Date); allDaysSet.add(b.Date); }
    symbolDays.set(s.symbol, days);
  }
  const allDays = Array.from(allDaysSet).sort();
  console.log(`全日数: ${allDays.length} (${allDays[0]} ~ ${allDays[allDays.length - 1]})`);

  // 結果蓄積
  interface DayResult { date: string; profit: number; win: number; loss: number; trades: number; }
  const dailyA: DayResult[] = [];
  const dailyB: DayResult[] = [];
  const dailyC: DayResult[] = []; // 10:40以降のみ
  const symAggA = new Map<string, { profit: number; win: number; loss: number; trades: number }>();
  const symAggB = new Map<string, { profit: number; win: number; loss: number; trades: number }>();

  // パーフェクトオーダー分析
  let poTotal = 0, poWith = 0, poWithout = 0;
  let poProfitWith = 0, poProfitWithout = 0;
  let poWinWith = 0, poLossWithout = 0, poWinWithout = 0, poLossWithPO = 0;

  // 日ごとに処理（メモリ節約のため1銘柄ずつ読み込み）
  for (let dayIdx = 0; dayIdx < allDays.length; dayIdx++) {
    const day = allDays[dayIdx];
    if (dayIdx % 20 === 0) console.log(`  処理中: ${day} (${dayIdx + 1}/${allDays.length})`);

    // この日のデータを銘柄ごとに読み込み
    const candleMapA = new Map<string, RealCandle[]>();
    const candleMapB = new Map<string, RealCandle[]>();
    const extraMAsMap = new Map<string, { ma5: (number|null)[]; ma20: (number|null)[]; ma60: (number|null)[]; ma100: (number|null)[] }>();

    for (const s of TARGET_STOCKS) {
      if (!symbolDays.get(s.symbol)?.has(day)) continue;
      const dayData = loadDayData(s.symbol).get(day);
      if (!dayData || dayData.length < 60) continue;

      // A: MA25 + slope25
      candleMapA.set(s.symbol, buildCandles(dayData, 25, 25));
      // B: MA20 + slope20
      candleMapB.set(s.symbol, buildCandles(dayData, 20, 20));
      // パーフェクトオーダー用
      if (dayData.length >= 100) {
        extraMAsMap.set(s.symbol, calcExtraMAs(dayData));
      }
    }

    if (candleMapA.size < 5) continue;

    // 市場効率性計算（共通）
    const symbols = Array.from(candleMapA.keys());
    const mkBias = (map: Map<string, RealCandle[]>) => {
      const ratioSeries = symbols.filter(s => map.has(s)).map(sym => {
        const cs = map.get(sym)!; const open = cs[0]?.open ?? 0;
        return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
      });
      return (p: number): number => {
        let sum = 0, cnt = 0;
        for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; }
        return cnt > 0 ? sum / cnt : 0;
      };
    };
    const dayStatsA = symbols.filter(s => candleMapA.has(s)).map(sym => { const cs = candleMapA.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStatsA);
    const rangeBound = isRangeBoundDay(eff);

    const marketBiasA = mkBias(candleMapA);
    const marketBiasB = mkBias(candleMapB);

    let dayProfitA = 0, dayWinA = 0, dayLossA = 0, dayTradesA = 0;
    let dayProfitB = 0, dayWinB = 0, dayLossB = 0, dayTradesB = 0;
    let dayProfitC = 0, dayWinC = 0, dayLossC = 0, dayTradesC = 0;

    for (const s of TARGET_STOCKS) {
      // --- A: 現行 ---
      const candlesA = candleMapA.get(s.symbol);
      if (candlesA) {
        const resA = simulateStockReal(s.symbol, s.ticker, s.name, candlesA, marketBiasA, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE });
        if (resA) {
          dayProfitA += resA.profitAmount; dayWinA += resA.winCount; dayLossA += resA.lossCount; dayTradesA += resA.tradesCount;
          const agg = symAggA.get(s.symbol) ?? { profit: 0, win: 0, loss: 0, trades: 0 };
          agg.profit += resA.profitAmount; agg.win += resA.winCount; agg.loss += resA.lossCount; agg.trades += resA.tradesCount;
          symAggA.set(s.symbol, agg);

          // C: 10:40以降のみ（ウォームアップ100本相当）
          let entryTime: string | null = null;
          for (const t of resA.trades) {
            if (t.type === "buy" || t.type === "short") { entryTime = t.time; }
            else if ((t.type === "sell" || t.type === "cover") && entryTime !== null) {
              if (entryTime >= "10:40") {
                const profit = t.profit ?? 0;
                dayProfitC += profit; dayTradesC++;
                if (profit > 0) dayWinC++; else dayLossC++;
              }
              entryTime = null;
            }
          }

          // パーフェクトオーダー分析
          const extraMAs = extraMAsMap.get(s.symbol);
          if (extraMAs && resA.trades) {
            let eTime: string | null = null;
            let eType: string | null = null;
            for (const t of resA.trades) {
              if (t.type === "buy" || t.type === "short") { eTime = t.time; eType = t.type; }
              else if ((t.type === "sell" || t.type === "cover") && eTime !== null && eType !== null) {
                const profit = t.profit ?? 0;
                // エントリー足のインデックスを探す
                const idx = candlesA.findIndex(c => c.time === eTime);
                if (idx >= 0 && idx < (extraMAs.ma100?.length ?? 0)) {
                  const m5 = extraMAs.ma5[idx];
                  const m20 = extraMAs.ma20[idx];
                  const m60 = extraMAs.ma60[idx];
                  const m100 = extraMAs.ma100[idx];
                  if (m5 !== null && m20 !== null && m60 !== null && m100 !== null) {
                    poTotal++;
                    const hasPO = eType === "short"
                      ? (m5 < m20 && m20 < m60 && m60 < m100)
                      : (m5 > m20 && m20 > m60 && m60 > m100);
                    if (hasPO) {
                      poWith++;
                      poProfitWith += profit;
                      if (profit > 0) poWinWith++; else poLossWithPO++;
                    } else {
                      poWithout++;
                      poProfitWithout += profit;
                      if (profit > 0) poWinWithout++; else poLossWithout++;
                    }
                  }
                }
                eTime = null; eType = null;
              }
            }
          }
        }
      }

      // --- B: 新仕様 (MA20) ---
      const candlesB = candleMapB.get(s.symbol);
      if (candlesB) {
        const resB = simulateStockReal(s.symbol, s.ticker, s.name, candlesB, marketBiasB, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE });
        if (resB) {
          dayProfitB += resB.profitAmount; dayWinB += resB.winCount; dayLossB += resB.lossCount; dayTradesB += resB.tradesCount;
          const agg = symAggB.get(s.symbol) ?? { profit: 0, win: 0, loss: 0, trades: 0 };
          agg.profit += resB.profitAmount; agg.win += resB.winCount; agg.loss += resB.lossCount; agg.trades += resB.tradesCount;
          symAggB.set(s.symbol, agg);
        }
      }
    }

    dailyA.push({ date: day, profit: Math.round(dayProfitA), win: dayWinA, loss: dayLossA, trades: dayTradesA });
    dailyB.push({ date: day, profit: Math.round(dayProfitB), win: dayWinB, loss: dayLossB, trades: dayTradesB });
    dailyC.push({ date: day, profit: Math.round(dayProfitC), win: dayWinC, loss: dayLossC, trades: dayTradesC });
  }

  // ============================================================
  // 集計
  // ============================================================
  const summarize = (daily: DayResult[], label: string) => {
    const tradedDays = daily.filter(d => d.trades > 0).length;
    const totalProfit = daily.reduce((s, d) => s + d.profit, 0);
    const totalWin = daily.reduce((s, d) => s + d.win, 0);
    const totalLoss = daily.reduce((s, d) => s + d.loss, 0);
    const totalTrades = daily.reduce((s, d) => s + d.trades, 0);
    const winRate = (totalWin + totalLoss) > 0 ? totalWin / (totalWin + totalLoss) : 0;
    const avgDay = tradedDays > 0 ? totalProfit / tradedDays : 0;
    const profits = daily.map(d => d.profit);
    const posDays = profits.filter(p => p > 0).length;
    const negDays = profits.filter(p => p < 0).length;
    const best = profits.length > 0 ? Math.max(...profits) : 0;
    const worst = profits.length > 0 ? Math.min(...profits) : 0;
    const sorted = [...profits].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const daysOver15k = profits.filter(p => p >= 15000).length;
    let maxDD = 0, peak = 0, cumulative = 0;
    for (const p of profits) { cumulative += p; if (cumulative > peak) peak = cumulative; const dd = peak - cumulative; if (dd > maxDD) maxDD = dd; }
    return { label, tradedDays, totalProfit, totalWin, totalLoss, totalTrades, winRate, avgDay, posDays, negDays, best, worst, median, daysOver15k, maxDD };
  };

  const sumA = summarize(dailyA, "A:現行(MA25+WU10)");
  const sumB = summarize(dailyB, "B:新(MA20+WU10)");
  const sumC = summarize(dailyC, "C:現行+10:40以降のみ");

  console.log("\n" + "=".repeat(80));
  console.log("                    比較バックテスト結果サマリー");
  console.log("=".repeat(80));
  console.log(`\n${"項目".padEnd(22)}${"A:現行(MA25)".padEnd(20)}${"B:MA20変更".padEnd(20)}${"C:10:40以降のみ".padEnd(20)}`);
  console.log("-".repeat(82));
  console.log(`${"取引日数".padEnd(20)}${String(sumA.tradedDays).padEnd(20)}${String(sumB.tradedDays).padEnd(20)}${String(sumC.tradedDays).padEnd(20)}`);
  console.log(`${"総損益(円)".padEnd(20)}${sumA.totalProfit.toLocaleString().padEnd(20)}${sumB.totalProfit.toLocaleString().padEnd(20)}${sumC.totalProfit.toLocaleString().padEnd(20)}`);
  console.log(`${"日平均(円)".padEnd(20)}${Math.round(sumA.avgDay).toLocaleString().padEnd(20)}${Math.round(sumB.avgDay).toLocaleString().padEnd(20)}${Math.round(sumC.avgDay).toLocaleString().padEnd(20)}`);
  console.log(`${"中央値/日(円)".padEnd(20)}${sumA.median.toLocaleString().padEnd(20)}${sumB.median.toLocaleString().padEnd(20)}${sumC.median.toLocaleString().padEnd(20)}`);
  console.log(`${"総取引数".padEnd(20)}${String(sumA.totalTrades).padEnd(20)}${String(sumB.totalTrades).padEnd(20)}${String(sumC.totalTrades).padEnd(20)}`);
  console.log(`${"勝率".padEnd(20)}${((sumA.winRate * 100).toFixed(1) + "%").padEnd(20)}${((sumB.winRate * 100).toFixed(1) + "%").padEnd(20)}${((sumC.winRate * 100).toFixed(1) + "%").padEnd(20)}`);
  console.log(`${"勝ち日/負け日".padEnd(20)}${(sumA.posDays + "/" + sumA.negDays).padEnd(20)}${(sumB.posDays + "/" + sumB.negDays).padEnd(20)}${(sumC.posDays + "/" + sumC.negDays).padEnd(20)}`);
  console.log(`${"最良日(円)".padEnd(20)}${sumA.best.toLocaleString().padEnd(20)}${sumB.best.toLocaleString().padEnd(20)}${sumC.best.toLocaleString().padEnd(20)}`);
  console.log(`${"最悪日(円)".padEnd(20)}${sumA.worst.toLocaleString().padEnd(20)}${sumB.worst.toLocaleString().padEnd(20)}${sumC.worst.toLocaleString().padEnd(20)}`);
  console.log(`${"15000円超日数".padEnd(20)}${String(sumA.daysOver15k).padEnd(20)}${String(sumB.daysOver15k).padEnd(20)}${String(sumC.daysOver15k).padEnd(20)}`);
  console.log(`${"最大DD(円)".padEnd(20)}${sumA.maxDD.toLocaleString().padEnd(20)}${sumB.maxDD.toLocaleString().padEnd(20)}${sumC.maxDD.toLocaleString().padEnd(20)}`);

  // パーフェクトオーダー分析
  console.log("\n" + "=".repeat(80));
  console.log("           パーフェクトオーダー効果分析");
  console.log("=".repeat(80));
  console.log(`分析対象エントリー数: ${poTotal}`);
  console.log(`  PO成立中: ${poWith}件 (${poTotal > 0 ? (poWith / poTotal * 100).toFixed(1) : 0}%)`);
  console.log(`  PO非成立: ${poWithout}件 (${poTotal > 0 ? (poWithout / poTotal * 100).toFixed(1) : 0}%)`);
  const wrPO = (poWinWith + poLossWithPO) > 0 ? poWinWith / (poWinWith + poLossWithPO) : 0;
  const wrNoPO = (poWinWithout + poLossWithout) > 0 ? poWinWithout / (poWinWithout + poLossWithout) : 0;
  console.log(`\n  PO成立時: 損益=${Math.round(poProfitWith).toLocaleString()}円  勝率=${(wrPO * 100).toFixed(1)}%  平均=${poWith > 0 ? Math.round(poProfitWith / poWith).toLocaleString() : 0}円/件`);
  console.log(`  PO非成立: 損益=${Math.round(poProfitWithout).toLocaleString()}円  勝率=${(wrNoPO * 100).toFixed(1)}%  平均=${poWithout > 0 ? Math.round(poProfitWithout / poWithout).toLocaleString() : 0}円/件`);
  console.log(`  勝率差: ${((wrPO - wrNoPO) * 100).toFixed(1)}ポイント (PO成立が${wrPO > wrNoPO ? "有利" : "不利"})`);

  // 銘柄別比較
  console.log("\n" + "=".repeat(80));
  console.log("           銘柄別比較（A vs B）");
  console.log("=".repeat(80));
  console.log(`${"銘柄".padEnd(20)}${"A損益".padEnd(14)}${"B損益".padEnd(14)}${"差分".padEnd(14)}${"A勝率".padEnd(8)}${"B勝率".padEnd(8)}`);
  console.log("-".repeat(78));
  for (const s of TARGET_STOCKS) {
    const aggA = symAggA.get(s.symbol);
    const aggB = symAggB.get(s.symbol);
    if (!aggA && !aggB) continue;
    const pA = aggA?.profit ?? 0;
    const pB = aggB?.profit ?? 0;
    const diff = pB - pA;
    const wrA2 = aggA && aggA.trades > 0 ? (aggA.win / aggA.trades * 100).toFixed(1) + "%" : "N/A";
    const wrB2 = aggB && aggB.trades > 0 ? (aggB.win / aggB.trades * 100).toFixed(1) + "%" : "N/A";
    console.log(`${(s.symbol + " " + s.name).padEnd(20)}${Math.round(pA).toLocaleString().padStart(10)}円  ${Math.round(pB).toLocaleString().padStart(10)}円  ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(9)}円  ${wrA2.padEnd(8)}${wrB2.padEnd(8)}`);
  }

  // 結論
  console.log("\n" + "=".repeat(80));
  console.log("                           結論");
  console.log("=".repeat(80));
  const diffAB = sumB.totalProfit - sumA.totalProfit;
  const diffAC = sumC.totalProfit - sumA.totalProfit;
  console.log(`\n1. MA25→MA20の影響:`);
  console.log(`   総損益差: ${diffAB >= 0 ? "+" : ""}${Math.round(diffAB).toLocaleString()}円 (${sumA.totalProfit !== 0 ? (diffAB / Math.abs(sumA.totalProfit) * 100).toFixed(1) : 0}%)`);
  console.log(`   取引数差: ${sumB.totalTrades - sumA.totalTrades}件`);
  console.log(`   勝率差: ${((sumB.winRate - sumA.winRate) * 100).toFixed(1)}ポイント`);
  console.log(`\n2. ウォームアップ100本(10:40以降のみ)の影響:`);
  console.log(`   総損益差: ${diffAC >= 0 ? "+" : ""}${Math.round(diffAC).toLocaleString()}円`);
  console.log(`   除外された取引数: ${sumA.totalTrades - sumC.totalTrades}件`);
  console.log(`   除外取引の損益: ${Math.round(sumA.totalProfit - sumC.totalProfit).toLocaleString()}円`);
  console.log(`\n3. パーフェクトオーダーの付加価値:`);
  console.log(`   勝率差: ${((wrPO - wrNoPO) * 100).toFixed(1)}ポイント`);
  console.log(`   1件あたり平均損益差: ${poWith > 0 && poWithout > 0 ? Math.round(poProfitWith / poWith - poProfitWithout / poWithout).toLocaleString() : "N/A"}円`);

  // CSV出力
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["date,profitA,profitB,profitC,tradesA,tradesB,tradesC"];
  for (let i = 0; i < dailyA.length; i++) {
    const a = dailyA[i]; const b = dailyB[i]; const c = dailyC[i];
    csvRows.push([a.date, a.profit, b?.profit ?? 0, c?.profit ?? 0, a.trades, b?.trades ?? 0, c?.trades ?? 0].join(","));
  }
  fs.writeFileSync(path.join(outDir, "compare_ma_confidence.csv"), csvRows.join("\n"), "utf8");
  console.log(`\nCSV出力: ${path.join(outDir, "compare_ma_confidence.csv")}`);
}

main();
