/**
 * B2方式 判定タイミング比較: 9:30 vs 9:50
 * 
 * 共通条件:
 *   - 10銘柄限定
 *   - B2方式（前場bullish時のみSHORT mediumブロック、後場は無条件許可）
 *   - SHORT medium解除
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
 * 
 * 比較:
 *   A: 9:30判定（現行実装）
 *   B: 9:50判定
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

function calcRSI(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

const TEN_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];
const DIRECTION_SYMBOLS = TEN_SYMBOLS;

const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const PM_BPR_THRESHOLD = 0.65;

interface Trade {
  date: string;
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  signalReason: string;
  confidence: string;
  beTriggered: boolean;
  session: "am" | "pm";
}

/**
 * 市場方向性判定（主要10銘柄の始値比変化率ベース）
 */
function getMarketDirection(
  candleCache: Map<string, any[]>,
  date: string,
  targetTimeMin: number
): "bullish" | "bearish" | "neutral" {
  let upCount = 0, downCount = 0, totalSymbols = 0;
  const changes: number[] = [];
  for (const symbol of DIRECTION_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length === 0) continue;
    const openPrice = candles[0].close;
    let currentCandle = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const t = candles[i].time as string;
      const h = parseInt(t.split(":")[0]);
      const m = parseInt(t.split(":")[1]);
      const tMin = h * 60 + m;
      if (tMin <= targetTimeMin) { currentCandle = candles[i]; break; }
    }
    if (!currentCandle) continue;
    totalSymbols++;
    const changeRate = (currentCandle.close - openPrice) / openPrice;
    changes.push(changeRate);
    if (changeRate >= 0.005) upCount++;
    else if (changeRate <= -0.005) downCount++;
  }
  if (totalSymbols === 0) return "neutral";
  changes.sort((a, b) => a - b);
  const median = changes[Math.floor(changes.length / 2)];
  if (downCount > 0 && upCount / downCount >= 2.0) return "bullish";
  if (upCount > 0 && downCount / upCount >= 2.0) return "bearish";
  if (median >= 0.005) return "bullish";
  if (median <= -0.005) return "bearish";
  if (totalSymbols > 0 && upCount / totalSymbols >= 0.6) return "bullish";
  if (totalSymbols > 0 && downCount / totalSymbols >= 0.6) return "bearish";
  return "neutral";
}

function runSimulation(
  dates: string[],
  directionKey: string,
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  directionCache: Map<string, string>,
  bprCache: Map<string, number[]>
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    for (const symbol of TEN_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      if (!signals || !candles || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);
      const bprs = bprCache.get(key) || new Array(candles.length).fill(0.5);

      let inLongPosition = false;
      let inShortPosition = false;
      let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };
      let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i].signal;
        const time = candles[i]?.time as string;
        if (!time) continue;

        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;
        const session: "am" | "pm" = timeMin < 11 * 60 + 30 ? "am" : "pm";

        // Process LONG position
        if (inLongPosition) {
          const profitHigh = (highs[i] - longEntry.price) / longEntry.price;
          const profitLow = (lows[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && profitHigh >= BE_TRIGGER) longEntry.beActive = true;
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.floor(2000000 / longEntry.price) * 100;
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
            inLongPosition = false;
          } else {
            const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
            if (profitLow <= slLevel) {
              const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
              inLongPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (closes[i] - longEntry.price) * (lots / 100), exitReason: "TIME",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
              inLongPosition = false;
            }
          }
        }

        // Process SHORT position
        if (inShortPosition) {
          const profitHigh = (shortEntry.price - lows[i]) / shortEntry.price;
          const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
          if (!shortEntry.beActive && profitHigh >= BE_TRIGGER) shortEntry.beActive = true;
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.floor(2000000 / shortEntry.price) * 100;
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
            inShortPosition = false;
          } else {
            const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
            if (lossHigh >= slLevel) {
              const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
              inShortPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
              inShortPosition = false;
            }
          }
        }

        // New entry check
        if (!sig) continue;
        if (timeMin < 9 * 60 + 30 || timeMin >= 15 * 60 + 15) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        // VWAP急落フィルター
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;

        // BUY medium全ブロック（共通）
        if (confidence === "medium" && sig.type === "buy") continue;

        // SHORT medium: B2方式（前場bullish時のみブロック）
        if (confidence === "medium" && sig.type === "sell") {
          if (timeMin < 11 * 60 + 30) {
            const direction = directionCache.get(`${date}_${directionKey}`) || "neutral";
            if (direction === "bullish") continue;
          }
          // 後場は無条件許可
        }

        // 後場全SHORT BPR>=0.65ブロック
        if (sig.type === "sell" && timeMin >= 13 * 60) {
          const bpr = bprs[i];
          if (bpr >= PM_BPR_THRESHOLD) continue;
        }

        // Entry
        if (sig.type === "buy" && !inLongPosition) {
          inLongPosition = true;
          longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
        } else if (sig.type === "sell" && !inShortPosition) {
          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
        }
      }

      // Close remaining positions
      if (inLongPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / longEntry.price) * 100;
        trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
          entryPrice: longEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (closes[lastIdx] - longEntry.price) * (lots / 100), exitReason: "EOD",
          signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: "pm" });
      }
      if (inShortPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / shortEntry.price) * 100;
        trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
          entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), exitReason: "EOD",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: "pm" });
      }
    }
  }
  return trades;
}

function printReport(label: string, trades: Trade[]) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const bes = trades.filter(t => t.pnl === 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = totalLoss !== 0 ? totalWin / Math.abs(totalLoss) : Infinity;
  const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  let maxDD = 0, peak = 0, cumPnl = 0;
  const sortedTrades = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
  for (const t of sortedTrades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  console.log(`\n${"=".repeat(90)}`);
  console.log(`=== ${label} ===`);
  console.log(`${"=".repeat(90)}`);
  console.log(`  取引数: ${trades.length}件 | 勝率: ${winRate.toFixed(1)}% (${wins.length}勝${losses.length}敗${bes.length}引分)`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | PF: ${pf.toFixed(2)} | 最大DD: -${maxDD.toFixed(0)}円`);
  console.log(`  期待値: ${expectancy.toFixed(0)}円/回 | 平均利益: +${avgWin.toFixed(0)}円 | 平均損失: ${avgLoss.toFixed(0)}円`);

  // LONG/SHORT
  const longs = trades.filter(t => t.side === "long");
  const shorts = trades.filter(t => t.side === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longWins = longs.filter(t => t.pnl > 0);
  const shortWins = shorts.filter(t => t.pnl > 0);
  const longPF = longs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) !== 0
    ? longs.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / Math.abs(longs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
    : Infinity;
  const shortPF = shorts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) !== 0
    ? shorts.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / Math.abs(shorts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
    : Infinity;
  console.log(`  LONG: ${longs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF ${longPF.toFixed(2)} | 勝率 ${longs.length > 0 ? (longWins.length / longs.length * 100).toFixed(1) : 0}%`);
  console.log(`  SHORT: ${shorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF ${shortPF.toFixed(2)} | 勝率 ${shorts.length > 0 ? (shortWins.length / shorts.length * 100).toFixed(1) : 0}%`);

  // 前場/後場
  const amTrades = trades.filter(t => t.session === "am");
  const pmTrades = trades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円`);
  console.log(`  後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円`);

  // 日別
  console.log(`  --- 日別損益 ---`);
  const dateMap = new Map<string, number>();
  for (const t of trades) {
    dateMap.set(t.date, (dateMap.get(t.date) || 0) + t.pnl);
  }
  for (const [d, pnl] of Array.from(dateMap.entries()).sort()) {
    console.log(`    ${d}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円`);
  }

  return { count: trades.length, winRate, totalPnl, pf, maxDD, expectancy, longPnl, shortPnl, amPnl, pmPnl };
}

async function main() {
  const db = await getDb();
  const dates = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-22",
                 "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-29", "2026-06-30"];

  console.log("=== B2方式 判定タイミング比較: 9:30 vs 9:50 ===");
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: 10銘柄`);

  // Load candles
  const candleCache = new Map<string, any[]>();
  const signalCache = new Map<string, any[]>();
  const bprCache = new Map<string, number[]>();

  for (const date of dates) {
    const rows = await db.select().from(rtCandles)
      .where(and(
        gte(rtCandles.tradeDate, date),
        lte(rtCandles.tradeDate, date),
        inArray(rtCandles.symbol, TEN_SYMBOLS)
      ));

    const bySymbol = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol)!.push(r);
    }

    for (const [symbol, symbolRows] of Array.from(bySymbol.entries())) {
      symbolRows.sort((a, b) => a.candleTime.localeCompare(b.candleTime));
      const key = `${date}_${symbol}`;
      const closes = symbolRows.map(r => Number(r.close));
      const highs = symbolRows.map(r => Number(r.high));
      const lows = symbolRows.map(r => Number(r.low));
      const volumes = symbolRows.map(r => Number(r.volume));
      const opens = symbolRows.map(r => Number(r.open));
      const vwapCandles = symbolRows.map(r => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low),
        close: Number(r.close), volume: Number(r.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i - j]; return s / 25; });
      const enrichedCandles = symbolRows.map((r: any, i: number) => ({
        time: r.candleTime,
        timestamp: 0,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? closes[i],
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02),
        bbMiddle: null,
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),
        ma5: ma5[i] ?? closes[i],
        ma25: ma25[i] ?? closes[i],
        rsi: rsiArr[i] ?? 50,
        atr: null as any,
      }));
      const signals = detectSignals(enrichedCandles as any);
      signalCache.set(key, signals);
      candleCache.set(key, enrichedCandles);

      // BPR
      const bprs = symbolRows.map(r => {
        const bs = r.boardSnapshot as any;
        return bs?.buyPressureRatio ?? bs?.bpr ?? 0.5;
      });
      bprCache.set(key, bprs);
    }
  }

  // Pre-compute direction for both timings
  // 9:30 = 9*60+30 = 570
  // 9:50 = 9*60+50 = 590
  const directionCache = new Map<string, string>();
  for (const date of dates) {
    const dir930 = getMarketDirection(candleCache, date, 570);
    const dir950 = getMarketDirection(candleCache, date, 590);
    directionCache.set(`${date}_930`, dir930);
    directionCache.set(`${date}_950`, dir950);
  }

  // Print direction comparison
  console.log(`\n--- 方向性判定比較 ---`);
  console.log(`| 日付 | 9:30判定 | 9:50判定 | 変化 |`);
  console.log(`|------|----------|----------|------|`);
  for (const date of dates) {
    const d930 = directionCache.get(`${date}_930`)!;
    const d950 = directionCache.get(`${date}_950`)!;
    const changed = d930 !== d950 ? "★変化" : "";
    console.log(`| ${date} | ${d930} | ${d950} | ${changed} |`);
  }

  // Run both patterns
  const trades930 = runSimulation(dates, "930", signalCache, candleCache, directionCache, bprCache);
  const trades950 = runSimulation(dates, "950", signalCache, candleCache, directionCache, bprCache);

  // Print reports
  const result930 = printReport("A: B2方式 9:30判定（現行）", trades930);
  const result950 = printReport("B: B2方式 9:50判定", trades950);

  // Comparison table
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("=== 最終比較 ===");
  console.log(`${"=".repeat(90)}`);
  console.log(`\n| パターン | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値 |`);
  console.log(`|----------|--------|------|--------|-----|--------|--------|`);
  console.log(`| A:9:30判定 | ${result930.count}件 | ${result930.winRate.toFixed(1)}% | ${result930.totalPnl >= 0 ? "+" : ""}${result930.totalPnl.toFixed(0)}円 | ${result930.pf.toFixed(2)} | -${result930.maxDD.toFixed(0)}円 | ${result930.expectancy.toFixed(0)}円 |`);
  console.log(`| B:9:50判定 | ${result950.count}件 | ${result950.winRate.toFixed(1)}% | ${result950.totalPnl >= 0 ? "+" : ""}${result950.totalPnl.toFixed(0)}円 | ${result950.pf.toFixed(2)} | -${result950.maxDD.toFixed(0)}円 | ${result950.expectancy.toFixed(0)}円 |`);

  console.log(`\n| パターン | LONG損益 | SHORT損益 | 前場損益 | 後場損益 |`);
  console.log(`|----------|----------|----------|----------|----------|`);
  console.log(`| A:9:30判定 | ${result930.longPnl >= 0 ? "+" : ""}${result930.longPnl.toFixed(0)}円 | ${result930.shortPnl >= 0 ? "+" : ""}${result930.shortPnl.toFixed(0)}円 | ${result930.amPnl >= 0 ? "+" : ""}${result930.amPnl.toFixed(0)}円 | ${result930.pmPnl >= 0 ? "+" : ""}${result930.pmPnl.toFixed(0)}円 |`);
  console.log(`| B:9:50判定 | ${result950.longPnl >= 0 ? "+" : ""}${result950.longPnl.toFixed(0)}円 | ${result950.shortPnl >= 0 ? "+" : ""}${result950.shortPnl.toFixed(0)}円 | ${result950.amPnl >= 0 ? "+" : ""}${result950.amPnl.toFixed(0)}円 | ${result950.pmPnl >= 0 ? "+" : ""}${result950.pmPnl.toFixed(0)}円 |`);

  const diff = result950.totalPnl - result930.totalPnl;
  console.log(`\n差分（9:50 - 9:30）: ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}円`);
  console.log(`PF変化: ${(result950.pf - result930.pf).toFixed(3)}`);
  console.log(`最大DD変化: ${(result950.maxDD - result930.maxDD) >= 0 ? "+" : ""}${(result950.maxDD - result930.maxDD).toFixed(0)}円`);

  // 9:30→9:50で判定が変わった日の影響分析
  console.log(`\n--- 判定変化日の影響分析 ---`);
  for (const date of dates) {
    const d930 = directionCache.get(`${date}_930`)!;
    const d950 = directionCache.get(`${date}_950`)!;
    if (d930 !== d950) {
      const dayTrades930 = trades930.filter(t => t.date === date);
      const dayTrades950 = trades950.filter(t => t.date === date);
      const dayPnl930 = dayTrades930.reduce((s, t) => s + t.pnl, 0);
      const dayPnl950 = dayTrades950.reduce((s, t) => s + t.pnl, 0);
      console.log(`  ${date}: ${d930}→${d950} | 9:30版: ${dayPnl930 >= 0 ? "+" : ""}${dayPnl930.toFixed(0)}円(${dayTrades930.length}件) → 9:50版: ${dayPnl950 >= 0 ? "+" : ""}${dayPnl950.toFixed(0)}円(${dayTrades950.length}件) | 差分: ${(dayPnl950 - dayPnl930) >= 0 ? "+" : ""}${(dayPnl950 - dayPnl930).toFixed(0)}円`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
