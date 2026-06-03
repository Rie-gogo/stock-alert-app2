/**
 * dailyReport.ts
 * 指定日（既定は本日JST）の全銘柄1分足を取得し、本番ロジックで当日損益をシミュレートして
 * 当日損益レポート（銘柄別・決済理由別・時間帯別・ロング/ショート別・ハイブリッド採用後・
 * デイリーストップ状況）を Markdown + CSV で出力する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/dailyReport.ts [YYYY-MM-DD]
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import { applyPortfolioRules, type PerStockTrades } from "../server/portfolio";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

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
  jstDate: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

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

function toCandles(bars: RawBar[]): RealCandle[] {
  const candles: RealCandle[] = bars.map(b => ({
    time: b.time, timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const signedVol = candles.map(c => { const range = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / range; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

const yen = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n).toLocaleString("ja-JP")}円`;

async function main() {
  const argDay = process.argv[2];
  // 既定は本日（JST）
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const todayJst = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;
  const targetDay = argDay || todayJst;
  console.log(`[dailyReport] Target day (JST): ${targetDay}`);

  // 全銘柄の5d 1mを取得
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try {
      const byDay = await fetch5dByDay(s.ticker);
      byTicker.set(s.symbol, byDay);
    } catch (e) {
      console.warn(`  ${s.symbol} fetch failed:`, (e as Error).message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 対象日にバーがある銘柄を抽出
  const candleMap = new Map<string, RealCandle[]>();
  let barCountInfo: string[] = [];
  for (const s of TARGET_STOCKS) {
    const bars = byTicker.get(s.symbol)?.get(targetDay);
    if (!bars) { barCountInfo.push(`${s.symbol}:none`); continue; }
    barCountInfo.push(`${s.symbol}:${bars.length}`);
    if (bars.length < 60) continue;
    candleMap.set(s.symbol, toCandles(bars));
  }
  console.log(`[dailyReport] bars per symbol on ${targetDay}: ${barCountInfo.join(" ")}`);

  if (candleMap.size < 1) {
    console.error(`[dailyReport] No sufficient intraday data for ${targetDay}. (Market may not have data yet or it's a holiday.)`);
    // 利用可能な日付を表示
    const avail = new Set<string>();
    for (const m of byTicker.values()) for (const d of m.keys()) avail.add(d);
    console.error(`Available days: ${Array.from(avail).sort().join(", ")}`);
    process.exit(2);
  }

  // 市場全体バイアス・効率
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
  // 市場の引け騰落（寄り→引けの平均）
  const marketMovePct = dayStats.reduce((s, d) => s + (d.open > 0 ? (d.close - d.open) / d.open : 0), 0) / dayStats.length * 100;

  // 銘柄別シミュレーション
  interface SymRow { symbol: string; name: string; profit: number; win: number; loss: number; trades: number; longProfit: number; shortProfit: number; longCount: number; shortCount: number; }
  const symRows: SymRow[] = [];
  const reasonAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const hourAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const tradeRows: string[] = ["symbol,name,entryTime,entryType,entryPrice,exitTime,exitType,exitPrice,shares,profit,exitReason"];
  const perStockToday: PerStockTrades[] = [];
  let longTotal = 0, shortTotal = 0, longCnt = 0, shortCnt = 0;

  for (const s of TARGET_STOCKS) {
    const candles = candleMap.get(s.symbol);
    if (!candles) continue;
    const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound);
    if (!res) continue;
    perStockToday.push({ symbol: s.symbol, trades: res.trades });

    let lp = 0, sp = 0, lc = 0, sc = 0;
    let open: { time: string; type: string; price: number; shares: number } | null = null;
    for (const t of res.trades) {
      if (t.type === "buy" || t.type === "short") {
        open = { time: t.time, type: t.type, price: t.price, shares: t.shares };
      } else if ((t.type === "sell" || t.type === "cover") && open) {
        const profit = t.profit ?? 0;
        const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
        const reason = sig?.reason ?? "";
        const reasonKey = reason.split("(")[0].trim() || "不明";
        tradeRows.push([s.symbol, s.name, open.time, open.type, open.price, t.time, t.type, t.price, t.shares, Math.round(profit), `"${reason}"`].join(","));
        if (open.type === "buy") { lp += profit; lc++; longTotal += profit; longCnt++; }
        else { sp += profit; sc++; shortTotal += profit; shortCnt++; }
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
    symRows.push({ symbol: s.symbol, name: s.name, profit: res.profitAmount, win: res.winCount, loss: res.lossCount, trades: res.tradesCount, longProfit: lp, shortProfit: sp, longCount: lc, shortCount: sc });
  }

  const allTotal = symRows.reduce((s, r) => s + r.profit, 0);
  const allWin = symRows.reduce((s, r) => s + r.win, 0);
  const allLoss = symRows.reduce((s, r) => s + r.loss, 0);

  // ハイブリッド（3銘柄厳選＋デイリーストップ）
  const pf = applyPortfolioRules(perStockToday);

  // ===== 出力 =====
  const outDir = path.join(process.cwd(), "analysis", "daily", targetDay);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "trades.csv"), tradeRows.join("\n"), "utf8");

  symRows.sort((a, b) => b.profit - a.profit);
  const symCsv = ["symbol,name,profit,win,loss,trades,longProfit,shortProfit,longCount,shortCount"];
  for (const r of symRows) symCsv.push([r.symbol, r.name, Math.round(r.profit), r.win, r.loss, r.trades, Math.round(r.longProfit), Math.round(r.shortProfit), r.longCount, r.shortCount].join(","));
  fs.writeFileSync(path.join(outDir, "by_symbol.csv"), symCsv.join("\n"), "utf8");

  // Markdown レポート
  const md: string[] = [];
  md.push(`# 当日損益レポート ${targetDay}`);
  md.push("");
  md.push(`生成時刻: ${new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16)} JST`);
  md.push("");
  md.push("## 1. 当日サマリー");
  md.push("");
  md.push("| 指標 | 値 |");
  md.push("|---|---|");
  md.push(`| 対象銘柄数 | ${candleMap.size}銘柄 |`);
  md.push(`| 市場の値動き（寄り→引け 平均） | ${marketMovePct >= 0 ? "+" : ""}${marketMovePct.toFixed(2)}% |`);
  md.push(`| 市場効率（トレンドの強さ 0〜1） | ${eff.toFixed(2)}${rangeBound ? "（レンジ相場＝取引抑制）" : ""} |`);
  md.push(`| 全銘柄合計損益（参考・上限なし） | ${yen(allTotal)} （勝${allWin}/負${allLoss}） |`);
  md.push(`| **本番採用後損益（同時3銘柄＋デイリーストップ）** | **${yen(pf.acceptedProfit)}** （勝${pf.acceptedWins}/負${pf.acceptedLosses}） |`);
  md.push(`| 枠不足等で見送った損益 | ${yen(pf.skippedProfit)} |`);
  md.push(`| 最大同時保有数 | ${pf.maxConcurrentObserved}銘柄 |`);
  md.push(`| デイリーストップ発動 | ${pf.dailyStopTriggered ? `あり（${pf.dailyStopReason === "loss_limit" ? "損失上限-1.5万円" : "利益保護"}）` : "なし"} |`);
  md.push(`| ロング合計 / ショート合計 | ${yen(longTotal)}（${longCnt}件） / ${yen(shortTotal)}（${shortCnt}件） |`);
  md.push("");

  md.push("## 2. 銘柄別損益（全銘柄ベース）");
  md.push("");
  md.push("| 銘柄 | 損益 | 勝/負 | ロング | ショート |");
  md.push("|---|--:|:--:|--:|--:|");
  for (const r of symRows) {
    if (r.trades === 0) continue;
    md.push(`| ${r.name}(${r.symbol}) | ${yen(r.profit)} | ${r.win}/${r.loss} | ${yen(r.longProfit)} | ${yen(r.shortProfit)} |`);
  }
  const noTrade = symRows.filter(r => r.trades === 0).map(r => `${r.name}`);
  if (noTrade.length) md.push(`\n取引なし: ${noTrade.join(", ")}`);
  md.push("");

  md.push("## 3. 決済理由別（なぜ手仕舞ったか）");
  md.push("");
  md.push("| 理由 | 損益 | 勝/負 | 件数 | 勝率 |");
  md.push("|---|--:|:--:|--:|--:|");
  for (const [r, a] of Array.from(reasonAgg.entries()).sort((x, y) => y[1].profit - x[1].profit)) {
    const wr = a.count > 0 ? (a.win / a.count) * 100 : 0;
    md.push(`| ${r} | ${yen(a.profit)} | ${a.win}/${a.loss} | ${a.count} | ${wr.toFixed(0)}% |`);
  }
  md.push("");

  md.push("## 4. 時間帯別（いつ仕掛けたか）");
  md.push("");
  md.push("| エントリー時間帯 | 損益 | 勝/負 | 件数 | 勝率 |");
  md.push("|---|--:|:--:|--:|--:|");
  for (const [h, a] of Array.from(hourAgg.entries()).sort((x, y) => x[0].localeCompare(y[0]))) {
    const wr = a.count > 0 ? (a.win / a.count) * 100 : 0;
    md.push(`| ${h} | ${yen(a.profit)} | ${a.win}/${a.loss} | ${a.count} | ${wr.toFixed(0)}% |`);
  }
  md.push("");

  const mdText = md.join("\n");
  fs.writeFileSync(path.join(outDir, "REPORT.md"), mdText, "utf8");

  console.log("\n" + mdText);
  console.log(`\n[dailyReport] Written to ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
