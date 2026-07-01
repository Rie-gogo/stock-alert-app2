/**
 * B2方式+10銘柄 詳細取引履歴・パフォーマンス分析
 * 
 * 出力:
 * 1. 全取引一覧（CSV形式）
 * 2. 銘柄別詳細統計
 * 3. 時間帯別（30分刻み）統計
 * 4. シグナル種別統計
 * 5. エグジット理由別統計
 * 6. 連勝/連敗分析
 * 7. 累積損益カーブデータ
 * 8. リスク指標（シャープレシオ相当、リカバリーファクター等）
 * 9. 前場/後場×LONG/SHORT マトリクス
 * 10. 日別詳細（取引数、勝率、損益、最大利益、最大損失）
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
const AFTERNOON_BPR_BLOCK = 0.65;

interface Trade {
  id: number;
  date: string;
  symbol: string;
  symbolName: string;
  side: "long" | "short";
  confidence: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  exitReason: string;
  signalReason: string;
  beTriggered: boolean;
  session: "am" | "pm";
  holdingBars: number;
  lots: number;
  maxProfit: number;
  maxLoss: number;
}

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

  // Day classification
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of TARGET_SYMBOLS) {
      const candles = candleCache.get(`${date}_${symbol}`);
      if (!candles || candles.length < 2) continue;
      const openPrice = candles[0].close;
      const closePrice = candles[candles.length - 1].close;
      const change = (closePrice - openPrice) / openPrice;
      if (change > 0.003) upCount++;
      else if (change < -0.003) downCount++;
    }
    if (upCount >= 5) dayClassification.set(date, "up");
    else if (downCount >= 5) dayClassification.set(date, "down");
    else dayClassification.set(date, "range");
  }

  // ====================================================================
  // Run B2 simulation with detailed tracking
  // ====================================================================
  const trades: Trade[] = [];
  let tradeId = 0;

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
      let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, maxProfit: 0, maxLoss: 0 };
      let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, maxProfit: 0, maxLoss: 0 };

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i].signal;
        const time = candles[i]?.time as string;
        if (!time) continue;

        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;
        const session: "am" | "pm" = timeMin < 11 * 60 + 30 ? "am" : "pm";

        // Track max profit/loss for open positions
        if (inLongPosition) {
          const unrealizedHigh = (highs[i] - longEntry.price) / longEntry.price;
          const unrealizedLow = (lows[i] - longEntry.price) / longEntry.price;
          if (unrealizedHigh > longEntry.maxProfit) longEntry.maxProfit = unrealizedHigh;
          if (unrealizedLow < longEntry.maxLoss) longEntry.maxLoss = unrealizedLow;
        }
        if (inShortPosition) {
          const unrealizedHigh = (shortEntry.price - lows[i]) / shortEntry.price;
          const unrealizedLow = -(highs[i] - shortEntry.price) / shortEntry.price;
          if (unrealizedHigh > shortEntry.maxProfit) shortEntry.maxProfit = unrealizedHigh;
          if (unrealizedLow < shortEntry.maxLoss) shortEntry.maxLoss = unrealizedLow;
        }

        // Process LONG position
        if (inLongPosition) {
          const profitHigh = (highs[i] - longEntry.price) / longEntry.price;
          const profitLow = (lows[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && profitHigh >= BE_TRIGGER) longEntry.beActive = true;
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.floor(2000000 / longEntry.price) * 100;
            tradeId++;
            trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "long", confidence: longEntry.conf,
              entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: (exitPrice - longEntry.price) * (lots / 100), pnlPercent: TP_PERCENT * 100,
              exitReason: "TP", signalReason: longEntry.reason, beTriggered: longEntry.beActive, session,
              holdingBars: i - longEntry.idx, lots, maxProfit: longEntry.maxProfit * 100, maxLoss: longEntry.maxLoss * 100 });
            inLongPosition = false;
          } else {
            const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
            if (profitLow <= slLevel) {
              const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              const pnlPct = longEntry.beActive ? 0 : -SL_PERCENT * 100;
              tradeId++;
              trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "long", confidence: longEntry.conf,
                entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), pnlPercent: pnlPct,
                exitReason: longEntry.beActive ? "BE" : "SL", signalReason: longEntry.reason, beTriggered: longEntry.beActive, session,
                holdingBars: i - longEntry.idx, lots, maxProfit: longEntry.maxProfit * 100, maxLoss: longEntry.maxLoss * 100 });
              inLongPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              const pnlPct = (closes[i] - longEntry.price) / longEntry.price * 100;
              tradeId++;
              trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "long", confidence: longEntry.conf,
                entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (closes[i] - longEntry.price) * (lots / 100), pnlPercent: pnlPct,
                exitReason: "TIME", signalReason: longEntry.reason, beTriggered: longEntry.beActive, session,
                holdingBars: i - longEntry.idx, lots, maxProfit: longEntry.maxProfit * 100, maxLoss: longEntry.maxLoss * 100 });
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
            tradeId++;
            trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "short", confidence: shortEntry.conf,
              entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: (shortEntry.price - exitPrice) * (lots / 100), pnlPercent: TP_PERCENT * 100,
              exitReason: "TP", signalReason: shortEntry.reason, beTriggered: shortEntry.beActive, session,
              holdingBars: i - shortEntry.idx, lots, maxProfit: shortEntry.maxProfit * 100, maxLoss: shortEntry.maxLoss * 100 });
            inShortPosition = false;
          } else {
            const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
            if (lossHigh >= slLevel) {
              const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              const pnlPct = shortEntry.beActive ? 0 : -SL_PERCENT * 100;
              tradeId++;
              trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "short", confidence: shortEntry.conf,
                entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), pnlPercent: pnlPct,
                exitReason: shortEntry.beActive ? "BE" : "SL", signalReason: shortEntry.reason, beTriggered: shortEntry.beActive, session,
                holdingBars: i - shortEntry.idx, lots, maxProfit: shortEntry.maxProfit * 100, maxLoss: shortEntry.maxLoss * 100 });
              inShortPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              const pnlPct = (shortEntry.price - closes[i]) / shortEntry.price * 100;
              tradeId++;
              trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "short", confidence: shortEntry.conf,
                entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (shortEntry.price - closes[i]) * (lots / 100), pnlPercent: pnlPct,
                exitReason: "TIME", signalReason: shortEntry.reason, beTriggered: shortEntry.beActive, session,
                holdingBars: i - shortEntry.idx, lots, maxProfit: shortEntry.maxProfit * 100, maxLoss: shortEntry.maxLoss * 100 });
              inShortPosition = false;
            }
          }
        }

        // New entry check
        if (!sig) continue;
        if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        if (sig.type === "sell" && isRoundLevelBreakdown(sig.reason) && timeMin >= 13 * 60) {
          const bpr = candles[i].bpr ?? 0.5;
          if (bpr >= AFTERNOON_BPR_BLOCK) continue;
        }

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;
        if (confidence === "medium" && sig.type === "buy") continue;

        // B2 filter
        if (confidence === "medium" && sig.type === "sell") {
          if (timeMin < 11 * 60 + 30) {
            const direction = directionCache.get(`${date}_930`) || "neutral";
            if (direction === "bullish") continue;
          }
        }

        if (sig.type === "buy" && !inLongPosition) {
          inLongPosition = true;
          longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false, maxProfit: 0, maxLoss: 0 };
        } else if (sig.type === "sell" && !inShortPosition) {
          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false, maxProfit: 0, maxLoss: 0 };
        }
      }

      // Close remaining
      if (inLongPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / longEntry.price) * 100;
        const pnlPct = (closes[lastIdx] - longEntry.price) / longEntry.price * 100;
        tradeId++;
        trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "long", confidence: longEntry.conf,
          entryTime: candles[longEntry.idx].time, entryPrice: longEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (closes[lastIdx] - longEntry.price) * (lots / 100), pnlPercent: pnlPct,
          exitReason: "EOD", signalReason: longEntry.reason, beTriggered: longEntry.beActive, session: "pm",
          holdingBars: lastIdx - longEntry.idx, lots, maxProfit: longEntry.maxProfit * 100, maxLoss: longEntry.maxLoss * 100 });
      }
      if (inShortPosition) {
        const lastIdx = candles.length - 1;
        const lots = Math.floor(2000000 / shortEntry.price) * 100;
        const pnlPct = (shortEntry.price - closes[lastIdx]) / shortEntry.price * 100;
        tradeId++;
        trades.push({ id: tradeId, date, symbol, symbolName: SYMBOL_NAMES[symbol] || symbol, side: "short", confidence: shortEntry.conf,
          entryTime: candles[shortEntry.idx].time, entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
          pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), pnlPercent: pnlPct,
          exitReason: "EOD", signalReason: shortEntry.reason, beTriggered: shortEntry.beActive, session: "pm",
          holdingBars: lastIdx - shortEntry.idx, lots, maxProfit: shortEntry.maxProfit * 100, maxLoss: shortEntry.maxLoss * 100 });
      }
    }
  }

  // Sort trades by date and time
  trades.sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));

  // ====================================================================
  // Output CSV
  // ====================================================================
  const csvHeader = "ID,日付,銘柄コード,銘柄名,方向,信頼度,エントリー時刻,エントリー価格,エグジット時刻,エグジット価格,損益(円),損益(%),エグジット理由,シグナル理由,BE発動,セッション,保有バー数,ロット数,最大含み益(%),最大含み損(%)";
  const csvRows = trades.map(t => 
    `${t.id},${t.date},${t.symbol},${t.symbolName},${t.side},${t.confidence},${t.entryTime},${t.entryPrice.toFixed(1)},${t.exitTime},${t.exitPrice.toFixed(1)},${t.pnl.toFixed(0)},${t.pnlPercent.toFixed(3)},${t.exitReason},${t.signalReason},${t.beTriggered},${t.session},${t.holdingBars},${t.lots},${t.maxProfit.toFixed(3)},${t.maxLoss.toFixed(3)}`
  );
  const csvContent = [csvHeader, ...csvRows].join("\n");
  fs.writeFileSync("/home/ubuntu/stock-alert-app/analysis/b2_10_trades.csv", csvContent);

  // ====================================================================
  // Console output: Comprehensive analysis
  // ====================================================================
  const output: string[] = [];
  const log = (s: string) => { output.push(s); console.log(s); };

  log("=".repeat(120));
  log("B2方式+10銘柄 詳細パフォーマンス分析");
  log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}営業日)`);
  log("=".repeat(120));

  // 1. 総合サマリー
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const breakevens = trades.filter(t => t.pnl === 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = totalLoss !== 0 ? totalWin / Math.abs(totalLoss) : Infinity;
  const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;
  const avgHolding = trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length;

  let maxDD = 0, peak = 0, cumPnl = 0;
  const equityCurve: { trade: number; pnl: number; cumPnl: number; dd: number }[] = [];
  for (let i = 0; i < trades.length; i++) {
    cumPnl += trades[i].pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({ trade: i + 1, pnl: trades[i].pnl, cumPnl, dd });
  }
  const recoveryFactor = maxDD > 0 ? totalPnl / maxDD : Infinity;

  // Daily returns for Sharpe-like ratio
  const dailyPnl = new Map<string, number>();
  for (const t of trades) { dailyPnl.set(t.date, (dailyPnl.get(t.date) || 0) + t.pnl); }
  const dailyReturns = [...dailyPnl.values()];
  const avgDailyReturn = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
  const stdDailyReturn = Math.sqrt(dailyReturns.reduce((s, v) => s + (v - avgDailyReturn) ** 2, 0) / dailyReturns.length);
  const dailySharpe = stdDailyReturn > 0 ? avgDailyReturn / stdDailyReturn : 0;

  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 1. 総合パフォーマンスサマリー                            │");
  log("├─────────────────────────────────────────────────────────┤");
  log(`│ 総取引数:     ${trades.length}件 (勝${wins.length} / 負${losses.length} / 引分${breakevens.length})`);
  log(`│ 勝率:         ${winRate.toFixed(1)}%`);
  log(`│ 総損益:       ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  log(`│ PF:           ${pf.toFixed(3)}`);
  log(`│ 期待値:       ${expectancy.toFixed(0)}円/回`);
  log(`│ 最大DD:       -${maxDD.toFixed(0)}円`);
  log(`│ リカバリーF:  ${recoveryFactor.toFixed(3)}`);
  log(`│ 日次シャープ: ${dailySharpe.toFixed(3)}`);
  log(`│ 平均利益:     +${avgWin.toFixed(0)}円`);
  log(`│ 平均損失:     ${avgLoss.toFixed(0)}円`);
  log(`│ 最大利益:     +${Math.max(...trades.map(t => t.pnl)).toFixed(0)}円`);
  log(`│ 最大損失:     ${Math.min(...trades.map(t => t.pnl)).toFixed(0)}円`);
  log(`│ 平均保有:     ${avgHolding.toFixed(1)}バー`);
  log(`│ 利益/損失比:  ${(avgWin / Math.abs(avgLoss)).toFixed(2)}`);
  log("└─────────────────────────────────────────────────────────┘");

  // 2. LONG/SHORT × 前場/後場 マトリクス
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 2. セッション×方向 マトリクス                            │");
  log("├─────────────────────────────────────────────────────────┤");
  const matrix = [
    { label: "LONG前場", filter: (t: Trade) => t.side === "long" && t.session === "am" },
    { label: "LONG後場", filter: (t: Trade) => t.side === "long" && t.session === "pm" },
    { label: "SHORT前場", filter: (t: Trade) => t.side === "short" && t.session === "am" },
    { label: "SHORT後場", filter: (t: Trade) => t.side === "short" && t.session === "pm" },
  ];
  log("  カテゴリ    | 件数 | 勝率  | 損益        | PF   | 期待値");
  log("  " + "-".repeat(70));
  for (const m of matrix) {
    const mt = trades.filter(m.filter);
    const mWins = mt.filter(t => t.pnl > 0);
    const mWinPnl = mWins.reduce((s, t) => s + t.pnl, 0);
    const mLossPnl = mt.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const mPnl = mt.reduce((s, t) => s + t.pnl, 0);
    const mPf = mLossPnl !== 0 ? mWinPnl / Math.abs(mLossPnl) : Infinity;
    const mExp = mt.length > 0 ? mPnl / mt.length : 0;
    const mWr = mt.length > 0 ? (mWins.length / mt.length * 100) : 0;
    log(`  ${m.label.padEnd(10)} | ${String(mt.length).padStart(4)}件 | ${mWr.toFixed(0).padStart(4)}% | ${(mPnl >= 0 ? "+" : "") + mPnl.toFixed(0).padStart(8)}円 | ${mPf.toFixed(2).padStart(4)} | ${mExp.toFixed(0)}円/回`);
  }

  // 3. 銘柄別詳細
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 3. 銘柄別詳細統計                                        │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  銘柄          | 件数 | 勝率  | 損益        | PF   | 期待値   | 最大利益  | 最大損失");
  log("  " + "-".repeat(100));
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }
  const sortedSymbols = [...bySymbol.entries()].sort((a, b) => {
    const aPnl = a[1].reduce((s, t) => s + t.pnl, 0);
    const bPnl = b[1].reduce((s, t) => s + t.pnl, 0);
    return bPnl - aPnl;
  });
  for (const [sym, st] of sortedSymbols) {
    const sWins = st.filter(t => t.pnl > 0);
    const sWinPnl = sWins.reduce((s, t) => s + t.pnl, 0);
    const sLossPnl = st.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const sPnl = st.reduce((s, t) => s + t.pnl, 0);
    const sPf = sLossPnl !== 0 ? sWinPnl / Math.abs(sLossPnl) : Infinity;
    const sExp = st.length > 0 ? sPnl / st.length : 0;
    const sWr = st.length > 0 ? (sWins.length / st.length * 100) : 0;
    const sMax = Math.max(...st.map(t => t.pnl));
    const sMin = Math.min(...st.map(t => t.pnl));
    const name = `${sym} ${SYMBOL_NAMES[sym] || ""}`;
    log(`  ${name.padEnd(14)} | ${String(st.length).padStart(4)}件 | ${sWr.toFixed(0).padStart(4)}% | ${(sPnl >= 0 ? "+" : "") + sPnl.toFixed(0).padStart(8)}円 | ${sPf.toFixed(2).padStart(4)} | ${sExp.toFixed(0).padStart(6)}円/回 | +${sMax.toFixed(0).padStart(6)}円 | ${sMin.toFixed(0).padStart(7)}円`);
  }

  // 4. 時間帯別（30分刻み）
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 4. エントリー時間帯別統計（30分刻み）                     │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  時間帯      | 件数 | 勝率  | 損益        | PF   | 期待値");
  log("  " + "-".repeat(70));
  const timeSlots = [
    { label: "09:00-09:30", min: 540, max: 570 },
    { label: "09:30-10:00", min: 570, max: 600 },
    { label: "10:00-10:30", min: 600, max: 630 },
    { label: "10:30-11:00", min: 630, max: 660 },
    { label: "11:30-12:00", min: 690, max: 720 },
    { label: "13:00-13:30", min: 780, max: 810 },
    { label: "13:30-14:00", min: 810, max: 840 },
    { label: "14:00-14:30", min: 840, max: 870 },
  ];
  for (const slot of timeSlots) {
    const slotTrades = trades.filter(t => {
      const h = parseInt(t.entryTime.split(":")[0]);
      const m = parseInt(t.entryTime.split(":")[1]);
      const tMin = h * 60 + m;
      return tMin >= slot.min && tMin < slot.max;
    });
    if (slotTrades.length === 0) continue;
    const sWins = slotTrades.filter(t => t.pnl > 0);
    const sWinPnl = sWins.reduce((s, t) => s + t.pnl, 0);
    const sLossPnl = slotTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const sPnl = slotTrades.reduce((s, t) => s + t.pnl, 0);
    const sPf = sLossPnl !== 0 ? sWinPnl / Math.abs(sLossPnl) : Infinity;
    const sExp = slotTrades.length > 0 ? sPnl / slotTrades.length : 0;
    const sWr = slotTrades.length > 0 ? (sWins.length / slotTrades.length * 100) : 0;
    log(`  ${slot.label.padEnd(12)} | ${String(slotTrades.length).padStart(4)}件 | ${sWr.toFixed(0).padStart(4)}% | ${(sPnl >= 0 ? "+" : "") + sPnl.toFixed(0).padStart(8)}円 | ${sPf.toFixed(2).padStart(4)} | ${sExp.toFixed(0)}円/回`);
  }

  // 5. シグナル種別
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 5. シグナル種別統計                                       │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  シグナル理由                    | 件数 | 勝率  | 損益        | PF");
  log("  " + "-".repeat(80));
  const byReason = new Map<string, Trade[]>();
  for (const t of trades) {
    // Simplify reason
    const reason = t.signalReason.split("+")[0].trim();
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(t);
  }
  const sortedReasons = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, rt] of sortedReasons) {
    const rWins = rt.filter(t => t.pnl > 0);
    const rWinPnl = rWins.reduce((s, t) => s + t.pnl, 0);
    const rLossPnl = rt.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const rPnl = rt.reduce((s, t) => s + t.pnl, 0);
    const rPf = rLossPnl !== 0 ? rWinPnl / Math.abs(rLossPnl) : Infinity;
    const rWr = rt.length > 0 ? (rWins.length / rt.length * 100) : 0;
    log(`  ${reason.padEnd(32)} | ${String(rt.length).padStart(4)}件 | ${rWr.toFixed(0).padStart(4)}% | ${(rPnl >= 0 ? "+" : "") + rPnl.toFixed(0).padStart(8)}円 | ${rPf.toFixed(2)}`);
  }

  // 6. エグジット理由別
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 6. エグジット理由別統計                                   │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  理由  | 件数 | 割合  | 損益        | 平均損益");
  log("  " + "-".repeat(60));
  const exitReasons = ["TP", "SL", "BE", "TIME", "EOD"];
  for (const reason of exitReasons) {
    const rt = trades.filter(t => t.exitReason === reason);
    if (rt.length === 0) continue;
    const rPnl = rt.reduce((s, t) => s + t.pnl, 0);
    const rAvg = rPnl / rt.length;
    const pct = (rt.length / trades.length * 100);
    log(`  ${reason.padEnd(6)} | ${String(rt.length).padStart(4)}件 | ${pct.toFixed(0).padStart(4)}% | ${(rPnl >= 0 ? "+" : "") + rPnl.toFixed(0).padStart(8)}円 | ${(rAvg >= 0 ? "+" : "") + rAvg.toFixed(0)}円/回`);
  }

  // 7. 連勝/連敗分析
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 7. 連勝/連敗分析                                         │");
  log("├─────────────────────────────────────────────────────────┤");
  let maxWinStreak = 0, maxLossStreak = 0, curWinStreak = 0, curLossStreak = 0;
  const winStreaks: number[] = [];
  const lossStreaks: number[] = [];
  for (const t of trades) {
    if (t.pnl > 0) {
      curWinStreak++;
      if (curLossStreak > 0) { lossStreaks.push(curLossStreak); curLossStreak = 0; }
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (t.pnl < 0) {
      curLossStreak++;
      if (curWinStreak > 0) { winStreaks.push(curWinStreak); curWinStreak = 0; }
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      if (curWinStreak > 0) winStreaks.push(curWinStreak);
      if (curLossStreak > 0) lossStreaks.push(curLossStreak);
      curWinStreak = 0; curLossStreak = 0;
    }
  }
  if (curWinStreak > 0) winStreaks.push(curWinStreak);
  if (curLossStreak > 0) lossStreaks.push(curLossStreak);
  const avgWinStreak = winStreaks.length > 0 ? winStreaks.reduce((s, v) => s + v, 0) / winStreaks.length : 0;
  const avgLossStreak = lossStreaks.length > 0 ? lossStreaks.reduce((s, v) => s + v, 0) / lossStreaks.length : 0;
  log(`  最大連勝: ${maxWinStreak}回 | 平均連勝: ${avgWinStreak.toFixed(1)}回`);
  log(`  最大連敗: ${maxLossStreak}回 | 平均連敗: ${avgLossStreak.toFixed(1)}回`);

  // 8. 信頼度別
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 8. 信頼度別統計                                           │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  信頼度  | 件数 | 勝率  | 損益        | PF   | 期待値");
  log("  " + "-".repeat(65));
  for (const conf of ["strong", "medium"]) {
    const ct = trades.filter(t => t.confidence === conf);
    if (ct.length === 0) continue;
    const cWins = ct.filter(t => t.pnl > 0);
    const cWinPnl = cWins.reduce((s, t) => s + t.pnl, 0);
    const cLossPnl = ct.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const cPnl = ct.reduce((s, t) => s + t.pnl, 0);
    const cPf = cLossPnl !== 0 ? cWinPnl / Math.abs(cLossPnl) : Infinity;
    const cWr = ct.length > 0 ? (cWins.length / ct.length * 100) : 0;
    const cExp = ct.length > 0 ? cPnl / ct.length : 0;
    log(`  ${conf.padEnd(8)} | ${String(ct.length).padStart(4)}件 | ${cWr.toFixed(0).padStart(4)}% | ${(cPnl >= 0 ? "+" : "") + cPnl.toFixed(0).padStart(8)}円 | ${cPf.toFixed(2).padStart(4)} | ${cExp.toFixed(0)}円/回`);
  }

  // 9. 日別詳細
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 9. 日別詳細統計                                           │");
  log("├─────────────────────────────────────────────────────────┤");
  log("  日付       | 分類 | 9:30判定 | 件数 | 勝率  | 損益        | 最大利益  | 最大損失  | 累積損益");
  log("  " + "-".repeat(110));
  let cumTotal = 0;
  for (const date of dates) {
    const dt = trades.filter(t => t.date === date);
    const dPnl = dt.reduce((s, t) => s + t.pnl, 0);
    cumTotal += dPnl;
    const dWins = dt.filter(t => t.pnl > 0).length;
    const dWr = dt.length > 0 ? (dWins / dt.length * 100) : 0;
    const dMax = dt.length > 0 ? Math.max(...dt.map(t => t.pnl)) : 0;
    const dMin = dt.length > 0 ? Math.min(...dt.map(t => t.pnl)) : 0;
    const cls = dayClassification.get(date) || "?";
    const arrow = cls === "up" ? "上昇" : cls === "down" ? "下落" : "レンジ";
    const dir = directionCache.get(`${date}_930`) || "?";
    log(`  ${date} | ${arrow.padEnd(4)} | ${dir.padEnd(8)} | ${String(dt.length).padStart(4)}件 | ${dWr.toFixed(0).padStart(4)}% | ${(dPnl >= 0 ? "+" : "") + dPnl.toFixed(0).padStart(8)}円 | +${dMax.toFixed(0).padStart(6)}円 | ${dMin.toFixed(0).padStart(7)}円 | ${(cumTotal >= 0 ? "+" : "") + cumTotal.toFixed(0)}円`);
  }

  // 10. 保有時間分布
  log("\n┌─────────────────────────────────────────────────────────┐");
  log("│ 10. 保有バー数分布                                        │");
  log("├─────────────────────────────────────────────────────────┤");
  const holdingBuckets = [
    { label: "1-5バー(5分以内)", min: 1, max: 6 },
    { label: "6-15バー(6-15分)", min: 6, max: 16 },
    { label: "16-30バー(16-30分)", min: 16, max: 31 },
    { label: "31-60バー(31-60分)", min: 31, max: 61 },
    { label: "61+バー(1時間超)", min: 61, max: 9999 },
  ];
  log("  保有時間         | 件数 | 勝率  | 損益        | PF   | 平均損益");
  log("  " + "-".repeat(75));
  for (const bucket of holdingBuckets) {
    const bt = trades.filter(t => t.holdingBars >= bucket.min && t.holdingBars < bucket.max);
    if (bt.length === 0) continue;
    const bWins = bt.filter(t => t.pnl > 0);
    const bWinPnl = bWins.reduce((s, t) => s + t.pnl, 0);
    const bLossPnl = bt.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const bPnl = bt.reduce((s, t) => s + t.pnl, 0);
    const bPf = bLossPnl !== 0 ? bWinPnl / Math.abs(bLossPnl) : Infinity;
    const bWr = bt.length > 0 ? (bWins.length / bt.length * 100) : 0;
    const bAvg = bPnl / bt.length;
    log(`  ${bucket.label.padEnd(18)} | ${String(bt.length).padStart(4)}件 | ${bWr.toFixed(0).padStart(4)}% | ${(bPnl >= 0 ? "+" : "") + bPnl.toFixed(0).padStart(8)}円 | ${bPf.toFixed(2).padStart(4)} | ${(bAvg >= 0 ? "+" : "") + bAvg.toFixed(0)}円/回`);
  }

  // Save equity curve CSV
  const eqCsv = "取引番号,個別損益,累積損益,DD\n" + equityCurve.map(e => `${e.trade},${e.pnl.toFixed(0)},${e.cumPnl.toFixed(0)},${e.dd.toFixed(0)}`).join("\n");
  fs.writeFileSync("/home/ubuntu/stock-alert-app/analysis/b2_10_equity_curve.csv", eqCsv);

  // Save full output
  fs.writeFileSync("/home/ubuntu/stock-alert-app/analysis/b2_10_detailed_analysis.txt", output.join("\n"));

  log("\n--- 出力ファイル ---");
  log("  analysis/b2_10_trades.csv          - 全取引一覧");
  log("  analysis/b2_10_equity_curve.csv    - 累積損益カーブ");
  log("  analysis/b2_10_detailed_analysis.txt - 本分析テキスト");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
