/**
 * B2方式+10銘柄: 後場全SHORT BPR>=0.65ブロック あり/なし比較
 * 
 * パターン:
 * A: B2 + 後場BPRブロックなし（前回のB2結果と同等だが大台割れのみBPRブロックも外す）
 * B: B2 + 後場大台割れSHORTのみBPR>=0.65ブロック（前回のB2結果）
 * C: B2 + 後場全SHORT BPR>=0.65ブロック（本番コードと同じ）
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";
import * as fs from "fs";

const TARGET_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];
const SYMBOL_NAMES: Record<string, string> = {
  "6920": "レーザーテック", "6857": "アドバンテスト", "5803": "フジクラ",
  "6976": "太陽誘電", "6981": "村田製作所", "6526": "ソシオネクスト",
  "9984": "ソフトバンクG", "7011": "三菱重工業", "8035": "東京エレクトロン", "8316": "三井住友FG"
};

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
  confidence: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  signalReason: string;
  session: "am" | "pm";
  holdingBars: number;
  bprAtEntry: number;
}

type BprMode = "none" | "roundonly" | "allshort";

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

function isRoundLevelBreakdown(reason: string): boolean {
  return reason.includes("大台割れ");
}

function getMarketDirection(
  candleCache: Map<string, any[]>,
  date: string,
  targetTimeMin: number
): "bullish" | "bearish" | "neutral" {
  let upCount = 0, downCount = 0, totalSymbols = 0;
  const changes: number[] = [];
  for (const symbol of TARGET_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length === 0) continue;
    let currentCandle = null;
    const openPrice = candles[0].close;
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
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  directionCache: Map<string, string>,
  bprMode: BprMode
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      if (!signals || !candles || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);

      let inLongPosition = false;
      let inShortPosition = false;
      let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };
      let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, bpr: 0.5 };

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
            trades.push({ date, symbol, side: "long", confidence: longEntry.conf,
              entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: (exitPrice - longEntry.price) * (lots / 100),
              exitReason: "TP", signalReason: longEntry.reason, session,
              holdingBars: i - longEntry.idx, bprAtEntry: 0.5 });
            inLongPosition = false;
          } else {
            const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
            if (profitLow <= slLevel) {
              const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", confidence: longEntry.conf,
                entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100),
                exitReason: longEntry.beActive ? "BE" : "SL", signalReason: longEntry.reason, session,
                holdingBars: i - longEntry.idx, bprAtEntry: 0.5 });
              inLongPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              trades.push({ date, symbol, side: "long", confidence: longEntry.conf,
                entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (closes[i] - longEntry.price) * (lots / 100),
                exitReason: "TIME", signalReason: longEntry.reason, session,
                holdingBars: i - longEntry.idx, bprAtEntry: 0.5 });
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
            trades.push({ date, symbol, side: "short", confidence: shortEntry.conf,
              entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: (shortEntry.price - exitPrice) * (lots / 100),
              exitReason: "TP", signalReason: shortEntry.reason, session,
              holdingBars: i - shortEntry.idx, bprAtEntry: shortEntry.bpr });
            inShortPosition = false;
          } else {
            const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
            if (lossHigh >= slLevel) {
              const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", confidence: shortEntry.conf,
                entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100),
                exitReason: shortEntry.beActive ? "BE" : "SL", signalReason: shortEntry.reason, session,
                holdingBars: i - shortEntry.idx, bprAtEntry: shortEntry.bpr });
              inShortPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              trades.push({ date, symbol, side: "short", confidence: shortEntry.conf,
                entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (shortEntry.price - closes[i]) * (lots / 100),
                exitReason: "TIME", signalReason: shortEntry.reason, session,
                holdingBars: i - shortEntry.idx, bprAtEntry: shortEntry.bpr });
              inShortPosition = false;
            }
          }
        }

        // New entry check
        if (!sig) continue;
        if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        // VWAP急落フィルター
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;
        if (confidence === "medium" && sig.type === "buy") continue;

        // B2 filter: 前場bullish時のSHORT mediumブロック
        if (confidence === "medium" && sig.type === "sell") {
          if (timeMin < 11 * 60 + 30) {
            const direction = directionCache.get(`${date}_930`) || "neutral";
            if (direction === "bullish") continue;
          }
        }

        // 後場BPRフィルター
        const bpr = candles[i].bpr ?? 0.5;
        if (sig.type === "sell" && timeMin >= 13 * 60) {
          if (bprMode === "roundonly" && isRoundLevelBreakdown(sig.reason)) {
            if (bpr >= PM_BPR_THRESHOLD) continue;
          } else if (bprMode === "allshort") {
            if (bpr >= PM_BPR_THRESHOLD) continue;
          }
          // bprMode === "none" → no block
        }

        if (sig.type === "buy" && !inLongPosition) {
          inLongPosition = true;
          longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
        } else if (sig.type === "sell" && !inShortPosition) {
          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false, bpr };
        }
      }

      // Close remaining
      if (inLongPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / longEntry.price) * 100;
        trades.push({ date, symbol, side: "long", confidence: longEntry.conf,
          entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (closes[lastIdx] - longEntry.price) * (lots / 100),
          exitReason: "EOD", signalReason: longEntry.reason, session: "pm",
          holdingBars: lastIdx - longEntry.idx, bprAtEntry: 0.5 });
      }
      if (inShortPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / shortEntry.price) * 100;
        trades.push({ date, symbol, side: "short", confidence: shortEntry.conf,
          entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100),
          exitReason: "EOD", signalReason: shortEntry.reason, session: "pm",
          holdingBars: lastIdx - shortEntry.idx, bprAtEntry: shortEntry.bpr });
      }
    }
  }

  return trades;
}

function analyzeResult(trades: Trade[], label: string): string[] {
  const output: string[] = [];
  const log = (s: string) => output.push(s);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  // Max DD
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const t of trades.sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`))) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  log(`\n┌─────────────────────────────────────────────────────────┐`);
  log(`│ ${label}`);
  log(`├─────────────────────────────────────────────────────────┤`);
  log(`│ 取引数: ${trades.length}件 (勝${wins.length} / 負${losses.length} / 引分${trades.length - wins.length - losses.length})`);
  log(`│ 勝率: ${winRate.toFixed(1)}%`);
  log(`│ 総損益: ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);
  log(`│ PF: ${pf.toFixed(3)}`);
  log(`│ 期待値: ${Math.round(expectancy).toLocaleString()}円/回`);
  log(`│ 最大DD: -${Math.round(maxDD).toLocaleString()}円`);
  log(`│ 平均利益: +${wins.length > 0 ? Math.round(grossProfit / wins.length).toLocaleString() : 0}円`);
  log(`│ 平均損失: -${losses.length > 0 ? Math.round(grossLoss / losses.length).toLocaleString() : 0}円`);
  log(`└─────────────────────────────────────────────────────────┘`);

  // Session x Direction
  log(`\n  セッション×方向:`);
  log(`  カテゴリ     | 件数 | 勝率  | 損益        | PF`);
  log(`  ---------------------------------------------------------------`);
  for (const sess of ["am", "pm"] as const) {
    for (const side of ["long", "short"] as const) {
      const sub = trades.filter(t => t.session === sess && t.side === side);
      if (sub.length === 0) continue;
      const subWins = sub.filter(t => t.pnl > 0);
      const subPnl = sub.reduce((s, t) => s + t.pnl, 0);
      const subGP = subWins.reduce((s, t) => s + t.pnl, 0);
      const subGL = Math.abs(sub.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      const subPF = subGL > 0 ? subGP / subGL : Infinity;
      log(`  ${side.toUpperCase().padEnd(5)}${sess.toUpperCase().padEnd(4)} | ${String(sub.length).padStart(4)}件 | ${(subWins.length / sub.length * 100).toFixed(0).padStart(3)}%  | ${(subPnl >= 0 ? '+' : '') + Math.round(subPnl).toLocaleString().padStart(10)}円 | ${subPF.toFixed(2)}`);
    }
  }

  // Daily breakdown
  log(`\n  日別損益:`);
  log(`  日付       | 件数 | 損益        | 累積`);
  log(`  ---------------------------------------------------------------`);
  const dateMap = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!dateMap.has(t.date)) dateMap.set(t.date, []);
    dateMap.get(t.date)!.push(t);
  }
  let cumTotal = 0;
  for (const [d, dt] of [...dateMap.entries()].sort()) {
    const dayPnl = dt.reduce((s, t) => s + t.pnl, 0);
    cumTotal += dayPnl;
    log(`  ${d} | ${String(dt.length).padStart(4)}件 | ${(dayPnl >= 0 ? '+' : '') + Math.round(dayPnl).toLocaleString().padStart(10)}円 | ${(cumTotal >= 0 ? '+' : '') + Math.round(cumTotal).toLocaleString()}円`);
  }

  // Blocked trades analysis (for allshort mode)
  const pmShorts = trades.filter(t => t.side === "short" && t.session === "pm");
  const highBprTrades = pmShorts.filter(t => t.bprAtEntry >= PM_BPR_THRESHOLD);
  const lowBprTrades = pmShorts.filter(t => t.bprAtEntry < PM_BPR_THRESHOLD);
  
  log(`\n  後場SHORT BPR分布:`);
  log(`  BPR>=0.65: ${highBprTrades.length}件, 損益: ${Math.round(highBprTrades.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}円`);
  log(`  BPR<0.65:  ${lowBprTrades.length}件, 損益: ${Math.round(lowBprTrades.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}円`);

  // Symbol breakdown
  log(`\n  銘柄別損益:`);
  log(`  銘柄          | 件数 | 損益        | PF`);
  log(`  ---------------------------------------------------------------`);
  for (const sym of TARGET_SYMBOLS) {
    const sub = trades.filter(t => t.symbol === sym);
    if (sub.length === 0) continue;
    const subPnl = sub.reduce((s, t) => s + t.pnl, 0);
    const subGP = sub.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const subGL = Math.abs(sub.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const subPF = subGL > 0 ? subGP / subGL : Infinity;
    log(`  ${(sym + ' ' + (SYMBOL_NAMES[sym] || '')).padEnd(16)} | ${String(sub.length).padStart(4)}件 | ${(subPnl >= 0 ? '+' : '') + Math.round(subPnl).toLocaleString().padStart(10)}円 | ${subPF.toFixed(2)}`);
  }

  return output;
}

async function main() {
  const db = await getDb();

  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TARGET_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-06-17"),
      lte(rtCandles.tradeDate, "2026-06-30")
    ));

  const grouped = new Map<string, typeof allCandles>();
  for (const c of allCandles) {
    const key = `${c.tradeDate}_${c.symbol}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  const dates = [...new Set(allCandles.map(c => c.tradeDate))].sort();

  // Pre-compute
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();

  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const candles = grouped.get(key);
      if (!candles || candles.length < 30) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

      const opens = candles.map((c: any) => Number(c.open));
      const highs = candles.map((c: any) => Number(c.high));
      const lows = candles.map((c: any) => Number(c.low));
      const closes = candles.map((c: any) => Number(c.close));
      const volumes = candles.map((c: any) => Number(c.volume));

      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i - j]; return s / 25; });

      const enrichedCandles = candles.map((c: any, i: number) => ({
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? closes[i],
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02),
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),
        ma5: ma5[i] ?? closes[i],
        ma25: ma25[i] ?? closes[i],
        rsi: rsiArr[i] ?? 50,
        atr: null as any,
        time: candles[i].candleTime,
      }));

      const signals = detectSignals(enrichedCandles as any);
      signalCache.set(key, signals);
      candleCache.set(key, candles.map((c: any, i: number) => ({
        ...c,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i], vwap: vwapArr[i] ?? closes[i],
        boardSnapshot: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot) : null,
        bpr: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot)?.buyPressureRatio ?? 0.5 : 0.5,
        time: c.candleTime,
      })));
    }
  }

  // Direction cache
  const directionCache = new Map<string, string>();
  for (const date of dates) {
    directionCache.set(`${date}_930`, getMarketDirection(candleCache, date, 9 * 60 + 30));
  }

  // Run 3 patterns
  console.log("========================================================================================================================");
  console.log("B2方式+10銘柄: 後場SHORT BPR>=0.65ブロック 3パターン比較");
  console.log("検証期間: 2026-06-17 〜 2026-06-30 (10営業日)");
  console.log("========================================================================================================================");

  const tradesA = runSimulation(dates, signalCache, candleCache, directionCache, "none");
  const tradesB = runSimulation(dates, signalCache, candleCache, directionCache, "roundonly");
  const tradesC = runSimulation(dates, signalCache, candleCache, directionCache, "allshort");

  // Summary table
  const calcStats = (trades: Trade[]) => {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
    let peak = 0, maxDD = 0, cumPnl = 0;
    for (const t of [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`))) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }
    return { count: trades.length, winRate: trades.length > 0 ? wins.length / trades.length * 100 : 0,
      totalPnl, pf, maxDD, expectancy: trades.length > 0 ? totalPnl / trades.length : 0 };
  };

  const statsA = calcStats(tradesA);
  const statsB = calcStats(tradesB);
  const statsC = calcStats(tradesC);

  console.log(`\n┌─────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ 総合比較サマリー                                                                │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);
  console.log(`  パターン                    | 取引数 | 勝率  | 総損益      | PF    | 最大DD      | 期待値`);
  console.log(`  --------------------------------------------------------------------------------------------`);
  console.log(`  A: BPRブロックなし           | ${String(statsA.count).padStart(4)}件 | ${statsA.winRate.toFixed(1).padStart(4)}% | ${(statsA.totalPnl >= 0 ? '+' : '') + Math.round(statsA.totalPnl).toLocaleString().padStart(10)}円 | ${statsA.pf.toFixed(3)} | -${Math.round(statsA.maxDD).toLocaleString().padStart(8)}円 | ${Math.round(statsA.expectancy).toLocaleString()}円/回`);
  console.log(`  B: 大台割れSHORTのみブロック  | ${String(statsB.count).padStart(4)}件 | ${statsB.winRate.toFixed(1).padStart(4)}% | ${(statsB.totalPnl >= 0 ? '+' : '') + Math.round(statsB.totalPnl).toLocaleString().padStart(10)}円 | ${statsB.pf.toFixed(3)} | -${Math.round(statsB.maxDD).toLocaleString().padStart(8)}円 | ${Math.round(statsB.expectancy).toLocaleString()}円/回`);
  console.log(`  C: 全SHORTブロック(本番同等)  | ${String(statsC.count).padStart(4)}件 | ${statsC.winRate.toFixed(1).padStart(4)}% | ${(statsC.totalPnl >= 0 ? '+' : '') + Math.round(statsC.totalPnl).toLocaleString().padStart(10)}円 | ${statsC.pf.toFixed(3)} | -${Math.round(statsC.maxDD).toLocaleString().padStart(8)}円 | ${Math.round(statsC.expectancy).toLocaleString()}円/回`);
  console.log(`└─────────────────────────────────────────────────────────────────────────────────┘`);

  // Detailed output for each pattern
  const outputA = analyzeResult(tradesA, "A: BPRブロックなし（後場SHORTフリー）");
  const outputB = analyzeResult(tradesB, "B: 大台割れSHORTのみBPR>=0.65ブロック");
  const outputC = analyzeResult(tradesC, "C: 後場全SHORT BPR>=0.65ブロック（本番同等）");

  for (const line of outputA) console.log(line);
  for (const line of outputB) console.log(line);
  for (const line of outputC) console.log(line);

  // Blocked trades detail for pattern C
  console.log(`\n┌─────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ パターンC ブロックされた取引の分析                                               │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);
  
  // Find trades in A that are not in C (blocked by BPR filter)
  const blockedTrades: Trade[] = [];
  for (const tA of tradesA) {
    if (tA.side !== "short" || tA.session !== "pm") continue;
    if (tA.bprAtEntry < PM_BPR_THRESHOLD) continue;
    // This trade would have been blocked in pattern C
    blockedTrades.push(tA);
  }
  
  const blockedPnl = blockedTrades.reduce((s, t) => s + t.pnl, 0);
  const blockedWins = blockedTrades.filter(t => t.pnl > 0);
  const blockedLosses = blockedTrades.filter(t => t.pnl < 0);
  
  console.log(`  ブロック対象取引数: ${blockedTrades.length}件`);
  console.log(`  ブロックにより回避した損益: ${(blockedPnl >= 0 ? '+' : '') + Math.round(blockedPnl).toLocaleString()}円`);
  console.log(`  内訳: 勝ち${blockedWins.length}件(+${Math.round(blockedWins.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}円) / 負け${blockedLosses.length}件(${Math.round(blockedLosses.reduce((s, t) => s + t.pnl, 0)).toLocaleString()}円) / 引分${blockedTrades.length - blockedWins.length - blockedLosses.length}件`);
  
  if (blockedTrades.length > 0) {
    console.log(`\n  ブロック取引詳細（BPR>=0.65の後場SHORT）:`);
    console.log(`  日付       | 銘柄         | BPR   | エントリー | 損益      | 理由`);
    console.log(`  ---------------------------------------------------------------`);
    for (const t of blockedTrades.sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`))) {
      console.log(`  ${t.date} | ${(t.symbol + ' ' + (SYMBOL_NAMES[t.symbol] || '')).padEnd(14)} | ${t.bprAtEntry.toFixed(3)} | ${t.entryTime} | ${(t.pnl >= 0 ? '+' : '') + Math.round(t.pnl).toLocaleString().padStart(8)}円 | ${t.signalReason.substring(0, 35)}`);
    }
  }

  // BPR threshold sweep
  console.log(`\n┌─────────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ BPR閾値スイープ（後場全SHORT対象）                                              │`);
  console.log(`├─────────────────────────────────────────────────────────────────────────────────┤`);
  console.log(`  閾値   | 取引数 | 総損益      | PF    | 最大DD      | ブロック数`);
  console.log(`  --------------------------------------------------------------------------------------------`);
  
  for (const threshold of [0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
    // Count how many PM shorts would be blocked at this threshold
    const pmShortsA = tradesA.filter(t => t.side === "short" && t.session === "pm");
    const blocked = pmShortsA.filter(t => t.bprAtEntry >= threshold);
    const allowed = tradesA.filter(t => !(t.side === "short" && t.session === "pm" && t.bprAtEntry >= threshold));
    const stats = calcStats(allowed);
    console.log(`  ${threshold.toFixed(2)}  | ${String(stats.count).padStart(4)}件 | ${(stats.totalPnl >= 0 ? '+' : '') + Math.round(stats.totalPnl).toLocaleString().padStart(10)}円 | ${stats.pf.toFixed(3)} | -${Math.round(stats.maxDD).toLocaleString().padStart(8)}円 | ${blocked.length}件`);
  }

  // Save full output
  const fullOutput = [
    "========================================================================================================================",
    "B2方式+10銘柄: 後場SHORT BPR>=0.65ブロック 3パターン比較",
    "検証期間: 2026-06-17 〜 2026-06-30 (10営業日)",
    "========================================================================================================================"
  ].join("\n");
  
  console.log("\n--- 完了 ---");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
