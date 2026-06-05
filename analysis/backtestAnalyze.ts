/**
 * backtestAnalyze.ts
 * 過去5営業日分の1分足を全銘柄取得し、日ごと・銘柄ごとにシミュレーションを実行して
 * 取引明細を全件CSVに書き出す分析スクリプト。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/backtestAnalyze.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import { applyPortfolioRules, type PerStockTrades } from "../server/portfolio";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  REGIME_CONSTANTS,
} from "../server/realSimulation";
import { calcVWAP } from "../server/vwap";
import * as fs from "fs";
import * as path from "path";

// realSimulation の RealCandle と同型（exportされていないためローカル定義）
interface RealCandle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  flow: number | null;
  slope: number | null;
  vwap: number | null;
}

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

function calcBollinger(data: number[], period = 20, stdDevMult = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = avg + stdDevMult * std;
    lower[i] = avg - stdDevMult * std;
  }
  return { upper, lower };
}

interface RawBar {
  timestamp: number;
  jstDate: string; // YYYY-MM-DD (JST)
  time: string;    // HH:MM (JST)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 5営業日分の1分足を取得し、JST日付ごとに分割した生バー配列を返す */
async function fetch5dByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const rawData = await callDataApi("YahooFinance/get_stock_chart", {
    query: { symbol: ticker, region: "JP", interval: "1m", range: "5d" },
  });
  const data = rawData as {
    chart?: { result?: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }> };
    }> };
  };
  const byDay = new Map<string, RawBar[]>();
  const result = data?.chart?.result?.[0];
  if (!result) return byDay;
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || c == null) continue;
    const d = new Date(ts[i] * 1000);
    // JSTに変換
    const jst = new Date(d.getTime() + 9 * 3600 * 1000);
    const y = jst.getUTCFullYear();
    const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
    const day = String(jst.getUTCDate()).padStart(2, "0");
    const jstDate = `${y}-${m}-${day}`;
    const hh = String(jst.getUTCHours()).padStart(2, "0");
    const mm = String(jst.getUTCMinutes()).padStart(2, "0");
    const arr = byDay.get(jstDate) ?? [];
    arr.push({ timestamp: ts[i] * 1000, jstDate, time: `${hh}:${mm}`, open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0 });
    byDay.set(jstDate, arr);
  }
  return byDay;
}

/** 生バー配列に指標を付与して RealCandle 配列にする */
function toCandles(bars: RawBar[]): RealCandle[] {
  const candles: RealCandle[] = bars.map(b => ({
    time: b.time, timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null, vwap: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  // VWAP（出来高加重平均価格）を計算（当日分のみなのでdayKeyは不要）
  const vwapSeries = calcVWAP(candles);
  candles.forEach((c, i) => { c.vwap = vwapSeries[i]; });
  const signedVol = candles.map(c => { const range = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / range; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

async function main() {
  console.log("[analyze] Fetching 5d 1m data for all symbols...");
  // ticker -> (jstDate -> bars)
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try {
      const byDay = await fetch5dByDay(s.ticker);
      byTicker.set(s.symbol, byDay);
      const days = Array.from(byDay.keys()).sort();
      console.log(`  ${s.symbol} ${s.name}: ${days.length} days [${days.join(", ")}]`);
    } catch (e) {
      console.warn(`  ${s.symbol} fetch failed:`, (e as Error).message);
    }
    await new Promise(r => setTimeout(r, 350));
  }

  // 全銘柄に共通して存在する日付を抽出
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[analyze] Days found: ${allDays.join(", ")}`);

  // CSV出力用
  const tradeRows: string[] = ["date,symbol,name,entryTime,entryType,entryPrice,exitTime,exitType,exitPrice,shares,profit,profitRate,exitReason"];
  const dailyRows: string[] = ["date,marketEfficiency,rangeBoundDay,totalProfit,winCount,lossCount,winRate"];
  const symbolAgg = new Map<string, { name: string; profit: number; win: number; loss: number; trades: number }>();
  const reasonAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const hourAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const portfolioDaily: Array<{ day: string; accepted: number; skipped: number; win: number; loss: number; maxConc: number }> = [];

  for (const day of allDays) {
    // この日に十分なバーがある銘柄だけを対象（寄り後の最低本数を確保）
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const byDay = byTicker.get(s.symbol);
      const bars = byDay?.get(day);
      if (!bars || bars.length < 60) continue; // 当日データが少ない日はスキップ
      candleMap.set(s.symbol, toCandles(bars));
    }
    if (candleMap.size < 5) { console.log(`[analyze] ${day}: too few symbols (${candleMap.size}), skip`); continue; }

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => {
      let sum = 0, cnt = 0;
      for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; }
      return cnt > 0 ? sum / cnt : 0;
    };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    const perStockToday: PerStockTrades[] = [];
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound);
      if (!res) continue;
      dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;
      perStockToday.push({ symbol: s.symbol, trades: res.trades });

      const agg = symbolAgg.get(s.symbol) ?? { name: s.name, profit: 0, win: 0, loss: 0, trades: 0 };
      agg.profit += res.profitAmount; agg.win += res.winCount; agg.loss += res.lossCount; agg.trades += res.tradesCount;
      symbolAgg.set(s.symbol, agg);

      // トレードをエントリー/決済ペアに変換して明細化
      let open: { time: string; type: string; price: number; shares: number } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          open = { time: t.time, type: t.type, price: t.price, shares: t.shares };
        } else if ((t.type === "sell" || t.type === "cover") && open) {
          const profit = t.profit ?? 0;
          const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
          const reason = sig?.reason ?? "";
          const reasonKey = reason.split("(")[0].trim() || "不明";
          tradeRows.push([day, s.symbol, s.name, open.time, open.type, open.price, t.time, t.type, t.price, t.shares, Math.round(profit), (t.profitRate ?? 0).toFixed(4), `"${reason}"`].join(","));

          const ra = reasonAgg.get(reasonKey) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          ra.profit += profit; ra.count++; if (profit > 0) ra.win++; else ra.loss++;
          reasonAgg.set(reasonKey, ra);

          const hour = open.time.split(":")[0] + ":00";
          const ha = hourAgg.get(hour) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          ha.profit += profit; ha.count++; if (profit > 0) ha.win++; else ha.loss++;
          hourAgg.set(hour, ha);
          open = null;
        }
      }
    }
    // 【ハイブリッド方式】同時保有3銘柄・同業種2銘柄に制限した後の採用損益
    const pf = applyPortfolioRules(perStockToday);
    portfolioDaily.push({ day, accepted: pf.acceptedProfit, skipped: pf.skippedProfit, win: pf.acceptedWins, loss: pf.acceptedLosses, maxConc: pf.maxConcurrentObserved });

    const dayWinRate = (dayWin + dayLoss) > 0 ? dayWin / (dayWin + dayLoss) : 0;
    dailyRows.push([day, eff.toFixed(3), String(rangeBound), Math.round(dayProfit), dayWin, dayLoss, dayWinRate.toFixed(3)].join(","));
    console.log(`[analyze] ${day}: all=${Math.round(dayProfit)} hybrid=${Math.round(pf.acceptedProfit)} (skip=${Math.round(pf.skippedProfit)}) maxConc=${pf.maxConcurrentObserved} eff=${eff.toFixed(2)}`);
  }

  // 出力
  const outDir = path.join(process.cwd(), "analysis", "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "trades.csv"), tradeRows.join("\n"), "utf8");
  fs.writeFileSync(path.join(outDir, "daily.csv"), dailyRows.join("\n"), "utf8");

  // 銘柄別集計
  const symRows = ["symbol,name,profit,win,loss,trades,winRate"];
  for (const [sym, a] of Array.from(symbolAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.trades > 0 ? a.win / a.trades : 0;
    symRows.push([sym, a.name, Math.round(a.profit), a.win, a.loss, a.trades, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_symbol.csv"), symRows.join("\n"), "utf8");

  // 決済理由別集計
  const reasonRows = ["reason,profit,win,loss,count,winRate"];
  for (const [r, a] of Array.from(reasonAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.count > 0 ? a.win / a.count : 0;
    reasonRows.push([`"${r}"`, Math.round(a.profit), a.win, a.loss, a.count, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_reason.csv"), reasonRows.join("\n"), "utf8");

  // 時間帯別集計
  const hourRows = ["entryHour,profit,win,loss,count,winRate"];
  for (const [h, a] of Array.from(hourAgg.entries()).sort((x, y) => x[0].localeCompare(y[0]))) {
    const wr = a.count > 0 ? a.win / a.count : 0;
    hourRows.push([h, Math.round(a.profit), a.win, a.loss, a.count, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_hour.csv"), hourRows.join("\n"), "utf8");

  // 【ハイブリッド方式 vs 全銘柄合計】の比較
  const tradedDays = portfolioDaily.length;
  const allTotal = dailyRows.slice(1).reduce((s, row) => s + Number(row.split(",")[3]), 0);
  const hybridTotal = portfolioDaily.reduce((s, d) => s + d.accepted, 0);
  const hybridWin = portfolioDaily.reduce((s, d) => s + d.win, 0);
  const hybridLoss = portfolioDaily.reduce((s, d) => s + d.loss, 0);
  const pfRows = ["date,hybridAccepted,skipped,win,loss,maxConcurrent"];
  for (const d of portfolioDaily) pfRows.push([d.day, Math.round(d.accepted), Math.round(d.skipped), d.win, d.loss, d.maxConc].join(","));
  fs.writeFileSync(path.join(outDir, "portfolio_daily.csv"), pfRows.join("\n"), "utf8");

  console.log("\n===== 全銘柄合計 vs ハイブリッド（3銘柄厳選） =====");
  console.log(`Traded days: ${tradedDays}`);
  console.log(`【全銘柄合計】  total=${Math.round(allTotal)}  avg/day=${Math.round(allTotal / tradedDays)}`);
  console.log(`【ハイブリッド】 total=${Math.round(hybridTotal)}  avg/day=${Math.round(hybridTotal / tradedDays)}  win/loss=${hybridWin}/${hybridLoss}  winRate=${((hybridWin/(hybridWin+hybridLoss||1))*100).toFixed(1)}%`);
  console.log("\nPortfolio daily:");
  console.log(pfRows.join("\n"));

  console.log("\n===== SUMMARY =====");
  console.log("By symbol (worst first):");
  console.log(symRows.join("\n"));
  console.log("\nBy reason (worst first):");
  console.log(reasonRows.join("\n"));
  console.log("\nBy entry hour:");
  console.log(hourRows.join("\n"));
  console.log("\nDaily:");
  console.log(dailyRows.join("\n"));
  console.log(`\n[analyze] CSVs written to ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
