/**
 * isBullish AND条件バックテスト
 * 
 * 現行: isBullish = (MA20 slope > -0.03%)
 * 提案: isBullish = (MA20 slope > -0.03%) AND (始値比 >= 0.2%)
 * 
 * AND条件 = 両方TRUEの時のみisBullish=TRUE → どちらかFALSEならSHORT許可
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

const ACTIVE_SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6920", "6758", "8316"];
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000;
const MA_PERIOD = 20;
const SLOPE_THRESHOLD = -0.03;
const OPEN_RATIO_THRESHOLD = 0.2;

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type IsBullishMode = "ma20_only" | "and_condition" | "original_open_only";

function calcIsBullish(buffer: Candle[], candle: Candle, mode: IsBullishMode): boolean {
  if (buffer.length < 2) return false;

  if (mode === "original_open_only") {
    const openPrice = buffer[0].open;
    const ratio = (candle.close - openPrice) / openPrice * 100;
    return ratio >= OPEN_RATIO_THRESHOLD;
  }

  if (mode === "ma20_only") {
    if (buffer.length < MA_PERIOD + 1) {
      const openPrice = buffer[0].open;
      const ratio = (candle.close - openPrice) / openPrice * 100;
      return ratio >= OPEN_RATIO_THRESHOLD;
    }
    const currentSlice = buffer.slice(buffer.length - MA_PERIOD).map(c => c.close);
    const currentMA = currentSlice.reduce((a, b) => a + b, 0) / MA_PERIOD;
    const prevSlice = buffer.slice(buffer.length - MA_PERIOD - 1, buffer.length - 1).map(c => c.close);
    const prevMA = prevSlice.reduce((a, b) => a + b, 0) / MA_PERIOD;
    const slope = (currentMA - prevMA) / prevMA * 100;
    return slope > SLOPE_THRESHOLD;
  }

  if (mode === "and_condition") {
    // AND条件: 両方TRUEの時のみisBullish=TRUE
    const openPrice = buffer[0].open;
    const openRatio = (candle.close - openPrice) / openPrice * 100;
    const openBullish = openRatio >= OPEN_RATIO_THRESHOLD;

    if (buffer.length < MA_PERIOD + 1) {
      return openBullish; // ウォームアップ中は始値比のみ
    }
    const currentSlice = buffer.slice(buffer.length - MA_PERIOD).map(c => c.close);
    const currentMA = currentSlice.reduce((a, b) => a + b, 0) / MA_PERIOD;
    const prevSlice = buffer.slice(buffer.length - MA_PERIOD - 1, buffer.length - 1).map(c => c.close);
    const prevMA = prevSlice.reduce((a, b) => a + b, 0) / MA_PERIOD;
    const slope = (currentMA - prevMA) / prevMA * 100;
    const slopeBullish = slope > SLOPE_THRESHOLD;

    return slopeBullish && openBullish; // 両方TRUEの時のみ
  }

  return false;
}

function detectSimpleSignals(buffer: Candle[], idx: number): { type: "sell" | "buy" | null; confidence: "strong" | "medium" } {
  if (idx < 5) return { type: null, confidence: "medium" };
  const candle = buffer[idx];
  const prev = buffer[idx - 1];

  // 大台割れ (100円刻み)
  const step = candle.close >= 10000 ? 500 : candle.close >= 5000 ? 100 : 50;
  const prevLevel = Math.floor(prev.close / step) * step;
  const currLevel = Math.floor(candle.close / step) * step;
  
  if (currLevel < prevLevel && candle.close < prevLevel) {
    // 大台割れ - check distance
    const dist = Math.abs(candle.close - prevLevel) / prevLevel * 100;
    if (dist <= 0.8) {
      const vol5 = buffer.slice(Math.max(0, idx - 5), idx).reduce((s, c) => s + c.volume, 0) / 5;
      const confidence = candle.volume > vol5 * 1.2 ? "strong" : "medium";
      return { type: "sell", confidence };
    }
  }
  if (currLevel > prevLevel && candle.close > prevLevel + step) {
    const dist = Math.abs(candle.close - (prevLevel + step)) / (prevLevel + step) * 100;
    if (dist <= 0.8) {
      const vol5 = buffer.slice(Math.max(0, idx - 5), idx).reduce((s, c) => s + c.volume, 0) / 5;
      const confidence = candle.volume > vol5 * 1.2 ? "strong" : "medium";
      return { type: "buy", confidence };
    }
  }

  // VWAP cross (simplified)
  if (idx >= 20) {
    const vwapSlice = buffer.slice(0, idx + 1);
    let cumVol = 0, cumTP = 0;
    for (const c of vwapSlice) {
      const tp = (c.high + c.low + c.close) / 3;
      cumVol += c.volume;
      cumTP += tp * c.volume;
    }
    const vwap = cumVol > 0 ? cumTP / cumVol : candle.close;
    if (prev.close > vwap && candle.close < vwap && candle.close < prev.close) {
      return { type: "sell", confidence: "strong" };
    }
    if (prev.close < vwap && candle.close > vwap && candle.close > prev.close) {
      return { type: "buy", confidence: "strong" };
    }
  }

  // ダウ理論 (simplified - 20-bar low break)
  if (idx >= 20) {
    const lookback = buffer.slice(idx - 20, idx);
    const low20 = Math.min(...lookback.map(c => c.low));
    const high20 = Math.max(...lookback.map(c => c.high));
    if (candle.close < low20 && candle.close < prev.close) {
      return { type: "sell", confidence: "strong" };
    }
    if (candle.close > high20 && candle.close > prev.close) {
      return { type: "buy", confidence: "strong" };
    }
  }

  return { type: null, confidence: "medium" };
}

interface Trade {
  symbol: string;
  date: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  reason: string;
}

function simulateDay(candles: Candle[], symbol: string, date: string, mode: IsBullishMode): Trade[] {
  const trades: Trade[] = [];
  let inPosition = false;
  let positionSide: "long" | "short" = "long";
  let entryPrice = 0;
  let entryTime = "";
  let entryReason = "";

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const time = candle.time.split("T")[1]?.substring(0, 5) || "";

    // Exit check
    if (inPosition) {
      const lots = Math.floor(POSITION_SIZE / entryPrice);
      if (positionSide === "short") {
        const slPrice = entryPrice * (1 + SL_PCT / 100);
        const tpPrice = entryPrice * (1 - TP_PCT / 100);
        if (candle.high >= slPrice) {
          trades.push({ symbol, date, side: "short", entry: entryPrice, exit: slPrice, pnl: -lots * (slPrice - entryPrice), entryTime, exitTime: time, reason: "SL" });
          inPosition = false;
        } else if (candle.low <= tpPrice) {
          trades.push({ symbol, date, side: "short", entry: entryPrice, exit: tpPrice, pnl: lots * (entryPrice - tpPrice), entryTime, exitTime: time, reason: "TP" });
          inPosition = false;
        } else if (time >= "15:20") {
          const pnl = lots * (entryPrice - candle.close);
          trades.push({ symbol, date, side: "short", entry: entryPrice, exit: candle.close, pnl, entryTime, exitTime: time, reason: "EOD" });
          inPosition = false;
        }
      } else {
        const slPrice = entryPrice * (1 - SL_PCT / 100);
        const tpPrice = entryPrice * (1 + TP_PCT / 100);
        if (candle.low <= slPrice) {
          trades.push({ symbol, date, side: "long", entry: entryPrice, exit: slPrice, pnl: -lots * (entryPrice - slPrice), entryTime, exitTime: time, reason: "SL" });
          inPosition = false;
        } else if (candle.high >= tpPrice) {
          trades.push({ symbol, date, side: "long", entry: entryPrice, exit: tpPrice, pnl: lots * (tpPrice - entryPrice), entryTime, exitTime: time, reason: "TP" });
          inPosition = false;
        } else if (time >= "15:20") {
          const pnl = lots * (candle.close - entryPrice);
          trades.push({ symbol, date, side: "long", entry: entryPrice, exit: candle.close, pnl, entryTime, exitTime: time, reason: "EOD" });
          inPosition = false;
        }
      }
      continue;
    }

    // Entry check (only 09:30-15:00)
    if (time < "09:30" || time >= "15:00") continue;

    const buffer = candles.slice(0, i + 1);
    const signal = detectSimpleSignals(buffer, buffer.length - 1);
    if (!signal.type) continue;

    // SHORT signal
    if (signal.type === "sell") {
      // medium block
      if (signal.confidence === "medium") continue;
      // isBullish check
      const bullish = calcIsBullish(buffer, candle, mode);
      if (bullish) continue;
      // Enter short
      inPosition = true;
      positionSide = "short";
      entryPrice = candle.close;
      entryTime = time;
      entryReason = "SHORT";
    }

    // BUY signal
    if (signal.type === "buy") {
      if (signal.confidence === "medium") continue;
      // For BUY, isBearish would be the opposite check - skip for now
      inPosition = true;
      positionSide = "long";
      entryPrice = candle.close;
      entryTime = time;
      entryReason = "LONG";
    }
  }

  // Force close at end of day
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const time = lastCandle.time.split("T")[1]?.substring(0, 5) || "15:25";
    const lots = Math.floor(POSITION_SIZE / entryPrice);
    const pnl = positionSide === "short"
      ? lots * (entryPrice - lastCandle.close)
      : lots * (lastCandle.close - entryPrice);
    trades.push({ symbol, date, side: positionSide, entry: entryPrice, exit: lastCandle.close, pnl, entryTime, exitTime: time, reason: "EOD" });
  }

  return trades;
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 3 });
  const db = drizzle(pool);

  // Get last 20 trading days
  const datesResult = await db.execute(
    sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' ORDER BY tradeDate DESC LIMIT 20`
  );
  const dates = (datesResult[0] as any[]).map(r => r.tradeDate).reverse();
  console.log(`=== isBullish AND条件 20日間バックテスト ===`);
  console.log(`期間: ${dates[0]} ～ ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: ${ACTIVE_SYMBOLS.length}銘柄`);
  console.log(`比較: 旧方式(始値比) vs 現行(MA20) vs AND条件`);
  console.log("");

  const modes: IsBullishMode[] = ["original_open_only", "ma20_only", "and_condition"];
  const modeNames: Record<IsBullishMode, string> = {
    original_open_only: "旧方式(始値比0.2%)",
    ma20_only: "現行(MA20傾き)",
    and_condition: "AND条件(MA20∧始値比)",
  };

  const allTrades: Record<IsBullishMode, Trade[]> = {
    original_open_only: [],
    ma20_only: [],
    and_condition: [],
  };

  for (const date of dates) {
    for (const symbol of ACTIVE_SYMBOLS) {
      const result = await db.execute(
        sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = ${symbol} AND tradeDate = ${date} ORDER BY candleTime ASC`
      );
      const rows = result[0] as any[];
      if (rows.length < 30) continue;

      const candles: Candle[] = rows.map(r => ({
        time: `${r.tradeDate}T${r.candleTime}`,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume ?? 0,
      }));

      for (const mode of modes) {
        const trades = simulateDay(candles, symbol, date, mode);
        allTrades[mode].push(...trades);
      }
    }
  }

  // Summary
  console.log("=== 全体サマリー ===");
  console.log("| 方式 | 取引数 | 勝率 | 合計損益 | 1件平均 | 最大日損 |");
  console.log("|------|--------|------|----------|---------|----------|");

  for (const mode of modes) {
    const trades = allTrades[mode];
    const wins = trades.filter(t => t.pnl > 0).length;
    const total = trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = total > 0 ? totalPnl / total : 0;
    
    // Max daily loss
    const dailyPnl = new Map<string, number>();
    for (const t of trades) {
      dailyPnl.set(t.date, (dailyPnl.get(t.date) || 0) + t.pnl);
    }
    const maxDailyLoss = Math.min(...Array.from(dailyPnl.values()), 0);
    
    console.log(`| ${modeNames[mode]} | ${total} | ${total > 0 ? (wins / total * 100).toFixed(1) : 0}% | ${Math.round(totalPnl).toLocaleString()}円 | ${Math.round(avgPnl).toLocaleString()}円 | ${Math.round(maxDailyLoss).toLocaleString()}円 |`);
  }

  // SHORT only comparison
  console.log("\n=== SHORT取引のみ ===");
  console.log("| 方式 | 取引数 | 勝率 | 合計損益 | 1件平均 |");
  console.log("|------|--------|------|----------|---------|");

  for (const mode of modes) {
    const shorts = allTrades[mode].filter(t => t.side === "short");
    const wins = shorts.filter(t => t.pnl > 0).length;
    const total = shorts.length;
    const totalPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = total > 0 ? totalPnl / total : 0;
    console.log(`| ${modeNames[mode]} | ${total} | ${total > 0 ? (wins / total * 100).toFixed(1) : 0}% | ${Math.round(totalPnl).toLocaleString()}円 | ${Math.round(avgPnl).toLocaleString()}円 |`);
  }

  // By symbol comparison
  console.log("\n=== 銘柄別損益比較 ===");
  console.log("| 銘柄 | 旧方式 | 現行(MA20) | AND条件 | AND vs 現行 |");
  console.log("|------|--------|------------|---------|-------------|");

  for (const symbol of ACTIVE_SYMBOLS) {
    const row: string[] = [symbol];
    let currentPnl = 0;
    let andPnl = 0;
    for (const mode of modes) {
      const symbolTrades = allTrades[mode].filter(t => t.symbol === symbol);
      const pnl = symbolTrades.reduce((s, t) => s + t.pnl, 0);
      row.push(`${Math.round(pnl).toLocaleString()}円`);
      if (mode === "ma20_only") currentPnl = pnl;
      if (mode === "and_condition") andPnl = pnl;
    }
    const diff = andPnl - currentPnl;
    row.push(`${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円`);
    console.log(`| ${row.join(" | ")} |`);
  }

  // Daily comparison
  console.log("\n=== 日別損益比較 ===");
  console.log("| 日付 | 旧方式 | 現行(MA20) | AND条件 | AND vs 現行 |");
  console.log("|------|--------|------------|---------|-------------|");

  for (const date of dates) {
    const row: string[] = [date];
    let currentPnl = 0;
    let andPnl = 0;
    for (const mode of modes) {
      const dayTrades = allTrades[mode].filter(t => t.date === date);
      const pnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      row.push(`${Math.round(pnl).toLocaleString()}円`);
      if (mode === "ma20_only") currentPnl = pnl;
      if (mode === "and_condition") andPnl = pnl;
    }
    const diff = andPnl - currentPnl;
    row.push(`${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円`);
    console.log(`| ${row.join(" | ")} |`);
  }

  await pool.end();
}

main().catch(console.error);
