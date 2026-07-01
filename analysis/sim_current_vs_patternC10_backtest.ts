/**
 * 現行 vs パターンC+10銘柄 比較バックテスト
 * 
 * パターンA（現行）:
 *   - 17銘柄（TARGET_STOCKS）
 *   - isBullish（始値比+0.2%以上）→ 全SHORT禁止
 *   - BUY medium → 直接エントリー禁止
 *   - SHORT medium → 直接エントリー禁止
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
 * 
 * パターンB（パターンC+10銘柄）:
 *   - 10銘柄限定
 *   - B2方式（9:30時点でbullish判定→前場SHORT mediumブロック、後場は無条件許可）
 *   - SHORT medium解除（ステートマシン経由以外も許可）
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

// 現行: 17銘柄
const ALL_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316",
                     "9107", "8306", "6758", "7203", "4568", "5016", "285A"];

// パターンC+10: 10銘柄
const TEN_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];

// 方向性判定用（B2方式で使用）
const DIRECTION_SYMBOLS = TEN_SYMBOLS;

const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const PM_BPR_THRESHOLD = 0.65;
const BULLISH_THRESHOLD = 0.002; // 始値比+0.2%

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

type PatternMode = "current" | "patternC10";

function runSimulation(
  dates: string[],
  mode: PatternMode,
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  directionCache: Map<string, string>,
  bprCache: Map<string, number[]>
): Trade[] {
  const trades: Trade[] = [];
  const tradeSymbols = mode === "current" ? ALL_SYMBOLS : TEN_SYMBOLS;

  for (const date of dates) {
    for (const symbol of tradeSymbols) {
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

      // isBullish判定（現行モード用）: 各銘柄の始値比
      const openPrice = closes[0];

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

        // VWAP急落フィルター（共通）
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;

        // ======= MODE-SPECIFIC FILTERS =======
        if (mode === "current") {
          // 現行: BUY medium全ブロック
          if (confidence === "medium" && sig.type === "buy") continue;
          // 現行: SHORT medium全ブロック
          if (confidence === "medium" && sig.type === "sell") continue;
          // 現行: isBullish（始値比+0.2%）→ 全SHORT禁止
          const priceChangeRatio = (closes[i] - openPrice) / openPrice;
          if (sig.type === "sell" && priceChangeRatio >= BULLISH_THRESHOLD) continue;
          // 現行: 後場全SHORT BPR>=0.65ブロック
          if (sig.type === "sell" && timeMin >= 13 * 60) {
            const bpr = bprs[i];
            if (bpr >= PM_BPR_THRESHOLD) continue;
          }
        } else {
          // パターンC+10銘柄: BUY medium全ブロック
          if (confidence === "medium" && sig.type === "buy") continue;
          // パターンC+10: SHORT mediumは解除（B2フィルターのみ）
          if (confidence === "medium" && sig.type === "sell") {
            // B2: 前場のSHORT mediumをbullish時のみブロック
            if (timeMin < 11 * 60 + 30) {
              const direction = directionCache.get(`${date}_930`) || "neutral";
              if (direction === "bullish") continue;
            }
            // 後場は無条件許可
          }
          // パターンC+10: 後場全SHORT BPR>=0.65ブロック
          if (sig.type === "sell" && timeMin >= 13 * 60) {
            const bpr = bprs[i];
            if (bpr >= PM_BPR_THRESHOLD) continue;
          }
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
  const longLoss = longs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const shortLoss = shorts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const longWinPnl = longWins.reduce((s, t) => s + t.pnl, 0);
  const shortWinPnl = shortWins.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n  --- LONG/SHORT別 ---`);
  console.log(`  LONG:  ${longs.length}件 | 勝率${longs.length > 0 ? (longWins.length / longs.length * 100).toFixed(0) : 0}% | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF:${longLoss !== 0 ? (longWinPnl / Math.abs(longLoss)).toFixed(2) : "∞"}`);
  console.log(`  SHORT: ${shorts.length}件 | 勝率${shorts.length > 0 ? (shortWins.length / shorts.length * 100).toFixed(0) : 0}% | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF:${shortLoss !== 0 ? (shortWinPnl / Math.abs(shortLoss)).toFixed(2) : "∞"}`);

  // 前場/後場
  const amTrades = trades.filter(t => t.session === "am");
  const pmTrades = trades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
  const amWins = amTrades.filter(t => t.pnl > 0);
  const pmWins = pmTrades.filter(t => t.pnl > 0);
  const amLossPnl = amTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const pmLossPnl = pmTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const amWinPnl = amWins.reduce((s, t) => s + t.pnl, 0);
  const pmWinPnl = pmWins.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n  --- 前場/後場別 ---`);
  console.log(`  前場: ${amTrades.length}件 | 勝率${amTrades.length > 0 ? (amWins.length / amTrades.length * 100).toFixed(0) : 0}% | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円 | PF:${amLossPnl !== 0 ? (amWinPnl / Math.abs(amLossPnl)).toFixed(2) : "∞"}`);
  console.log(`  後場: ${pmTrades.length}件 | 勝率${pmTrades.length > 0 ? (pmWins.length / pmTrades.length * 100).toFixed(0) : 0}% | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円 | PF:${pmLossPnl !== 0 ? (pmWinPnl / Math.abs(pmLossPnl)).toFixed(2) : "∞"}`);

  // 銘柄別損益
  console.log(`\n  --- 銘柄別損益 ---`);
  const bySymbol = new Map<string, { pnl: number; count: number; wins: number }>();
  for (const t of trades) {
    const s = bySymbol.get(t.symbol) || { pnl: 0, count: 0, wins: 0 };
    s.pnl += t.pnl;
    s.count++;
    if (t.pnl > 0) s.wins++;
    bySymbol.set(t.symbol, s);
  }
  for (const [sym, data] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${data.count}件 | 勝率${(data.wins / data.count * 100).toFixed(0)}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(0)}円`);
  }

  // 日別損益
  console.log(`\n  --- 日別損益 ---`);
  const byDate = new Map<string, number>();
  for (const t of trades) {
    byDate.set(t.date, (byDate.get(t.date) || 0) + t.pnl);
  }
  for (const [date, pnl] of [...byDate.entries()].sort()) {
    console.log(`  ${date}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円`);
  }

  return { totalPnl, pf, maxDD, winRate, expectancy, count: trades.length, longPnl, shortPnl, amPnl, pmPnl };
}

async function main() {
  const db = await getDb();

  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, ALL_SYMBOLS),
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
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`現行対象: ${ALL_SYMBOLS.length}銘柄`);
  console.log(`パターンC+10対象: ${TEN_SYMBOLS.length}銘柄\n`);

  // Pre-compute signals, candle data, and BPR for all symbols
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();
  const bprCache = new Map<string, number[]>();

  for (const date of dates) {
    for (const symbol of ALL_SYMBOLS) {
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
      candleCache.set(key, enrichedCandles);

      // BPR extraction
      const bprs = candles.map((c: any) => {
        const bs = c.boardSnapshot as any;
        return bs?.buyPressureRatio ?? bs?.bpr ?? 0.5;
      });
      bprCache.set(key, bprs);
    }
  }

  // Pre-compute direction for B2 (9:30 = 9*60+30 = 570)
  const directionCache = new Map<string, string>();
  for (const date of dates) {
    const dir = getMarketDirection(candleCache, date, 570);
    directionCache.set(`${date}_930`, dir);
  }

  // Run both patterns
  const currentTrades = runSimulation(dates, "current", signalCache, candleCache, directionCache, bprCache);
  const patternC10Trades = runSimulation(dates, "patternC10", signalCache, candleCache, directionCache, bprCache);

  // Print reports
  const resultA = printReport("A: 現行（17銘柄, medium全ブロック, isBullish SHORT禁止, PM BPR>=0.65ブロック）", currentTrades);
  const resultB = printReport("B: パターンC+10銘柄（10銘柄, B2方式, SHORT medium解除, PM BPR>=0.65ブロック）", patternC10Trades);

  // Comparison table
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("=== 最終比較 ===");
  console.log(`${"=".repeat(90)}`);
  console.log(`\n| パターン | 銘柄数 | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値 |`);
  console.log(`|----------|--------|--------|------|--------|-----|--------|--------|`);
  console.log(`| A:現行 | 17 | ${resultA.count}件 | ${resultA.winRate.toFixed(1)}% | ${resultA.totalPnl >= 0 ? "+" : ""}${resultA.totalPnl.toFixed(0)}円 | ${resultA.pf.toFixed(2)} | -${resultA.maxDD.toFixed(0)}円 | ${resultA.expectancy.toFixed(0)}円 |`);
  console.log(`| B:パターンC+10 | 10 | ${resultB.count}件 | ${resultB.winRate.toFixed(1)}% | ${resultB.totalPnl >= 0 ? "+" : ""}${resultB.totalPnl.toFixed(0)}円 | ${resultB.pf.toFixed(2)} | -${resultB.maxDD.toFixed(0)}円 | ${resultB.expectancy.toFixed(0)}円 |`);
  
  console.log(`\n| パターン | LONG損益 | SHORT損益 | 前場損益 | 後場損益 |`);
  console.log(`|----------|----------|----------|----------|----------|`);
  console.log(`| A:現行 | ${resultA.longPnl >= 0 ? "+" : ""}${resultA.longPnl.toFixed(0)}円 | ${resultA.shortPnl >= 0 ? "+" : ""}${resultA.shortPnl.toFixed(0)}円 | ${resultA.amPnl >= 0 ? "+" : ""}${resultA.amPnl.toFixed(0)}円 | ${resultA.pmPnl >= 0 ? "+" : ""}${resultA.pmPnl.toFixed(0)}円 |`);
  console.log(`| B:パターンC+10 | ${resultB.longPnl >= 0 ? "+" : ""}${resultB.longPnl.toFixed(0)}円 | ${resultB.shortPnl >= 0 ? "+" : ""}${resultB.shortPnl.toFixed(0)}円 | ${resultB.amPnl >= 0 ? "+" : ""}${resultB.amPnl.toFixed(0)}円 | ${resultB.pmPnl >= 0 ? "+" : ""}${resultB.pmPnl.toFixed(0)}円 |`);

  const diff = resultB.totalPnl - resultA.totalPnl;
  console.log(`\n差分（B - A）: ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}円`);
  console.log(`PF改善: ${(resultB.pf - resultA.pf).toFixed(3)}`);
  console.log(`最大DD変化: ${(resultB.maxDD - resultA.maxDD) >= 0 ? "+" : ""}${(resultB.maxDD - resultA.maxDD).toFixed(0)}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
