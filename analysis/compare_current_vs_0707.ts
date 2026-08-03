/**
 * compare_current_vs_0707.ts
 * 
 * 現在の仕様 vs 7/7仕様をrt_candlesデータで比較バックテスト
 * 
 * 主な差分:
 * 1. isBullish判定: MA20傾き(現在) vs 始値比+0.2%固定(7/7)
 * 2. ROUND_LEVEL_CONFIRM_BARS: 4(現在) vs 5(7/7)
 * 3. 午後安値圏フィルター(-5%): あり(現在) vs なし(7/7)
 * 4. 午後高値圏フィルター(+4%): あり(現在) vs なし(7/7)
 * 5. MARKET_CLOSE_TIME: 15:25(現在) vs 15:30(7/7)
 * 6. NO_ENTRY_AFTER: 15:05(現在) vs 15:15(7/7)
 * 7. TRADE_EXCLUDED_SYMBOLS: あり(現在) vs なし(7/7)
 * 
 * データ: 7/7以降のrt_candles（7/7〜7/31、19営業日）
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/compare_current_vs_0707.ts
 */

import mysql from "mysql2/promise";
import { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";

// ============================================================
// 共通定数
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const MIN_CANDLES_FOR_SIGNAL = 30;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const NO_ENTRY_LUNCH_START = "12:00";
const NO_ENTRY_LUNCH_END = "12:59";
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const PULLBACK_MAX_WAIT = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;
const IS_BULLISH_FALLBACK_THRESHOLD = 0.2;
const HTF_TIMEFRAME_MINUTES = 3;

// ============================================================
// 設定パターン
// ============================================================
interface Config {
  name: string;
  isBullishMode: "ma20_slope" | "open_ratio_fixed";
  confirmBars: number;
  pmLowzoneFilter: boolean;  // 午後安値圏フィルター
  pmHighzoneFilter: boolean; // 午後高値圏フィルター
  marketCloseTime: string;
  noEntryAfter: string;
  useTradeExcluded: boolean;
}

const CONFIG_CURRENT: Config = {
  name: "現在の仕様",
  isBullishMode: "ma20_slope",
  confirmBars: 4,
  pmLowzoneFilter: true,
  pmHighzoneFilter: true,
  marketCloseTime: "15:25",
  noEntryAfter: "15:05",
  useTradeExcluded: true,
};

const CONFIG_0707: Config = {
  name: "7/7仕様",
  isBullishMode: "open_ratio_fixed",
  confirmBars: 5,
  pmLowzoneFilter: false,
  pmHighzoneFilter: false,
  marketCloseTime: "15:30",
  noEntryAfter: "15:15",
  useTradeExcluded: false,
};

// アブレーション: isBullishのみ変更
const CONFIG_ISBULLISH_ONLY: Config = {
  ...CONFIG_CURRENT,
  name: "現在 + isBullish始値比固定",
  isBullishMode: "open_ratio_fixed",
};

// アブレーション: CONFIRM_BARSのみ変更
const CONFIG_CONFIRM5_ONLY: Config = {
  ...CONFIG_CURRENT,
  name: "現在 + CONFIRM_BARS=5",
  confirmBars: 5,
};

// アブレーション: 午後フィルターなし
const CONFIG_NO_PM_FILTER: Config = {
  ...CONFIG_CURRENT,
  name: "現在 - 午後フィルター",
  pmLowzoneFilter: false,
  pmHighzoneFilter: false,
};

// アブレーション: 大引け時刻を7/7に戻す
const CONFIG_CLOSE_0707: Config = {
  ...CONFIG_CURRENT,
  name: "現在 + 大引け15:30/エントリー15:15",
  marketCloseTime: "15:30",
  noEntryAfter: "15:15",
};

// ============================================================
// シグナル検出（簡易版 - エンジンのコアロジックを再現）
// ============================================================
interface Candle {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

interface CandleWithIndicators extends Candle {
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  atr: number | null;
}

interface Signal {
  type: "buy" | "sell";
  confidence: "strong" | "medium";
  reason: string;
}

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  tradeDate: string;
}

interface Trade {
  symbol: string;
  tradeDate: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  exitReason: string;
  signalReason: string;
}

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1];
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100;
    else result[i] = 100 - 100 / (1 + avgGain / avgLoss);
    if (i < data.length - 1) {
      const d = data[i + 1] - data[i];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
  }
  return result;
}

function calcATR(candles: CandleWithIndicators[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function getHTFTrend(buffer: CandleWithIndicators[], currentIdx: number, minutes: number): "up" | "down" | "neutral" {
  if (currentIdx < minutes * 5) return "neutral";
  // Build HTF candles from 1-min data
  const htfCandles: { close: number }[] = [];
  for (let i = 0; i <= currentIdx; i += minutes) {
    const end = Math.min(i + minutes, currentIdx + 1);
    const slice = buffer.slice(i, end);
    if (slice.length > 0) htfCandles.push({ close: slice[slice.length - 1].close });
  }
  if (htfCandles.length < 10) return "neutral";
  const closes = htfCandles.map(c => c.close);
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma25Slice = closes.slice(-25);
  if (ma25Slice.length < 25) return "neutral";
  const ma25 = ma25Slice.reduce((a, b) => a + b, 0) / 25;
  if (ma5 > ma25 * 1.001) return "up";
  if (ma5 < ma25 * 0.999) return "down";
  return "neutral";
}

function detectSignalsSimple(buffer: CandleWithIndicators[], idx: number): Signal[] {
  if (idx < MIN_CANDLES_FOR_SIGNAL) return [];
  const signals: Signal[] = [];
  const c = buffer[idx];
  const prev = buffer[idx - 1];
  if (!c.ma5 || !c.ma25 || !prev.ma5 || !prev.ma25) return signals;

  // ダウ理論上昇 (MA5 > MA25 クロス)
  if (prev.ma5 <= prev.ma25 && c.ma5 > c.ma25) {
    signals.push({ type: "buy", confidence: "strong", reason: "ダウ理論上昇(MA5>MA25クロス)" });
  }
  // ダウ理論下降 (MA5 < MA25 クロス)
  if (prev.ma5 >= prev.ma25 && c.ma5 < c.ma25) {
    signals.push({ type: "sell", confidence: "strong", reason: "ダウ理論下降(MA5<MA25クロス)" });
  }
  // VWAP上抜け (RSI50超え + MA5上向き)
  if (c.rsi !== null && prev.rsi !== null && prev.rsi < 50 && c.rsi >= 50 && c.ma5 > prev.ma5) {
    signals.push({ type: "buy", confidence: "medium", reason: "VWAPクロス上抜け" });
  }
  // VWAP下抜け (RSI50割れ + MA5下向き)
  if (c.rsi !== null && prev.rsi !== null && prev.rsi > 50 && c.rsi <= 50 && c.ma5 < prev.ma5) {
    signals.push({ type: "sell", confidence: "medium", reason: "VWAPクロス下抜け" });
  }
  // 大台確認 (キリ番突破)
  const roundLevels = getRoundLevels(c.close);
  for (const rl of roundLevels) {
    if (prev.close < rl && c.close >= rl) {
      signals.push({ type: "buy", confidence: "medium", reason: `大台確認(${rl}円突破)` });
    }
    if (prev.close > rl && c.close <= rl) {
      signals.push({ type: "sell", confidence: "medium", reason: `大台割れ(${rl}円割込)` });
    }
  }
  return signals;
}

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  let step: number;
  if (price >= 50000) step = 1000;
  else if (price >= 10000) step = 500;
  else if (price >= 5000) step = 200;
  else if (price >= 1000) step = 100;
  else step = 50;
  const base = Math.floor(price / step) * step;
  levels.push(base, base + step);
  return levels;
}

function getBoardScore(snapshot: any, side: "long" | "short"): number {
  if (!snapshot) return 0;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (typeof bpr !== "number") return 0;
  // 要素A: アグレッシブ注文
  if (snapshot.aggressiveBuyRatio > 0.6 && side === "long") score += 2;
  else if (snapshot.aggressiveSellRatio > 0.6 && side === "short") score += 2;
  // 要素B: 厚い板
  if (side === "long" && snapshot.largeBuyWall) score += 1;
  if (side === "short" && snapshot.largeSellWall) score += 1;
  // 要素E: BPR強さ
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  return score;
}

// ============================================================
// シミュレーションエンジン
// ============================================================
function runSimulation(allCandles: Map<string, Candle[]>, config: Config): { trades: Trade[]; blocked: number } {
  const trades: Trade[] = [];
  let blocked = 0;
  const activeSymbols = config.useTradeExcluded
    ? TARGET_STOCKS.filter(s => !TRADE_EXCLUDED_SYMBOLS.has(s.symbol)).map(s => s.symbol)
    : TARGET_STOCKS.map(s => s.symbol);

  for (const symbol of activeSymbols) {
    const candles = allCandles.get(symbol);
    if (!candles || candles.length === 0) continue;

    // Group by date
    const byDate = new Map<string, Candle[]>();
    for (const c of candles) {
      const arr = byDate.get(c.tradeDate) || [];
      arr.push(c);
      byDate.set(c.tradeDate, arr);
    }

    for (const [tradeDate, dayCandles] of byDate) {
      const sorted = dayCandles.sort((a, b) => a.candleTime.localeCompare(b.candleTime));
      // Filter lunch break
      const filtered = sorted.filter(c => !(c.candleTime >= NO_ENTRY_LUNCH_START && c.candleTime <= NO_ENTRY_LUNCH_END));
      if (filtered.length < MIN_CANDLES_FOR_SIGNAL) continue;

      // Build indicators
      const closes = filtered.map(c => c.close);
      const ma5Arr = calcMA(closes, 5);
      const ma25Arr = calcMA(closes, 25);
      const rsiArr = calcRSI(closes, 14);
      const buffer: CandleWithIndicators[] = filtered.map((c, i) => ({
        ...c,
        ma5: ma5Arr[i],
        ma25: ma25Arr[i],
        rsi: rsiArr[i],
        atr: null,
      }));

      let openPos: OpenPosition | null = null;
      let lastStopLossTime: string | null = null;
      const dayPnl = { total: 0 };

      for (let i = 1; i < buffer.length; i++) {
        const candle = buffer[i];
        const candleTime = candle.candleTime;

        // ---- Exit logic ----
        if (openPos) {
          const slPct = STOP_LOSS_PERCENT / 100;
          const tpPct = TAKE_PROFIT_PERCENT / 100;
          let exitPrice: number | null = null;
          let exitReason = "";

          if (openPos.side === "long") {
            if (candle.low <= openPos.entryPrice * (1 - slPct)) {
              exitPrice = openPos.entryPrice * (1 - slPct);
              exitReason = "SL";
            } else if (candle.high >= openPos.entryPrice * (1 + tpPct)) {
              exitPrice = openPos.entryPrice * (1 + tpPct);
              exitReason = "TP";
            }
          } else {
            if (candle.high >= openPos.entryPrice * (1 + slPct)) {
              exitPrice = openPos.entryPrice * (1 + slPct);
              exitReason = "SL";
            } else if (candle.low <= openPos.entryPrice * (1 - tpPct)) {
              exitPrice = openPos.entryPrice * (1 - tpPct);
              exitReason = "TP";
            }
          }

          // EOD
          if (!exitPrice && candleTime >= config.marketCloseTime) {
            exitPrice = candle.close;
            exitReason = "EOD";
          }

          if (exitPrice) {
            const pnl = openPos.side === "long"
              ? (exitPrice - openPos.entryPrice) * openPos.shares
              : (openPos.entryPrice - exitPrice) * openPos.shares;
            trades.push({
              symbol, tradeDate, side: openPos.side,
              entryTime: openPos.entryTime, exitTime: candleTime,
              entryPrice: openPos.entryPrice, exitPrice,
              shares: openPos.shares, pnl,
              exitReason, signalReason: "",
            });
            dayPnl.total += pnl;
            if (exitReason === "SL") lastStopLossTime = candleTime;
            openPos = null;
          }
          continue; // Don't generate new signals while in position
        }

        // ---- Entry logic ----
        if (candleTime < NO_ENTRY_BEFORE) continue;
        if (candleTime >= config.noEntryAfter) continue;
        if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
        if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;

        // No re-entry after SL for 30 min
        if (lastStopLossTime) {
          const slMin = parseInt(lastStopLossTime.split(":")[0]) * 60 + parseInt(lastStopLossTime.split(":")[1]);
          const curMin = parseInt(candleTime.split(":")[0]) * 60 + parseInt(candleTime.split(":")[1]);
          if (curMin - slMin < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        }

        // isBullish判定
        const isBullish = (() => {
          if (config.isBullishMode === "open_ratio_fixed") {
            const openPrice = buffer[0].open;
            const priceChangeRatio = (candle.close - openPrice) / openPrice * 100;
            return priceChangeRatio >= 0.2;
          } else {
            // MA20 slope
            if (buffer.length < IS_BULLISH_MA_PERIOD + 1 || i < IS_BULLISH_MA_PERIOD + 1) {
              const openPrice = buffer[0].open;
              const priceChangeRatio = (candle.close - openPrice) / openPrice * 100;
              return priceChangeRatio >= IS_BULLISH_FALLBACK_THRESHOLD;
            }
            const currentSlice = buffer.slice(i - IS_BULLISH_MA_PERIOD + 1, i + 1).map(c => c.close);
            const currentMA = currentSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
            const prevSlice = buffer.slice(i - IS_BULLISH_MA_PERIOD, i).map(c => c.close);
            const prevMA = prevSlice.reduce((a, b) => a + b, 0) / IS_BULLISH_MA_PERIOD;
            const slope = (currentMA - prevMA) / prevMA * 100;
            return slope > IS_BULLISH_SLOPE_THRESHOLD;
          }
        })();

        // HTF filter
        const htfTrend = getHTFTrend(buffer, i, HTF_TIMEFRAME_MINUTES);

        // Detect signals
        const signals = detectSignalsSimple(buffer, i);
        if (signals.length === 0) continue;

        for (const sig of signals) {
          if (openPos) break; // Only one position at a time per symbol

          // medium BUY direct block
          if (sig.type === "buy" && sig.confidence === "medium") {
            blocked++;
            continue;
          }

          if (sig.type === "buy") {
            // HTF filter for BUY
            if (htfTrend === "down") { blocked++; continue; }
            // Board score
            const bs = getBoardScore(candle.boardSnapshot, "long");
            if (bs < BOARD_SCORE_THRESHOLD) { blocked++; continue; }

            // 午後高値圏フィルター
            if (config.pmHighzoneFilter && candleTime >= PM_BPR_FILTER_START) {
              const openPrice = buffer[0].open;
              const rise = (candle.close - openPrice) / openPrice;
              if (rise >= 0.04) { blocked++; continue; }
            }

            const capital = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
            const shares = Math.floor(capital / candle.close / 100) * 100;
            if (shares <= 0) continue;
            openPos = { symbol, side: "long", entryPrice: candle.close, shares, entryTime: candleTime, tradeDate };
          }

          if (sig.type === "sell") {
            // isBullish block
            if (isBullish) { blocked++; continue; }
            // SHORT medium全ブロック
            if (sig.confidence === "medium") { blocked++; continue; }
            // HTF filter for SHORT
            if (htfTrend === "up") { blocked++; continue; }
            // Board score
            const bs = getBoardScore(candle.boardSnapshot, "short");
            if (bs < BOARD_SCORE_THRESHOLD) { blocked++; continue; }
            // 後場BPRフィルター
            if (candleTime >= PM_BPR_FILTER_START && candle.boardSnapshot) {
              const bpr = candle.boardSnapshot.buyPressureRatio;
              if (typeof bpr === "number" && bpr >= PM_BPR_BLOCK_THRESHOLD) { blocked++; continue; }
            }
            // 午後安値圏フィルター
            if (config.pmLowzoneFilter && candleTime >= PM_BPR_FILTER_START) {
              const openPrice = buffer[0].open;
              const drop = (candle.close - openPrice) / openPrice;
              if (drop <= -0.05) { blocked++; continue; }
            }

            const capital = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
            const shares = Math.floor(capital / candle.close / 100) * 100;
            if (shares <= 0) continue;
            openPos = { symbol, side: "short", entryPrice: candle.close, shares, entryTime: candleTime, tradeDate };
          }
        }
      }

      // Force close at EOD if still open
      if (openPos && buffer.length > 0) {
        const lastCandle = buffer[buffer.length - 1];
        const pnl = openPos.side === "long"
          ? (lastCandle.close - openPos.entryPrice) * openPos.shares
          : (openPos.entryPrice - lastCandle.close) * openPos.shares;
        trades.push({
          symbol, tradeDate, side: openPos.side,
          entryTime: openPos.entryTime, exitTime: lastCandle.candleTime,
          entryPrice: openPos.entryPrice, exitPrice: lastCandle.close,
          shares: openPos.shares, pnl,
          exitReason: "EOD_FORCE", signalReason: "",
        });
      }
    }
  }
  return { trades, blocked };
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 7/7以降のデータを取得（7/7仕様が稼働していた期間）
  const [rows] = await conn.execute(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot 
     FROM rt_candles 
     WHERE tradeDate >= '2026-07-07' 
     ORDER BY tradeDate, symbol, candleTime`
  ) as any[];

  console.log(`取得データ: ${rows.length}本（7/7〜7/31）`);

  // Group by symbol
  const allCandles = new Map<string, Candle[]>();
  for (const row of rows) {
    const candle: Candle = {
      symbol: row.symbol,
      tradeDate: row.tradeDate,
      candleTime: row.candleTime,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: Number(row.volume),
      boardSnapshot: typeof row.boardSnapshot === "string" ? JSON.parse(row.boardSnapshot) : row.boardSnapshot,
    };
    const arr = allCandles.get(candle.symbol) || [];
    arr.push(candle);
    allCandles.set(candle.symbol, arr);
  }

  const configs = [CONFIG_CURRENT, CONFIG_0707, CONFIG_ISBULLISH_ONLY, CONFIG_CONFIRM5_ONLY, CONFIG_NO_PM_FILTER, CONFIG_CLOSE_0707];

  console.log("\n" + "=".repeat(80));
  console.log("バックテスト比較: 現在の仕様 vs 7/7仕様（7/7〜7/31、19営業日）");
  console.log("=".repeat(80));

  const results: { name: string; totalPnl: number; wins: number; losses: number; trades: number; pf: number; maxDD: number; blocked: number }[] = [];

  for (const config of configs) {
    const { trades, blocked } = runSimulation(allCandles, config);
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Max drawdown
    let peak = 0, dd = 0, maxDD = 0;
    let cumPnl = 0;
    for (const t of trades.sort((a, b) => `${a.tradeDate}${a.entryTime}`.localeCompare(`${b.tradeDate}${b.entryTime}`))) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    results.push({ name: config.name, totalPnl, wins, losses, trades: trades.length, pf, maxDD, blocked });

    console.log(`\n--- ${config.name} ---`);
    console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${trades.length}件 (${wins}勝${losses}敗)`);
    console.log(`  勝率: ${trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0}%`);
    console.log(`  PF: ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
    console.log(`  最大DD: -${Math.round(maxDD).toLocaleString()}円`);
    console.log(`  ブロック数: ${blocked}`);

    // Daily breakdown
    const byDate = new Map<string, number>();
    for (const t of trades) {
      byDate.set(t.tradeDate, (byDate.get(t.tradeDate) || 0) + t.pnl);
    }
    const sortedDates = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const winDays = sortedDates.filter(([, pnl]) => pnl > 0).length;
    const lossDays = sortedDates.filter(([, pnl]) => pnl <= 0).length;
    console.log(`  日次: ${winDays}勝${lossDays}敗 (勝率${(winDays / (winDays + lossDays) * 100).toFixed(0)}%)`);
  }

  // Summary table
  console.log("\n\n" + "=".repeat(80));
  console.log("サマリー比較表");
  console.log("=".repeat(80));
  console.log(
    "設定".padEnd(30) + "総損益".padStart(12) + "取引数".padStart(8) + "勝率".padStart(8) + "PF".padStart(8) + "最大DD".padStart(12)
  );
  console.log("-".repeat(78));
  for (const r of results) {
    console.log(
      r.name.padEnd(30) +
      `${r.totalPnl >= 0 ? "+" : ""}${Math.round(r.totalPnl).toLocaleString()}`.padStart(12) +
      `${r.trades}`.padStart(8) +
      `${(r.wins / Math.max(r.trades, 1) * 100).toFixed(1)}%`.padStart(8) +
      `${r.pf === Infinity ? "∞" : r.pf.toFixed(2)}`.padStart(8) +
      `-${Math.round(r.maxDD).toLocaleString()}`.padStart(12)
    );
  }

  // isBullish specific analysis
  console.log("\n\n" + "=".repeat(80));
  console.log("isBullish判定の影響分析");
  console.log("=".repeat(80));
  const currentResult = results.find(r => r.name === "現在の仕様")!;
  const isBullishResult = results.find(r => r.name === "現在 + isBullish始値比固定")!;
  const diff = currentResult.totalPnl - isBullishResult.totalPnl;
  console.log(`  MA20傾き方式（現在）: ${currentResult.totalPnl >= 0 ? "+" : ""}${Math.round(currentResult.totalPnl).toLocaleString()}円`);
  console.log(`  始値比固定方式（7/7）: ${isBullishResult.totalPnl >= 0 ? "+" : ""}${Math.round(isBullishResult.totalPnl).toLocaleString()}円`);
  console.log(`  差分: ${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円 → ${diff >= 0 ? "MA20傾き方式が優位" : "始値比固定方式が優位"}`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
