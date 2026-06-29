/**
 * compare_round_break_v3.ts
 * 「大台割れ Ver3」比較バックテスト
 * 
 * Ver3条件:
 * - 3本維持（現行5本→3本）
 * - 出来高 >= 直近10本平均×1.5
 * - 5分足MA5 < MA25
 * - レジーム = down
 * - ATR率 >= 0.20%
 * - 終値 < VWAP
 * - 板読みスコア >= 2
 * - buy_pressure禁止
 * - large_buy_wall禁止
 * - 日経先物MA5<MA25（データなしのためスキップ）
 */

import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { asc } from "drizzle-orm";

// ============================================================
// 定数（現行システムと同一）
// ============================================================
const INITIAL_CAPITAL = 3_000_000;
const STOP_LOSS_RATIO = 0.005;
const TAKE_PROFIT_RATIO = 0.015;
const TRAIL_TRIGGER = 0.01;
const TRAIL_GAP = 0.005;
const BREAKEVEN_TRIGGER = 0.005;
const LOT_RATIO = 0.30;
const MAX_TRADES_PER_DAY = 10;
const WARMUP_BARS = 10;
const SHORT_MAX_HOLD_BARS = 60;
const SLOPE_THRESHOLD = 0.0001;
const SHORT_RSI_MIN = 40;
const SHORT_NEAR_MA = 0.003;
const ATR_BLOCK_THRESHOLD = 0.0012;

// ============================================================
// Ver3 大台割れ条件
// ============================================================
const V3_MAINTAIN_BARS = 3;       // 3本維持（現行は5本相当）
const V3_VOLUME_MULT = 1.5;      // 出来高 >= 平均×1.5
const V3_ATR_MIN = 0.0020;       // ATR率 >= 0.20%
const V3_BOARD_SCORE_MIN = 2;    // 板読みスコア >= 2

// ============================================================
// テクニカル指標
// ============================================================
interface BoardData {
  signal: string;
  buyPressureRatio: number;
  largeBuyWall: boolean;
  largeSellWall: boolean;
  totalAskQty: number;
  totalBidQty: number;
  icebergAskDetected: boolean;
  icebergBidDetected: boolean;
  marketOrderDirection: string;
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  board?: BoardData;
  ma5?: number;
  ma25?: number;
  rsi?: number;
  vwap?: number;
  bbUpper?: number;
  bbLower?: number;
  atr?: number;
}

interface Candle5m {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number;
  ma25?: number;
}

function computeIndicators(candles: Candle[]): void {
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    c.vwap = cumVol > 0 ? cumPV / cumVol : c.close;
  }
  for (let i = 0; i < candles.length; i++) {
    if (i >= 4) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += candles[j].close;
      candles[i].ma5 = sum / 5;
    }
    if (i >= 24) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += candles[j].close;
      candles[i].ma25 = sum / 25;
    }
  }
  for (let i = 14; i < candles.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - 13; j <= i; j++) {
      const diff = candles[j].close - candles[j - 1].close;
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / 14, avgLoss = losses / 14;
    candles[i].rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = 19; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += candles[j].close;
    const mean = sum / 20;
    let sqSum = 0;
    for (let j = i - 19; j <= i; j++) sqSum += (candles[j].close - mean) ** 2;
    const std = Math.sqrt(sqSum / 20);
    candles[i].bbUpper = mean + 2 * std;
    candles[i].bbLower = mean - 2 * std;
  }
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    (candles[i] as any)._tr = tr;
  }
  for (let i = 14; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += (candles[j] as any)._tr || 0;
    candles[i].atr = sum / 14;
  }
}

function build5mCandles(candles1m: Candle[]): Candle5m[] {
  const bars5m: Candle5m[] = [];
  for (let i = 0; i < candles1m.length; i += 5) {
    const chunk = candles1m.slice(i, Math.min(i + 5, candles1m.length));
    if (chunk.length === 0) continue;
    bars5m.push({
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  // Compute MA5 and MA25 on 5m bars
  for (let i = 0; i < bars5m.length; i++) {
    if (i >= 4) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += bars5m[j].close;
      bars5m[i].ma5 = sum / 5;
    }
    if (i >= 24) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += bars5m[j].close;
      bars5m[i].ma25 = sum / 25;
    }
  }
  return bars5m;
}

function getSlope(candles: Candle[], i: number, period = 10): number {
  if (i < period) return 0;
  return (candles[i].close - candles[i - period].close) / candles[i - period].close / period;
}

function trailingAvgVolume(candles: Candle[], i: number, period: number): number {
  if (i < period) return candles[i].volume;
  let sum = 0;
  for (let j = i - period; j < i; j++) sum += candles[j].volume;
  return sum / period;
}

// ============================================================
// 板読みスコア計算
// ============================================================
function computeBoardScore(board: BoardData | undefined, direction: "short"): number {
  if (!board) return 0;
  let score = 0;
  
  // signal = sell_pressure → +1
  if (board.signal === "sell_pressure") score++;
  // totalAskQty > totalBidQty (売り板厚い = 下落圧力) → +1
  if (board.totalAskQty > board.totalBidQty * 1.2) score++;
  // icebergAskDetected (大口売り隠し注文) → +1
  if (board.icebergAskDetected) score++;
  // largeSellWall → +1
  if (board.largeSellWall) score++;
  // marketOrderDirection = sell → +1
  if (board.marketOrderDirection === "sell") score++;
  
  return score;
}

// ============================================================
// シグナル検出
// ============================================================
type SignalType = "round_number_break" | "round_number_break_v3" | "vwap_cross_down" | "vwap_bearish_bounce" | "pullback_short" | "head_shoulders" | "other_short";

interface ShortSignal {
  type: SignalType;
  bar: number;
  price: number;
  reason: string;
}

function detectShortSignals(
  candles: Candle[], i: number, bars5m: Candle5m[], useV3: boolean
): ShortSignal[] {
  const signals: ShortSignal[] = [];
  if (i < WARMUP_BARS || i < 2) return signals;
  const curr = candles[i], prev = candles[i - 1];
  const slope = getSlope(candles, i);
  const atrRatio = curr.atr ? curr.atr / curr.close : 0;
  if (atrRatio < ATR_BLOCK_THRESHOLD) return signals;
  const isStrongUp = slope > SLOPE_THRESHOLD * 3;
  if (isStrongUp) return signals;
  const avgVol = trailingAvgVolume(candles, i, 10);
  const volConfirmed = curr.volume >= avgVol * 0.8;
  if (!volConfirmed) return signals;

  // 1. VWAPクロス下抜け
  if (curr.vwap && prev.vwap && prev.close > prev.vwap && curr.close <= curr.vwap && slope < 0) {
    signals.push({ type: "vwap_cross_down", bar: i, price: curr.close, reason: `VWAPクロス下抜け` });
  }
  // 2. VWAP反落
  if (i >= 3 && curr.vwap && prev.vwap) {
    const prev2 = candles[i - 2];
    if (prev2.vwap && prev2.close > prev2.vwap && prev.high >= prev.vwap! * 0.998 && curr.close < curr.vwap && curr.close < curr.open && slope < 0) {
      signals.push({ type: "vwap_bearish_bounce", bar: i, price: curr.close, reason: `VWAP反落` });
    }
  }
  // 3. 下落相場の戻り売り
  const stockTrendDown = slope < -SLOPE_THRESHOLD;
  const nearMA25 = curr.ma25 && Math.abs(curr.close - curr.ma25) / curr.ma25 <= SHORT_NEAR_MA;
  if (stockTrendDown && (curr.rsi ?? 50) >= SHORT_RSI_MIN && nearMA25 && curr.close <= curr.ma25!) {
    signals.push({ type: "pullback_short", bar: i, price: curr.close, reason: `戻り売り` });
  }
  // 4. 三尊
  if (i >= 40) {
    const lookback = candles.slice(i - 39, i + 1);
    const highs = lookback.map(c => c.high);
    const maxIdx = highs.indexOf(Math.max(...highs));
    if (maxIdx >= 10 && maxIdx <= 30) {
      const leftPeak = Math.max(...highs.slice(0, maxIdx - 3));
      const rightPeak = Math.max(...highs.slice(maxIdx + 3));
      const centerPeak = highs[maxIdx];
      if (centerPeak > leftPeak && centerPeak > rightPeak && Math.abs(leftPeak - rightPeak) / centerPeak < 0.005) {
        const neckline = Math.min(...lookback.slice(maxIdx - 5, maxIdx + 5).map(c => c.low));
        if (curr.close < neckline && prev.close >= neckline) {
          signals.push({ type: "head_shoulders", bar: i, price: curr.close, reason: `三尊` });
        }
      }
    }
  }
  
  // 5. 大台割れ
  const roundUnit = curr.close >= 10000 ? 100 : curr.close >= 1000 ? 100 : 10;
  const prevRound = Math.ceil(prev.close / roundUnit) * roundUnit;
  const currRound = Math.ceil(curr.close / roundUnit) * roundUnit;
  if (currRound < prevRound && curr.close < prevRound - roundUnit * 0.1) {
    if (useV3) {
      // ===== Ver3条件 =====
      // 3本維持
      let maintained = true;
      for (let j = Math.max(0, i - V3_MAINTAIN_BARS + 1); j < i; j++) {
        if (candles[j].close > prevRound) { maintained = false; break; }
      }
      if (!maintained) { /* skip */ }
      else {
        // 出来高 >= 直近10本平均×1.5
        const avgVol10 = trailingAvgVolume(candles, i, 10);
        const volOk = curr.volume >= avgVol10 * V3_VOLUME_MULT;
        
        // 5分足MA5 < MA25
        const bar5mIdx = Math.floor(i / 5);
        const bar5m = bars5m[bar5mIdx];
        const ma5mOk = bar5m && bar5m.ma5 !== undefined && bar5m.ma25 !== undefined && bar5m.ma5 < bar5m.ma25;
        
        // レジーム = down (slope < -threshold)
        const regimeDown = slope < -SLOPE_THRESHOLD;
        
        // ATR率 >= 0.20%
        const atrOk = atrRatio >= V3_ATR_MIN;
        
        // 終値 < VWAP
        const belowVwap = curr.vwap !== undefined && curr.close < curr.vwap;
        
        // 板読みスコア >= 2
        const boardScore = computeBoardScore(curr.board, "short");
        const boardOk = boardScore >= V3_BOARD_SCORE_MIN;
        
        // buy_pressure禁止
        const noBuyPressure = !curr.board || curr.board.buyPressureRatio < 0.65;
        
        // large_buy_wall禁止
        const noLargeBuyWall = !curr.board || !curr.board.largeBuyWall;
        
        if (volOk && ma5mOk && regimeDown && atrOk && belowVwap && boardOk && noBuyPressure && noLargeBuyWall) {
          signals.push({ type: "round_number_break_v3", bar: i, price: curr.close, reason: `大台割れV3(${prevRound}円) vol=${(curr.volume/avgVol10).toFixed(1)}x board=${boardScore}` });
        }
      }
    } else {
      // ===== 現行条件 =====
      let maintained = true;
      for (let j = Math.max(0, i - 4); j < i; j++) {
        if (candles[j].close > prevRound) { maintained = false; break; }
      }
      if (maintained && slope <= 0) {
        signals.push({ type: "round_number_break", bar: i, price: curr.close, reason: `大台割れ(${prevRound}円)` });
      }
    }
  }
  
  // 6. RSI+BB
  if ((curr.rsi ?? 50) >= 70 && curr.bbUpper && curr.close >= curr.bbUpper) {
    signals.push({ type: "other_short", bar: i, price: curr.close, reason: `RSI+BB上限` });
  }
  // 7. 上ヒゲ
  const bodySize = Math.abs(curr.open - curr.close);
  const upperShadow = curr.high - Math.max(curr.open, curr.close);
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;
  if (bodySize > 0.01 && upperShadow >= bodySize * 2 && lowerShadow <= bodySize * 0.5 && (curr.rsi ?? 50) >= 55) {
    signals.push({ type: "other_short", bar: i, price: curr.close, reason: `上ヒゲ` });
  }

  return signals;
}

// ============================================================
// シミュレーション
// ============================================================
interface TradeResult {
  date: string; symbol: string;
  entryBar: number; entryTime: string; entryPrice: number;
  exitBar: number; exitTime: string; exitPrice: number;
  pnl: number; pnlRate: number;
  reason: string; exitReason: string; signalType: string;
}

function simulateDay(
  candles: Candle[], symbol: string, date: string, useV3: boolean
): TradeResult[] {
  computeIndicators(candles);
  const bars5m = build5mCandles(candles);
  const trades: TradeResult[] = [];
  let capital = INITIAL_CAPITAL;
  let shortShares = 0, shortEntryPrice = 0, shortLowWater = 0, shortEntryBar = -1;
  let tradeCount = 0, shortEntryReason = "", shortSignalType = "";

  function isBlockedTime(time: string): boolean {
    const [h, m] = time.split(":").map(Number);
    const mins = h * 60 + m;
    if (mins >= 660 && mins <= 690) return true;
    if (mins >= 750 && mins <= 780) return true;
    return false;
  }

  for (let i = 0; i < candles.length; i++) {
    const curr = candles[i];

    // ========== エグジット ==========
    if (shortShares > 0) {
      if (curr.close < shortLowWater) shortLowWater = curr.close;
      const gain = (shortEntryPrice - shortLowWater) / shortEntryPrice;
      let stopPrice = shortEntryPrice * (1 + STOP_LOSS_RATIO);
      let exitReason = "損切り";
      if (gain >= TRAIL_TRIGGER) {
        stopPrice = shortLowWater * (1 + TRAIL_GAP);
        exitReason = "トレイリング利確";
      } else if (gain >= BREAKEVEN_TRIGGER) {
        stopPrice = Math.min(stopPrice, shortEntryPrice);
        exitReason = "同値撤退";
      }
      const profitRate = (shortEntryPrice - curr.close) / shortEntryPrice;
      if (profitRate >= TAKE_PROFIT_RATIO) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({ date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time, entryPrice: shortEntryPrice, exitBar: i, exitTime: curr.time, exitPrice: curr.close, pnl, pnlRate: profitRate, reason: shortEntryReason, exitReason: "利確", signalType: shortSignalType });
        shortShares = 0; tradeCount++;
        continue;
      }
      if (curr.close >= stopPrice) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({ date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time, entryPrice: shortEntryPrice, exitBar: i, exitTime: curr.time, exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice, reason: shortEntryReason, exitReason, signalType: shortSignalType });
        shortShares = 0; tradeCount++;
        continue;
      }
      if (i - shortEntryBar >= SHORT_MAX_HOLD_BARS) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({ date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time, entryPrice: shortEntryPrice, exitBar: i, exitTime: curr.time, exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice, reason: shortEntryReason, exitReason: "時間切れ", signalType: shortSignalType });
        shortShares = 0; tradeCount++;
        continue;
      }
      if (i === candles.length - 1) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({ date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time, entryPrice: shortEntryPrice, exitBar: i, exitTime: curr.time, exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice, reason: shortEntryReason, exitReason: "大引け", signalType: shortSignalType });
        shortShares = 0; tradeCount++;
        continue;
      }
    }

    // ========== エントリー ==========
    if (shortShares === 0 && tradeCount < MAX_TRADES_PER_DAY && !isBlockedTime(curr.time)) {
      const signals = detectShortSignals(candles, i, bars5m, useV3);
      for (const sig of signals) {
        if (shortShares > 0) break;
        const maxSpend = capital * LOT_RATIO;
        const shares = Math.floor(maxSpend / curr.close / 100) * 100;
        if (shares > 0) {
          shortShares = shares;
          shortEntryPrice = curr.close;
          shortLowWater = curr.close;
          shortEntryBar = i;
          capital -= shares * curr.close;
          shortEntryReason = sig.reason;
          shortSignalType = sig.type;
          break;
        }
      }
    }
  }

  return trades;
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  const allCandles = await db.select().from(rtCandles).orderBy(asc(rtCandles.tradeDate), asc(rtCandles.candleTime));
  console.log(`Total candles: ${allCandles.length}`);

  // グループ化
  const grouped: Record<string, Record<string, Candle[]>> = {};
  for (const c of allCandles) {
    if (!grouped[c.tradeDate]) grouped[c.tradeDate] = {};
    if (!grouped[c.tradeDate][c.symbol]) grouped[c.tradeDate][c.symbol] = [];
    const board = c.boardSnapshot ? (c.boardSnapshot as any as BoardData) : undefined;
    grouped[c.tradeDate][c.symbol].push({
      time: c.candleTime, open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
      board,
    });
  }

  const dates = Object.keys(grouped).sort();
  console.log(`Dates: ${dates.join(", ")}`);

  // 両方式でシミュレーション
  const currentAll: TradeResult[] = [];
  const v3All: TradeResult[] = [];

  for (const date of dates) {
    for (const symbol of Object.keys(grouped[date])) {
      const candles = grouped[date][symbol];
      if (candles.length < 30) continue;

      const curr = simulateDay(candles.map(c => ({ ...c })), symbol, date, false);
      currentAll.push(...curr);

      const v3 = simulateDay(candles.map(c => ({ ...c })), symbol, date, true);
      v3All.push(...v3);
    }
  }

  // 集計
  function agg(trades: TradeResult[]) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;
    const stopLoss = trades.filter(t => t.exitReason === "損切り").length;
    const takeProfit = trades.filter(t => t.exitReason === "利確" || t.exitReason === "トレイリング利確").length;
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    let peak = 0, maxDD = 0, cumPnl = 0;
    const sorted = [...trades].sort((a, b) => `${a.date}${a.exitTime}`.localeCompare(`${b.date}${b.exitTime}`));
    for (const t of sorted) { cumPnl += t.pnl; if (cumPnl > peak) peak = cumPnl; const dd = peak - cumPnl; if (dd > maxDD) maxDD = dd; }
    return { totalPnl, entryCount: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length > 0 ? wins.length / trades.length * 100 : 0, avgWin, avgLoss, maxLoss, stopLoss, takeProfit, pf, maxDD };
  }

  const cs = agg(currentAll);
  const vs = agg(v3All);

  // 大台割れ単体
  const currRound = currentAll.filter(t => t.signalType === "round_number_break");
  const v3Round = v3All.filter(t => t.signalType === "round_number_break_v3");
  const currRoundPnl = currRound.reduce((s, t) => s + t.pnl, 0);
  const v3RoundPnl = v3Round.reduce((s, t) => s + t.pnl, 0);

  // 出力
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const fmtPct = (n: number) => n.toFixed(2);

  console.log("\n" + "=".repeat(70));
  console.log("  大台割れ Ver3 比較バックテスト結果");
  console.log("  データ: rt_candles (KABUステーションAPI) " + dates[0] + " ~ " + dates[dates.length - 1]);
  console.log("=".repeat(70));

  console.log("\n【検証項目】");
  console.log(`${"指標".padEnd(22)}${"現行".padStart(14)}${"Ver3".padStart(14)}${"差分".padStart(14)}`);
  console.log("-".repeat(64));
  const rows: [string, number, number][] = [
    ["総損益", cs.totalPnl, vs.totalPnl],
    ["Profit Factor", cs.pf, vs.pf],
    ["最大DD", cs.maxDD, vs.maxDD],
    ["勝率(%)", cs.winRate, vs.winRate],
    ["平均利益", cs.avgWin, vs.avgWin],
    ["平均損失", cs.avgLoss, vs.avgLoss],
    ["大台割れ単体損益", currRoundPnl, v3RoundPnl],
    ["エントリー数", cs.entryCount, vs.entryCount],
  ];
  for (const [name, c, s] of rows) {
    const diff = s - c;
    const cStr = Math.abs(c) > 10 ? fmt(c) : fmtPct(c);
    const sStr = Math.abs(s) > 10 ? fmt(s) : fmtPct(s);
    const dStr = (diff >= 0 ? "+" : "") + (Math.abs(diff) > 10 ? fmt(diff) : fmtPct(diff));
    console.log(`${name.padEnd(22)}${cStr.padStart(14)}${sStr.padStart(14)}${dStr.padStart(14)}`);
  }

  // 追加
  console.log("\n【追加指標】");
  console.log(`  損切り回数: ${cs.stopLoss} → ${vs.stopLoss}`);
  console.log(`  利確回数: ${cs.takeProfit} → ${vs.takeProfit}`);
  console.log(`  最大損失: ${fmt(cs.maxLoss)}円 → ${fmt(vs.maxLoss)}円`);

  // 大台割れ詳細
  console.log("\n【大台割れ詳細】");
  console.log(`  現行: ${currRound.length}件, ${currRound.filter(t => t.pnl > 0).length}W/${currRound.filter(t => t.pnl <= 0).length}L, P&L: ${fmt(currRoundPnl)}円`);
  console.log(`  Ver3: ${v3Round.length}件, ${v3Round.filter(t => t.pnl > 0).length}W/${v3Round.filter(t => t.pnl <= 0).length}L, P&L: ${fmt(v3RoundPnl)}円`);
  if (v3Round.length > 0) {
    console.log(`  Ver3 取引詳細:`);
    for (const t of v3Round) {
      console.log(`    ${t.date} ${t.symbol} ${t.entryTime}→${t.exitTime} @${t.entryPrice}→${t.exitPrice} ${t.pnl > 0 ? "+" : ""}${fmt(t.pnl)}円 [${t.exitReason}] ${t.reason}`);
    }
  }

  // 合格基準
  console.log("\n【合格基準チェック】");
  const entryReduction = cs.entryCount > 0 ? (cs.entryCount - vs.entryCount) / cs.entryCount * 100 : 0;
  const criteria = [
    { name: "総損益改善", pass: vs.totalPnl > cs.totalPnl },
    { name: "ProfitFactor改善", pass: vs.pf > cs.pf },
    { name: "最大DD改善", pass: vs.maxDD < cs.maxDD },
    { name: "大台割れ損益プラス化", pass: v3RoundPnl > 0 },
    { name: "エントリー数減少15%以内", pass: entryReduction <= 15 },
  ];
  let passCount = 0;
  for (const c of criteria) {
    console.log(`  ${c.pass ? "✅ PASS" : "❌ FAIL"} ${c.name}`);
    if (c.pass) passCount++;
  }
  console.log(`\n  合格: ${passCount}/${criteria.length}`);

  // 日別
  console.log("\n【日別損益】");
  console.log(`${"日付".padEnd(12)}${"現行".padStart(12)}${"Ver3".padStart(12)}${"差分".padStart(12)}`);
  for (const date of dates) {
    const cDay = currentAll.filter(t => t.date === date).reduce((s, t) => s + t.pnl, 0);
    const vDay = v3All.filter(t => t.date === date).reduce((s, t) => s + t.pnl, 0);
    const diff = vDay - cDay;
    console.log(`${date.padEnd(12)}${fmt(cDay).padStart(12)}${fmt(vDay).padStart(12)}${((diff >= 0 ? "+" : "") + fmt(diff)).padStart(12)}`);
  }

  // Ver3がブロックした大台割れの分析
  console.log("\n【Ver3がブロックした大台割れ分析】");
  const blockedTrades = currRound; // 現行で入った大台割れ
  const blockedWins = blockedTrades.filter(t => t.pnl > 0);
  const blockedLosses = blockedTrades.filter(t => t.pnl <= 0);
  const v3Entered = v3Round.length;
  const blocked = currRound.length - v3Entered;
  console.log(`  現行大台割れ: ${currRound.length}件`);
  console.log(`  Ver3通過: ${v3Entered}件`);
  console.log(`  ブロック: ${blocked}件`);
  console.log(`    うち損切りだった: ${blockedLosses.length - (v3Round.filter(t => t.pnl <= 0).length)}件 (正しいブロック)`);
  console.log(`    うち利確だった: ${blockedWins.length - (v3Round.filter(t => t.pnl > 0).length)}件 (逸失利益)`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
