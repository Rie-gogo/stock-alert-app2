/**
 * リアルタイム市場レジーム方式 vs 固定判定 vs フィルターなし
 * パターンC（SHORTのmediumのみ解除）に対するフィルター比較
 * 
 * 前提条件（全方式共通）:
 * - VWAP急落フィルター
 * - 固定0.5% BEストップ
 * - 後場大台割れSHORT BPR>=0.65ブロック
 * 
 * 比較方式:
 * C1: フィルターなし（SHORTのmedium全解除）
 * C2: 固定上昇日判定でブロック
 * C3: リアルタイム市場レジーム
 *   ① 対象銘柄 < VWAP → SHORT medium許可
 *   ② 7銘柄中の上昇/下落比率で強気/弱気判定
 *   ③ 強気レジーム時は板スコア閾値+1（=通常のstrong条件と同等）
 *   ④ 弱気レジーム時は通常条件（medium許可）
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
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
  regime?: string;
  belowVwap?: boolean;
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

// Market regime determination at each candle time
// Returns: "bullish" | "bearish" | "neutral"
function getMarketRegime(
  allSymbolCandles: Map<string, { close: number; open: number; vwap: number; time: string }[]>,
  targetTime: string,
  targetDate: string
): "bullish" | "bearish" | "neutral" {
  let upCount = 0;
  let downCount = 0;
  let totalSymbols = 0;
  const changes: number[] = [];

  for (const [symbol, candles] of allSymbolCandles) {
    if (candles.length === 0) continue;
    // Find the candle at or before targetTime
    let currentCandle = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= targetTime) {
        currentCandle = candles[i];
        break;
      }
    }
    if (!currentCandle) continue;
    totalSymbols++;
    const openPrice = candles[0].open;
    const changeRate = (currentCandle.close - openPrice) / openPrice;
    changes.push(changeRate);
    if (changeRate >= 0.005) upCount++;
    else if (changeRate <= -0.005) downCount++;
  }

  if (totalSymbols === 0) return "neutral";

  // Median change rate
  changes.sort((a, b) => a - b);
  const median = changes[Math.floor(changes.length / 2)];

  // 上昇銘柄数/下落銘柄数 >= 2.0 → bullish
  if (downCount > 0 && upCount / downCount >= 2.0) return "bullish";
  if (upCount > 0 && downCount / upCount >= 2.0) return "bearish";
  // 中央値 >= +0.5% → bullish
  if (median >= 0.005) return "bullish";
  if (median <= -0.005) return "bearish";
  // 60%以上が+0.5%以上 → bullish
  if (upCount / totalSymbols >= 0.6) return "bullish";
  if (downCount / totalSymbols >= 0.6) return "bearish";

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
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.length}銘柄`);

  // Classify market days (for fixed method)
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of TARGET_SYMBOLS) {
      const candles = grouped.get(`${date}_${symbol}`);
      if (!candles || candles.length < 2) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));
      const openPrice = Number(candles[0].open);
      const closePrice = Number(candles[candles.length - 1].close);
      if ((closePrice - openPrice) / openPrice >= 0.005) upCount++;
      else if ((closePrice - openPrice) / openPrice <= -0.005) downCount++;
    }
    if (upCount >= 4) dayClassification.set(date, "up");
    else if (downCount >= 4) dayClassification.set(date, "down");
    else dayClassification.set(date, "range");
  }

  console.log("\n日別市場分類:");
  for (const [date, cls] of [...dayClassification.entries()].sort()) {
    console.log(`  ${date}: ${cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日"}`);
  }

  // Pre-compute signals and VWAP for all date/symbol combinations
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();
  const vwapCache = new Map<string, number[]>();

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
        high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
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
      vwapCache.set(key, vwapArr.map(v => v ?? 0));
      candleCache.set(key, candles.map((c: any, i: number) => ({
        ...c,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i], vwap: vwapArr[i] ?? closes[i],
        bpr: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot)?.bpr ?? 0.5 : 0.5,
        time: c.candleTime,
      })));
    }
  }

  // Run simulation for each method
  type Method = "C1" | "C2" | "C3";
  const methods: Method[] = ["C1", "C2", "C3"];
  const methodNames: Record<Method, string> = {
    C1: "フィルターなし（SHORT medium全解除）",
    C2: "固定上昇日判定でブロック",
    C3: "リアルタイム市場レジーム",
  };

  const allResults: Record<Method, Trade[]> = { C1: [], C2: [], C3: [] };
  const c3BlockedTrades: Trade[] = []; // Trades that C3 blocked but C1 would have taken
  const c3RegimeLog: { date: string; time: string; regime: string; symbol: string; action: string }[] = [];

  for (const date of dates) {
    // Build per-date candle map for regime calculation
    const dateCandles = new Map<string, { close: number; open: number; vwap: number; time: string }[]>();
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const candles = candleCache.get(key);
      if (!candles) continue;
      dateCandles.set(symbol, candles.map((c: any) => ({
        close: c.close, open: c.open, vwap: c.vwap, time: c.time,
      })));
    }

    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      const vwapArr = vwapCache.get(key);
      if (!signals || !candles || !vwapArr || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);

      for (const method of methods) {
        let inShortPosition = false;
        let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, regime: "", belowVwap: false };

        for (let i = 0; i < signals.length; i++) {
          const sig = signals[i].signal;
          const time = candles[i]?.time as string;
          if (!time) continue;
          const hour = parseInt(time.split(":")[0]);
          const min = parseInt(time.split(":")[1]);
          const timeMin = hour * 60 + min;
          const session: "am" | "pm" = timeMin < 11 * 60 + 30 ? "am" : "pm";

          // Process SHORT position exit
          if (inShortPosition) {
            const profitHigh = (shortEntry.price - lows[i]) / shortEntry.price;
            const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
            if (!shortEntry.beActive && profitHigh >= BE_TRIGGER) shortEntry.beActive = true;
            if (profitHigh >= TP_PERCENT) {
              const exitPrice = shortEntry.price * (1 - TP_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              allResults[method].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                regime: shortEntry.regime, belowVwap: shortEntry.belowVwap });
              inShortPosition = false;
            } else {
              const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
              if (lossHigh >= slLevel) {
                const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[method].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice,
                  pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                  regime: shortEntry.regime, belowVwap: shortEntry.belowVwap });
                inShortPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[method].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                  regime: shortEntry.regime, belowVwap: shortEntry.belowVwap });
                inShortPosition = false;
              }
            }
          }

          // New SHORT entry check (medium only - strong is already in baseline)
          if (!sig || sig.type !== "sell") continue;
          if (sig.confidence !== "medium") continue; // Only medium SHORT
          if (inShortPosition) continue;
          if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
          if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

          // VWAP急落フィルター
          if (sig.reason.includes("VWAPクロス下抜け")) {
            const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
            const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
            if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
          }

          // 後場大台割れSHORT BPR>=0.65ブロック
          if (isRoundLevelBreakdown(sig.reason) && timeMin >= 12 * 60 + 30) {
            const bpr = candles[i].bpr ?? 0.5;
            if (bpr >= AFTERNOON_BPR_BLOCK) continue;
          }

          // Method-specific filters
          const belowVwap = closes[i] < (vwapArr[i] || closes[i]);
          const regime = getMarketRegime(dateCandles, time, date);

          if (method === "C2") {
            // Fixed daily classification
            const dayClass = dayClassification.get(date);
            if (dayClass === "up") continue; // Block all SHORT medium on up days
          } else if (method === "C3") {
            // Realtime regime filter
            if (regime === "bullish") {
              // In bullish regime: only allow if stock is below VWAP
              if (!belowVwap) {
                c3RegimeLog.push({ date, time, regime, symbol, action: "BLOCKED (bullish + above VWAP)" });
                continue;
              }
              c3RegimeLog.push({ date, time, regime, symbol, action: "ALLOWED (bullish but below VWAP)" });
            } else if (regime === "neutral") {
              // In neutral: allow if below VWAP
              if (!belowVwap) {
                c3RegimeLog.push({ date, time, regime, symbol, action: "BLOCKED (neutral + above VWAP)" });
                continue;
              }
              c3RegimeLog.push({ date, time, regime, symbol, action: "ALLOWED (neutral + below VWAP)" });
            } else {
              // Bearish: allow all
              c3RegimeLog.push({ date, time, regime, symbol, action: "ALLOWED (bearish)" });
            }
          }
          // C1: no filter, always allow

          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: sig.confidence, beActive: false, regime, belowVwap };
        }

        // Close any remaining position at end of day
        if (inShortPosition) {
          const lastIdx = candles.length - 1;
          const lots = Math.floor(2000000 / shortEntry.price) * 100;
          allResults[method].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
            entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
            pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), exitReason: "EOD",
            signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
            session: "pm", regime: shortEntry.regime, belowVwap: shortEntry.belowVwap });
        }
      }
    }
  }

  // Output results
  console.log("\n" + "=".repeat(80));
  console.log("=== 3方式比較結果 ===");
  console.log("=".repeat(80));

  for (const method of methods) {
    const trades = allResults[method];
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const bes = trades.filter(t => t.pnl === 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = totalLoss === 0 ? Infinity : totalProfit / totalLoss;
    const avgWin = wins.length > 0 ? totalProfit / wins.length : 0;
    const avgLoss2 = losses.length > 0 ? totalLoss / losses.length : 0;

    // Max DD
    let maxDD = 0, cumPnl = 0, peak = 0;
    const sortedTrades = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sortedTrades) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    const amTrades = trades.filter(t => t.session === "am");
    const pmTrades = trades.filter(t => t.session === "pm");
    const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);

    console.log(`\n--- ${method}: ${methodNames[method]} ---`);
    console.log(`取引数: ${trades.length}件 | 勝率: ${trades.length > 0 ? Math.round(wins.length / trades.length * 100) : 0}% (${wins.length}勝${losses.length}敗${bes.length}BE)`);
    console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl)}円 | PF: ${pf === Infinity ? "∞" : pf.toFixed(2)} | 期待値: ${trades.length > 0 ? Math.round(totalPnl / trades.length) : 0}円/回`);
    console.log(`最大DD: ${Math.round(maxDD)}円`);
    console.log(`平均利益: +${Math.round(avgWin)}円 | 平均損失: -${Math.round(avgLoss2)}円`);
    console.log(`前場: ${amTrades.length}件 ${amPnl >= 0 ? "+" : ""}${Math.round(amPnl)}円 | 後場: ${pmTrades.length}件 ${pmPnl >= 0 ? "+" : ""}${Math.round(pmPnl)}円`);

    // Daily breakdown
    console.log("  日別損益:");
    for (const date of dates) {
      const dayTrades = trades.filter(t => t.date === date);
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const dayClass = dayClassification.get(date) || "?";
      console.log(`    ${date} [${dayClass === "up" ? "上昇" : dayClass === "down" ? "下落" : "レンジ"}]: ${dayTrades.length}件 ${dayPnl >= 0 ? "+" : ""}${Math.round(dayPnl)}円`);
    }

    // Up/Down day breakdown
    const upDayTrades = trades.filter(t => dayClassification.get(t.date) === "up");
    const downDayTrades = trades.filter(t => dayClassification.get(t.date) === "down");
    const rangeDayTrades = trades.filter(t => dayClassification.get(t.date) === "range");
    console.log(`  上昇日: ${upDayTrades.length}件 ${upDayTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${Math.round(upDayTrades.reduce((s, t) => s + t.pnl, 0))}円`);
    console.log(`  下落日: ${downDayTrades.length}件 ${downDayTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${Math.round(downDayTrades.reduce((s, t) => s + t.pnl, 0))}円`);
    console.log(`  レンジ日: ${rangeDayTrades.length}件 ${rangeDayTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${Math.round(rangeDayTrades.reduce((s, t) => s + t.pnl, 0))}円`);
  }

  // C3 regime analysis
  console.log("\n" + "=".repeat(80));
  console.log("=== C3 リアルタイムレジーム分析 ===");
  console.log("=".repeat(80));
  const regimeActions = c3RegimeLog.reduce((acc, r) => {
    if (!acc[r.action]) acc[r.action] = 0;
    acc[r.action]++;
    return acc;
  }, {} as Record<string, number>);
  console.log("\nレジーム判定結果:");
  for (const [action, count] of Object.entries(regimeActions)) {
    console.log(`  ${action}: ${count}件`);
  }

  // Compare C3 blocked vs C1 (what would have happened)
  console.log("\n--- C3でブロックされたトレードの仮想損益 ---");
  const c1Trades = allResults["C1"];
  const c3Trades = allResults["C3"];
  // Find trades in C1 but not in C3 (blocked by C3)
  const c3EntryKeys = new Set(c3Trades.map(t => `${t.date}_${t.symbol}_${t.entryTime}`));
  const blockedByC3 = c1Trades.filter(t => !c3EntryKeys.has(`${t.date}_${t.symbol}_${t.entryTime}`));
  const blockedPnl = blockedByC3.reduce((s, t) => s + t.pnl, 0);
  const blockedWins = blockedByC3.filter(t => t.pnl > 0);
  const blockedLosses = blockedByC3.filter(t => t.pnl < 0);
  console.log(`ブロック数: ${blockedByC3.length}件`);
  console.log(`ブロック分の損益: ${blockedPnl >= 0 ? "+" : ""}${Math.round(blockedPnl)}円`);
  console.log(`内訳: ${blockedWins.length}勝 ${blockedLosses.length}敗`);
  if (blockedPnl < 0) {
    console.log(`→ ブロックにより${Math.round(Math.abs(blockedPnl))}円の損失を回避`);
  } else {
    console.log(`→ ブロックにより${Math.round(blockedPnl)}円の利益を逸失`);
  }

  // Blocked by date
  console.log("\n  ブロック日別:");
  for (const date of dates) {
    const dayBlocked = blockedByC3.filter(t => t.date === date);
    if (dayBlocked.length === 0) continue;
    const dayPnl = dayBlocked.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${date}: ${dayBlocked.length}件 ${dayPnl >= 0 ? "+" : ""}${Math.round(dayPnl)}円`);
  }

  // Summary comparison table
  console.log("\n" + "=".repeat(80));
  console.log("=== 最終比較サマリー ===");
  console.log("=".repeat(80));
  console.log("\nパターン | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値 | 上昇日損益 | 下落日損益");
  console.log("-".repeat(120));
  for (const method of methods) {
    const trades = allResults[method];
    const wins = trades.filter(t => t.pnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = totalLoss === 0 ? Infinity : totalProfit / totalLoss;
    let maxDD = 0, cumPnl2 = 0, peak2 = 0;
    const sorted = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sorted) { cumPnl2 += t.pnl; if (cumPnl2 > peak2) peak2 = cumPnl2; const dd = peak2 - cumPnl2; if (dd > maxDD) maxDD = dd; }
    const upPnl = trades.filter(t => dayClassification.get(t.date) === "up").reduce((s, t) => s + t.pnl, 0);
    const downPnl = trades.filter(t => dayClassification.get(t.date) === "down").reduce((s, t) => s + t.pnl, 0);
    console.log(`${method}: ${methodNames[method]} | ${trades.length}件 | ${trades.length > 0 ? Math.round(wins.length / trades.length * 100) : 0}% | ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl)}円 | ${pf === Infinity ? "∞" : pf.toFixed(2)} | ${Math.round(maxDD)}円 | ${trades.length > 0 ? Math.round(totalPnl / trades.length) : 0}円/回 | ${upPnl >= 0 ? "+" : ""}${Math.round(upPnl)}円 | ${downPnl >= 0 ? "+" : ""}${Math.round(downPnl)}円`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
