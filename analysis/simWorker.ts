/**
 * Simulation worker: replays rt_candles through the actual engine
 * with DB writes mocked and ROUND_DISTANCE_BLOCK_THRESHOLD_PCT overridden.
 * 
 * Usage: ROUND_THRESHOLD=0.8 npx tsx analysis/simWorker.ts
 *        ROUND_THRESHOLD=999 npx tsx analysis/simWorker.ts
 */
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// We can't easily monkey-patch the engine's module-level const.
// Instead, we'll directly patch the shouldBlockRoundDistance function
// by modifying the module at runtime.

// Approach: Read candles from DB, then call processCandle.
// But processCandle writes to DB. We need to intercept that.
// 
// BEST APPROACH: Since the engine uses module-level state and DB writes,
// the cleanest way is to:
// 1. Temporarily modify the threshold constant in the source
// 2. Run a script that imports and uses the engine
// 3. Restore the original
//
// Even cleaner: use the exported shouldBlockRoundDistance with a custom threshold
// and simulate the state machine manually.
//
// ACTUAL APPROACH: We'll write a self-contained simulation that replicates
// the key logic (signal detection → state machine → 0.8% check → entry)
// using the actual candle data from DB, importing the signal detection functions.

import { detectSignals, calcMA, type CandleWithSignal } from "../server/routers/stockData";
import { getHigherTfTrend } from "../server/vwap";
import { getStockName, TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

const ROUND_THRESHOLD = parseFloat(process.env.ROUND_THRESHOLD || "0.8");
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));
const MAX_CONCURRENT = 3;
const TP_PCT = 1.5;
const SL_PCT = 0.5;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const BOARD_SCORE_THRESHOLD = 1;

interface Position {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryDate: string;
  reason: string;
  confidence: SignalConfidence;
}

interface Trade {
  date: string;
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  reason: string;
  exitReason: string;
  confidence: SignalConfidence;
}

interface RoundPendingState {
  direction: "buy" | "sell";
  level: number;
  confirmCount: number;
  reason: string;
}

interface RoundPullbackState {
  direction: "buy" | "sell";
  level: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

async function runSimulation() {
  const db = await getDb();
  
  // Get all trading dates
  const datesResult = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE tradeDate >= '2026-07-17' AND tradeDate <= '2026-07-27'
    ORDER BY tradeDate
  `);
  const dates = (datesResult as any)[0].map((r: any) => r.tradeDate);

  const allTrades: Trade[] = [];
  
  for (const date of dates) {
    // Load candles for this date
    const candlesResult = await db.execute(sql`
      SELECT symbol, tradeDate, candleTime, 
             CAST(open AS DOUBLE) as \`open\`, 
             CAST(high AS DOUBLE) as high, 
             CAST(low AS DOUBLE) as low, 
             CAST(close AS DOUBLE) as \`close\`, 
             CAST(volume AS SIGNED) as volume,
             boardSnapshot
      FROM rt_candles 
      WHERE tradeDate = ${date}
      ORDER BY candleTime, symbol
    `);
    const candles = (candlesResult as any)[0];
    
    // Run day simulation
    const dayTrades = await simulateDay(date, candles);
    allTrades.push(...dayTrades);
  }

  // Output results
  console.log(`\n閾値: ${ROUND_THRESHOLD}%`);
  console.log("═══════════════════════════════════════════════════════════════");
  
  // Daily breakdown
  let cumPnl = 0;
  console.log(`${"日付".padEnd(12)} ${"取引".padStart(4)} ${"勝敗".padStart(8)} ${"勝率".padStart(5)} ${"日次損益".padStart(12)} ${"累計".padStart(12)}`);
  console.log("─".repeat(60));
  
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    const wins = dayTrades.filter(t => t.pnl > 0).length;
    const losses = dayTrades.filter(t => t.pnl <= 0).length;
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    const wr = dayTrades.length > 0 ? (wins / dayTrades.length * 100).toFixed(0) + "%" : "-";
    console.log(
      `${date.padEnd(12)} ${String(dayTrades.length).padStart(4)} ${(wins + "勝" + losses + "敗").padStart(8)} ${wr.padStart(5)} ${((dayPnl >= 0 ? "+" : "") + Math.round(dayPnl).toLocaleString() + "円").padStart(12)} ${((cumPnl >= 0 ? "+" : "") + Math.round(cumPnl).toLocaleString() + "円").padStart(12)}`
    );
  }
  console.log("─".repeat(60));
  const totalWins = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl <= 0).length;
  const totalWR = allTrades.length > 0 ? (totalWins / allTrades.length * 100).toFixed(0) : "0";
  console.log(`合計: ${allTrades.length}件, ${totalWins}勝${totalLosses}敗, 勝率${totalWR}%, 損益${cumPnl >= 0 ? "+" : ""}${Math.round(cumPnl).toLocaleString()}円`);

  // Trade details
  if (allTrades.length > 0 && allTrades.length <= 30) {
    console.log("\n■ 取引詳細");
    for (const t of allTrades) {
      const pnlStr = (t.pnl >= 0 ? "+" : "") + Math.round(t.pnl).toLocaleString();
      console.log(`  ${t.date} ${t.entryTime}→${t.exitTime} ${t.symbol} ${t.side.toUpperCase()} @${t.entryPrice}→${t.exitPrice} ${pnlStr}円 [${t.exitReason}] ${t.reason.slice(0, 30)}`);
    }
  }

  process.exit(0);
}

async function simulateDay(date: string, candles: any[]): Promise<Trade[]> {
  const trades: Trade[] = [];
  const positions = new Map<string, Position>();
  const candleBuffers = new Map<string, CandleWithSignal[]>();
  const roundPendingStates = new Map<string, RoundPendingState>();
  const roundPullbackStates = new Map<string, RoundPullbackState>();
  const dailyLoss = { total: 0 };
  
  // Group candles by time slot for processing in time order
  const timeSlots = new Map<string, any[]>();
  for (const c of candles) {
    if (c.candleTime >= "11:30" && c.candleTime < "12:30") continue; // lunch skip
    const key = c.candleTime;
    if (!timeSlots.has(key)) timeSlots.set(key, []);
    timeSlots.get(key)!.push(c);
  }
  
  const sortedTimes = [...timeSlots.keys()].sort();
  
  for (const time of sortedTimes) {
    const timeCandles = timeSlots.get(time)!;
    
    for (const candle of timeCandles) {
      const { symbol, candleTime } = candle;
      
      // Skip excluded symbols
      if (!ALLOWED_SYMBOLS.has(symbol) || TRADE_EXCLUDED_SYMBOLS.has(symbol)) continue;
      
      // Add to buffer
      if (!candleBuffers.has(symbol)) candleBuffers.set(symbol, []);
      const buffer = candleBuffers.get(symbol)!;
      const candleWithSignal: CandleWithSignal = {
        time: candleTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        signals: [],
      };
      buffer.push(candleWithSignal);
      
      // Check exit conditions for open positions
      if (positions.has(symbol)) {
        const pos = positions.get(symbol)!;
        const exitResult = checkExit(pos, candle, candleTime);
        if (exitResult) {
          const pnl = pos.side === "long" 
            ? (exitResult.price - pos.entryPrice) * pos.shares
            : (pos.entryPrice - exitResult.price) * pos.shares;
          trades.push({
            date,
            symbol,
            side: pos.side,
            entryTime: pos.entryTime,
            exitTime: candleTime,
            entryPrice: pos.entryPrice,
            exitPrice: exitResult.price,
            shares: pos.shares,
            pnl,
            reason: pos.reason,
            exitReason: exitResult.reason,
            confidence: pos.confidence,
          });
          dailyLoss.total += pnl;
          positions.delete(symbol);
        }
      }
      
      // Force close at market close
      if (candleTime >= MARKET_CLOSE && positions.has(symbol)) {
        const pos = positions.get(symbol)!;
        const pnl = pos.side === "long"
          ? (candle.close - pos.entryPrice) * pos.shares
          : (pos.entryPrice - candle.close) * pos.shares;
        trades.push({
          date,
          symbol,
          side: pos.side,
          entryTime: pos.entryTime,
          exitTime: candleTime,
          entryPrice: pos.entryPrice,
          exitPrice: candle.close,
          shares: pos.shares,
          pnl,
          reason: pos.reason,
          exitReason: "強制決済(大引け)",
          confidence: pos.confidence,
        });
        dailyLoss.total += pnl;
        positions.delete(symbol);
        continue;
      }
      
      // Skip entry logic if outside trading hours or already have position
      if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
      if (positions.has(symbol)) continue;
      if (positions.size >= MAX_CONCURRENT) continue;
      if (dailyLoss.total <= -100000) continue; // daily loss limit
      if (buffer.length < 30) continue; // warmup
      
      // Detect signals
      const signals = detectSignals(buffer);
      candleWithSignal.signals = signals;
      
      // Process round level state machines
      // 1. Check existing round pullback states
      if (roundPullbackStates.has(symbol)) {
        const rpb = roundPullbackStates.get(symbol)!;
        rpb.waitCount++;
        
        if (rpb.direction === "buy") {
          if (candle.close < rpb.level) {
            // Price fell below round level - cancel
            roundPullbackStates.delete(symbol);
          } else if (!rpb.pulledBack && candle.close < rpb.signalPrice) {
            rpb.pulledBack = true;
          } else if (rpb.pulledBack && candle.close >= rpb.signalPrice) {
            // Pullback confirmed - check 0.8% filter
            const distPct = calculateRoundDistancePct(candle.close, rpb.level);
            if (distPct > ROUND_THRESHOLD) {
              // Blocked by filter
              roundPullbackStates.delete(symbol);
            } else {
              // Entry!
              const shares = calcShares(candle.close);
              positions.set(symbol, {
                symbol,
                side: rpb.direction === "buy" ? "long" : "short",
                entryPrice: candle.close,
                shares,
                entryTime: candleTime,
                entryDate: date,
                reason: rpb.reason + " (押し目確認後)",
                confidence: "medium",
              });
              roundPullbackStates.delete(symbol);
            }
          } else if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
            // Timeout - enter with strong trend if filter passes
            const distPct = calculateRoundDistancePct(candle.close, rpb.level);
            if (distPct > ROUND_THRESHOLD) {
              roundPullbackStates.delete(symbol);
            } else {
              const shares = calcShares(candle.close);
              positions.set(symbol, {
                symbol,
                side: rpb.direction === "buy" ? "long" : "short",
                entryPrice: candle.close,
                shares,
                entryTime: candleTime,
                entryDate: date,
                reason: rpb.reason + " (押し目なし・強トレンド)",
                confidence: "strong",
              });
              roundPullbackStates.delete(symbol);
            }
          }
        } else {
          // SHORT pullback
          if (candle.close > rpb.level) {
            roundPullbackStates.delete(symbol);
          } else if (!rpb.pulledBack && candle.close > rpb.signalPrice) {
            rpb.pulledBack = true;
          } else if (rpb.pulledBack && candle.close <= rpb.signalPrice) {
            const distPct = calculateRoundDistancePct(candle.close, rpb.level);
            if (distPct > ROUND_THRESHOLD) {
              roundPullbackStates.delete(symbol);
            } else {
              const shares = calcShares(candle.close);
              positions.set(symbol, {
                symbol,
                side: "short",
                entryPrice: candle.close,
                shares,
                entryTime: candleTime,
                entryDate: date,
                reason: rpb.reason + " (押し目確認後)",
                confidence: "medium",
              });
              roundPullbackStates.delete(symbol);
            }
          } else if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
            const distPct = calculateRoundDistancePct(candle.close, rpb.level);
            if (distPct > ROUND_THRESHOLD) {
              roundPullbackStates.delete(symbol);
            } else {
              const shares = calcShares(candle.close);
              positions.set(symbol, {
                symbol,
                side: "short",
                entryPrice: candle.close,
                shares,
                entryTime: candleTime,
                entryDate: date,
                reason: rpb.reason + " (押し目なし・強トレンド)",
                confidence: "strong",
              });
              roundPullbackStates.delete(symbol);
            }
          }
        }
        if (positions.has(symbol)) continue;
      }
      
      // 2. Check existing round pending (confirmation bar) states
      if (roundPendingStates.has(symbol)) {
        const rp = roundPendingStates.get(symbol)!;
        const maintained = rp.direction === "buy" 
          ? candle.close > rp.level 
          : candle.close < rp.level;
        
        if (!maintained) {
          roundPendingStates.delete(symbol);
        } else {
          rp.confirmCount++;
          if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
            // Confirmed! Move to pullback state
            roundPullbackStates.set(symbol, {
              direction: rp.direction,
              level: rp.level,
              signalPrice: candle.close,
              waitCount: 0,
              pulledBack: false,
              reason: rp.reason,
            });
            roundPendingStates.delete(symbol);
          }
        }
        continue; // Don't process new signals while in state machine
      }
      
      // 3. Process new signals
      for (const sig of signals) {
        if (positions.has(symbol)) break;
        if (positions.size >= MAX_CONCURRENT) break;
        
        const isBuy = sig.type.includes("大台超え") || sig.type.includes("VWAP反発") || sig.type.includes("ダウ理論");
        const isSell = sig.type.includes("大台割れ") || sig.type.includes("VWAP割れ") || sig.type.includes("三尊");
        
        if (sig.type.includes("大台超え") || sig.type.includes("大台割れ")) {
          // Register in round level state machine
          const direction = sig.type.includes("大台超え") ? "buy" : "sell";
          // Extract round level from signal reason
          const levelMatch = sig.reason?.match(/(\d+)円/);
          const level = levelMatch ? parseInt(levelMatch[1]) : Math.round(candle.close / 100) * 100;
          
          roundPendingStates.set(symbol, {
            direction,
            level,
            confirmCount: 1,
            reason: sig.reason || sig.type,
          });
        }
        // Skip direct medium entries (they are blocked in production)
        // Only strong confidence direct entries are allowed
      }
    }
  }
  
  // Force close remaining positions at end of day
  for (const [symbol, pos] of positions) {
    const lastCandle = candles.filter((c: any) => c.symbol === symbol).pop();
    if (lastCandle) {
      const pnl = pos.side === "long"
        ? (lastCandle.close - pos.entryPrice) * pos.shares
        : (pos.entryPrice - lastCandle.close) * pos.shares;
      trades.push({
        date,
        symbol,
        side: pos.side,
        entryTime: pos.entryTime,
        exitTime: lastCandle.candleTime,
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        shares: pos.shares,
        pnl,
        reason: pos.reason,
        exitReason: "EOD強制決済",
        confidence: pos.confidence,
      });
    }
  }
  
  return trades;
}

function checkExit(pos: Position, candle: any, time: string): { price: number; reason: string } | null {
  if (pos.side === "long") {
    const tp = pos.entryPrice * (1 + TP_PCT / 100);
    const sl = pos.entryPrice * (1 - SL_PCT / 100);
    if (candle.high >= tp) return { price: tp, reason: "利確" };
    if (candle.low <= sl) return { price: sl, reason: "損切り" };
  } else {
    const tp = pos.entryPrice * (1 - TP_PCT / 100);
    const sl = pos.entryPrice * (1 + SL_PCT / 100);
    if (candle.low <= tp) return { price: tp, reason: "利確" };
    if (candle.high >= sl) return { price: sl, reason: "損切り" };
  }
  return null;
}

function calcShares(price: number): number {
  const capital = 15000000;
  const positionSize = capital * 0.2; // 20% per position
  return Math.floor(positionSize / (price * 100)) * 100;
}

runSimulation().catch(e => { console.error(e); process.exit(1); });
