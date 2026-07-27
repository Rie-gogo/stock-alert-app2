import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { detectSignals } from "../server/routers/stockData";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("No DATABASE_URL"); process.exit(1); }

const db = drizzle(DATABASE_URL);

// Engine parameters
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const MARKET_CLOSE_TIME = "15:25";
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const ROUND_DISTANCE_BLOCK_THRESHOLD_PCT = 0.8;
const HTF_TIMEFRAME_MINUTES = 3;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;
const PM_HIGHZONE_THRESHOLD = 0.04;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const MAX_TOTAL_EXPOSURE = 8_910_000;

// Active symbols after 7/16 (excluding TRADE_EXCLUDED)
const TRADE_EXCLUDED = new Set(["3778","4568","6526","6723","6758","6976","7011","7203","8306","8316"]);
const ALL_SYMBOLS = ["285A","3436","3778","4568","5016","5803","6526","6723","6758","6857","6920","6976","6981","7011","7203","8035","8306","8316","9107","9984"];
// After 7/23 some were re-added: 6976, 6526, 9107
const ALLOWED_BEFORE_723 = ALL_SYMBOLS.filter(s => !TRADE_EXCLUDED.has(s));
const READDED_723 = new Set(["6976","6526","9107"]);

function getAllowedSymbols(date: string): string[] {
  if (date >= "2026-07-23") {
    return [...ALLOWED_BEFORE_723, ...Array.from(READDED_723).filter(s => !ALLOWED_BEFORE_723.includes(s))];
  }
  return ALLOWED_BEFORE_723;
}

function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function detectRoundLevel(prev: number, curr: number): { crossedBelow: boolean; crossedAbove: boolean; level: number | null } {
  const step = 100;
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  if (prevLevel === currLevel) return { crossedBelow: false, crossedAbove: false, level: null };
  if (currLevel < prevLevel) return { crossedBelow: true, crossedAbove: false, level: currLevel + step };
  return { crossedBelow: false, crossedAbove: true, level: currLevel };
}

function getHigherTfTrend(buffer: any[], idx: number, minutes: number): "up" | "down" | "neutral" {
  if (buffer.length < minutes) return "neutral";
  const slice = buffer.slice(Math.max(0, idx - minutes + 1), idx + 1);
  if (slice.length < 2) return "neutral";
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  const changePct = (last - first) / first * 100;
  if (changePct > 0.1) return "up";
  if (changePct < -0.1) return "down";
  return "neutral";
}

interface Candle { open: number; high: number; low: number; close: number; volume: number; time: string; }
interface Position { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; reason: string; tp: number; sl: number; }
interface Trade { symbol: string; side: string; entryPrice: number; exitPrice: number; entryTime: string; exitTime: string; shares: number; pnl: number; reason: string; exitReason: string; }

async function simulateDay(date: string, useFilter: boolean): Promise<Trade[]> {
  const allowed = getAllowedSymbols(date);
  
  // Fetch candles for this date
  const rows: any[] = await db.execute(sql`
    SELECT symbol, candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE DATE(candleTime) = ${date}
    AND symbol IN (${sql.raw(allowed.map(s => `'${s}'`).join(','))})
    ORDER BY candleTime ASC
  `);
  
  if (!rows || rows.length === 0) return [];
  
  // Group by symbol
  const bySymbol = new Map<string, Candle[]>();
  for (const r of (rows as any)) {
    const sym = r.symbol;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    const timeStr = new Date(r.candleTime).toTimeString().substring(0, 5);
    bySymbol.get(sym)!.push({ open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume), time: timeStr });
  }
  
  const trades: Trade[] = [];
  
  for (const [symbol, candles] of bySymbol) {
    const positions: Position[] = [];
    const dayTrades: Trade[] = [];
    const buffer: Candle[] = [];
    
    // State machines
    let roundPending: { direction: "buy"|"sell"; level: number; confirmCount: number; reason: string } | null = null;
    let roundPullback: { direction: "buy"|"sell"; level: number; signalPrice: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
    let pullbackState: { recentSwingLow: number; signalPrice: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
    
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleTime = candle.time;
      buffer.push(candle);
      
      // Skip lunch
      if (candleTime >= "11:30" && candleTime < "12:30") continue;
      
      // Exit check for open positions
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        let exitPrice = 0;
        let exitReason = "";
        
        if (candleTime >= MARKET_CLOSE_TIME) {
          exitPrice = candle.close;
          exitReason = "大引け決済";
        } else if (pos.side === "long") {
          if (candle.low <= pos.sl) { exitPrice = pos.sl; exitReason = "損切り"; }
          else if (candle.high >= pos.tp) { exitPrice = pos.tp; exitReason = "利確"; }
        } else {
          if (candle.high >= pos.sl) { exitPrice = pos.sl; exitReason = "損切り"; }
          else if (candle.low <= pos.tp) { exitPrice = pos.tp; exitReason = "利確"; }
        }
        
        if (exitPrice > 0) {
          const pnl = pos.side === "long" 
            ? (exitPrice - pos.entryPrice) * pos.shares 
            : (pos.entryPrice - exitPrice) * pos.shares;
          dayTrades.push({ symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice, entryTime: pos.entryTime, exitTime: candleTime, shares: pos.shares, pnl, reason: pos.reason, exitReason });
          positions.splice(p, 1);
        }
      }
      
      // Entry logic
      if (positions.length > 0) continue; // One position per symbol at a time
      if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
      if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
      
      // --- State Machine Processing ---
      // Round level confirmation bar
      if (roundPending) {
        roundPending.confirmCount++;
        if (roundPending.direction === "buy" && candle.close < roundPending.level) {
          roundPending = null;
        } else if (roundPending.direction === "sell" && candle.close > roundPending.level) {
          roundPending = null;
        } else if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
          // Move to pullback state
          roundPullback = { direction: roundPending.direction, level: roundPending.level, signalPrice: candle.close, waitCount: 0, pulledBack: false, reason: roundPending.reason };
          roundPending = null;
        }
        if (roundPending) continue; // Still waiting for confirmation
      }
      
      // Round pullback state
      if (roundPullback) {
        roundPullback.waitCount++;
        const side = roundPullback.direction;
        
        // Cancel if price crosses back
        if (side === "buy" && candle.close < roundPullback.level) { roundPullback = null; continue; }
        if (side === "sell" && candle.close > roundPullback.level) { roundPullback = null; continue; }
        
        // Timeout: strong trend entry
        if (roundPullback.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          // HTF check at entry
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
          if (side === "buy" && htfTrend === "down") { roundPullback = null; continue; }
          if (side === "sell" && htfTrend === "up") { roundPullback = null; continue; }
          
          // 0.8% filter check
          if (useFilter) {
            const distPct = Math.abs(candle.close - roundPullback.level) / roundPullback.level * 100;
            if (distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) { roundPullback = null; continue; }
          }
          
          // Enter
          const shares = calcShares(candle.close);
          const tp = side === "long" ? candle.close * (1 + TAKE_PROFIT_PERCENT / 100) : candle.close * (1 - TAKE_PROFIT_PERCENT / 100);
          const sl = side === "long" ? candle.close * (1 - STOP_LOSS_PERCENT / 100) : candle.close * (1 + STOP_LOSS_PERCENT / 100);
          positions.push({ symbol, side, entryPrice: candle.close, shares, entryTime: candleTime, reason: roundPullback.reason, tp, sl });
          roundPullback = null;
          continue;
        }
        
        // Pullback detection
        if (side === "buy") {
          if (!roundPullback.pulledBack && candle.close < roundPullback.signalPrice) roundPullback.pulledBack = true;
          if (roundPullback.pulledBack && candle.close > roundPullback.signalPrice) {
            // HTF check
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
            if (htfTrend === "down") { roundPullback = null; continue; }
            // 0.8% filter
            if (useFilter) {
              const distPct = Math.abs(candle.close - roundPullback.level) / roundPullback.level * 100;
              if (distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) { roundPullback = null; continue; }
            }
            const shares = calcShares(candle.close);
            const tp = candle.close * (1 + TAKE_PROFIT_PERCENT / 100);
            const sl = candle.close * (1 - STOP_LOSS_PERCENT / 100);
            positions.push({ symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, reason: roundPullback.reason, tp, sl });
            roundPullback = null;
            continue;
          }
        } else {
          if (!roundPullback.pulledBack && candle.close > roundPullback.signalPrice) roundPullback.pulledBack = true;
          if (roundPullback.pulledBack && candle.close < roundPullback.signalPrice) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
            if (htfTrend === "up") { roundPullback = null; continue; }
            if (useFilter) {
              const distPct = Math.abs(candle.close - roundPullback.level) / roundPullback.level * 100;
              if (distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) { roundPullback = null; continue; }
            }
            const shares = calcShares(candle.close);
            const tp = candle.close * (1 - TAKE_PROFIT_PERCENT / 100);
            const sl = candle.close * (1 + STOP_LOSS_PERCENT / 100);
            positions.push({ symbol, side: "short", entryPrice: candle.close, shares, entryTime: candleTime, reason: roundPullback.reason, tp, sl });
            roundPullback = null;
            continue;
          }
        }
        continue;
      }
      
      // Dow pullback state
      if (pullbackState) {
        pullbackState.waitCount++;
        if (candle.low < pullbackState.recentSwingLow || pullbackState.waitCount > 10) {
          pullbackState = null;
        } else {
          if (!pullbackState.pulledBack && candle.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && candle.close > pullbackState.signalPrice) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
            if (htfTrend !== "down") {
              const shares = calcShares(candle.close);
              const tp = candle.close * (1 + TAKE_PROFIT_PERCENT / 100);
              const sl = candle.close * (1 - STOP_LOSS_PERCENT / 100);
              positions.push({ symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, reason: pullbackState.reason, tp, sl });
            }
            pullbackState = null;
            continue;
          }
          continue;
        }
      }
      
      // Signal detection
      if (buffer.length < 30) continue; // Need enough data for MA calculation
      
      const withSignals = detectSignals(buffer as any);
      const latestSignal = withSignals[withSignals.length - 1];
      if (!latestSignal?.signal) continue;
      
      const sig = latestSignal.signal;
      
      // isBullish calculation
      const isBullish = (() => {
        if (buffer.length < IS_BULLISH_MA_PERIOD + 1) {
          const openPrice = buffer[0].open;
          return (candle.close - openPrice) / openPrice * 100 >= 0.2;
        }
        const currentSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).map(c => c.close);
        const currentMA = currentSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
        const prevSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD - 1, buffer.length - 1).map(c => c.close);
        const prevMA = prevSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
        const slope = (currentMA - prevMA) / prevMA * 100;
        return slope > IS_BULLISH_SLOPE_THRESHOLD;
      })();
      
      // BUY signals
      if (sig.type === "buy") {
        if (sig.reason.includes("VWAPクロス上抜け")) continue;
        
        // HTF filter
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (htfTrend === "down") continue;
        
        // Dow theory → pullback SM
        if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
          if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
            const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
            const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
            const swingLow = Math.min(...lookbackWindow.map(c => c.low));
            if (swingHigh > swingLow) {
              const pullbackDepth = (swingHigh - candle.close) / (swingHigh - swingLow);
              if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) continue;
            }
          }
          pullbackState = { recentSwingLow: sig.recentSwingLow, signalPrice: candle.close, waitCount: 0, pulledBack: false, reason: sig.reason };
          continue;
        }
        
        // 大台超え → confirmation SM
        if (sig.reason.startsWith("大台超え")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : candle.close;
          roundPending = { direction: "buy", level, confirmCount: 0, reason: sig.reason };
          continue;
        }
        
        // Medium block (non-SM entries)
        if (sig.confidence === "medium") continue;
        
        // Strong direct entry
        // Afternoon high zone filter
        if (candleTime >= "13:00") {
          const openPrice = buffer[0].open;
          if ((candle.close - openPrice) / openPrice >= PM_HIGHZONE_THRESHOLD) continue;
        }
        
        const shares = calcShares(candle.close);
        const tp = candle.close * (1 + TAKE_PROFIT_PERCENT / 100);
        const sl = candle.close * (1 - STOP_LOSS_PERCENT / 100);
        positions.push({ symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, reason: sig.reason, tp, sl });
      }
      
      // SELL signals
      if (sig.type === "sell") {
        if (isBullish) continue;
        
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (htfTrend === "up") continue;
        
        // 大台割れ → confirmation SM
        if (sig.reason.startsWith("大台割れ")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : candle.close;
          roundPending = { direction: "sell", level, confirmCount: 0, reason: sig.reason };
          continue;
        }
        
        // SHORT medium全ブロック
        if (sig.confidence === "medium") continue;
        
        // Afternoon low zone filter
        if (candleTime >= "13:00") {
          const openPrice = buffer[0].open;
          if ((candle.close - openPrice) / openPrice <= -0.05) continue;
        }
        
        const shares = calcShares(candle.close);
        const tp = candle.close * (1 - TAKE_PROFIT_PERCENT / 100);
        const sl = candle.close * (1 + STOP_LOSS_PERCENT / 100);
        positions.push({ symbol, side: "short", entryPrice: candle.close, shares, entryTime: candleTime, reason: sig.reason, tp, sl });
      }
    }
    
    // Force close any remaining positions at last candle
    for (const pos of positions) {
      const lastCandle = candles[candles.length - 1];
      const pnl = pos.side === "long" 
        ? (lastCandle.close - pos.entryPrice) * pos.shares 
        : (pos.entryPrice - lastCandle.close) * pos.shares;
      dayTrades.push({ symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice: lastCandle.close, entryTime: pos.entryTime, exitTime: lastCandle.time, shares: pos.shares, pnl, reason: pos.reason, exitReason: "大引け決済" });
    }
    
    trades.push(...dayTrades);
  }
  
  return trades;
}

async function main() {
  const dates = ["2026-07-17","2026-07-21","2026-07-22","2026-07-23","2026-07-24","2026-07-27"];
  
  console.log("=== 30日間シミュレーション比較: 0.8%フィルターあり vs なし ===\n");
  console.log("日付       | フィルターあり                    | フィルターなし                    | 差分");
  console.log("           | 取引  勝率    損益               | 取引  勝率    損益               |");
  console.log("-".repeat(100));
  
  let totalWithFilter = { trades: 0, wins: 0, pnl: 0 };
  let totalNoFilter = { trades: 0, wins: 0, pnl: 0 };
  const dailyResults: { date: string; withFilter: Trade[]; noFilter: Trade[] }[] = [];
  
  for (const date of dates) {
    const withFilter = await simulateDay(date, true);
    const noFilter = await simulateDay(date, false);
    
    dailyResults.push({ date, withFilter, noFilter });
    
    const wfWins = withFilter.filter(t => t.pnl > 0).length;
    const nfWins = noFilter.filter(t => t.pnl > 0).length;
    const wfPnl = withFilter.reduce((s, t) => s + t.pnl, 0);
    const nfPnl = noFilter.reduce((s, t) => s + t.pnl, 0);
    const wfWr = withFilter.length > 0 ? (wfWins / withFilter.length * 100).toFixed(0) : "-";
    const nfWr = noFilter.length > 0 ? (nfWins / noFilter.length * 100).toFixed(0) : "-";
    
    totalWithFilter.trades += withFilter.length;
    totalWithFilter.wins += wfWins;
    totalWithFilter.pnl += wfPnl;
    totalNoFilter.trades += noFilter.length;
    totalNoFilter.wins += nfWins;
    totalNoFilter.pnl += nfPnl;
    
    const diff = nfPnl - wfPnl;
    console.log(`${date} | ${String(withFilter.length).padStart(3)}件 ${String(wfWr).padStart(3)}% ${String(Math.round(wfPnl)).padStart(10)}円 | ${String(noFilter.length).padStart(3)}件 ${String(nfWr).padStart(3)}% ${String(Math.round(nfPnl)).padStart(10)}円 | ${diff >= 0 ? '+' : ''}${Math.round(diff)}円`);
  }
  
  console.log("-".repeat(100));
  const wfWr = totalWithFilter.trades > 0 ? (totalWithFilter.wins / totalWithFilter.trades * 100).toFixed(0) : "-";
  const nfWr = totalNoFilter.trades > 0 ? (totalNoFilter.wins / totalNoFilter.trades * 100).toFixed(0) : "-";
  const diff = totalNoFilter.pnl - totalWithFilter.pnl;
  console.log(`合計       | ${String(totalWithFilter.trades).padStart(3)}件 ${String(wfWr).padStart(3)}% ${String(Math.round(totalWithFilter.pnl)).padStart(10)}円 | ${String(totalNoFilter.trades).padStart(3)}件 ${String(nfWr).padStart(3)}% ${String(Math.round(totalNoFilter.pnl)).padStart(10)}円 | ${diff >= 0 ? '+' : ''}${Math.round(diff)}円`);
  
  // Show the trades that are ONLY in noFilter (blocked by 0.8% filter)
  console.log("\n\n=== 0.8%フィルターでブロックされた取引（フィルターなしのみ存在） ===\n");
  for (const { date, withFilter, noFilter } of dailyResults) {
    const wfKeys = new Set(withFilter.map(t => `${t.symbol}_${t.entryTime}`));
    const blocked = noFilter.filter(t => !wfKeys.has(`${t.symbol}_${t.entryTime}`));
    if (blocked.length === 0) continue;
    console.log(`\n--- ${date} (ブロック${blocked.length}件) ---`);
    for (const t of blocked) {
      const result = t.pnl > 0 ? "勝" : "負";
      console.log(`  ${t.symbol} ${t.side.toUpperCase()} ${t.entryTime}→${t.exitTime} @${t.entryPrice}→${t.exitPrice} ${result} ${Math.round(t.pnl)}円 [${t.exitReason}] ${t.reason.substring(0, 40)}`);
    }
  }
  
  // Summary of blocked trades
  const allBlocked: Trade[] = [];
  for (const { withFilter, noFilter } of dailyResults) {
    const wfKeys = new Set(withFilter.map(t => `${t.symbol}_${t.entryTime}`));
    allBlocked.push(...noFilter.filter(t => !wfKeys.has(`${t.symbol}_${t.entryTime}`)));
  }
  
  if (allBlocked.length > 0) {
    const blockedWins = allBlocked.filter(t => t.pnl > 0).length;
    const blockedPnl = allBlocked.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n\n=== ブロック取引サマリー ===`);
    console.log(`件数: ${allBlocked.length}件`);
    console.log(`勝率: ${(blockedWins / allBlocked.length * 100).toFixed(0)}% (${blockedWins}勝${allBlocked.length - blockedWins}敗)`);
    console.log(`合計損益: ${Math.round(blockedPnl)}円`);
    console.log(`1件平均: ${Math.round(blockedPnl / allBlocked.length)}円`);
    console.log(`\n→ フィルターが正当: ブロック対象の合計損益がマイナスなら有効`);
    console.log(`→ フィルターが過剰: ブロック対象の合計損益がプラスなら機会損失`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
