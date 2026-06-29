/**
 * compare_accum_breakout.ts
 * 
 * 比較バックテスト:
 *   A) 現行仕様（蓄積ブレイクなし）
 *   B) 現行 + 蓄積ブレイク上抜け/下抜けシグナル追加
 * 
 * 蓄積ブレイク仕様:
 *   横ばい検出: 直近N本(5本)の range_ratio ≤ 0.004
 *   ブレイク: close > max(high[N]) × 1.0005 (上抜け) or close < min(low[N]) × 0.9995 (下抜け)
 *   出来高: volume ≥ 直近N本平均 × 1.5
 *   フィルター: レジーム≠down(上抜け) / レジーム≠up(下抜け)、ADX≥20
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/compare_accum_breakout.ts
 */

import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  evaluateRegimeGates,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import { calcVWAP } from "../server/vwap";
import { isVolumeConfirmed, trailingAvgVolume } from "../server/signalConfirmation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null;
  flow: number | null; slope: number | null; vwap: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;
const SLOPE_THRESHOLD = 0.0003;

// ---- 蓄積ブレイクパラメータ ----
const ACCUM_N = 5;              // 横ばい判定本数
const ACCUM_RANGE_RATIO = 0.004; // 横ばい閾値 (0.4%)
const ACCUM_BREAK_MARGIN = 0.0005; // ブレイク確認マージン (+0.05%)
const ACCUM_VOL_MULT = 1.5;    // 出来高倍率
const ADX_THRESHOLD = 20;       // ADXフィルター閾値

// ---- テクニカル指標計算 ----
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

// ADX計算（簡易版）
function calcADX(candles: { high: number; low: number; close: number }[], period = 14): number[] {
  const adx: number[] = new Array(candles.length).fill(0);
  if (candles.length < period * 2 + 1) return adx;
  
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  // Smoothed TR, +DM, -DM
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  
  const dx: number[] = [];
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dxVal = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dx.push(dxVal);
  }
  
  // ADX = smoothed DX
  if (dx.length >= period) {
    let adxSmooth = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const startIdx = period * 2; // offset in original candles array (+1 for tr offset)
    if (startIdx < candles.length) adx[startIdx] = adxSmooth;
    for (let i = period; i < dx.length; i++) {
      adxSmooth = (adxSmooth * (period - 1) + dx[i]) / period;
      const idx = i + period + 1;
      if (idx < candles.length) adx[idx] = adxSmooth;
    }
  }
  return adx;
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

/**
 * 蓄積ブレイク検出
 * 現行のsimulateStockRealの結果に追加シグナルとして独立シミュレーション
 */
function simulateWithAccumBreakout(
  symbol: string, ticker: string, name: string,
  candles: RealCandle[],
  marketBiasAt: (progress: number) => number,
  initialCapital: number,
  rangeBound: boolean,
): { profit: number; win: number; loss: number; trades: number; signals: { time: string; type: string; reason: string; profit?: number }[] } {
  // まず現行シミュレーションを実行
  const baseResult = simulateStockReal(symbol, ticker, name, candles, marketBiasAt, initialCapital, 70, 30, 2.0, rangeBound, 1.0, {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
  });
  
  if (!baseResult) return { profit: 0, win: 0, loss: 0, trades: 0, signals: [] };

  // 蓄積ブレイクシグナルを独立に検出・シミュレーション
  // 現行エンジンのポジションと競合しないよう、蓄積ブレイクは「追加シグナル」として
  // 現行がポジションを持っていない時間帯のみエントリーする
  
  // ADX計算
  const adxSeries = calcADX(candles);
  
  // 現行エンジンのポジション保有時間帯を推定（trades配列から）
  const busyBars = new Set<number>();
  let entryIdx = -1;
  for (const t of baseResult.trades) {
    if (t.type === "buy" || t.type === "short") {
      entryIdx = candles.findIndex(c => c.time === t.time);
    } else if ((t.type === "sell" || t.type === "cover") && entryIdx >= 0) {
      const exitIdx = candles.findIndex(c => c.time === t.time);
      for (let k = entryIdx; k <= exitIdx && k < candles.length; k++) busyBars.add(k);
      entryIdx = -1;
    }
  }

  // 蓄積ブレイクのみのシミュレーション
  const accumSignals: { time: string; type: string; reason: string; profit?: number }[] = [];
  let accumProfit = 0, accumWin = 0, accumLoss = 0, accumTrades = 0;
  let inPosition = false;
  let posType: "long" | "short" = "long";
  let posEntry = 0;
  let posShares = 0;
  let posEntryBar = 0;
  let posHighWater = 0;
  let posLowWater = 0;

  const volumes = candles.map(c => c.volume);
  const lotRatio = 0.3; // 蓄積ブレイクは控えめなロット

  for (let i = ACCUM_N + 1; i < candles.length; i++) {
    const curr = candles[i];
    const entryHour = parseInt(curr.time.split(":")[0], 10);
    
    // 14:30以降はエントリーしない（大引け前）
    if (curr.time >= "14:30" && !inPosition) continue;
    // 12時台はエントリーしない
    if (entryHour === 12 && !inPosition) continue;

    // ポジション管理（決済）
    if (inPosition) {
      const holdBars = i - posEntryBar;
      let exitReason = "";
      let shouldExit = false;

      if (posType === "long") {
        if (curr.close > posHighWater) posHighWater = curr.close;
        const gain = (posHighWater - posEntry) / posEntry;
        // 損切り
        if (curr.close <= posEntry * (1 - SHORT_STOP_LOSS_PERCENT / 100)) {
          shouldExit = true; exitReason = "損切り";
        }
        // トレイリング
        else if (gain >= 0.01 && curr.close <= posHighWater * 0.994) {
          shouldExit = true; exitReason = "トレイリング利確";
        }
        // 同値撤退
        else if (gain >= 0.005 && curr.close <= posEntry * 1.001) {
          shouldExit = true; exitReason = "同値撤退";
        }
        // 最大保有45本
        else if (holdBars >= 45) {
          shouldExit = true; exitReason = "時間切れ";
        }
        // 昼休み前
        else if (curr.time >= "11:25" && curr.time < "12:30") {
          shouldExit = true; exitReason = "昼休み前決済";
        }
        // 大引け
        else if (curr.time >= "14:55") {
          shouldExit = true; exitReason = "大引け決済";
        }
        if (shouldExit) {
          const profit = (curr.close - posEntry) * posShares;
          accumProfit += profit; accumTrades++;
          if (profit > 0) accumWin++; else accumLoss++;
          accumSignals.push({ time: curr.time, type: "sell", reason: `蓄積ブレイク上抜け→${exitReason}`, profit });
          inPosition = false;
        }
      } else {
        // short
        if (curr.close < posLowWater) posLowWater = curr.close;
        const gain = (posEntry - posLowWater) / posEntry;
        if (curr.close >= posEntry * (1 + SHORT_STOP_LOSS_PERCENT / 100)) {
          shouldExit = true; exitReason = "損切り";
        } else if (gain >= 0.01 && curr.close >= posLowWater * 1.006) {
          shouldExit = true; exitReason = "トレイリング利確";
        } else if (gain >= 0.005 && curr.close >= posEntry * 0.999) {
          shouldExit = true; exitReason = "同値撤退";
        } else if (holdBars >= 45) {
          shouldExit = true; exitReason = "時間切れ";
        } else if (curr.time >= "11:25" && curr.time < "12:30") {
          shouldExit = true; exitReason = "昼休み前決済";
        } else if (curr.time >= "14:55") {
          shouldExit = true; exitReason = "大引け決済";
        }
        if (shouldExit) {
          const profit = (posEntry - curr.close) * posShares;
          accumProfit += profit; accumTrades++;
          if (profit > 0) accumWin++; else accumLoss++;
          accumSignals.push({ time: curr.time, type: "cover", reason: `蓄積ブレイク下抜け→${exitReason}`, profit });
          inPosition = false;
        }
      }
      continue; // ポジション中は新規エントリーしない
    }

    // 現行エンジンがポジション中ならスキップ
    if (busyBars.has(i)) continue;

    // ---- 蓄積ブレイク検出 ----
    // ADXフィルター
    if (adxSeries[i] < ADX_THRESHOLD) continue;

    // 横ばい判定: 直近N本の range_ratio
    const lookbackBars = candles.slice(i - ACCUM_N, i);
    const maxHigh = Math.max(...lookbackBars.map(b => b.high));
    const minLow = Math.min(...lookbackBars.map(b => b.low));
    const rangeRatio = curr.close > 0 ? (maxHigh - minLow) / curr.close : 999;
    
    if (rangeRatio > ACCUM_RANGE_RATIO) continue; // 横ばいでない

    // 出来高確認: 直近N本平均の1.5倍以上
    const avgVol = lookbackBars.reduce((s, b) => s + b.volume, 0) / ACCUM_N;
    if (avgVol <= 0 || curr.volume < avgVol * ACCUM_VOL_MULT) continue;

    // レジーム判定
    const slope = curr.slope ?? 0;
    const flow = curr.flow ?? 0;
    const progress = candles.length > 1 ? i / (candles.length - 1) : 1;
    const mktBias = marketBiasAt(progress);
    const slopeUp = slope > SLOPE_THRESHOLD;
    const slopeDown = slope < -SLOPE_THRESHOLD;

    // 上抜けブレイク
    const breakUp = curr.close > maxHigh * (1 + ACCUM_BREAK_MARGIN);
    // 下抜けブレイク
    const breakDown = curr.close < minLow * (1 - ACCUM_BREAK_MARGIN);

    if (breakUp && !slopeDown) {
      // 蓄積ブレイク上抜け → ロングエントリー
      const maxSpend = initialCapital * lotRatio;
      const shares = Math.floor(maxSpend / curr.close / 100) * 100;
      if (shares > 0) {
        inPosition = true; posType = "long"; posEntry = curr.close; posShares = shares;
        posEntryBar = i; posHighWater = curr.close; posLowWater = curr.close;
        accumSignals.push({ time: curr.time, type: "buy", reason: `蓄積ブレイク上抜け (横ばい${ACCUM_N}本 range=${(rangeRatio*100).toFixed(2)}%, vol×${(curr.volume/avgVol).toFixed(1)}, ADX=${adxSeries[i].toFixed(0)})` });
      }
    } else if (breakDown && !slopeUp) {
      // 蓄積ブレイク下抜け → ショートエントリー
      const maxSpend = initialCapital * lotRatio;
      const shares = Math.floor(maxSpend / curr.close / 100) * 100;
      if (shares > 0) {
        inPosition = true; posType = "short"; posEntry = curr.close; posShares = shares;
        posEntryBar = i; posHighWater = curr.close; posLowWater = curr.close;
        accumSignals.push({ time: curr.time, type: "short", reason: `蓄積ブレイク下抜け (横ばい${ACCUM_N}本 range=${(rangeRatio*100).toFixed(2)}%, vol×${(curr.volume/avgVol).toFixed(1)}, ADX=${adxSeries[i].toFixed(0)})` });
      }
    }
  }

  // 合算
  return {
    profit: baseResult.profitAmount + accumProfit,
    win: baseResult.winCount + accumWin,
    loss: baseResult.lossCount + accumLoss,
    trades: baseResult.tradesCount + accumTrades,
    signals: accumSignals,
  };
}

function main() {
  console.log("=== 蓄積ブレイク比較バックテスト開始 ===\n");
  console.log(`パラメータ: N=${ACCUM_N}, range≤${ACCUM_RANGE_RATIO*100}%, vol×${ACCUM_VOL_MULT}, ADX≥${ADX_THRESHOLD}`);

  // 全日付を収集
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
  console.log(`全日数: ${allDays.length} (${allDays[0]} ~ ${allDays[allDays.length - 1]})\n`);

  // 結果蓄積
  interface DayResult { date: string; profit: number; win: number; loss: number; trades: number; }
  const dailyA: DayResult[] = [];
  const dailyB: DayResult[] = [];
  
  // 蓄積ブレイク専用統計
  let accumTotalSignals = 0, accumTotalWin = 0, accumTotalLoss = 0, accumTotalProfit = 0;
  const accumBySymbol = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const accumByType = { long: { profit: 0, win: 0, loss: 0, count: 0 }, short: { profit: 0, win: 0, loss: 0, count: 0 } };
  const accumByExitReason = new Map<string, { profit: number; count: number }>();

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

    // 市場効率性
    const symbols = Array.from(candleMap.keys());
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    // 市場バイアス関数
    const ratioSeries = symbols.map(sym => {
      const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0;
      return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
    });
    const marketBiasAt = (p: number): number => {
      let sum = 0, cnt = 0;
      for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; }
      return cnt > 0 ? sum / cnt : 0;
    };

    let dayProfitA = 0, dayWinA = 0, dayLossA = 0, dayTradesA = 0;
    let dayProfitB = 0, dayWinB = 0, dayLossB = 0, dayTradesB = 0;

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;

      // A: 現行のみ
      const resA = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, {
        shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
        lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
      });
      if (resA) {
        dayProfitA += resA.profitAmount; dayWinA += resA.winCount; dayLossA += resA.lossCount; dayTradesA += resA.tradesCount;
      }

      // B: 現行 + 蓄積ブレイク
      const resB = simulateWithAccumBreakout(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, rangeBound);
      dayProfitB += resB.profit; dayWinB += resB.win; dayLossB += resB.loss; dayTradesB += resB.trades;

      // 蓄積ブレイク専用統計
      for (const sig of resB.signals) {
        if (sig.type === "buy" || sig.type === "short") {
          accumTotalSignals++;
          const symAgg = accumBySymbol.get(s.symbol) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          symAgg.count++;
          accumBySymbol.set(s.symbol, symAgg);
        } else if (sig.profit !== undefined) {
          accumTotalProfit += sig.profit;
          if (sig.profit > 0) accumTotalWin++; else accumTotalLoss++;
          
          // 銘柄別
          const symAgg = accumBySymbol.get(s.symbol) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          symAgg.profit += sig.profit;
          if (sig.profit > 0) symAgg.win++; else symAgg.loss++;
          accumBySymbol.set(s.symbol, symAgg);
          
          // ロング/ショート別
          if (sig.reason.includes("上抜け")) {
            accumByType.long.profit += sig.profit; accumByType.long.count++;
            if (sig.profit > 0) accumByType.long.win++; else accumByType.long.loss++;
          } else {
            accumByType.short.profit += sig.profit; accumByType.short.count++;
            if (sig.profit > 0) accumByType.short.win++; else accumByType.short.loss++;
          }
          
          // 決済理由別
          const reason = sig.reason.replace(/蓄積ブレイク[上下]抜け→/, "");
          const rAgg = accumByExitReason.get(reason) ?? { profit: 0, count: 0 };
          rAgg.profit += sig.profit; rAgg.count++;
          accumByExitReason.set(reason, rAgg);
        }
      }
    }

    dailyA.push({ date: day, profit: Math.round(dayProfitA), win: dayWinA, loss: dayLossA, trades: dayTradesA });
    dailyB.push({ date: day, profit: Math.round(dayProfitB), win: dayWinB, loss: dayLossB, trades: dayTradesB });
  }

  // ============================================================
  // 集計出力
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
    let maxDD = 0, peak = 0, cumulative = 0;
    for (const p of profits) { cumulative += p; if (cumulative > peak) peak = cumulative; const dd = peak - cumulative; if (dd > maxDD) maxDD = dd; }
    return { label, tradedDays, totalProfit, totalWin, totalLoss, totalTrades, winRate, avgDay, posDays, negDays, best, worst, maxDD };
  };

  const sumA = summarize(dailyA, "A:現行のみ");
  const sumB = summarize(dailyB, "B:現行+蓄積ブレイク");

  console.log("\n" + "=".repeat(80));
  console.log("                    比較バックテスト結果サマリー");
  console.log("=".repeat(80));
  console.log(`\n${"項目".padEnd(22)}${"A:現行のみ".padEnd(22)}${"B:+蓄積ブレイク".padEnd(22)}`);
  console.log("-".repeat(66));
  console.log(`${"取引日数".padEnd(20)}${String(sumA.tradedDays).padEnd(22)}${String(sumB.tradedDays).padEnd(22)}`);
  console.log(`${"総損益(円)".padEnd(20)}${sumA.totalProfit.toLocaleString().padEnd(22)}${sumB.totalProfit.toLocaleString().padEnd(22)}`);
  console.log(`${"日平均(円)".padEnd(20)}${Math.round(sumA.avgDay).toLocaleString().padEnd(22)}${Math.round(sumB.avgDay).toLocaleString().padEnd(22)}`);
  console.log(`${"総取引数".padEnd(20)}${String(sumA.totalTrades).padEnd(22)}${String(sumB.totalTrades).padEnd(22)}`);
  console.log(`${"勝率".padEnd(20)}${((sumA.winRate * 100).toFixed(1) + "%").padEnd(22)}${((sumB.winRate * 100).toFixed(1) + "%").padEnd(22)}`);
  console.log(`${"勝ち日/負け日".padEnd(20)}${(sumA.posDays + "/" + sumA.negDays).padEnd(22)}${(sumB.posDays + "/" + sumB.negDays).padEnd(22)}`);
  console.log(`${"最良日(円)".padEnd(20)}${sumA.best.toLocaleString().padEnd(22)}${sumB.best.toLocaleString().padEnd(22)}`);
  console.log(`${"最悪日(円)".padEnd(20)}${sumA.worst.toLocaleString().padEnd(22)}${sumB.worst.toLocaleString().padEnd(22)}`);
  console.log(`${"最大DD(円)".padEnd(20)}${sumA.maxDD.toLocaleString().padEnd(22)}${sumB.maxDD.toLocaleString().padEnd(22)}`);

  const diff = sumB.totalProfit - sumA.totalProfit;
  console.log(`\n蓄積ブレイク追加による差分: ${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円 (${sumA.totalProfit !== 0 ? ((diff / Math.abs(sumA.totalProfit)) * 100).toFixed(1) : 0}%)`);

  // 蓄積ブレイク専用分析
  console.log("\n" + "=".repeat(80));
  console.log("           蓄積ブレイクシグナル単体分析");
  console.log("=".repeat(80));
  const accumWinRate = (accumTotalWin + accumTotalLoss) > 0 ? accumTotalWin / (accumTotalWin + accumTotalLoss) : 0;
  console.log(`\n  総シグナル数: ${accumTotalSignals}`);
  console.log(`  決済済み: ${accumTotalWin + accumTotalLoss}件`);
  console.log(`  勝率: ${(accumWinRate * 100).toFixed(1)}%`);
  console.log(`  総損益: ${Math.round(accumTotalProfit).toLocaleString()}円`);
  console.log(`  平均損益/件: ${(accumTotalWin + accumTotalLoss) > 0 ? Math.round(accumTotalProfit / (accumTotalWin + accumTotalLoss)).toLocaleString() : 0}円`);

  console.log(`\n  --- ロング/ショート別 ---`);
  const lWr = accumByType.long.count > 0 ? (accumByType.long.win / accumByType.long.count * 100).toFixed(1) : "N/A";
  const sWr = accumByType.short.count > 0 ? (accumByType.short.win / accumByType.short.count * 100).toFixed(1) : "N/A";
  console.log(`  上抜け(ロング): ${accumByType.long.count}件, 勝率${lWr}%, 損益${Math.round(accumByType.long.profit).toLocaleString()}円`);
  console.log(`  下抜け(ショート): ${accumByType.short.count}件, 勝率${sWr}%, 損益${Math.round(accumByType.short.profit).toLocaleString()}円`);

  console.log(`\n  --- 決済理由別 ---`);
  for (const [reason, data] of Array.from(accumByExitReason.entries()).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason}: ${data.count}件, ${Math.round(data.profit).toLocaleString()}円`);
  }

  console.log(`\n  --- 銘柄別 ---`);
  const symEntries = Array.from(accumBySymbol.entries()).sort((a, b) => b[1].profit - a[1].profit);
  for (const [sym, data] of symEntries) {
    if (data.count === 0) continue;
    const stock = TARGET_STOCKS.find(s => s.symbol === sym);
    const wr = (data.win + data.loss) > 0 ? (data.win / (data.win + data.loss) * 100).toFixed(1) : "N/A";
    console.log(`  ${sym} ${stock?.name ?? ""}: ${data.count}件, 勝率${wr}%, 損益${Math.round(data.profit).toLocaleString()}円`);
  }

  // パラメータ感度分析（N=3,4,5,6で比較）
  console.log("\n" + "=".repeat(80));
  console.log("           パラメータ感度分析（横ばい本数N）");
  console.log("=".repeat(80));
  // 簡易版: 各Nでのシグナル発生数と概算を出力
  for (const testN of [3, 4, 5, 6]) {
    let sigCount = 0;
    for (const s of TARGET_STOCKS) {
      for (const day of allDays) {
        const dayData = symbolData.get(s.symbol)?.get(day);
        if (!dayData || dayData.length < 60) continue;
        const candles = buildCandles(dayData);
        const adx = calcADX(candles);
        for (let i = testN + 1; i < candles.length; i++) {
          if (adx[i] < ADX_THRESHOLD) continue;
          const lb = candles.slice(i - testN, i);
          const mxH = Math.max(...lb.map(b => b.high));
          const mnL = Math.min(...lb.map(b => b.low));
          const rr = candles[i].close > 0 ? (mxH - mnL) / candles[i].close : 999;
          if (rr > ACCUM_RANGE_RATIO) continue;
          const avgV = lb.reduce((s, b) => s + b.volume, 0) / testN;
          if (avgV <= 0 || candles[i].volume < avgV * ACCUM_VOL_MULT) continue;
          if (candles[i].close > mxH * (1 + ACCUM_BREAK_MARGIN) || candles[i].close < mnL * (1 - ACCUM_BREAK_MARGIN)) {
            sigCount++;
          }
        }
      }
    }
    console.log(`  N=${testN}: シグナル発生数 = ${sigCount}件 (${allDays.length}日間, ${TARGET_STOCKS.length}銘柄)`);
  }

  // CSV出力
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["date,profitA,profitB,tradesA,tradesB"];
  for (let i = 0; i < dailyA.length; i++) {
    const a = dailyA[i]; const b = dailyB[i];
    csvRows.push([a.date, a.profit, b?.profit ?? 0, a.trades, b?.trades ?? 0].join(","));
  }
  fs.writeFileSync(path.join(outDir, "compare_accum_breakout.csv"), csvRows.join("\n"), "utf8");
  console.log(`\nCSV出力: ${path.join(outDir, "compare_accum_breakout.csv")}`);
}

main();
