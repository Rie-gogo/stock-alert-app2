/**
 * B2方式 30分ごと地合い再判定 比較バックテスト
 * 
 * 比較パターン:
 *   A: 9:30固定判定（現行） — 前場bullish時のみSHORT mediumブロック
 *   B: 30分ごと再判定（前場のみ） — 9:30, 10:00, 10:30, 11:00で再判定、後場は無条件許可
 *   C: 30分ごと再判定（全時間帯） — 前場+後場も30分ごとに再判定
 * 
 * 共通条件:
 *   - 10銘柄限定
 *   - SHORT medium解除（B2方式で条件付き許可）
 *   - BUY medium全ブロック
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
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

const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const PM_BPR_THRESHOLD = 0.65;

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  beTriggered: boolean; session: "am" | "pm";
}

/**
 * 市場方向性判定
 */
function getMarketDirection(
  candleCache: Map<string, any[]>,
  date: string,
  targetTimeMin: number
): "bullish" | "bearish" | "neutral" {
  let upCount = 0, downCount = 0, totalSymbols = 0;
  const changes: number[] = [];

  for (const symbol of TEN_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length === 0) continue;

    const openPrice = candles[0].close;
    let currentCandle = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const t = candles[i].time as string;
      const [h, m] = t.split(":").map(Number);
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

type PatternMode = "fixed_930" | "rolling_am_only" | "rolling_all";

function runSimulation(
  dates: string[],
  mode: PatternMode,
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
      const bprs = bprCache.get(key) || [];

      let inLongPosition = false, inShortPosition = false;
      let longEntry: any = null, shortEntry: any = null;

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i].signal;
        const time = candles[i].time as string;
        const [h, m] = time.split(":").map(Number);
        const timeMin = h * 60 + m;
        const session: "am" | "pm" = timeMin < 12 * 60 + 30 ? "am" : "pm";

        // Manage existing positions
        if (inLongPosition && longEntry) {
          const gain = (closes[i] - longEntry.price) / longEntry.price;
          const loss = (lows[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && gain >= BE_TRIGGER) longEntry.beActive = true;
          if (gain >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.floor(2000000 / longEntry.price) * 100;
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: candles[longEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false;
          } else {
            const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
            if (loss <= slLevel) {
              const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: candles[longEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
              inLongPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (closes[i] - longEntry.price) * (lots / 100), exitReason: "TIME",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: candles[longEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
              inLongPosition = false;
            }
          }
        }

        if (inShortPosition && shortEntry) {
          const gain = (shortEntry.price - closes[i]) / shortEntry.price;
          const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
          if (!shortEntry.beActive && gain >= BE_TRIGGER) shortEntry.beActive = true;
          if (gain >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.floor(2000000 / shortEntry.price) * 100;
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: candles[shortEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false;
          } else {
            const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
            if (lossHigh >= slLevel) {
              const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: candles[shortEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
              inShortPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: candles[shortEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
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

        // SHORT medium: 方向性判定に基づくブロック
        if (confidence === "medium" && sig.type === "sell") {
          if (mode === "fixed_930") {
            // 前場bullish時のみブロック
            if (timeMin < 11 * 60 + 30) {
              const direction = directionCache.get(`${date}_570`) || "neutral";
              if (direction === "bullish") continue;
            }
            // 後場は無条件許可
          } else if (mode === "rolling_am_only") {
            // 前場: 30分ごとに再判定（最寄りの判定時点を使用）
            if (timeMin < 11 * 60 + 30) {
              // 30分刻みで最寄りの判定時点を取得
              const checkPoint = Math.floor(timeMin / 30) * 30;
              const direction = directionCache.get(`${date}_${checkPoint}`) || "neutral";
              if (direction === "bullish") continue;
            }
            // 後場は無条件許可
          } else if (mode === "rolling_all") {
            // 全時間帯: 30分ごとに再判定
            const checkPoint = Math.floor(timeMin / 30) * 30;
            const direction = directionCache.get(`${date}_${checkPoint}`) || "neutral";
            if (direction === "bullish") continue;
          }
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

      // Close remaining positions at end of day
      if (inLongPosition && longEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.floor(2000000 / longEntry.price) * 100;
        trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
          entryPrice: longEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: (lastClose - longEntry.price) * (lots / 100), exitReason: "EOD",
          signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: candles[longEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
      }
      if (inShortPosition && shortEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.floor(2000000 / shortEntry.price) * 100;
        trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
          entryPrice: shortEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: (shortEntry.price - lastClose) * (lots / 100), exitReason: "EOD",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: candles[shortEntry.idx].time.split(":").map(Number)[0] * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
      }
    }
  }
  return trades;
}

function printReport(title: string, trades: Trade[]) {
  console.log(`\n${"=".repeat(90)}`);
  console.log(`=== ${title} ===`);
  console.log(`${"=".repeat(90)}`);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const bes = trades.filter(t => t.pnl === 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  // Max DD
  let peak = 0, maxDD = 0, cum = 0;
  const dailyPnl = new Map<string, number>();
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    dailyPnl.set(t.date, (dailyPnl.get(t.date) || 0) + t.pnl);
  }

  const longTrades = trades.filter(t => t.side === "long");
  const shortTrades = trades.filter(t => t.side === "short");
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const longWins = longTrades.filter(t => t.pnl > 0);
  const shortWins = shortTrades.filter(t => t.pnl > 0);
  const longGP = longWins.reduce((s, t) => s + t.pnl, 0);
  const longGL = Math.abs(longTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const shortGP = shortWins.reduce((s, t) => s + t.pnl, 0);
  const shortGL = Math.abs(shortTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const longPF = longGL > 0 ? longGP / longGL : Infinity;
  const shortPF = shortGL > 0 ? shortGP / shortGL : Infinity;
  const longWR = longTrades.length > 0 ? (longWins.length / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100) : 0;

  const amTrades = trades.filter(t => t.session === "am");
  const pmTrades = trades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);

  console.log(`  取引数: ${trades.length}件 | 勝率: ${winRate.toFixed(1)}% (${wins.length}勝${losses.length}敗${bes.length}引分)`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | PF: ${pf.toFixed(2)} | 最大DD: ${maxDD.toFixed(0)}円`);
  console.log(`  期待値: ${expectancy.toFixed(0)}円/回 | 平均利益: +${avgWin.toFixed(0)}円 | 平均損失: -${avgLoss.toFixed(0)}円`);
  console.log(`  LONG: ${longTrades.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF ${longPF.toFixed(2)} | 勝率 ${longWR.toFixed(1)}%`);
  console.log(`  SHORT: ${shortTrades.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF ${shortPF.toFixed(2)} | 勝率 ${shortWR.toFixed(1)}%`);
  console.log(`  前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円`);
  console.log(`  後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円`);
  console.log(`  --- 日別損益 ---`);
  const dates2 = [...new Set(trades.map(t => t.date))].sort();
  for (const d of dates2) {
    const dp = dailyPnl.get(d) || 0;
    console.log(`    ${d}: ${dp >= 0 ? "+" : ""}${dp.toFixed(0)}円`);
  }

  return { count: trades.length, winRate, totalPnl, pf, maxDD, expectancy, longPnl, shortPnl, amPnl, pmPnl };
}

async function main() {
  const db = await getDb();
  const dates = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-22",
                 "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-29", "2026-06-30"];

  console.log("=== B2方式 30分ごと地合い再判定 比較バックテスト ===");
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: 10銘柄\n`);

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

  // Pre-compute direction at every 30-min interval
  const directionCache = new Map<string, string>();
  for (const date of dates) {
    // 9:00(540) to 15:00(900) in 30-min steps
    for (let tMin = 540; tMin <= 900; tMin += 30) {
      directionCache.set(`${date}_${tMin}`, getMarketDirection(candleCache, date, tMin));
    }
  }

  // Print direction transitions
  console.log("--- 30分ごと方向性判定推移 ---");
  console.log("| 日付 | 9:30 | 10:00 | 10:30 | 11:00 | 13:00 | 13:30 | 14:00 | 14:30 | 15:00 |");
  console.log("|------|------|-------|-------|-------|-------|-------|-------|-------|-------|");
  for (const date of dates) {
    const times = [570, 600, 630, 660, 780, 810, 840, 870, 900];
    const dirs = times.map(t => {
      const d = directionCache.get(`${date}_${t}`) || "neutral";
      return d === "bullish" ? "↑bull" : d === "bearish" ? "↓bear" : "→neut";
    });
    console.log(`| ${date} | ${dirs.join(" | ")} |`);
  }
  console.log();

  // Run 3 patterns
  const tradesA = runSimulation(dates, "fixed_930", signalCache, candleCache, directionCache, bprCache);
  const tradesB = runSimulation(dates, "rolling_am_only", signalCache, candleCache, directionCache, bprCache);
  const tradesC = runSimulation(dates, "rolling_all", signalCache, candleCache, directionCache, bprCache);

  // Print reports
  const resultA = printReport("A: 9:30固定判定（現行）", tradesA);
  const resultB = printReport("B: 30分ごと再判定（前場のみ）", tradesB);
  const resultC = printReport("C: 30分ごと再判定（全時間帯）", tradesC);

  // Comparison table
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("=== 最終比較 ===");
  console.log(`${"=".repeat(90)}`);
  console.log(`\n| パターン | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値 |`);
  console.log(`|----------|--------|------|--------|-----|--------|--------|`);
  const results = [
    { name: "A:9:30固定", ...resultA },
    { name: "B:30分(前場)", ...resultB },
    { name: "C:30分(全)", ...resultC },
  ];
  for (const r of results) {
    console.log(`| ${r.name} | ${r.count}件 | ${r.winRate.toFixed(1)}% | ${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(0)}円 | ${r.pf.toFixed(2)} | ${r.maxDD.toFixed(0)}円 | ${r.expectancy.toFixed(0)}円 |`);
  }

  console.log(`\n| パターン | LONG損益 | SHORT損益 | 前場損益 | 後場損益 |`);
  console.log(`|----------|----------|----------|----------|----------|`);
  for (const r of results) {
    console.log(`| ${r.name} | ${r.longPnl >= 0 ? "+" : ""}${r.longPnl.toFixed(0)}円 | ${r.shortPnl >= 0 ? "+" : ""}${r.shortPnl.toFixed(0)}円 | ${r.amPnl >= 0 ? "+" : ""}${r.amPnl.toFixed(0)}円 | ${r.pmPnl >= 0 ? "+" : ""}${r.pmPnl.toFixed(0)}円 |`);
  }

  // Difference analysis
  console.log(`\n--- 差分分析 ---`);
  console.log(`B vs A (30分前場 vs 固定): ${(resultB.totalPnl - resultA.totalPnl) >= 0 ? "+" : ""}${(resultB.totalPnl - resultA.totalPnl).toFixed(0)}円`);
  console.log(`C vs A (30分全 vs 固定): ${(resultC.totalPnl - resultA.totalPnl) >= 0 ? "+" : ""}${(resultC.totalPnl - resultA.totalPnl).toFixed(0)}円`);
  console.log(`PF変化: A=${resultA.pf.toFixed(3)}, B=${resultB.pf.toFixed(3)}, C=${resultC.pf.toFixed(3)}`);
  console.log(`最大DD変化: A=${resultA.maxDD.toFixed(0)}, B=${resultB.maxDD.toFixed(0)}, C=${resultC.maxDD.toFixed(0)}`);

  // Per-day comparison for days where direction changed
  console.log(`\n--- 判定変化日の影響 ---`);
  for (const date of dates) {
    const d930 = directionCache.get(`${date}_570`) || "neutral";
    const d1000 = directionCache.get(`${date}_600`) || "neutral";
    const d1030 = directionCache.get(`${date}_630`) || "neutral";
    const d1100 = directionCache.get(`${date}_660`) || "neutral";
    if (d930 !== d1000 || d1000 !== d1030 || d1030 !== d1100) {
      const dayA = tradesA.filter(t => t.date === date).reduce((s, t) => s + t.pnl, 0);
      const dayB = tradesB.filter(t => t.date === date).reduce((s, t) => s + t.pnl, 0);
      const dayC = tradesC.filter(t => t.date === date).reduce((s, t) => s + t.pnl, 0);
      const countA = tradesA.filter(t => t.date === date).length;
      const countB = tradesB.filter(t => t.date === date).length;
      const countC = tradesC.filter(t => t.date === date).length;
      console.log(`  ${date}: ${d930}→${d1000}→${d1030}→${d1100}`);
      console.log(`    A: ${dayA >= 0 ? "+" : ""}${dayA.toFixed(0)}円(${countA}件) | B: ${dayB >= 0 ? "+" : ""}${dayB.toFixed(0)}円(${countB}件) | C: ${dayC >= 0 ? "+" : ""}${dayC.toFixed(0)}円(${countC}件)`);
    }
  }

  process.exit(0);
}

main();
