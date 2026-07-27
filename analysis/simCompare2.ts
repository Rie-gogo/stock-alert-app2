import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { detectSignals } from "../server/routers/stockData";

const db = drizzle(process.env.DATABASE_URL!);

// Engine parameters
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE_TIME = "15:25";
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

const TRADE_EXCLUDED = new Set(["3778","4568","6526","6723","6758","6976","7011","7203","8306","8316"]);
const ALL_SYMBOLS = ["285A","3436","3778","4568","5016","5803","6526","6723","6758","6857","6920","6976","6981","7011","7203","8035","8306","8316","9107","9984"];
const ALLOWED_BEFORE_723 = ALL_SYMBOLS.filter(s => !TRADE_EXCLUDED.has(s));

function getAllowedSymbols(date: string): string[] {
  if (date >= "2026-07-23") {
    return [...new Set([...ALLOWED_BEFORE_723, "6976", "6526", "9107"])];
  }
  return ALLOWED_BEFORE_723;
}

function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  return Math.max(100, Math.floor(Math.floor(amount / price) / 100) * 100);
}

function getHigherTfTrend(buffer: any[], idx: number, minutes: number): "up" | "down" | "neutral" {
  if (buffer.length < minutes) return "neutral";
  const slice = buffer.slice(Math.max(0, idx - minutes + 1), idx + 1);
  if (slice.length < 2) return "neutral";
  const changePct = (slice[slice.length - 1].close - slice[0].close) / slice[0].close * 100;
  if (changePct > 0.1) return "up";
  if (changePct < -0.1) return "down";
  return "neutral";
}

interface Candle { open: number; high: number; low: number; close: number; volume: number; time: string; }
interface Position { symbol: string; side: "long"|"short"; entryPrice: number; shares: number; entryTime: string; reason: string; tp: number; sl: number; }
interface Trade { symbol: string; side: string; entryPrice: number; exitPrice: number; entryTime: string; exitTime: string; shares: number; pnl: number; reason: string; exitReason: string; blockedByFilter: boolean; }

async function simulateDay(date: string, useFilter: boolean): Promise<Trade[]> {
  const allowed = getAllowedSymbols(date);
  
  const [rows] = await db.execute(sql`
    SELECT symbol, candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = ${date}
    ORDER BY candleTime ASC, symbol ASC
  `) as any[];
  
  if (!rows || rows.length === 0) return [];
  
  // Group by symbol, filter to allowed
  const bySymbol = new Map<string, Candle[]>();
  for (const r of rows) {
    const sym = r.symbol as string;
    if (!allowed.includes(sym)) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push({
      open: parseFloat(r.open), high: parseFloat(r.high),
      low: parseFloat(r.low), close: parseFloat(r.close),
      volume: parseInt(r.volume), time: r.candleTime as string
    });
  }
  
  const trades: Trade[] = [];
  
  for (const [symbol, candles] of bySymbol) {
    const positions: Position[] = [];
    const buffer: Candle[] = [];
    let roundPending: { direction: "buy"|"sell"; level: number; confirmCount: number; reason: string } | null = null;
    let roundPullback: { direction: "buy"|"sell"; level: number; signalPrice: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
    let pullbackState: { recentSwingLow: number; signalPrice: number; waitCount: number; pulledBack: boolean; reason: string } | null = null;
    
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleTime = candle.time;
      buffer.push(candle);
      
      // Skip lunch
      if (candleTime >= "11:30" && candleTime < "12:30") continue;
      
      // Exit check
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        let exitPrice = 0, exitReason = "";
        
        if (candleTime >= MARKET_CLOSE_TIME) {
          exitPrice = candle.close; exitReason = "大引け決済";
        } else if (pos.side === "long") {
          if (candle.low <= pos.sl) { exitPrice = pos.sl; exitReason = "損切り"; }
          else if (candle.high >= pos.tp) { exitPrice = pos.tp; exitReason = "利確"; }
        } else {
          if (candle.high >= pos.sl) { exitPrice = pos.sl; exitReason = "損切り"; }
          else if (candle.low <= pos.tp) { exitPrice = pos.tp; exitReason = "利確"; }
        }
        
        if (exitPrice > 0) {
          const pnl = pos.side === "long" ? (exitPrice - pos.entryPrice) * pos.shares : (pos.entryPrice - exitPrice) * pos.shares;
          trades.push({ symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice, entryTime: pos.entryTime, exitTime: candleTime, shares: pos.shares, pnl, reason: pos.reason, exitReason, blockedByFilter: false });
          positions.splice(p, 1);
        }
      }
      
      // Entry logic
      if (positions.length > 0) continue;
      if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= "11:00" && candleTime < "11:30") continue;
      if (candleTime >= "12:30" && candleTime < "13:00") continue;
      
      // State machine: round level confirmation
      if (roundPending) {
        roundPending.confirmCount++;
        if (roundPending.direction === "buy" && candle.close < roundPending.level) { roundPending = null; }
        else if (roundPending.direction === "sell" && candle.close > roundPending.level) { roundPending = null; }
        else if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
          roundPullback = { direction: roundPending.direction, level: roundPending.level, signalPrice: candle.close, waitCount: 0, pulledBack: false, reason: roundPending.reason };
          roundPending = null;
        }
        if (roundPending) continue;
      }
      
      // State machine: round pullback
      if (roundPullback) {
        roundPullback.waitCount++;
        const side = roundPullback.direction;
        if (side === "buy" && candle.close < roundPullback.level) { roundPullback = null; continue; }
        if (side === "sell" && candle.close > roundPullback.level) { roundPullback = null; continue; }
        
        let shouldEnter = false;
        if (roundPullback.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          // Timeout entry
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
          if (side === "buy" && htfTrend === "down") { roundPullback = null; continue; }
          if (side === "sell" && htfTrend === "up") { roundPullback = null; continue; }
          shouldEnter = true;
        } else {
          // Pullback detection
          if (side === "buy") {
            if (!roundPullback.pulledBack && candle.close < roundPullback.signalPrice) roundPullback.pulledBack = true;
            if (roundPullback.pulledBack && candle.close > roundPullback.signalPrice) {
              const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
              if (htfTrend === "down") { roundPullback = null; continue; }
              shouldEnter = true;
            }
          } else {
            if (!roundPullback.pulledBack && candle.close > roundPullback.signalPrice) roundPullback.pulledBack = true;
            if (roundPullback.pulledBack && candle.close < roundPullback.signalPrice) {
              const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
              if (htfTrend === "up") { roundPullback = null; continue; }
              shouldEnter = true;
            }
          }
        }
        
        if (shouldEnter) {
          // 0.8% filter check
          const distPct = Math.abs(candle.close - roundPullback.level) / roundPullback.level * 100;
          if (useFilter && distPct > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) {
            roundPullback = null; continue;
          }
          const shares = calcShares(candle.close);
          const tp = side === "long" ? candle.close * (1 + TAKE_PROFIT_PERCENT / 100) : candle.close * (1 - TAKE_PROFIT_PERCENT / 100);
          const sl = side === "long" ? candle.close * (1 - STOP_LOSS_PERCENT / 100) : candle.close * (1 + STOP_LOSS_PERCENT / 100);
          positions.push({ symbol, side, entryPrice: candle.close, shares, entryTime: candleTime, reason: roundPullback.reason + ` [乖離${distPct.toFixed(2)}%]`, tp, sl });
          roundPullback = null;
          continue;
        }
        continue;
      }
      
      // Dow pullback state
      if (pullbackState) {
        pullbackState.waitCount++;
        if (candle.low < pullbackState.recentSwingLow || pullbackState.waitCount > 10) { pullbackState = null; }
        else {
          if (!pullbackState.pulledBack && candle.close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && candle.close > pullbackState.signalPrice) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
            if (htfTrend !== "down") {
              const shares = calcShares(candle.close);
              positions.push({ symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, reason: pullbackState.reason, tp: candle.close * 1.015, sl: candle.close * 0.995 });
            }
            pullbackState = null; continue;
          }
          continue;
        }
      }
      
      // Signal detection
      if (buffer.length < 30) continue;
      
      const withSignals = detectSignals(buffer as any);
      const latestSignal = withSignals[withSignals.length - 1];
      if (!latestSignal?.signal) continue;
      const sig = latestSignal.signal;
      
      // isBullish
      const isBullish = (() => {
        if (buffer.length < IS_BULLISH_MA_PERIOD + 1) return (candle.close - buffer[0].open) / buffer[0].open * 100 >= 0.2;
        const cur = buffer.slice(-IS_BULLISH_MA_PERIOD).map(c => c.close);
        const curMA = cur.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
        const prev = buffer.slice(-IS_BULLISH_MA_PERIOD - 1, -1).map(c => c.close);
        const prevMA = prev.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
        return (curMA - prevMA) / prevMA * 100 > IS_BULLISH_SLOPE_THRESHOLD;
      })();
      
      // BUY
      if (sig.type === "buy") {
        if (sig.reason.includes("VWAPクロス上抜け")) continue;
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (htfTrend === "down") continue;
        
        if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
          if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
            const w = buffer.slice(-PULLBACK_DEPTH_LOOKBACK);
            const sh = Math.max(...w.map(c => c.high)), sl2 = Math.min(...w.map(c => c.low));
            if (sh > sl2) { const d = (sh - candle.close) / (sh - sl2); if (d < PULLBACK_DEPTH_MIN || d > PULLBACK_DEPTH_MAX) continue; }
          }
          pullbackState = { recentSwingLow: sig.recentSwingLow, signalPrice: candle.close, waitCount: 0, pulledBack: false, reason: sig.reason };
          continue;
        }
        if (sig.reason.startsWith("大台超え")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          roundPending = { direction: "buy", level: m ? parseFloat(m[1]) : candle.close, confirmCount: 0, reason: sig.reason };
          continue;
        }
        if (sig.confidence === "medium") continue;
        if (candleTime >= "13:00" && (candle.close - buffer[0].open) / buffer[0].open >= PM_HIGHZONE_THRESHOLD) continue;
        const shares = calcShares(candle.close);
        positions.push({ symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, reason: sig.reason, tp: candle.close * 1.015, sl: candle.close * 0.995 });
      }
      
      // SELL
      if (sig.type === "sell") {
        if (isBullish) continue;
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, HTF_TIMEFRAME_MINUTES);
        if (htfTrend === "up") continue;
        
        if (sig.reason.startsWith("大台割れ")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          roundPending = { direction: "sell", level: m ? parseFloat(m[1]) : candle.close, confirmCount: 0, reason: sig.reason };
          continue;
        }
        if (sig.confidence === "medium") continue;
        if (candleTime >= "13:00" && (candle.close - buffer[0].open) / buffer[0].open <= -0.05) continue;
        const shares = calcShares(candle.close);
        positions.push({ symbol, side: "short", entryPrice: candle.close, shares, entryTime: candleTime, reason: sig.reason, tp: candle.close * 0.985, sl: candle.close * 1.005 });
      }
    }
    
    // Force close remaining
    for (const pos of positions) {
      const last = candles[candles.length - 1];
      const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
      trades.push({ symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice: last.close, entryTime: pos.entryTime, exitTime: last.time, shares: pos.shares, pnl, reason: pos.reason, exitReason: "大引け決済", blockedByFilter: false });
    }
  }
  return trades;
}

async function main() {
  const dates = ["2026-07-17","2026-07-21","2026-07-22","2026-07-23","2026-07-24","2026-07-27"];
  
  console.log("=== 7/17-7/27 シミュレーション比較: 0.8%フィルターあり vs なし ===\n");
  console.log("日付       | フィルターあり                    | フィルターなし                    | 差分");
  console.log("-".repeat(100));
  
  let totWF = { n: 0, w: 0, pnl: 0 }, totNF = { n: 0, w: 0, pnl: 0 };
  const allBlockedTrades: Trade[] = [];
  
  for (const date of dates) {
    const wf = await simulateDay(date, true);
    const nf = await simulateDay(date, false);
    
    const wfW = wf.filter(t => t.pnl > 0).length, nfW = nf.filter(t => t.pnl > 0).length;
    const wfP = wf.reduce((s, t) => s + t.pnl, 0), nfP = nf.reduce((s, t) => s + t.pnl, 0);
    totWF.n += wf.length; totWF.w += wfW; totWF.pnl += wfP;
    totNF.n += nf.length; totNF.w += nfW; totNF.pnl += nfP;
    
    const wfWr = wf.length > 0 ? `${(wfW/wf.length*100).toFixed(0)}%` : " -%";
    const nfWr = nf.length > 0 ? `${(nfW/nf.length*100).toFixed(0)}%` : " -%";
    const diff = nfP - wfP;
    console.log(`${date} | ${String(wf.length).padStart(3)}件 ${wfWr.padStart(4)} ${String(Math.round(wfP)).padStart(10)}円 | ${String(nf.length).padStart(3)}件 ${nfWr.padStart(4)} ${String(Math.round(nfP)).padStart(10)}円 | ${diff >= 0 ? '+' : ''}${Math.round(diff)}円`);
    
    // Find blocked trades
    const wfKeys = new Set(wf.map(t => `${t.symbol}_${t.entryTime}`));
    const blocked = nf.filter(t => !wfKeys.has(`${t.symbol}_${t.entryTime}`));
    allBlockedTrades.push(...blocked);
  }
  
  console.log("-".repeat(100));
  const wfWr = totWF.n > 0 ? `${(totWF.w/totWF.n*100).toFixed(0)}%` : " -%";
  const nfWr = totNF.n > 0 ? `${(totNF.w/totNF.n*100).toFixed(0)}%` : " -%";
  const diff = totNF.pnl - totWF.pnl;
  console.log(`合計       | ${String(totWF.n).padStart(3)}件 ${wfWr.padStart(4)} ${String(Math.round(totWF.pnl)).padStart(10)}円 | ${String(totNF.n).padStart(3)}件 ${nfWr.padStart(4)} ${String(Math.round(totNF.pnl)).padStart(10)}円 | ${diff >= 0 ? '+' : ''}${Math.round(diff)}円`);
  
  if (allBlockedTrades.length > 0) {
    console.log(`\n\n=== 0.8%フィルターでブロックされた取引詳細 ===\n`);
    for (const t of allBlockedTrades) {
      const result = t.pnl > 0 ? "勝" : "負";
      console.log(`${t.symbol} ${t.side.toUpperCase().padEnd(5)} ${t.entryTime}→${t.exitTime} @${t.entryPrice}→${t.exitPrice} ${result} ${Math.round(t.pnl).toLocaleString()}円 [${t.exitReason}] ${t.reason.substring(0, 60)}`);
    }
    const bW = allBlockedTrades.filter(t => t.pnl > 0).length;
    const bP = allBlockedTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`\nブロック取引サマリー: ${allBlockedTrades.length}件, 勝率${(bW/allBlockedTrades.length*100).toFixed(0)}%, 合計${Math.round(bP)}円, 平均${Math.round(bP/allBlockedTrades.length)}円`);
  } else {
    console.log("\n※ フィルターによるブロック取引なし（両方とも同じ結果）");
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
