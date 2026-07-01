/**
 * リアルタイム市場レジーム方式 vs 固定判定方式 比較バックテスト
 * 
 * パターンC（SHORTのmedium解除）に対して:
 * - C1: フィルターなし（全SHORTのmedium解除）
 * - C2: 固定上昇日判定でSHORT mediumブロック
 * - C3: リアルタイム市場レジームでSHORT medium条件付き許可
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { TARGET_STOCKS } from "../shared/stocks";
import { detectSignals } from "../server/routers/stockData";
import { calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

const ACTIVE_SYMBOLS = TARGET_STOCKS.map(s => s.symbol);
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const BE_TRIGGER_PCT = 0.5;

interface Candle {
  symbol: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

interface Trade {
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  confidence: string;
  signalType: string;
  regime: string;
  date: string;
}

interface MarketRegime {
  time: string;
  upCount: number;
  downCount: number;
  flatCount: number;
  medianChange: number;
  regime: "bullish" | "bearish" | "neutral";
}

function computeVWAP(candles: Candle[]): number {
  let cumPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumPV / cumVol : candles[candles.length - 1]?.close ?? 0;
}

function getMarketRegime(
  allSymbolCandles: Map<string, Candle[]>,
  currentTime: string
): MarketRegime {
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;
  const changes: number[] = [];

  for (const [symbol, candles] of allSymbolCandles) {
    const candlesUpToNow = candles.filter(c => c.candleTime <= currentTime);
    if (candlesUpToNow.length < 2) continue;
    
    const openPrice = candlesUpToNow[0].open;
    const currentPrice = candlesUpToNow[candlesUpToNow.length - 1].close;
    const changeRate = ((currentPrice - openPrice) / openPrice) * 100;
    changes.push(changeRate);
    
    if (changeRate >= 0.3) upCount++;
    else if (changeRate <= -0.3) downCount++;
    else flatCount++;
  }

  changes.sort((a, b) => a - b);
  const medianChange = changes.length > 0 
    ? changes[Math.floor(changes.length / 2)] 
    : 0;

  let regime: "bullish" | "bearish" | "neutral" = "neutral";
  if (upCount >= Math.ceil(changes.length * 0.6) || medianChange >= 0.5) {
    regime = "bullish";
  } else if (downCount >= Math.ceil(changes.length * 0.6) || medianChange <= -0.5) {
    regime = "bearish";
  }

  return { time: currentTime, upCount, downCount, flatCount, medianChange, regime };
}

function simulateTrade(
  candles: Candle[],
  entryIdx: number,
  side: "LONG" | "SHORT"
): { exitIdx: number; exitPrice: number; pnl: number; exitReason: string } {
  const entry = candles[entryIdx];
  const entryPrice = entry.close;
  const slPrice = side === "SHORT"
    ? entryPrice * (1 + SL_PCT / 100)
    : entryPrice * (1 - SL_PCT / 100);
  const tpPrice = side === "SHORT"
    ? entryPrice * (1 - TP_PCT / 100)
    : entryPrice * (1 + TP_PCT / 100);
  
  let beActive = false;
  let currentSL = slPrice;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    
    // Check BE trigger
    if (!beActive) {
      const unrealizedPct = side === "SHORT"
        ? ((entryPrice - c.low) / entryPrice) * 100
        : ((c.high - entryPrice) / entryPrice) * 100;
      if (unrealizedPct >= BE_TRIGGER_PCT) {
        beActive = true;
        currentSL = entryPrice; // Move SL to entry
      }
    }

    // Check SL
    if (side === "SHORT") {
      if (c.high >= currentSL) {
        const exitPrice = currentSL;
        const pnl = (entryPrice - exitPrice) * (2000000 / entryPrice);
        return { exitIdx: i, exitPrice, pnl, exitReason: beActive ? "BE" : "SL" };
      }
      if (c.low <= tpPrice) {
        const exitPrice = tpPrice;
        const pnl = (entryPrice - exitPrice) * (2000000 / entryPrice);
        return { exitIdx: i, exitPrice, pnl, exitReason: "TP" };
      }
    } else {
      if (c.low <= currentSL) {
        const exitPrice = currentSL;
        const pnl = (exitPrice - entryPrice) * (2000000 / entryPrice);
        return { exitIdx: i, exitPrice, pnl, exitReason: beActive ? "BE" : "SL" };
      }
      if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const pnl = (exitPrice - entryPrice) * (2000000 / entryPrice);
        return { exitIdx: i, exitPrice, pnl, exitReason: "TP" };
      }
    }
  }

  // Force exit at end of day
  const lastCandle = candles[candles.length - 1];
  const exitPrice = lastCandle.close;
  const pnl = side === "SHORT"
    ? (entryPrice - exitPrice) * (2000000 / entryPrice)
    : (exitPrice - entryPrice) * (2000000 / entryPrice);
  return { exitIdx: candles.length - 1, exitPrice, pnl, exitReason: "EOD" };
}

async function main() {
  const db = await getDb();
  
  // Get all dates
  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, ACTIVE_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-06-17"),
      lte(rtCandles.tradeDate, "2026-06-30")
    ))
    .orderBy(rtCandles.tradeDate, rtCandles.candleTime);

  // Group by date
  const byDate = new Map<string, typeof allCandles>();
  for (const c of allCandles) {
    const arr = byDate.get(c.tradeDate) || [];
    arr.push(c);
    byDate.set(c.tradeDate, arr);
  }

  const dates = [...byDate.keys()].sort();
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${ACTIVE_SYMBOLS.length}銘柄\n`);

  // Results storage
  const tradesC1: Trade[] = []; // No filter
  const tradesC2: Trade[] = []; // Fixed day classification
  const tradesC3: Trade[] = []; // Realtime regime

  for (const date of dates) {
    const dayCandles = byDate.get(date)!;
    
    // Group by symbol
    const bySymbol = new Map<string, Candle[]>();
    for (const c of dayCandles) {
      const candle: Candle = {
        symbol: c.symbol,
        candleTime: c.candleTime,
        open: parseFloat(c.open as any),
        high: parseFloat(c.high as any),
        low: parseFloat(c.low as any),
        close: parseFloat(c.close as any),
        volume: c.volume,
        boardSnapshot: c.boardSnapshot,
      };
      const arr = bySymbol.get(c.symbol) || [];
      arr.push(candle);
      bySymbol.set(c.symbol, arr);
    }

    // Determine fixed day classification (end of day)
    let fixedDayUp = 0;
    let fixedDayDown = 0;
    for (const [sym, candles] of bySymbol) {
      if (candles.length < 2) continue;
      const dayChange = ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100;
      if (dayChange >= 0.3) fixedDayUp++;
      else if (dayChange <= -0.3) fixedDayDown++;
    }
    const isFixedUpDay = fixedDayUp >= Math.ceil(bySymbol.size * 0.6);

    // Process each symbol for SHORT medium signals
    for (const [symbol, candles] of bySymbol) {
      if (candles.length < 30) continue;

      // Compute indicators
      const closes = candles.map(c => c.close);
      const bb = calcBollinger(closes, 20, 2);
      
      // Compute VWAP incrementally
      const vwapValues: number[] = [];
      for (let i = 0; i < candles.length; i++) {
        vwapValues.push(computeVWAP(candles.slice(0, i + 1)));
      }

      // Enrich candles with indicators for detectSignals
      const enrichedCandles = candles.map((c, i) => ({
        ...c,
        ma5: null as number | null,
        ma25: null as number | null,
        rsi: null as number | null,
        bbUpper: bb.upper[i] ?? null,
        bbMiddle: bb.middle[i] ?? null,
        bbLower: bb.lower[i] ?? null,
        vwap: vwapValues[i],
      }));

      // Compute MA5, MA25
      for (let i = 0; i < enrichedCandles.length; i++) {
        if (i >= 4) {
          enrichedCandles[i].ma5 = closes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
        }
        if (i >= 24) {
          enrichedCandles[i].ma25 = closes.slice(i - 24, i + 1).reduce((a, b) => a + b, 0) / 25;
        }
      }

      // Detect signals
      const signals = detectSignals(enrichedCandles as any);

      // Filter for SHORT medium signals only (strong already allowed in baseline)
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        if (!sig) continue;
        if (sig.side !== "SHORT") continue;
        if (sig.confidence !== "medium") continue;

        // Time filter
        const time = candles[i].candleTime;
        if (time < "09:05" || time > "14:50") continue;
        if (time >= "11:00" && time <= "11:30") continue;
        if (time >= "12:30" && time <= "13:00") continue;

        // VWAP drop filter (improvement 2)
        if (sig.reason.includes("VWAPクロス下抜け") && i >= 5) {
          const drop5 = ((candles[i].close - candles[i - 5].close) / candles[i - 5].close) * 100;
          const drop3 = ((candles[i].close - candles[i - 3].close) / candles[i - 3].close) * 100;
          if (drop5 <= -0.8 || drop3 <= -0.6) continue;
        }

        // Afternoon BPR filter
        if (time >= "13:00" && sig.reason.includes("大台割れ")) {
          const board = candles[i].boardSnapshot;
          if (board && board.buyPressureRatio >= 0.65) continue;
        }

        // Simulate trade
        const tradeResult = simulateTrade(candles, i, "SHORT");
        const trade: Trade = {
          symbol,
          side: "SHORT",
          entryTime: time,
          entryPrice: candles[i].close,
          exitTime: candles[tradeResult.exitIdx]?.candleTime ?? "15:00",
          exitPrice: tradeResult.exitPrice,
          pnl: tradeResult.pnl,
          exitReason: tradeResult.exitReason,
          confidence: "medium",
          signalType: sig.reason.substring(0, 30),
          regime: "",
          date,
        };

        // C1: No filter - always allow
        tradesC1.push({ ...trade, regime: "none" });

        // C2: Fixed day classification - block on up days
        if (!isFixedUpDay) {
          tradesC2.push({ ...trade, regime: "fixed_not_up" });
        }

        // C3: Realtime regime
        const marketRegime = getMarketRegime(bySymbol, time);
        const symbolVwap = vwapValues[i];
        const closePrice = candles[i].close;

        // Conditions for C3:
        // ① 対象銘柄 < VWAP → SHORT OK
        // ② 市場弱気レジーム → 通常条件で許可
        // ③ 市場強気レジーム → 板スコア閾値+1（ここでは板signal=sell_pressureを要求）
        // ④ 中立 → 対象銘柄 < VWAP なら許可
        
        let c3Allowed = false;
        let c3Reason = "";

        if (marketRegime.regime === "bearish") {
          // 弱気レジーム: 通常条件で許可
          c3Allowed = true;
          c3Reason = `bearish(up=${marketRegime.upCount},down=${marketRegime.downCount},med=${marketRegime.medianChange.toFixed(2)}%)`;
        } else if (marketRegime.regime === "bullish") {
          // 強気レジーム: 対象銘柄 < VWAP かつ 板がsell_pressure
          const board = candles[i].boardSnapshot;
          if (closePrice < symbolVwap && board && board.signal === "sell_pressure") {
            c3Allowed = true;
            c3Reason = `bullish_exception(close<VWAP+sell_pressure)`;
          } else {
            c3Reason = `bullish_blocked(close${closePrice >= symbolVwap ? ">=VWAP" : "<VWAP"},board=${board?.signal ?? "null"})`;
          }
        } else {
          // 中立: 対象銘柄 < VWAP なら許可
          if (closePrice < symbolVwap) {
            c3Allowed = true;
            c3Reason = `neutral(close<VWAP)`;
          } else {
            c3Reason = `neutral_blocked(close>=VWAP)`;
          }
        }

        if (c3Allowed) {
          tradesC3.push({ ...trade, regime: c3Reason });
        }
      }
    }
  }

  // === Results ===
  console.log("=" .repeat(80));
  console.log("=== 3方式比較結果 ===");
  console.log("=" .repeat(80));

  function printStats(label: string, trades: Trade[]) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const bes = trades.filter(t => t.pnl === 0 || (t.pnl > -100 && t.pnl < 100));
    const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const pf = Math.abs(totalLoss) > 0 ? totalProfit / Math.abs(totalLoss) : Infinity;
    
    // Max DD
    let peak = 0;
    let cumPnl = 0;
    let maxDD = 0;
    for (const t of trades.sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`))) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = cumPnl - peak;
      if (dd < maxDD) maxDD = dd;
    }

    // By market phase
    const amTrades = trades.filter(t => t.entryTime < "12:30");
    const pmTrades = trades.filter(t => t.entryTime >= "12:30");
    const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);

    console.log(`\n--- ${label} ---`);
    console.log(`取引数: ${trades.length}件 | 勝率: ${trades.length > 0 ? Math.round(wins.length / trades.length * 100) : 0}% (${wins.length}勝${losses.length}敗${bes.length}BE)`);
    console.log(`総損益: ${netPnl >= 0 ? "+" : ""}${Math.round(netPnl)}円 | PF: ${pf === Infinity ? "∞" : pf.toFixed(2)} | 期待値: ${trades.length > 0 ? Math.round(netPnl / trades.length) : 0}円/回`);
    console.log(`最大DD: ${Math.round(maxDD)}円`);
    console.log(`平均利益: +${wins.length > 0 ? Math.round(totalProfit / wins.length) : 0}円 | 平均損失: ${losses.length > 0 ? Math.round(totalLoss / losses.length) : 0}円`);
    console.log(`前場: ${amTrades.length}件 ${amPnl >= 0 ? "+" : ""}${Math.round(amPnl)}円 | 後場: ${pmTrades.length}件 ${pmPnl >= 0 ? "+" : ""}${Math.round(pmPnl)}円`);

    // By date
    console.log(`\n  日別損益:`);
    const byDate = new Map<string, number>();
    for (const t of trades) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.pnl);
    }
    for (const [d, pnl] of [...byDate.entries()].sort()) {
      const count = trades.filter(t => t.date === d).length;
      console.log(`    ${d}: ${count}件 ${pnl >= 0 ? "+" : ""}${Math.round(pnl)}円`);
    }

    // Regime breakdown for C3
    if (label.includes("C3")) {
      console.log(`\n  レジーム別:`);
      const byRegime = new Map<string, { count: number; pnl: number }>();
      for (const t of trades) {
        const key = t.regime.split("(")[0];
        const cur = byRegime.get(key) || { count: 0, pnl: 0 };
        cur.count++;
        cur.pnl += t.pnl;
        byRegime.set(key, cur);
      }
      for (const [r, data] of byRegime) {
        console.log(`    ${r}: ${data.count}件 ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl)}円`);
      }
    }
  }

  printStats("C1: フィルターなし（SHORT medium全解除）", tradesC1);
  printStats("C2: 固定上昇日判定でブロック", tradesC2);
  printStats("C3: リアルタイム市場レジーム", tradesC3);

  // === Comparison table ===
  console.log("\n" + "=" .repeat(80));
  console.log("=== 比較サマリー ===");
  console.log("=" .repeat(80));
  
  function calcPF(trades: Trade[]) {
    const profit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return loss > 0 ? profit / loss : Infinity;
  }
  function calcDD(trades: Trade[]) {
    let peak = 0, cum = 0, maxDD = 0;
    for (const t of trades.sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`))) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      if (cum - peak < maxDD) maxDD = cum - peak;
    }
    return maxDD;
  }

  const scenarios = [
    { label: "C1: フィルターなし", trades: tradesC1 },
    { label: "C2: 固定上昇日判定", trades: tradesC2 },
    { label: "C3: リアルタイムレジーム", trades: tradesC3 },
  ];

  console.log("\nパターン | 取引数 | 勝率 | 総損益 | PF | 最大DD | 期待値");
  console.log("-".repeat(90));
  for (const s of scenarios) {
    const wins = s.trades.filter(t => t.pnl > 0).length;
    const wr = s.trades.length > 0 ? Math.round(wins / s.trades.length * 100) : 0;
    const netPnl = s.trades.reduce((sum, t) => sum + t.pnl, 0);
    const pf = calcPF(s.trades);
    const dd = calcDD(s.trades);
    const ev = s.trades.length > 0 ? Math.round(netPnl / s.trades.length) : 0;
    console.log(`${s.label} | ${s.trades.length}件 | ${wr}% | ${netPnl >= 0 ? "+" : ""}${Math.round(netPnl)}円 | ${pf === Infinity ? "∞" : pf.toFixed(2)} | ${Math.round(dd)}円 | ${ev}円/回`);
  }

  // 6/30 specific
  console.log("\n--- 6/30（上昇日）の比較 ---");
  for (const s of scenarios) {
    const dayTrades = s.trades.filter(t => t.date === "2026-06-30");
    const pnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`${s.label}: ${dayTrades.length}件 ${pnl >= 0 ? "+" : ""}${Math.round(pnl)}円`);
  }

  // Up days vs down days
  console.log("\n--- 上昇日 vs 下落日 ---");
  // Determine day type from data
  const dayTypes = new Map<string, string>();
  for (const date of dates) {
    const dayCandles = byDate.get(date)!;
    const bySymbol = new Map<string, Candle[]>();
    for (const c of dayCandles) {
      const candle: Candle = { symbol: c.symbol, candleTime: c.candleTime, open: parseFloat(c.open as any), high: parseFloat(c.high as any), low: parseFloat(c.low as any), close: parseFloat(c.close as any), volume: c.volume, boardSnapshot: c.boardSnapshot };
      const arr = bySymbol.get(c.symbol) || [];
      arr.push(candle);
      bySymbol.set(c.symbol, arr);
    }
    let up = 0, down = 0;
    for (const [, candles] of bySymbol) {
      if (candles.length < 2) continue;
      const chg = ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100;
      if (chg >= 0.3) up++;
      else if (chg <= -0.3) down++;
    }
    if (up >= Math.ceil(bySymbol.size * 0.6)) dayTypes.set(date, "上昇");
    else if (down >= Math.ceil(bySymbol.size * 0.6)) dayTypes.set(date, "下落");
    else dayTypes.set(date, "レンジ");
  }

  for (const s of scenarios) {
    const upDayTrades = s.trades.filter(t => dayTypes.get(t.date) === "上昇");
    const downDayTrades = s.trades.filter(t => dayTypes.get(t.date) === "下落");
    const upPnl = upDayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const downPnl = downDayTrades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`${s.label}: 上昇日 ${upDayTrades.length}件 ${upPnl >= 0 ? "+" : ""}${Math.round(upPnl)}円 | 下落日 ${downDayTrades.length}件 ${downPnl >= 0 ? "+" : ""}${Math.round(downPnl)}円`);
  }

  // C3 blocked trades analysis
  console.log("\n--- C3でブロックされたトレード分析 ---");
  const c3Blocked = tradesC1.filter(t1 => !tradesC3.some(t3 => t3.date === t1.date && t3.symbol === t1.symbol && t3.entryTime === t1.entryTime));
  const blockedPnl = c3Blocked.reduce((s, t) => s + t.pnl, 0);
  const blockedWins = c3Blocked.filter(t => t.pnl > 0);
  const blockedLosses = c3Blocked.filter(t => t.pnl < 0);
  console.log(`ブロック数: ${c3Blocked.length}件`);
  console.log(`ブロック分の損益: ${blockedPnl >= 0 ? "+" : ""}${Math.round(blockedPnl)}円`);
  console.log(`内訳: ${blockedWins.length}勝 ${blockedLosses.length}敗`);
  console.log(`ブロックによる損失回避: ${Math.round(Math.abs(blockedLosses.reduce((s, t) => s + t.pnl, 0)))}円`);
  console.log(`ブロックによる利益逸失: ${Math.round(blockedWins.reduce((s, t) => s + t.pnl, 0))}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
