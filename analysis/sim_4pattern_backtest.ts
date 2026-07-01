/**
 * 4パターン比較バックテスト
 * 
 * 前提条件（全パターン共通）:
 * - VWAP急落フィルター（5本下落率≤-0.8% or 3本下落率≤-0.6%でVWAP SHORT禁止）
 * - 固定0.5% BEストップ
 * - 後場大台割れSHORT BPR>=0.65ブロック
 * 
 * パターン:
 * A. 現行（strongのみ）
 * B. ダウ理論medium解除（直近高値更新LONG + 直近安値更新SHORT）
 * C. SHORTのmediumのみ解除
 * D. B + C（両方解除）
 */
import { getDb } from "../server/db";
import { rtCandles, rtTrades } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

const TARGET_SYMBOLS = ["6526", "9984", "6976", "6920", "8035", "6857", "6981"];
const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const AFTERNOON_BPR_BLOCK = 0.65;

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
    const change = closes[i] - closes[i-1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i-1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function isDowTheory(reason: string): boolean {
  return reason.includes("ダウ理論") || reason.includes("直近安値更新") || reason.includes("直近高値更新");
}

function isDowHigh(reason: string): boolean {
  return reason.includes("直近高値更新");
}

function isDowLow(reason: string): boolean {
  return reason.includes("直近安値更新");
}

function isRoundLevelBreakdown(reason: string): boolean {
  return reason.includes("大台割れ");
}

type PatternFilter = (sig: { type: string; confidence?: string; reason: string }) => boolean;

const patterns: { name: string; filter: PatternFilter }[] = [
  {
    name: "A: 現行（strongのみ）",
    filter: (sig) => sig.confidence === "strong",
  },
  {
    name: "B: ダウ理論medium解除",
    filter: (sig) => {
      if (sig.confidence === "strong") return true;
      if (sig.confidence === "medium" && isDowTheory(sig.reason)) return true;
      return false;
    },
  },
  {
    name: "C: SHORTのmediumのみ解除",
    filter: (sig) => {
      if (sig.confidence === "strong") return true;
      if (sig.confidence === "medium" && sig.type === "sell") return true;
      return false;
    },
  },
  {
    name: "D: B+C（両方解除）",
    filter: (sig) => {
      if (sig.confidence === "strong") return true;
      if (sig.confidence === "medium") {
        if (sig.type === "sell") return true; // All SHORT medium
        if (sig.type === "buy" && isDowHigh(sig.reason)) return true; // Dow LONG medium
      }
      return false;
    },
  },
];

async function main() {
  const db = await getDb();

  // Get all candle data
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
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")}`);
  console.log(`適用フィルター: VWAP急落フィルター, BEストップ(0.5%), 後場大台割れBPR>=0.65ブロック\n`);

  // Classify market days
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of TARGET_SYMBOLS) {
      const candles = grouped.get(`${date}_${symbol}`);
      if (!candles || candles.length < 2) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));
      const openPrice = Number(candles[0].open);
      const closePrice = Number(candles[candles.length - 1].close);
      const change = (closePrice - openPrice) / openPrice;
      if (change > 0.003) upCount++;
      else if (change < -0.003) downCount++;
    }
    if (upCount >= 4) dayClassification.set(date, "up");
    else if (downCount >= 4) dayClassification.set(date, "down");
    else dayClassification.set(date, "range");
  }

  console.log("日別市場分類:");
  for (const [date, cls] of [...dayClassification.entries()].sort()) {
    console.log(`  ${date}: ${cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日"}`);
  }
  console.log();

  // Pre-compute signals for all date/symbol combinations
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();
  
  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const candles = grouped.get(key);
      if (!candles || candles.length < 30) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

      const closes = candles.map((c: any) => Number(c.close));
      const highs = candles.map((c: any) => Number(c.high));
      const lows = candles.map((c: any) => Number(c.low));
      const opens = candles.map((c: any) => Number(c.open));
      const volumes = candles.map((c: any) => Number(c.volume));

      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i]+closes[i-1]+closes[i-2]+closes[i-3]+closes[i-4])/5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i-j]; return s/25; });

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

      const signals = detectSignals(enrichedCandles, symbol);
      signalCache.set(key, signals);
      candleCache.set(key, candles.map((c: any, i: number) => ({
        ...c,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i], vwap: vwapArr[i] ?? closes[i],
        bpr: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot)?.bpr ?? 0.5 : 0.5,
      })));
    }
  }

  // Run simulation for each pattern
  const allResults: { name: string; trades: Trade[] }[] = [];

  for (const pattern of patterns) {
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
        let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };

        for (let i = 0; i < signals.length; i++) {
          const sig = signals[i].signal;
          const time = candles[i]?.candleTime as string;
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
              trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime,
                entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: "TP",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
              inLongPosition = false;
            } else {
              const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
              if (profitLow <= slLevel) {
                const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime,
                  entryPrice: longEntry.price, exitTime: time, exitPrice,
                  pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                  signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
                inLongPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime,
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
              trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
              inShortPosition = false;
            } else {
              const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
              if (lossHigh >= slLevel) {
                const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice,
                  pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
                inShortPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
                inShortPosition = false;
              }
            }
          }

          // New entry check
          if (!sig) continue;
          if (!pattern.filter(sig)) continue;
          if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
          if ((timeMin >= 11*60 && timeMin < 11*60+30) || (timeMin >= 12*60+30 && timeMin < 13*60)) continue;

          // VWAP急落フィルター（SHORT VWAP下抜けのみ）
          if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
            const drop5 = i >= 5 ? (closes[i] - closes[i-5]) / closes[i-5] : 0;
            const drop3 = i >= 3 ? (closes[i] - closes[i-3]) / closes[i-3] : 0;
            if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
          }

          // 後場大台割れSHORT BPR>=0.65ブロック
          if (sig.type === "sell" && isRoundLevelBreakdown(sig.reason) && timeMin >= 12 * 60 + 30) {
            const bpr = candles[i].bpr ?? 0.5;
            if (bpr >= AFTERNOON_BPR_BLOCK) continue;
          }

          if (sig.type === "buy" && !inLongPosition) {
            inLongPosition = true;
            longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: sig.confidence || "strong", beActive: false };
          } else if (sig.type === "sell" && !inShortPosition) {
            inShortPosition = true;
            shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: sig.confidence || "strong", beActive: false };
          }
        }
      }
    }

    allResults.push({ name: pattern.name, trades });
  }

  // Print comprehensive comparison
  console.log(`\n${"=".repeat(80)}`);
  console.log(`=== 4パターン比較結果 ===`);
  console.log(`${"=".repeat(80)}\n`);

  // Summary table
  console.log("--- 総合比較 ---");
  console.log("パターン | 取引数 | 勝率 | 総損益 | PF | 期待値 | 最大DD | 平均利益 | 平均損失");
  console.log("-".repeat(100));

  for (const { name, trades } of allResults) {
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

    // Max drawdown
    let maxDD = 0, peak = 0, cumPnl = 0;
    const sortedTrades = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sortedTrades) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    console.log(`${name} | ${trades.length}件 | ${winRate.toFixed(0)}% | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | ${pf.toFixed(2)} | ${expectancy.toFixed(0)}円 | -${maxDD.toFixed(0)}円 | +${avgWin.toFixed(0)}円 | ${avgLoss.toFixed(0)}円`);
  }

  // Detailed breakdown for each pattern
  for (const { name, trades } of allResults) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== ${name} ===`);
    console.log(`${"=".repeat(70)}`);

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const bes = trades.filter(t => t.pnl === 0);
    const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    // 前場/後場別
    const amTrades = trades.filter(t => t.session === "am");
    const pmTrades = trades.filter(t => t.session === "pm");
    const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
    const amWins = amTrades.filter(t => t.pnl > 0).length;
    const pmWins = pmTrades.filter(t => t.pnl > 0).length;
    const amLossPnl = amTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const pmLossPnl = pmTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const amWinPnl = amTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const pmWinPnl = pmTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);

    console.log(`\n--- 前場/後場別 ---`);
    console.log(`  前場: ${amTrades.length}件 | 勝率${amTrades.length > 0 ? (amWins/amTrades.length*100).toFixed(0) : 0}% | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円 | PF:${amLossPnl !== 0 ? (amWinPnl / Math.abs(amLossPnl)).toFixed(2) : "∞"}`);
    console.log(`  後場: ${pmTrades.length}件 | 勝率${pmTrades.length > 0 ? (pmWins/pmTrades.length*100).toFixed(0) : 0}% | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円 | PF:${pmLossPnl !== 0 ? (pmWinPnl / Math.abs(pmLossPnl)).toFixed(2) : "∞"}`);

    // 上昇日/下落日/レンジ日別
    console.log(`\n--- 市場環境別 ---`);
    for (const cls of ["up", "down", "range"] as const) {
      const label = cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日";
      const clsDates = [...dayClassification.entries()].filter(([_, c]) => c === cls).map(([d]) => d);
      const clsTrades = trades.filter(t => clsDates.includes(t.date));
      const clsPnl = clsTrades.reduce((s, t) => s + t.pnl, 0);
      const clsWins = clsTrades.filter(t => t.pnl > 0).length;
      const clsLossPnl = clsTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
      const clsWinPnl = clsTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      console.log(`  ${label}(${clsDates.length}日): ${clsTrades.length}件 | 勝率${clsTrades.length > 0 ? (clsWins/clsTrades.length*100).toFixed(0) : 0}% | ${clsPnl >= 0 ? "+" : ""}${clsPnl.toFixed(0)}円 | PF:${clsLossPnl !== 0 ? (clsWinPnl / Math.abs(clsLossPnl)).toFixed(2) : "∞"}`);
    }

    // 日別損益
    console.log(`\n--- 日別損益 ---`);
    const byDate = new Map<string, number>();
    for (const t of trades) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.pnl);
    }
    for (const [date, pnl] of [...byDate.entries()].sort()) {
      const cls = dayClassification.get(date) || "?";
      const label = cls === "up" ? "↑" : cls === "down" ? "↓" : "→";
      console.log(`  ${date} ${label}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円`);
    }

    // LONG vs SHORT
    const longs = trades.filter(t => t.side === "long");
    const shorts = trades.filter(t => t.side === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n--- LONG/SHORT別 ---`);
    console.log(`  LONG:  ${longs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円`);
    console.log(`  SHORT: ${shorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円`);
  }

  // Final recommendation
  console.log(`\n${"=".repeat(80)}`);
  console.log(`=== 最終判定 ===`);
  console.log(`${"=".repeat(80)}`);

  const results = allResults.map(r => {
    const totalPnl = r.trades.reduce((s, t) => s + t.pnl, 0);
    const wins = r.trades.filter(t => t.pnl > 0);
    const losses = r.trades.filter(t => t.pnl < 0);
    const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const pf = totalLoss !== 0 ? totalWin / Math.abs(totalLoss) : Infinity;
    let maxDD = 0, peak = 0, cumPnl = 0;
    const sorted = [...r.trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sorted) { cumPnl += t.pnl; if (cumPnl > peak) peak = cumPnl; const dd = peak - cumPnl; if (dd > maxDD) maxDD = dd; }
    return { name: r.name, pnl: totalPnl, pf, maxDD, count: r.trades.length };
  });

  console.log("\n判定基準: PF >= 1.10 かつ 最大DD <= 現行の1.5倍\n");
  const baseDD = results[0].maxDD;
  for (const r of results) {
    const pfOk = r.pf >= 1.10;
    const ddOk = r.maxDD <= baseDD * 1.5;
    const verdict = pfOk && ddOk ? "✅ 採用可" : pfOk ? "⚠️ DD注意" : ddOk ? "❌ PF不足" : "❌ 不採用";
    console.log(`${r.name}: PF=${r.pf.toFixed(2)} | DD=-${r.maxDD.toFixed(0)}円 | 損益=${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}円 → ${verdict}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
