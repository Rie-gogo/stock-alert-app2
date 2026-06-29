/**
 * compare_9bar_exit_5m.ts
 * 
 * 比較バックテスト（5分足ベース）:
 *   A) 現行仕様
 *   B) 現行 + 9の法則エグジット（5分足基準）
 *      ルールA: 5分足で9本（=45分）以上保有 + 含み益 > 0 → 利確
 *      ルールB: 5分足で5本（=25分）以上保有 + |含み損益率| < 0.1% → 撤退
 * 
 * 1分足データで実行するが、本数カウントは5分足換算（×5）で判定する。
 *   ルールA: 1分足で45本以上保有 + 含み益 > 0 → 利確
 *   ルールB: 1分足で25本以上保有 + |損益率| < 0.1% → 撤退
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/compare_9bar_exit_5m.ts
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

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }
interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null;
  flow: number | null; slope: number | null; vwap: number | null;
}

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

// 9の法則パラメータ（5分足ベース → 1分足換算）
const RULE_A_BARS_1M = 45;     // 5分足9本 = 1分足45本（45分間）
const RULE_B_BARS_1M = 25;     // 5分足5本 = 1分足25本（25分間）
const RULE_B_THRESHOLD = 0.001; // 膠着判定閾値 (0.1%)

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += data[j];
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

function buildCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: 0, open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null, vwap: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
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

function simulate9BarRule5m(
  symbol: string, ticker: string, name: string,
  candles: RealCandle[],
  marketBiasAt: (progress: number) => number,
  initialCapital: number,
  rangeBound: boolean,
): { 
  baseProfit: number; baseWin: number; baseLoss: number; baseTrades: number;
  newProfit: number; newWin: number; newLoss: number; newTrades: number;
  ruleAFired: number; ruleBFired: number; ruleAProfit: number; ruleBProfit: number;
  ruleASaved: number; ruleBSaved: number;
  ruleAOrigProfit: number; ruleBOrigProfit: number; // 現行での同じ取引の損益
} | null {
  const baseResult = simulateStockReal(symbol, ticker, name, candles, marketBiasAt, initialCapital, 70, 30, 2.0, rangeBound, 1.0, {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
  });
  if (!baseResult || baseResult.tradesCount === 0) return null;

  // 取引ペアを構築
  interface TradePair {
    entryType: "long" | "short";
    entryIdx: number;
    entryPrice: number;
    exitIdx: number;
    exitPrice: number;
    profit: number;
    shares: number;
  }
  
  const pairs: TradePair[] = [];
  let pendingEntry: { type: "long" | "short"; idx: number; price: number; shares: number } | null = null;
  
  for (const t of baseResult.trades) {
    const candleIdx = candles.findIndex(c => c.time === t.time);
    if (candleIdx < 0) continue;
    
    if (t.type === "buy") {
      pendingEntry = { type: "long", idx: candleIdx, price: t.price, shares: t.shares };
    } else if (t.type === "short") {
      pendingEntry = { type: "short", idx: candleIdx, price: t.price, shares: t.shares };
    } else if (t.type === "sell" && pendingEntry?.type === "long") {
      pairs.push({
        entryType: "long", entryIdx: pendingEntry.idx, entryPrice: pendingEntry.price,
        exitIdx: candleIdx, exitPrice: t.price, profit: t.profit ?? 0, shares: pendingEntry.shares,
      });
      pendingEntry = null;
    } else if (t.type === "cover" && pendingEntry?.type === "short") {
      pairs.push({
        entryType: "short", entryIdx: pendingEntry.idx, entryPrice: pendingEntry.price,
        exitIdx: candleIdx, exitPrice: t.price, profit: t.profit ?? 0, shares: pendingEntry.shares,
      });
      pendingEntry = null;
    }
  }

  let newProfit = 0, newWin = 0, newLoss = 0;
  let ruleAFired = 0, ruleBFired = 0, ruleAProfit = 0, ruleBProfit = 0;
  let ruleASaved = 0, ruleBSaved = 0;
  let ruleAOrigProfit = 0, ruleBOrigProfit = 0;

  for (const pair of pairs) {
    let exitIdx = pair.exitIdx;
    let exitPrice = pair.exitPrice;
    let exitReason = "original";

    // エントリーからエグジットまでの各足を走査
    for (let i = pair.entryIdx + 1; i <= pair.exitIdx && i < candles.length; i++) {
      const barsHeld = i - pair.entryIdx;
      const currPrice = candles[i].close;
      
      // 含み損益率
      let unrealizedPct: number;
      if (pair.entryType === "long") {
        unrealizedPct = (currPrice - pair.entryPrice) / pair.entryPrice;
      } else {
        unrealizedPct = (pair.entryPrice - currPrice) / pair.entryPrice;
      }

      // 損切りは9の法則より優先（現行SLが先に発火する足はスキップ）
      const slTriggered = pair.entryType === "long" 
        ? currPrice <= pair.entryPrice * (1 - 0.02)
        : currPrice >= pair.entryPrice * (1 + SHORT_STOP_LOSS_PERCENT / 100);
      
      if (slTriggered) break; // 損切りが先 → 現行と同じ

      // トレイリング利確も9の法則より優先
      // トレイリングは+1%到達後にピークから0.5%戻しで発火
      // ここでは簡略化: 含み益が+1%以上の場合は9の法則を適用しない
      if (unrealizedPct >= 0.01) continue; // トレイリング圏内はスキップ

      // ルールA: 45本(5分足9本)以上 + 含み益 > 0 → 利確
      if (barsHeld >= RULE_A_BARS_1M && unrealizedPct > 0) {
        exitIdx = i;
        exitPrice = currPrice;
        exitReason = "ruleA";
        break;
      }

      // ルールB: 25本(5分足5本)以上 + |含み損益率| < 0.1% → 撤退
      if (barsHeld >= RULE_B_BARS_1M && Math.abs(unrealizedPct) < RULE_B_THRESHOLD) {
        exitIdx = i;
        exitPrice = currPrice;
        exitReason = "ruleB";
        break;
      }
    }

    // 新しい損益を計算
    let newPairProfit: number;
    if (pair.entryType === "long") {
      newPairProfit = (exitPrice - pair.entryPrice) * pair.shares;
    } else {
      newPairProfit = (pair.entryPrice - exitPrice) * pair.shares;
    }

    newProfit += newPairProfit;
    if (newPairProfit > 0) newWin++; else newLoss++;

    if (exitReason === "ruleA") {
      ruleAFired++;
      ruleAProfit += newPairProfit;
      ruleAOrigProfit += pair.profit;
      if (newPairProfit > pair.profit) ruleASaved++;
    } else if (exitReason === "ruleB") {
      ruleBFired++;
      ruleBProfit += newPairProfit;
      ruleBOrigProfit += pair.profit;
      if (newPairProfit > pair.profit) ruleBSaved++;
    }
  }

  return {
    baseProfit: baseResult.profitAmount,
    baseWin: baseResult.winCount,
    baseLoss: baseResult.lossCount,
    baseTrades: baseResult.tradesCount,
    newProfit: Math.round(newProfit),
    newWin, newLoss, newTrades: pairs.length,
    ruleAFired, ruleBFired,
    ruleAProfit: Math.round(ruleAProfit),
    ruleBProfit: Math.round(ruleBProfit),
    ruleASaved, ruleBSaved,
    ruleAOrigProfit: Math.round(ruleAOrigProfit),
    ruleBOrigProfit: Math.round(ruleBOrigProfit),
  };
}

function main() {
  console.log("=== 9の法則（5分足ベース）比較バックテスト ===\n");
  console.log(`ルールA: 5分足9本（=1分足45本=45分）以上保有 + 含み益 > 0 かつ 含み益 < 1% → 利確`);
  console.log(`ルールB: 5分足5本（=1分足25本=25分）以上保有 + |損益率| < 0.1% → 撤退`);
  console.log(`※ 含み益 ≥ 1%（トレイリング圏内）の場合は9の法則を適用せず、トレイリングに委ねる`);
  console.log(`現行: SL(ショート0.5%/ロング2%) / トレイリング(+1%→0.5%戻し) / 同値(+0.5%) / 最大保有60本 / 昼休み11:20 / 大引け`);

  const allDaysSet = new Set<string>();
  const symbolData = new Map<string, Map<string, JqBar[]>>();
  
  for (const s of TARGET_STOCKS) {
    const fp = path.join(process.cwd(), "analysis", "jq_data", `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); allDaysSet.add(b.Date); }
    symbolData.set(s.symbol, byDay);
  }
  
  const allDays = Array.from(allDaysSet).sort();
  console.log(`\n全日数: ${allDays.length} (${allDays[0]} ~ ${allDays[allDays.length - 1]})\n`);

  interface DayResult { date: string; baseProfit: number; newProfit: number; baseTrades: number; }
  const daily: DayResult[] = [];
  
  let totalBaseProfit = 0, totalNewProfit = 0;
  let totalBaseWin = 0, totalBaseLoss = 0, totalNewWin = 0, totalNewLoss = 0;
  let totalBaseTrades = 0, totalNewTrades = 0;
  let totalRuleAFired = 0, totalRuleBFired = 0;
  let totalRuleAProfit = 0, totalRuleBProfit = 0;
  let totalRuleASaved = 0, totalRuleBSaved = 0;
  let totalRuleAOrigProfit = 0, totalRuleBOrigProfit = 0;
  
  const bySymbol = new Map<string, { baseProfit: number; newProfit: number; ruleAFired: number; ruleBFired: number; ruleASaved: number; ruleBSaved: number }>();

  for (let dayIdx = 0; dayIdx < allDays.length; dayIdx++) {
    const day = allDays[dayIdx];
    if (dayIdx % 20 === 0) console.log(`  処理中: ${day} (${dayIdx + 1}/${allDays.length})`);

    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const dayData = symbolData.get(s.symbol)?.get(day);
      if (!dayData || dayData.length < 60) continue;
      candleMap.set(s.symbol, buildCandles(dayData));
    }
    if (candleMap.size < 5) continue;

    const symbols = Array.from(candleMap.keys());
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    const ratioSeries = symbols.map(sym => {
      const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0;
      return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
    });
    const marketBiasAt = (p: number): number => {
      let sum = 0, cnt = 0;
      for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; }
      return cnt > 0 ? sum / cnt : 0;
    };

    let dayBaseProfit = 0, dayNewProfit = 0, dayBaseTrades = 0;

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;

      const result = simulate9BarRule5m(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, rangeBound);
      if (!result) continue;

      dayBaseProfit += result.baseProfit;
      dayNewProfit += result.newProfit;
      dayBaseTrades += result.baseTrades;
      
      totalBaseProfit += result.baseProfit;
      totalNewProfit += result.newProfit;
      totalBaseWin += result.baseWin;
      totalBaseLoss += result.baseLoss;
      totalNewWin += result.newWin;
      totalNewLoss += result.newLoss;
      totalBaseTrades += result.baseTrades;
      totalNewTrades += result.newTrades;
      totalRuleAFired += result.ruleAFired;
      totalRuleBFired += result.ruleBFired;
      totalRuleAProfit += result.ruleAProfit;
      totalRuleBProfit += result.ruleBProfit;
      totalRuleASaved += result.ruleASaved;
      totalRuleBSaved += result.ruleBSaved;
      totalRuleAOrigProfit += result.ruleAOrigProfit;
      totalRuleBOrigProfit += result.ruleBOrigProfit;

      const sym = bySymbol.get(s.symbol) ?? { baseProfit: 0, newProfit: 0, ruleAFired: 0, ruleBFired: 0, ruleASaved: 0, ruleBSaved: 0 };
      sym.baseProfit += result.baseProfit;
      sym.newProfit += result.newProfit;
      sym.ruleAFired += result.ruleAFired;
      sym.ruleBFired += result.ruleBFired;
      sym.ruleASaved += result.ruleASaved;
      sym.ruleBSaved += result.ruleBSaved;
      bySymbol.set(s.symbol, sym);
    }

    daily.push({ date: day, baseProfit: Math.round(dayBaseProfit), newProfit: Math.round(dayNewProfit), baseTrades: dayBaseTrades });
  }

  // ============================================================
  // 結果出力
  // ============================================================
  console.log("\n" + "=".repeat(80));
  console.log("        9の法則（5分足ベース）エグジット 比較結果サマリー");
  console.log("=".repeat(80));
  
  const baseWinRate = (totalBaseWin + totalBaseLoss) > 0 ? totalBaseWin / (totalBaseWin + totalBaseLoss) * 100 : 0;
  const newWinRate = (totalNewWin + totalNewLoss) > 0 ? totalNewWin / (totalNewWin + totalNewLoss) * 100 : 0;
  
  console.log(`\n${"項目".padEnd(24)}${"A:現行".padEnd(22)}${"B:+9の法則(5分足)".padEnd(22)}`);
  console.log("-".repeat(68));
  console.log(`${"総損益(円)".padEnd(22)}${totalBaseProfit.toLocaleString().padEnd(22)}${totalNewProfit.toLocaleString().padEnd(22)}`);
  console.log(`${"総取引数".padEnd(22)}${String(totalBaseTrades).padEnd(22)}${String(totalNewTrades).padEnd(22)}`);
  console.log(`${"勝率".padEnd(22)}${(baseWinRate.toFixed(1) + "%").padEnd(22)}${(newWinRate.toFixed(1) + "%").padEnd(22)}`);
  console.log(`${"勝ち/負け".padEnd(22)}${(totalBaseWin + "/" + totalBaseLoss).padEnd(22)}${(totalNewWin + "/" + totalNewLoss).padEnd(22)}`);
  
  const diff = totalNewProfit - totalBaseProfit;
  console.log(`\n差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円 (${totalBaseProfit !== 0 ? ((diff / Math.abs(totalBaseProfit)) * 100).toFixed(1) : 0}%)`);

  // 日別統計
  const baseDayProfits = daily.map(d => d.baseProfit);
  const newDayProfits = daily.map(d => d.newProfit);
  const tradedDays = daily.filter(d => d.baseTrades > 0).length;
  const basePosDays = baseDayProfits.filter(p => p > 0).length;
  const baseNegDays = baseDayProfits.filter(p => p < 0).length;
  const newPosDays = newDayProfits.filter(p => p > 0).length;
  const newNegDays = newDayProfits.filter(p => p < 0).length;
  
  let baseMaxDD = 0, basePeak = 0, baseCum = 0;
  for (const p of baseDayProfits) { baseCum += p; if (baseCum > basePeak) basePeak = baseCum; const dd = basePeak - baseCum; if (dd > baseMaxDD) baseMaxDD = dd; }
  let newMaxDD = 0, newPeak = 0, newCum = 0;
  for (const p of newDayProfits) { newCum += p; if (newCum > newPeak) newPeak = newCum; const dd = newPeak - newCum; if (dd > newMaxDD) newMaxDD = dd; }

  console.log(`\n${"日平均(円)".padEnd(22)}${(tradedDays > 0 ? Math.round(totalBaseProfit / tradedDays) : 0).toLocaleString().padEnd(22)}${(tradedDays > 0 ? Math.round(totalNewProfit / tradedDays) : 0).toLocaleString().padEnd(22)}`);
  console.log(`${"勝ち日/負け日".padEnd(22)}${(basePosDays + "/" + baseNegDays).padEnd(22)}${(newPosDays + "/" + newNegDays).padEnd(22)}`);
  console.log(`${"最良日(円)".padEnd(22)}${Math.max(...baseDayProfits).toLocaleString().padEnd(22)}${Math.max(...newDayProfits).toLocaleString().padEnd(22)}`);
  console.log(`${"最悪日(円)".padEnd(22)}${Math.min(...baseDayProfits).toLocaleString().padEnd(22)}${Math.min(...newDayProfits).toLocaleString().padEnd(22)}`);
  console.log(`${"最大DD(円)".padEnd(22)}${baseMaxDD.toLocaleString().padEnd(22)}${newMaxDD.toLocaleString().padEnd(22)}`);

  // 9の法則の詳細分析
  console.log("\n" + "=".repeat(80));
  console.log("              9の法則（5分足）ルール別詳細");
  console.log("=".repeat(80));
  
  const totalFired = totalRuleAFired + totalRuleBFired;
  console.log(`\n  ルールA（45分含み益利確 / 含み益<1%のみ）: ${totalRuleAFired}回発火`);
  console.log(`    9の法則での損益: ${totalRuleAProfit.toLocaleString()}円 (平均: ${totalRuleAFired > 0 ? Math.round(totalRuleAProfit / totalRuleAFired).toLocaleString() : 0}円/回)`);
  console.log(`    現行での同取引損益: ${totalRuleAOrigProfit.toLocaleString()}円 (平均: ${totalRuleAFired > 0 ? Math.round(totalRuleAOrigProfit / totalRuleAFired).toLocaleString() : 0}円/回)`);
  console.log(`    差分: ${(totalRuleAProfit - totalRuleAOrigProfit >= 0 ? "+" : "")}${(totalRuleAProfit - totalRuleAOrigProfit).toLocaleString()}円`);
  console.log(`    現行より改善した件数: ${totalRuleASaved}/${totalRuleAFired} (${totalRuleAFired > 0 ? (totalRuleASaved / totalRuleAFired * 100).toFixed(1) : 0}%)`);
  
  console.log(`\n  ルールB（25分膠着撤退）: ${totalRuleBFired}回発火`);
  console.log(`    9の法則での損益: ${totalRuleBProfit.toLocaleString()}円 (平均: ${totalRuleBFired > 0 ? Math.round(totalRuleBProfit / totalRuleBFired).toLocaleString() : 0}円/回)`);
  console.log(`    現行での同取引損益: ${totalRuleBOrigProfit.toLocaleString()}円 (平均: ${totalRuleBFired > 0 ? Math.round(totalRuleBOrigProfit / totalRuleBFired).toLocaleString() : 0}円/回)`);
  console.log(`    差分: ${(totalRuleBProfit - totalRuleBOrigProfit >= 0 ? "+" : "")}${(totalRuleBProfit - totalRuleBOrigProfit).toLocaleString()}円`);
  console.log(`    現行より改善した件数: ${totalRuleBSaved}/${totalRuleBFired} (${totalRuleBFired > 0 ? (totalRuleBSaved / totalRuleBFired * 100).toFixed(1) : 0}%)`);
  
  console.log(`\n  合計発火: ${totalFired}/${totalNewTrades}件 (${totalNewTrades > 0 ? (totalFired / totalNewTrades * 100).toFixed(1) : 0}%)`);
  console.log(`  9の法則で変更されなかった取引: ${totalNewTrades - totalFired}件`);

  // 銘柄別
  console.log("\n" + "=".repeat(80));
  console.log("              銘柄別 差分分析");
  console.log("=".repeat(80));
  console.log(`\n  ${"銘柄".padEnd(20)}${"現行".padEnd(14)}${"9の法則".padEnd(14)}${"差分".padEnd(12)}${"ルールA".padEnd(8)}${"ルールB".padEnd(8)}`);
  console.log("  " + "-".repeat(76));
  
  const symEntries = Array.from(bySymbol.entries()).sort((a, b) => (b[1].newProfit - b[1].baseProfit) - (a[1].newProfit - a[1].baseProfit));
  for (const [sym, data] of symEntries) {
    const stock = TARGET_STOCKS.find(s => s.symbol === sym);
    const d = data.newProfit - data.baseProfit;
    console.log(`  ${(sym + " " + (stock?.name ?? "")).padEnd(18)}${Math.round(data.baseProfit).toLocaleString().padEnd(14)}${Math.round(data.newProfit).toLocaleString().padEnd(14)}${(d >= 0 ? "+" : "") + Math.round(d).toLocaleString().padEnd(11)}${String(data.ruleAFired).padEnd(8)}${String(data.ruleBFired).padEnd(8)}`);
  }

  // CSV出力
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["date,baseProfit,newProfit,baseTrades"];
  for (const d of daily) { csvRows.push([d.date, d.baseProfit, d.newProfit, d.baseTrades].join(",")); }
  fs.writeFileSync(path.join(outDir, "compare_9bar_exit_5m.csv"), csvRows.join("\n"), "utf8");
  console.log(`\nCSV出力: ${path.join(outDir, "compare_9bar_exit_5m.csv")}`);
}

main();
