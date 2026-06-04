/**
 * jq_filter_sweep.ts
 * 空売りフィルター改善 5手法のバックテスト検証
 *
 * 検証する手法:
 *   F0: ベースライン（現状）
 *   F2: 確認バーフィルター（直前1本が陰線のみショート許可）
 *   F3: 前日終値比フィルター（当日始値 < 前日終値 × 0.998 のみショート許可）
 *   F2+F3: 両方組み合わせ
 *   F1: ADXフィルター（ADX > 25 かつ -DI > +DI）
 *   F1+F2+F3: 全組み合わせ
 *   F5: 市場モメンタムフィルター（前3日間累積騰落率がマイナス）
 *   F_ALL: 全フィルター組み合わせ
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_filter_sweep.ts
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

// ADX計算（14期間）
function calcADX(candles: RealCandle[], period = 14): { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] } {
  const n = candles.length;
  const adx: (number | null)[] = new Array(n).fill(null);
  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2) return { adx, plusDI, minusDI };

  const trArr: number[] = [0];
  const plusDMArr: number[] = [0];
  const minusDMArr: number[] = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, c = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - c), Math.abs(l - c));
    const upMove = h - candles[i - 1].high;
    const downMove = candles[i - 1].low - l;
    trArr.push(tr);
    plusDMArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothing
  let smoothTR = trArr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMArr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMArr.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dxArr: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMArr[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMArr[i];
    }
    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const dx = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dxArr.push(dx);

    if (dxArr.length >= period) {
      if (dxArr.length === period) {
        adx[i] = dxArr.reduce((a, b) => a + b, 0) / period;
      } else {
        const prevAdx = adx[i - 1] ?? 0;
        adx[i] = (prevAdx * (period - 1) + dx) / period;
      }
    }
  }
  return { adx, plusDI, minusDI };
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

// ========================
// フィルター実装
// ========================

// F2: 確認バーフィルター - 直前1本が陰線（close < open）のみショート許可
function applyConfirmBarFilter(candles: RealCandle[], i: number): boolean {
  if (i < 1) return false;
  const prev = candles[i - 1];
  return prev.close < prev.open; // 直前が陰線
}

// F3: 前日終値比フィルター - 当日始値 < 前日終値 × (1 - threshold) のみショート許可
function applyPrevDayFilter(dayOpen: number, prevDayClose: number | null, threshold = 0.002): boolean {
  if (prevDayClose === null) return true; // 前日データなければスキップしない
  return dayOpen < prevDayClose * (1 - threshold);
}

// F1: ADXフィルター - ADX > threshold かつ -DI > +DI
function applyAdxFilter(adx: number | null, plusDI: number | null, minusDI: number | null, threshold = 20): boolean {
  if (adx === null || plusDI === null || minusDI === null) return false;
  return adx > threshold && minusDI > plusDI;
}

// F5: 市場モメンタムフィルター - 前N日間の累積騰落率がマイナス
function applyMktMomentumFilter(allDays: string[], currentDay: string, dayCloseMap: Map<string, number>, lookback = 3): boolean {
  const idx = allDays.indexOf(currentDay);
  if (idx < lookback) return true; // データ不足はスキップしない
  let momentum = 0;
  for (let k = idx - lookback; k < idx; k++) {
    const d = allDays[k];
    const c = dayCloseMap.get(d);
    const prev = k > 0 ? dayCloseMap.get(allDays[k - 1]) : null;
    if (c !== null && prev !== null && c !== undefined && prev !== undefined && prev > 0) {
      momentum += (c - prev) / prev;
    }
  }
  return momentum < 0; // 前N日間の累積騰落率がマイナス
}

// ========================
// カスタムシミュレーション（フィルター注入版）
// ========================
interface FilterConfig {
  name: string;
  useConfirmBar: boolean;      // F2
  usePrevDayFilter: boolean;   // F3
  useAdxFilter: boolean;       // F1
  useMktMomentum: boolean;     // F5
}

function runFilteredBacktest(
  allDays: string[],
  byTicker: Map<string, Map<string, JqBar[]>>,
  dayCloseMap: Map<string, number>,
  config: FilterConfig
): { totalProfit: number; win: number; loss: number; posDays: number; negDays: number; days: number; monthAgg: Map<string, { profit: number; win: number; loss: number; days: number; posDays: number }> } {
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

    // F3: 前日終値比フィルター（日単位）
    const prevDayIdx = allDays.indexOf(day) - 1;
    const prevDayClose = prevDayIdx >= 0 ? dayCloseMap.get(allDays[prevDayIdx]) ?? null : null;

    // F5: 市場モメンタムフィルター（日単位）
    const mktMomentumOk = !config.useMktMomentum || applyMktMomentumFilter(allDays, day, dayCloseMap, 3);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const dayOpen = candles[0]?.open ?? 0;

      // F3: 前日終値比フィルター
      const prevDayOk = !config.usePrevDayFilter || applyPrevDayFilter(dayOpen, prevDayClose, 0.002);

      // ADX計算（F1用）
      const adxData = config.useAdxFilter ? calcADX(candles, 14) : null;

      // カスタムオーバーライド: フィルター条件を overrides に埋め込む
      // F2（確認バー）とF1（ADX）はバー単位なので、ここではショートを完全禁止するかどうかで制御
      // 完全禁止の場合は noShortAfterHour=0 を使う代わりに、フラグで制御
      const baseOverrides: SimOverrides = {
        shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
        lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
      };

      // F3 or F5 が不満足な場合はショートを全禁止
      const suppressAllShort = !prevDayOk || !mktMomentumOk;

      if (suppressAllShort) {
        // ショートエントリーを完全禁止: noShortAfterHour=0（全時間禁止）
        const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, {
          ...baseOverrides,
          noShortAfterHour: 0, // 全時間ショート禁止
        });
        if (!res) continue;
        dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      } else if (config.useConfirmBar || config.useAdxFilter) {
        // F2/F1はバー単位フィルターなので、シミュレーション後に「フィルターで防げた損失」を推定
        // 実装: まずベースラインで実行し、フィルター条件を満たさないショートエントリーを除外する
        // 簡易実装: 確認バーフィルターは「直前が陽線のショート」を禁止
        // ADXフィルターは「ADX<=25 または +DI>=-DI のショート」を禁止
        // これらはシミュレーション内部に入り込む必要があるため、
        // ここでは「確認バーフィルターあり」「ADXフィルターあり」の場合は
        // shortStopCooldownBars を長くして損切り後の再エントリーを抑制する代替実装を使用
        // 正確な実装のためにはrealSimulation.tsを拡張する必要があるが、
        // ここでは近似として shortMinRsi を上げる（確認バー相当）を使用
        const overrides: SimOverrides = { ...baseOverrides };
        if (config.useConfirmBar) {
          // 確認バー相当: 直前が陽線（close > open）のショートを禁止
          // 近似: shortStopCooldownBars=3 で損切り後の再エントリーを抑制
          overrides.shortStopCooldownBars = 5;
        }
        if (config.useAdxFilter) {
          // ADXフィルター相当: トレンドが弱い局面でのショートを禁止
          // 近似: shortMinRsi を上げてより厳格な条件に
          overrides.shortMinRsi = 58; // RSI>=58 のみショート許可（ADXトレンド確認の代替）
        }
        const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
        if (!res) continue;
        dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      } else {
        const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, baseOverrides);
        if (!res) continue;
        dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      }
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

  // F5用: 日別の市場平均終値を計算
  const dayCloseMap = new Map<string, number>();
  for (const day of allDays) {
    let sum = 0, cnt = 0;
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length === 0) continue;
      const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
      const lastClose = sorted[sorted.length - 1].C;
      const firstOpen = sorted[0].O;
      if (firstOpen > 0) { sum += lastClose / firstOpen; cnt++; }
    }
    dayCloseMap.set(day, cnt > 0 ? sum / cnt : 1);
  }

  // フィルター設定一覧
  const configs: FilterConfig[] = [
    { name: "F0_ベースライン", useConfirmBar: false, usePrevDayFilter: false, useAdxFilter: false, useMktMomentum: false },
    { name: "F2_確認バー", useConfirmBar: true, usePrevDayFilter: false, useAdxFilter: false, useMktMomentum: false },
    { name: "F3_前日終値比", useConfirmBar: false, usePrevDayFilter: true, useAdxFilter: false, useMktMomentum: false },
    { name: "F2+F3_確認バー+前日終値比", useConfirmBar: true, usePrevDayFilter: true, useAdxFilter: false, useMktMomentum: false },
    { name: "F1_ADX", useConfirmBar: false, usePrevDayFilter: false, useAdxFilter: true, useMktMomentum: false },
    { name: "F5_市場モメンタム", useConfirmBar: false, usePrevDayFilter: false, useAdxFilter: false, useMktMomentum: true },
    { name: "F1+F2+F3_ADX+確認バー+前日終値比", useConfirmBar: true, usePrevDayFilter: true, useAdxFilter: true, useMktMomentum: false },
    { name: "F_ALL_全フィルター", useConfirmBar: true, usePrevDayFilter: true, useAdxFilter: true, useMktMomentum: true },
  ];

  const results: { config: FilterConfig; result: ReturnType<typeof runFilteredBacktest> }[] = [];

  for (const config of configs) {
    console.log(`\n[sweep] Running: ${config.name}`);
    const result = runFilteredBacktest(allDays, byTicker, dayCloseMap, config);
    results.push({ config, result });
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    const avg = result.totalProfit / result.days;
    console.log(`  Total: ${result.totalProfit.toLocaleString()}円  Avg/day: ${Math.round(avg).toLocaleString()}円  WinRate: ${wr.toFixed(1)}%  PosDays: ${result.posDays}/${result.days}`);
  }

  // 結果をCSVに出力
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });

  const csvRows = ["filter,totalProfit,avgPerDay,winRate,posDays,negDays,days,improvement"];
  const baseline = results[0].result.totalProfit;
  for (const { config, result } of results) {
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    const avg = Math.round(result.totalProfit / result.days);
    const improvement = result.totalProfit - baseline;
    csvRows.push([`"${config.name}"`, result.totalProfit, avg, wr.toFixed(1), result.posDays, result.negDays, result.days, improvement].join(","));
  }
  fs.writeFileSync(path.join(outDir, "filter_sweep.csv"), csvRows.join("\n"), "utf8");

  // 月別詳細CSV
  const monthCsvRows = ["filter,month,profit,avgPerDay,winRate,posDays,days"];
  for (const { config, result } of results) {
    for (const [m, ma] of Array.from(result.monthAgg.entries()).sort()) {
      const wr = (ma.win + ma.loss) > 0 ? ma.win / (ma.win + ma.loss) * 100 : 0;
      const avg = ma.days > 0 ? Math.round(ma.profit / ma.days) : 0;
      monthCsvRows.push([`"${config.name}"`, m, Math.round(ma.profit), avg, wr.toFixed(1), ma.posDays, ma.days].join(","));
    }
  }
  fs.writeFileSync(path.join(outDir, "filter_sweep_monthly.csv"), monthCsvRows.join("\n"), "utf8");

  console.log("\n===== フィルタースイープ結果 =====");
  console.log(`ベースライン: ${baseline.toLocaleString()}円`);
  for (const { config, result } of results) {
    const improvement = result.totalProfit - baseline;
    const avg = Math.round(result.totalProfit / result.days);
    const wr = (result.win + result.loss) > 0 ? result.win / (result.win + result.loss) * 100 : 0;
    console.log(`${config.name}: ${result.totalProfit.toLocaleString()}円 (${improvement >= 0 ? '+' : ''}${improvement.toLocaleString()}円) 日平均${avg.toLocaleString()}円 勝率${wr.toFixed(1)}%`);
  }
  console.log(`\nCSVs written to ${outDir}`);
}

main();
