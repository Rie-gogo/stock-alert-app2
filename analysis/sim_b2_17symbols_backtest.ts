/**
 * B2方式（前場のみブロック）17銘柄拡大検証バックテスト
 * 
 * 方向性判定: 主要10銘柄で判定（判定と取引対象を分離）
 * 取引対象: 17銘柄（10日間データがある全銘柄）
 * 
 * 比較パターン:
 * B0: ベースライン（SHORT medium全解除、フィルターなし）
 * B2: 前場のみブロック方式（9:30判定、前場のみ適用、後場は無条件許可）
 * 
 * 追加比較:
 * B0-10: 10銘柄のみ（前回結果との整合性確認）
 * B2-10: 10銘柄のみ
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

// 方向性判定用（主要10銘柄）
const DIRECTION_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];

// 取引対象（17銘柄: 10日間データがある全銘柄）
const TRADE_SYMBOLS_17 = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316",
                          "9107", "8306", "6758", "7203", "4568", "5016", "285A"];

const TRADE_SYMBOLS_10 = DIRECTION_SYMBOLS;

const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const AFTERNOON_BPR_BLOCK = 0.65;
const BOARD_SCORE_THRESHOLD = 1;

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

function isRoundLevelBreakdown(reason: string): boolean {
  return reason.includes("大台割れ");
}

function calcBoardScoreSimple(boardSnapshot: any, side: "long" | "short"): number {
  if (!boardSnapshot) return 1;
  let score = 0;
  const bpr = boardSnapshot.buyPressureRatio ?? boardSnapshot.bpr ?? 0.5;
  if ((boardSnapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") {
    if (boardSnapshot.largeSellWall) score += 1;
    if (boardSnapshot.largeBuyWall) score -= 1;
  } else {
    if (boardSnapshot.largeBuyWall) score += 1;
    if (boardSnapshot.largeSellWall) score -= 1;
  }
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  return score;
}

/**
 * 市場方向性判定（主要10銘柄の始値比変化率ベース）
 */
function getMarketDirection(
  candleCache: Map<string, any[]>,
  date: string,
  targetTimeMin: number
): "bullish" | "bearish" | "neutral" {
  let upCount = 0;
  let downCount = 0;
  let totalSymbols = 0;
  const changes: number[] = [];

  for (const symbol of DIRECTION_SYMBOLS) {
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
      if (tMin <= targetTimeMin) {
        currentCandle = candles[i];
        break;
      }
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
  tradeSymbols: string[],
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  directionCache: Map<string, string>,
  applyB2Filter: boolean
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    for (const symbol of tradeSymbols) {
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
        if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        // VWAP急落フィルター
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        // 後場大台割れSHORT BPR>=0.65ブロック
        if (sig.type === "sell" && isRoundLevelBreakdown(sig.reason) && timeMin >= 13 * 60) {
          const bpr = candles[i].bpr ?? 0.5;
          if (bpr >= AFTERNOON_BPR_BLOCK) continue;
        }

        const confidence = sig.confidence || "strong";

        // 全パターン共通: weakはブロック、BUY mediumはブロック
        if (confidence === "weak") continue;
        if (confidence === "medium" && sig.type === "buy") continue;

        // B2フィルター: 前場のSHORT mediumをbullish時ブロック
        if (applyB2Filter && confidence === "medium" && sig.type === "sell") {
          if (timeMin < 11 * 60 + 30) { // 前場
            const direction = directionCache.get(`${date}_930`) || "neutral";
            if (direction === "bullish") {
              continue; // ブロック
            }
          }
          // 後場は無条件許可
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
          pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), exitReason: "TIME",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: "pm" });
      }
    }
  }
  return trades;
}

function printReport(label: string, trades: Trade[], dayClassification: Map<string, string>) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
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
  console.log(`  取引数: ${trades.length}件 | 勝率: ${winRate.toFixed(1)}% | 総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  PF: ${pf.toFixed(2)} | 期待値: ${expectancy.toFixed(0)}円/回 | 最大DD: -${maxDD.toFixed(0)}円`);
  console.log(`  平均利益: +${avgWin.toFixed(0)}円 | 平均損失: ${avgLoss.toFixed(0)}円`);

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

  // 市場環境別
  console.log(`\n  --- 市場環境別 ---`);
  for (const cls of ["up", "down", "range"] as const) {
    const label2 = cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日";
    const clsDates = [...dayClassification.entries()].filter(([_, c]) => c === cls).map(([d]) => d);
    const clsTrades = trades.filter(t => clsDates.includes(t.date));
    const clsPnl = clsTrades.reduce((s, t) => s + t.pnl, 0);
    const clsWins = clsTrades.filter(t => t.pnl > 0).length;
    const clsLossPnl = clsTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const clsWinPnl = clsTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${label2}(${clsDates.length}日): ${clsTrades.length}件 | 勝率${clsTrades.length > 0 ? (clsWins / clsTrades.length * 100).toFixed(0) : 0}% | ${clsPnl >= 0 ? "+" : ""}${clsPnl.toFixed(0)}円 | PF:${clsLossPnl !== 0 ? (clsWinPnl / Math.abs(clsLossPnl)).toFixed(2) : "∞"}`);
  }

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
  const sortedSymbols = [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, data] of sortedSymbols) {
    console.log(`  ${sym}: ${data.count}件 | 勝率${(data.wins / data.count * 100).toFixed(0)}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(0)}円`);
  }

  // 日別損益
  console.log(`\n  --- 日別損益 ---`);
  const byDate = new Map<string, number>();
  for (const t of trades) {
    byDate.set(t.date, (byDate.get(t.date) || 0) + t.pnl);
  }
  for (const [date, pnl] of [...byDate.entries()].sort()) {
    const cls = dayClassification.get(date) || "?";
    const arrow = cls === "up" ? "↑" : cls === "down" ? "↓" : "→";
    console.log(`  ${date} ${arrow}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円`);
  }

  // 反転耐性
  const upDates = [...dayClassification.entries()].filter(([_, c]) => c === "up").map(([d]) => d);
  const downDates = [...dayClassification.entries()].filter(([_, c]) => c === "down").map(([d]) => d);
  const upPnl = trades.filter(t => upDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
  const downPnl = trades.filter(t => downDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
  const ratio = downPnl > 0 ? Math.abs(upPnl) / downPnl : Infinity;
  console.log(`\n  --- 反転耐性 ---`);
  console.log(`  上昇日損益: ${upPnl >= 0 ? "+" : ""}${upPnl.toFixed(0)}円 | 下落日損益: ${downPnl >= 0 ? "+" : ""}${downPnl.toFixed(0)}円`);
  console.log(`  反転比率: ${ratio.toFixed(3)} (低いほど良い)`);

  return { totalPnl, pf, maxDD, winRate, expectancy, count: trades.length, upPnl, downPnl, ratio };
}

async function main() {
  const db = await getDb();

  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TRADE_SYMBOLS_17),
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
  console.log(`方向性判定銘柄: ${DIRECTION_SYMBOLS.join(", ")} (${DIRECTION_SYMBOLS.length}銘柄)`);
  console.log(`取引対象銘柄(17): ${TRADE_SYMBOLS_17.join(", ")}`);
  console.log(`取引対象銘柄(10): ${TRADE_SYMBOLS_10.join(", ")}\n`);

  // Pre-compute signals and candle data for ALL 17 symbols
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();

  for (const date of dates) {
    for (const symbol of TRADE_SYMBOLS_17) {
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

  // Classify market days
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of DIRECTION_SYMBOLS) {
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

  // Pre-compute direction at 9:30
  const directionCache = new Map<string, string>();
  for (const date of dates) {
    directionCache.set(`${date}_930`, getMarketDirection(candleCache, date, 9 * 60 + 30));
  }

  console.log("日別市場分類 & 9:30方向性判定:");
  for (const date of dates) {
    const cls = dayClassification.get(date) || "?";
    const dir = directionCache.get(`${date}_930`) || "?";
    const arrow = cls === "up" ? "↑" : cls === "down" ? "↓" : "→";
    console.log(`  ${date} ${arrow}: 9:30=${dir}`);
  }
  console.log();

  // ====================================================================
  // Run 4 simulations
  // ====================================================================
  console.log("\n" + "=".repeat(110));
  console.log("=== B2方式 17銘柄拡大検証 ===");
  console.log("=".repeat(110));

  const results: any[] = [];

  // B0-17: ベースライン 17銘柄
  const r1 = printReport("B0-17: ベースライン（SHORT medium全解除）17銘柄", 
    runSimulation(dates, TRADE_SYMBOLS_17, signalCache, candleCache, directionCache, false),
    dayClassification);
  results.push({ label: "B0-17", ...r1 });

  // B2-17: 前場のみブロック 17銘柄
  const r2 = printReport("B2-17: 前場のみブロック方式 17銘柄", 
    runSimulation(dates, TRADE_SYMBOLS_17, signalCache, candleCache, directionCache, true),
    dayClassification);
  results.push({ label: "B2-17", ...r2 });

  // B0-10: ベースライン 10銘柄（前回結果との整合性確認）
  const r3 = printReport("B0-10: ベースライン（SHORT medium全解除）10銘柄", 
    runSimulation(dates, TRADE_SYMBOLS_10, signalCache, candleCache, directionCache, false),
    dayClassification);
  results.push({ label: "B0-10", ...r3 });

  // B2-10: 前場のみブロック 10銘柄
  const r4 = printReport("B2-10: 前場のみブロック方式 10銘柄", 
    runSimulation(dates, TRADE_SYMBOLS_10, signalCache, candleCache, directionCache, true),
    dayClassification);
  results.push({ label: "B2-10", ...r4 });

  // ====================================================================
  // 最終比較
  // ====================================================================
  console.log(`\n\n${"=".repeat(110)}`);
  console.log("=== 最終比較サマリー ===");
  console.log("=".repeat(110));
  console.log("\nパターン | 銘柄数 | 取引数 | 勝率 | 総損益 | PF | 期待値 | 最大DD | 反転比率");
  console.log("-".repeat(110));
  for (const r of results) {
    const symbols = r.label.includes("17") ? "17" : "10";
    console.log(`${r.label} | ${symbols}銘柄 | ${r.count}件 | ${r.winRate.toFixed(0)}% | ${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(0)}円 | ${r.pf.toFixed(2)} | ${r.expectancy.toFixed(0)}円/回 | -${r.maxDD.toFixed(0)}円 | ${r.ratio.toFixed(3)}`);
  }

  // B2の改善効果
  console.log(`\n--- B2方式の改善効果 ---`);
  console.log(`  17銘柄: B0→B2で PF ${(results[0] as any).pf.toFixed(2)}→${(results[1] as any).pf.toFixed(2)} | 損益 ${(results[0] as any).totalPnl >= 0 ? "+" : ""}${(results[0] as any).totalPnl.toFixed(0)}→${(results[1] as any).totalPnl >= 0 ? "+" : ""}${(results[1] as any).totalPnl.toFixed(0)}円 | 反転比 ${(results[0] as any).ratio.toFixed(3)}→${(results[1] as any).ratio.toFixed(3)}`);
  console.log(`  10銘柄: B0→B2で PF ${(results[2] as any).pf.toFixed(2)}→${(results[3] as any).pf.toFixed(2)} | 損益 ${(results[2] as any).totalPnl >= 0 ? "+" : ""}${(results[2] as any).totalPnl.toFixed(0)}→${(results[3] as any).totalPnl >= 0 ? "+" : ""}${(results[3] as any).totalPnl.toFixed(0)}円 | 反転比 ${(results[2] as any).ratio.toFixed(3)}→${(results[3] as any).ratio.toFixed(3)}`);

  // 追加7銘柄の寄与
  const trades17 = runSimulation(dates, TRADE_SYMBOLS_17, signalCache, candleCache, directionCache, true);
  const extra7Symbols = TRADE_SYMBOLS_17.filter(s => !TRADE_SYMBOLS_10.includes(s));
  const extra7Trades = trades17.filter(t => extra7Symbols.includes(t.symbol));
  const extra7Pnl = extra7Trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n--- 追加7銘柄の寄与（B2方式） ---`);
  console.log(`  追加銘柄: ${extra7Symbols.join(", ")}`);
  console.log(`  取引数: ${extra7Trades.length}件 | 損益: ${extra7Pnl >= 0 ? "+" : ""}${extra7Pnl.toFixed(0)}円`);
  
  const byExtraSymbol = new Map<string, { pnl: number; count: number; wins: number }>();
  for (const t of extra7Trades) {
    const s = byExtraSymbol.get(t.symbol) || { pnl: 0, count: 0, wins: 0 };
    s.pnl += t.pnl;
    s.count++;
    if (t.pnl > 0) s.wins++;
    byExtraSymbol.set(t.symbol, s);
  }
  for (const [sym, data] of [...byExtraSymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${data.count}件 | 勝率${(data.wins / data.count * 100).toFixed(0)}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(0)}円`);
  }

  // 最終判定
  console.log(`\n${"=".repeat(110)}`);
  console.log("=== 最終判定 ===");
  console.log("=".repeat(110));
  const best17 = results[1]; // B2-17
  const best10 = results[3]; // B2-10
  console.log(`\n  B2-17: PF=${best17.pf.toFixed(2)} | DD=-${best17.maxDD.toFixed(0)}円 | 損益=${best17.totalPnl >= 0 ? "+" : ""}${best17.totalPnl.toFixed(0)}円 | 反転比=${best17.ratio.toFixed(3)}`);
  console.log(`  B2-10: PF=${best10.pf.toFixed(2)} | DD=-${best10.maxDD.toFixed(0)}円 | 損益=${best10.totalPnl >= 0 ? "+" : ""}${best10.totalPnl.toFixed(0)}円 | 反転比=${best10.ratio.toFixed(3)}`);
  
  if (best17.pf >= best10.pf && best17.totalPnl >= best10.totalPnl) {
    console.log(`\n  → 17銘柄の方が優位。取引対象を17銘柄に拡大すべき。`);
  } else if (best17.pf < best10.pf) {
    console.log(`\n  → 10銘柄の方がPFが高い。追加7銘柄が質を下げている可能性。`);
  } else {
    console.log(`\n  → 結果は混在。個別銘柄の寄与を確認して判断。`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
