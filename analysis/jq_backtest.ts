/**
 * jq_backtest.ts
 * analysis/jq_data/<symbol>.json (J-Quants 1分足) を読み込み、本番と同一の
 * simulateStockReal(損切り2.0%) でバックテストする。
 *
 * backtest20d.ts と同じ集計構造を用い、データ源のみ J-Quants 1分足に差し替えたもの。
 * 1分足・60営業日という長期間で、勝率・日次損益・「1日15,000円以上」達成日数を集計する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/jq_backtest.ts
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

// JST日付+時刻からUTCミリ秒へ。
function toTimestamp(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
}

function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null, vwap: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14); const bb = calcBollinger(closes, 20, 2);
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
  // 銘柄ごとに日別バー配列を構築
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`[jq-bt] missing ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[jq-bt] Days found: ${allDays.length} (${allDays[0]} .. ${allDays[allDays.length - 1]})`);

  const dailyRows: string[] = ["date,marketEfficiency,rangeBoundDay,totalProfit,winCount,lossCount,winRate"];
  const reasonAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const symbolAgg = new Map<string, { name: string; profit: number; win: number; loss: number; trades: number }>();
  const dailyProfits: { date: string; profit: number }[] = [];

  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue; // 1分足は1日約300本。最低60本確保
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) { continue; }

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE });
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
    const wr = (dayWin + dayLoss) > 0 ? dayWin / (dayWin + dayLoss) : 0;
    dailyRows.push([day, eff.toFixed(3), String(rangeBound), Math.round(dayProfit), dayWin, dayLoss, wr.toFixed(3)].join(","));
    dailyProfits.push({ date: day, profit: Math.round(dayProfit) });
    grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
    if (dayProfit > 0) posDays++; else if (dayProfit < 0) negDays++;
    console.log(`[jq-bt] ${day}: profit=${Math.round(dayProfit)} win=${dayWin} loss=${dayLoss} eff=${eff.toFixed(2)} range=${rangeBound}`);
  }

  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "daily.csv"), dailyRows.join("\n"), "utf8");

  const symRows = ["symbol,name,profit,win,loss,trades,winRate"];
  for (const [sym, a] of Array.from(symbolAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.trades > 0 ? a.win / a.trades : 0;
    symRows.push([sym, a.name, Math.round(a.profit), a.win, a.loss, a.trades, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_symbol.csv"), symRows.join("\n"), "utf8");

  const reasonRows = ["reason,profit,win,loss,count,winRate"];
  for (const [r, a] of Array.from(reasonAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.count > 0 ? a.win / a.count : 0;
    reasonRows.push([`"${r}"`, Math.round(a.profit), a.win, a.loss, a.count, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_reason.csv"), reasonRows.join("\n"), "utf8");

  const tradedDays = dailyProfits.length;
  const avg = tradedDays > 0 ? grandTotal / tradedDays : 0;
  const overallWr = (grandWin + grandLoss) > 0 ? grandWin / (grandWin + grandLoss) : 0;
  const profitsArr = dailyProfits.map(d => d.profit);
  const best = Math.max(...profitsArr), worst = Math.min(...profitsArr);
  const daysOver15k = profitsArr.filter(p => p >= 15000).length;
  const medianDay = [...profitsArr].sort((a, b) => a - b)[Math.floor(profitsArr.length / 2)];

  console.log("\n===== J-QUANTS 1m BACKTEST SUMMARY =====");
  console.log(`Traded days: ${tradedDays}`);
  console.log(`Total profit: ${Math.round(grandTotal)} yen`);
  console.log(`Avg/day: ${Math.round(avg)} yen`);
  console.log(`Median/day: ${medianDay} yen`);
  console.log(`Win/Loss trades: ${grandWin}/${grandLoss}  winRate: ${(overallWr * 100).toFixed(1)}%`);
  console.log(`Positive days: ${posDays}, Negative days: ${negDays}`);
  console.log(`Best day: ${best}, Worst day: ${worst}`);
  console.log(`Days >= 15000 yen: ${daysOver15k}/${tradedDays} (${(daysOver15k / tradedDays * 100).toFixed(1)}%)`);
  console.log(`\n[jq-bt] CSVs written to ${outDir}`);
}

main();
