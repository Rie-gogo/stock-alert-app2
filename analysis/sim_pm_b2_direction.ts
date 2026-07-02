/**
 * sim_pm_b2_direction.ts
 * 
 * 後場B2方式（PM_B2_DIRECTION）シミュレーション
 * 
 * 現行エンジンでは後場のSHORT mediumは無条件許可だが、
 * 後場にも地合い判断を適用した場合の損益を比較する。
 * 
 * 比較パターン:
 *   A: 現行（後場SHORT medium無条件許可）
 *   B: PM_B2 bullish時ブロック（後場bullishの日のみSHORT mediumブロック）
 *   C: PM_B2 bullish+neutral時ブロック（後場bearishの日のみSHORT medium許可）
 *   D: PM_B2 全方向ブロック（後場SHORT medium全ブロック）
 * 
 * 後場地合い判定:
 *   12:30時点の全銘柄の「始値→12:30終値」変動率平均で判定
 *   avgChange >= +0.2% → bullish
 *   avgChange <= -0.2% → bearish
 *   それ以外 → neutral
 * 
 * 共通条件:
 *   - 10銘柄限定
 *   - 前場: 現行B2方式（9:30固定判定、bullish時SHORT mediumブロック）
 *   - BUY medium全ブロック
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_pm_b2_direction.ts
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
const B2_THRESHOLD = 0.2; // ±0.2%

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  beTriggered: boolean; session: "am" | "pm";
}

/**
 * 前場B2方式: 9:30時点の市場方向性判定（現行と同一ロジック）
 * 全銘柄の始値→9:30終値の変動率平均で判定
 */
function getAMDirection(
  candleCache: Map<string, any[]>,
  date: string
): "bullish" | "bearish" | "neutral" {
  let totalChange = 0;
  let count = 0;

  for (const symbol of TEN_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length < 2) continue;

    const firstOpen = candles[0].open;
    // 9:30時点の足を探す
    let latestClose = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
      const [h, m] = (candles[i].time as string).split(":").map(Number);
      const tMin = h * 60 + m;
      if (tMin <= 9 * 60 + 30) {
        latestClose = candles[i].close;
      } else break;
    }
    const changeRate = (latestClose - firstOpen) / firstOpen * 100;
    totalChange += changeRate;
    count++;
  }

  if (count < 3) return "neutral";
  const avg = totalChange / count;
  if (avg >= B2_THRESHOLD) return "bullish";
  if (avg <= -B2_THRESHOLD) return "bearish";
  return "neutral";
}

/**
 * 後場B2方式: 13:30時点の市場方向性判定
 * 全銘柄の始値→13:30終値の変動率平均で判定
 */
function getPMDirection(
  candleCache: Map<string, any[]>,
  date: string
): "bullish" | "bearish" | "neutral" {
  let totalChange = 0;
  let count = 0;

  for (const symbol of TEN_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length < 2) continue;

    const firstOpen = candles[0].open;
    // 13:30時点の足を探す
    let latestClose: number | null = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const [h, m] = (candles[i].time as string).split(":").map(Number);
      const tMin = h * 60 + m;
      if (tMin <= 13 * 60 + 30) {
        latestClose = candles[i].close;
        break;
      }
    }
    if (latestClose === null) continue;
    const changeRate = (latestClose - firstOpen) / firstOpen * 100;
    totalChange += changeRate;
    count++;
  }

  if (count < 3) return "neutral";
  const avg = totalChange / count;
  if (avg >= B2_THRESHOLD) return "bullish";
  if (avg <= -B2_THRESHOLD) return "bearish";
  return "neutral";
}

type PMBlockMode = "none" | "bullish_only" | "bullish_neutral" | "all";

function runSimulation(
  dates: string[],
  pmBlockMode: PMBlockMode,
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  amDirectionCache: Map<string, string>,
  pmDirectionCache: Map<string, string>,
  bprCache: Map<string, number[]>
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    const amDir = amDirectionCache.get(date) || "neutral";
    const pmDir = pmDirectionCache.get(date) || "neutral";

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
        const isAM = timeMin < 11 * 60 + 30;
        const session: "am" | "pm" = timeMin < 12 * 60 + 30 ? "am" : "pm";

        // === Manage existing LONG position ===
        if (inLongPosition && longEntry) {
          const gain = (closes[i] - longEntry.price) / longEntry.price;
          const loss = (lows[i] - longEntry.price) / longEntry.price;
          const highGain = (highs[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && highGain >= BE_TRIGGER) longEntry.beActive = true;
          
          // SL/BE check first
          const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
          if (loss <= slLevel) {
            const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((exitPrice - longEntry.price) * lots), exitReason: longEntry.beActive ? "BE" : "SL",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          } else if (highGain >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((exitPrice - longEntry.price) * lots), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((closes[i] - longEntry.price) * lots), exitReason: "TIME",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          }
        }

        // === Manage existing SHORT position ===
        if (inShortPosition && shortEntry) {
          const gain = (shortEntry.price - closes[i]) / shortEntry.price;
          const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
          const lowGain = (shortEntry.price - lows[i]) / shortEntry.price;
          if (!shortEntry.beActive && lowGain >= BE_TRIGGER) shortEntry.beActive = true;
          
          // SL/BE check first
          const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
          if (lossHigh >= slLevel) {
            const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((shortEntry.price - exitPrice) * lots), exitReason: shortEntry.beActive ? "BE" : "SL",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          } else if (lowGain >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((shortEntry.price - exitPrice) * lots), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(2700000 / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((shortEntry.price - closes[i]) * lots), exitReason: "TIME",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          }
        }

        // === New entry check ===
        if (!sig) continue;
        if (timeMin < 9 * 60 + 30 || timeMin >= 15 * 60 + 15) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        // VWAP急落フィルター
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        // VWAPクロス上抜け無効化
        if (sig.type === "buy" && sig.reason && sig.reason.includes("VWAPクロス上抜け")) continue;

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;

        // BUY medium全ブロック（共通）
        if (confidence === "medium" && sig.type === "buy") continue;

        // SHORT medium: B2方式による方向性ブロック
        if (confidence === "medium" && sig.type === "sell") {
          if (isAM) {
            // 前場: 現行B2方式（bullish時のみブロック）
            if (amDir === "bullish") continue;
          } else {
            // 後場: PM_B2_DIRECTIONに基づくブロック
            if (pmBlockMode === "bullish_only") {
              // 後場bullish時のみブロック
              if (pmDir === "bullish") continue;
            } else if (pmBlockMode === "bullish_neutral") {
              // 後場bullishまたはneutral時ブロック（bearishのみ許可）
              if (pmDir === "bullish" || pmDir === "neutral") continue;
            } else if (pmBlockMode === "all") {
              // 後場SHORT medium全ブロック
              continue;
            }
            // pmBlockMode === "none": 後場は無条件許可（現行）
          }
        }

        // 後場全SHORT BPR>=0.65ブロック
        if (sig.type === "sell" && timeMin >= 13 * 60) {
          const bpr = bprs[i] ?? 0.5;
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
        const lots = Math.max(100, Math.floor(Math.floor(2700000 / longEntry.price) / 100) * 100);
        trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
          entryPrice: longEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: Math.round((lastClose - longEntry.price) * lots), exitReason: "EOD",
          signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
          session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
      }
      if (inShortPosition && shortEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.max(100, Math.floor(Math.floor(2700000 / shortEntry.price) / 100) * 100);
        trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
          entryPrice: shortEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: Math.round((shortEntry.price - lastClose) * lots), exitReason: "EOD",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
          session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
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
  const avgLoss2 = losses.length > 0 ? grossLoss / losses.length : 0;
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

  // PM SHORT medium specific
  const pmShortMedium = trades.filter(t => t.session === "pm" && t.side === "short" && t.confidence === "medium");
  const pmShortMediumPnl = pmShortMedium.reduce((s, t) => s + t.pnl, 0);
  const pmShortMediumWins = pmShortMedium.filter(t => t.pnl > 0).length;

  console.log(`  取引数: ${trades.length}件 | 勝率: ${winRate.toFixed(1)}% (${wins.length}勝${losses.length}敗${bes.length}引分)`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | PF: ${pf.toFixed(2)} | 最大DD: ${maxDD.toFixed(0)}円`);
  console.log(`  期待値: ${expectancy.toFixed(0)}円/回 | 平均利益: +${avgWin.toFixed(0)}円 | 平均損失: -${avgLoss2.toFixed(0)}円`);
  console.log(`  LONG: ${longTrades.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF ${longPF.toFixed(2)} | 勝率 ${longWR.toFixed(1)}%`);
  console.log(`  SHORT: ${shortTrades.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF ${shortPF.toFixed(2)} | 勝率 ${shortWR.toFixed(1)}%`);
  console.log(`  前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円`);
  console.log(`  後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円`);
  console.log(`  後場SHORT medium: ${pmShortMedium.length}件 | ${pmShortMediumPnl >= 0 ? "+" : ""}${pmShortMediumPnl.toFixed(0)}円 | 勝率 ${pmShortMedium.length > 0 ? (pmShortMediumWins / pmShortMedium.length * 100).toFixed(1) : 0}%`);
  console.log(`  --- 日別損益 ---`);
  const dates2 = [...new Set(trades.map(t => t.date))].sort();
  for (const d of dates2) {
    const dp = dailyPnl.get(d) || 0;
    const dayPmShort = trades.filter(t => t.date === d && t.session === "pm" && t.side === "short" && t.confidence === "medium");
    const dayPmShortPnl = dayPmShort.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${d}: ${dp >= 0 ? "+" : ""}${dp.toFixed(0)}円 (後場SHORT med: ${dayPmShort.length}件/${dayPmShortPnl >= 0 ? "+" : ""}${dayPmShortPnl.toFixed(0)}円)`);
  }

  return { count: trades.length, winRate, totalPnl, pf, maxDD, expectancy, longPnl, shortPnl, amPnl, pmPnl, pmShortMediumCount: pmShortMedium.length, pmShortMediumPnl };
}

async function main() {
  const db = await getDb();
  const dates = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-22",
                 "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-29", "2026-06-30"];

  console.log("╔══════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  後場B2方式（PM_B2_DIRECTION）シミュレーション                                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: 10銘柄 | ロット: 270万円/銘柄 | SL:0.5% TP:1.5% BE:0.5%`);
  console.log(`前場B2: 9:30固定判定（現行通り）`);
  console.log(`後場B2: 13:30時点で判定（±0.2%閾値）\n`);

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

  // Pre-compute AM and PM directions
  const amDirectionCache = new Map<string, string>();
  const pmDirectionCache = new Map<string, string>();
  for (const date of dates) {
    amDirectionCache.set(date, getAMDirection(candleCache, date));
    pmDirectionCache.set(date, getPMDirection(candleCache, date));
  }

  // Print direction summary
  console.log("--- 日別地合い判定 ---");
  console.log("| 日付       | 前場(AM) B2 | 後場(PM) B2 |");
  console.log("|------------|-------------|-------------|");
  for (const date of dates) {
    const am = amDirectionCache.get(date) || "neutral";
    const pm = pmDirectionCache.get(date) || "neutral";
    const amLabel = am === "bullish" ? "↑ bullish" : am === "bearish" ? "↓ bearish" : "→ neutral";
    const pmLabel = pm === "bullish" ? "↑ bullish" : pm === "bearish" ? "↓ bearish" : "→ neutral";
    console.log(`| ${date} | ${amLabel.padEnd(11)} | ${pmLabel.padEnd(11)} |`);
  }
  console.log();

  // Run 4 patterns
  const tradesA = runSimulation(dates, "none", signalCache, candleCache, amDirectionCache, pmDirectionCache, bprCache);
  const tradesB = runSimulation(dates, "bullish_only", signalCache, candleCache, amDirectionCache, pmDirectionCache, bprCache);
  const tradesC = runSimulation(dates, "bullish_neutral", signalCache, candleCache, amDirectionCache, pmDirectionCache, bprCache);
  const tradesD = runSimulation(dates, "all", signalCache, candleCache, amDirectionCache, pmDirectionCache, bprCache);

  // Print reports
  const resultA = printReport("A: 現行（後場SHORT medium無条件許可）", tradesA);
  const resultB = printReport("B: PM_B2 bullish時のみブロック", tradesB);
  const resultC = printReport("C: PM_B2 bullish+neutral時ブロック（bearishのみ許可）", tradesC);
  const resultD = printReport("D: PM_B2 全方向ブロック（後場SHORT medium全禁止）", tradesD);

  // Final comparison table
  console.log(`\n\n${"=".repeat(90)}`);
  console.log("=== 最終比較 ===");
  console.log(`${"=".repeat(90)}`);
  console.log(`\n| パターン | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値 | 後場SHmed件数 | 後場SHmed損益 |`);
  console.log(`|----------|--------|------|--------|-----|--------|--------|-------------|-------------|`);
  const results = [
    { name: "A:現行(無条件許可)", ...resultA },
    { name: "B:bullish時ブロック", ...resultB },
    { name: "C:bull+neut時ブロック", ...resultC },
    { name: "D:全ブロック", ...resultD },
  ];
  for (const r of results) {
    console.log(`| ${r.name.padEnd(20)} | ${String(r.count).padStart(4)}件 | ${r.winRate.toFixed(1).padStart(5)}% | ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(0).padStart(8)}円 | ${r.pf.toFixed(2).padStart(4)} | ${r.maxDD.toFixed(0).padStart(7)}円 | ${(r.expectancy >= 0 ? "+" : "") + r.expectancy.toFixed(0).padStart(6)}円 | ${String(r.pmShortMediumCount).padStart(11)}件 | ${(r.pmShortMediumPnl >= 0 ? "+" : "") + r.pmShortMediumPnl.toFixed(0).padStart(10)}円 |`);
  }

  console.log(`\n| パターン | LONG損益 | SHORT損益 | 前場損益 | 後場損益 |`);
  console.log(`|----------|----------|----------|----------|----------|`);
  for (const r of results) {
    console.log(`| ${r.name.padEnd(20)} | ${(r.longPnl >= 0 ? "+" : "") + r.longPnl.toFixed(0).padStart(8)}円 | ${(r.shortPnl >= 0 ? "+" : "") + r.shortPnl.toFixed(0).padStart(8)}円 | ${(r.amPnl >= 0 ? "+" : "") + r.amPnl.toFixed(0).padStart(8)}円 | ${(r.pmPnl >= 0 ? "+" : "") + r.pmPnl.toFixed(0).padStart(8)}円 |`);
  }

  // Difference analysis
  console.log(`\n--- 差分分析（vs 現行A） ---`);
  console.log(`B vs A (bullish時ブロック): ${(resultB.totalPnl - resultA.totalPnl) >= 0 ? "+" : ""}${(resultB.totalPnl - resultA.totalPnl).toFixed(0)}円 | 後場SHORT med: ${resultA.pmShortMediumCount - resultB.pmShortMediumCount}件削減`);
  console.log(`C vs A (bull+neut時ブロック): ${(resultC.totalPnl - resultA.totalPnl) >= 0 ? "+" : ""}${(resultC.totalPnl - resultA.totalPnl).toFixed(0)}円 | 後場SHORT med: ${resultA.pmShortMediumCount - resultC.pmShortMediumCount}件削減`);
  console.log(`D vs A (全ブロック): ${(resultD.totalPnl - resultA.totalPnl) >= 0 ? "+" : ""}${(resultD.totalPnl - resultA.totalPnl).toFixed(0)}円 | 後場SHORT med: ${resultA.pmShortMediumCount - resultD.pmShortMediumCount}件削減`);

  // PM direction breakdown
  console.log(`\n--- 後場地合い別の後場SHORT medium損益（パターンA: 現行） ---`);
  const bullishDates = dates.filter(d => pmDirectionCache.get(d) === "bullish");
  const neutralDates = dates.filter(d => pmDirectionCache.get(d) === "neutral");
  const bearishDates = dates.filter(d => pmDirectionCache.get(d) === "bearish");
  
  const pmShortMedA = tradesA.filter(t => t.session === "pm" && t.side === "short" && t.confidence === "medium");
  const bullishPmSM = pmShortMedA.filter(t => bullishDates.includes(t.date));
  const neutralPmSM = pmShortMedA.filter(t => neutralDates.includes(t.date));
  const bearishPmSM = pmShortMedA.filter(t => bearishDates.includes(t.date));

  console.log(`  bullish日(${bullishDates.length}日): ${bullishPmSM.length}件 | ${bullishPmSM.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${bullishPmSM.reduce((s, t) => s + t.pnl, 0).toFixed(0)}円 | 勝率 ${bullishPmSM.length > 0 ? (bullishPmSM.filter(t => t.pnl > 0).length / bullishPmSM.length * 100).toFixed(1) : 0}%`);
  console.log(`  neutral日(${neutralDates.length}日): ${neutralPmSM.length}件 | ${neutralPmSM.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${neutralPmSM.reduce((s, t) => s + t.pnl, 0).toFixed(0)}円 | 勝率 ${neutralPmSM.length > 0 ? (neutralPmSM.filter(t => t.pnl > 0).length / neutralPmSM.length * 100).toFixed(1) : 0}%`);
  console.log(`  bearish日(${bearishDates.length}日): ${bearishPmSM.length}件 | ${bearishPmSM.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${bearishPmSM.reduce((s, t) => s + t.pnl, 0).toFixed(0)}円 | 勝率 ${bearishPmSM.length > 0 ? (bearishPmSM.filter(t => t.pnl > 0).length / bearishPmSM.length * 100).toFixed(1) : 0}%`);

  // Recommendation
  console.log(`\n--- 推奨 ---`);
  const bestResult = results.reduce((best, r) => r.totalPnl > best.totalPnl ? r : best, results[0]);
  console.log(`最も利益が高いパターン: ${bestResult.name}`);
  console.log(`総損益: ${bestResult.totalPnl >= 0 ? "+" : ""}${bestResult.totalPnl.toFixed(0)}円 | PF: ${bestResult.pf.toFixed(2)} | 勝率: ${bestResult.winRate.toFixed(1)}%`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
