/**
 * threePeakDetector.ts
 *
 * 3山切り下げv2 (SHORT) / 3谷切り上げv2 (LONG) シグナル検出モジュール
 * 
 * 現行エンジンのエントリーには一切影響せず、シグナル検出とDB記録のみを行う。
 * 仮想TP/SL/EOD判定も追跡する。
 *
 * 対象銘柄: 6981（村田製作所）のみ
 */

import { getDb } from "./db";
import { rt3peakSignals } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

// ============================================================
// 定数
// ============================================================

/** 対象銘柄（6981のみ） */
const TARGET_SYMBOL = "6981";

/** TP率: 1.5% */
const TP_PERCENT = 0.015;

/** SL率: 0.5% */
const SL_PERCENT = 0.005;

/** エントリー禁止時刻（以降はシグナル検出しない） */
const NO_ENTRY_AFTER = "14:50";

/** 強制決済時刻 */
const FORCE_EXIT_TIME = "15:20";

/** 最小足数（ウォームアップ） */
const MIN_CANDLES = 10;

/** スイングポイント検出のlookback */
const SWING_LOOKBACK = 2;

/** 連続切り下げ/切り上げの最小回数 */
const MIN_CONSECUTIVE = 3;

/** 前回エントリーからの最小間隔（足数） */
const MIN_ENTRY_INTERVAL = 5;

/** 仮想投資額（1トレードあたり） */
const VIRTUAL_AMOUNT = 1_000_000;

// ============================================================
// 型定義
// ============================================================

interface SimpleCandle {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SwingPoint {
  price: number;
  index: number;
  time: string;
}

interface ThreePeakPosition {
  direction: "short" | "long";
  entryPrice: number;
  entryTime: string;
  entryIdx: number;
  shares: number;
  consecutiveCount: number;
  details: string;
}

// ============================================================
// メモリ上の状態（日次リセット）
// ============================================================

/** 当日のバッファ（6981のみ） */
let dayBuffer: SimpleCandle[] = [];

/** 現在の仮想ポジション（最大1つ） */
let openPosition: ThreePeakPosition | null = null;

/** 最後にシグナルを出した足のインデックス */
let lastSignalIdx = -10;

/** 現在の日付 */
let currentDate = "";

// ============================================================
// スイングポイント検出
// ============================================================

function detectSwingHighs(candles: SimpleCandle[], upToIdx: number): SwingPoint[] {
  const highs: SwingPoint[] = [];
  const end = Math.min(upToIdx, candles.length - 1);
  for (let i = SWING_LOOKBACK; i <= end - SWING_LOOKBACK; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    for (let j = 1; j <= SWING_LOOKBACK; j++) {
      if (candles[i - j].high >= curr.high || candles[i + j].high >= curr.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) highs.push({ price: curr.high, index: i, time: candles[i].candleTime });
  }
  return highs;
}

function detectSwingLows(candles: SimpleCandle[], upToIdx: number): SwingPoint[] {
  const lows: SwingPoint[] = [];
  const end = Math.min(upToIdx, candles.length - 1);
  for (let i = SWING_LOOKBACK; i <= end - SWING_LOOKBACK; i++) {
    const curr = candles[i];
    let isSwingLow = true;
    for (let j = 1; j <= SWING_LOOKBACK; j++) {
      if (candles[i - j].low <= curr.low || candles[i + j].low <= curr.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) lows.push({ price: curr.low, index: i, time: candles[i].candleTime });
  }
  return lows;
}

// ============================================================
// 連続カウント
// ============================================================

/** 連続切り下げ回数（直近から遡る） */
function countConsecutiveLH(swingHighs: SwingPoint[]): number {
  if (swingHighs.length < 2) return 0;
  let count = 0;
  for (let i = swingHighs.length - 1; i > 0; i--) {
    if (swingHighs[i].price < swingHighs[i - 1].price) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** 連続切り上げ回数（直近から遡る） */
function countConsecutiveHL(swingLows: SwingPoint[]): number {
  if (swingLows.length < 2) return 0;
  let count = 0;
  for (let i = swingLows.length - 1; i > 0; i--) {
    if (swingLows[i].price > swingLows[i - 1].price) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ============================================================
// トレンド継続確認（v2条件）
// ============================================================

/** 直近スイングハイ以降に高値更新なし → 下降トレンド継続 */
function isStillInDowntrend(candles: SimpleCandle[], swingHighs: SwingPoint[], currentIdx: number): boolean {
  if (swingHighs.length === 0) return false;
  const lastSH = swingHighs[swingHighs.length - 1];
  for (let i = lastSH.index + 1; i <= currentIdx; i++) {
    if (candles[i].high > lastSH.price) return false;
  }
  return true;
}

/** 直近スイングロー以降に安値更新なし → 上昇トレンド継続 */
function isStillInUptrend(candles: SimpleCandle[], swingLows: SwingPoint[], currentIdx: number): boolean {
  if (swingLows.length === 0) return false;
  const lastSL = swingLows[swingLows.length - 1];
  for (let i = lastSL.index + 1; i <= currentIdx; i++) {
    if (candles[i].low < lastSL.price) return false;
  }
  return true;
}

// ============================================================
// DB操作
// ============================================================

async function insertSignal(data: {
  tradeDate: string;
  symbol: string;
  direction: "short" | "long";
  signalTime: string;
  entryPrice: number;
  shares: number;
  consecutiveCount: number;
  details: string;
}): Promise<number | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const result = await db.insert(rt3peakSignals).values({
      tradeDate: data.tradeDate,
      symbol: data.symbol,
      direction: data.direction,
      signalTime: data.signalTime,
      entryPrice: String(data.entryPrice),
      shares: data.shares,
      consecutiveCount: data.consecutiveCount,
      details: data.details,
    });
    return (result as any)[0]?.insertId ?? null;
  } catch (err) {
    console.error("[3PeakDetector] DB insert error:", err);
    return null;
  }
}

async function updateSignalExit(data: {
  tradeDate: string;
  signalTime: string;
  symbol: string;
  direction: "short" | "long";
  exitPrice: number;
  exitTime: string;
  exitReason: "tp" | "sl" | "eod";
  virtualPnl: number;
  holdBars: number;
}): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    // 当日の該当シグナルを更新（pendingのもの）
    await db.update(rt3peakSignals)
      .set({
        exitPrice: String(data.exitPrice),
        exitTime: data.exitTime,
        exitReason: data.exitReason,
        virtualPnl: data.virtualPnl,
        holdBars: data.holdBars,
      })
      .where(
        and(
          eq(rt3peakSignals.tradeDate, data.tradeDate),
          eq(rt3peakSignals.signalTime, data.signalTime),
          eq(rt3peakSignals.symbol, data.symbol),
          eq(rt3peakSignals.direction, data.direction),
          eq(rt3peakSignals.exitReason, "pending"),
        )
      );
  } catch (err) {
    console.error("[3PeakDetector] DB update error:", err);
  }
}

// ============================================================
// メインロジック
// ============================================================

/**
 * 日次リセット
 */
export function resetThreePeakState(tradeDate: string): void {
  if (tradeDate !== currentDate) {
    dayBuffer = [];
    openPosition = null;
    lastSignalIdx = -10;
    currentDate = tradeDate;
    console.log(`[3PeakDetector] 日次リセット: ${tradeDate}`);
  }
}

/**
 * 1分足を受信して3山v2シグナルを検出する
 * 現行エンジンのprocessCandleから呼ばれる（6981のみ）
 *
 * @returns シグナルが検出された場合はその情報、なければnull
 */
export async function processThreePeakCandle(
  symbol: string,
  tradeDate: string,
  candleTime: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Promise<{ direction: "short" | "long"; entryPrice: number } | null> {
  // 6981以外はスキップ
  if (symbol !== TARGET_SYMBOL) return null;

  // 昼休みスキップ
  if (candleTime >= "11:30" && candleTime < "12:30") return null;

  // 日付変更チェック
  resetThreePeakState(tradeDate);

  // バッファに追加
  const candle: SimpleCandle = { candleTime, open, high, low, close, volume };
  dayBuffer.push(candle);

  const currentIdx = dayBuffer.length - 1;

  // ---- 仮想ポジションの管理（TP/SL/EOD判定） ----
  if (openPosition) {
    const pos = openPosition;
    const holdBars = currentIdx - pos.entryIdx;

    if (pos.direction === "short") {
      // SHORT: 高値がSLに到達 or 安値がTPに到達
      const lossPct = (high - pos.entryPrice) / pos.entryPrice;
      const profitPct = (pos.entryPrice - low) / pos.entryPrice;

      if (lossPct >= SL_PERCENT) {
        const exitPrice = pos.entryPrice * (1 + SL_PERCENT);
        const pnl = Math.round((pos.entryPrice - exitPrice) * pos.shares);
        await updateSignalExit({
          tradeDate, signalTime: pos.entryTime, symbol, direction: "short",
          exitPrice, exitTime: candleTime, exitReason: "sl", virtualPnl: pnl, holdBars,
        });
        console.log(`[3PeakDetector] SHORT SL: @${pos.entryPrice}→${exitPrice.toFixed(0)} PnL:${pnl}円 [${holdBars}本]`);
        openPosition = null;
        return null;
      }
      if (profitPct >= TP_PERCENT) {
        const exitPrice = pos.entryPrice * (1 - TP_PERCENT);
        const pnl = Math.round((pos.entryPrice - exitPrice) * pos.shares);
        await updateSignalExit({
          tradeDate, signalTime: pos.entryTime, symbol, direction: "short",
          exitPrice, exitTime: candleTime, exitReason: "tp", virtualPnl: pnl, holdBars,
        });
        console.log(`[3PeakDetector] SHORT TP: @${pos.entryPrice}→${exitPrice.toFixed(0)} PnL:+${pnl}円 [${holdBars}本]`);
        openPosition = null;
        return null;
      }
    } else {
      // LONG: 安値がSLに到達 or 高値がTPに到達
      const lossPct = (pos.entryPrice - low) / pos.entryPrice;
      const profitPct = (high - pos.entryPrice) / pos.entryPrice;

      if (lossPct >= SL_PERCENT) {
        const exitPrice = pos.entryPrice * (1 - SL_PERCENT);
        const pnl = Math.round((exitPrice - pos.entryPrice) * pos.shares);
        await updateSignalExit({
          tradeDate, signalTime: pos.entryTime, symbol, direction: "long",
          exitPrice, exitTime: candleTime, exitReason: "sl", virtualPnl: pnl, holdBars,
        });
        console.log(`[3PeakDetector] LONG SL: @${pos.entryPrice}→${exitPrice.toFixed(0)} PnL:${pnl}円 [${holdBars}本]`);
        openPosition = null;
        return null;
      }
      if (profitPct >= TP_PERCENT) {
        const exitPrice = pos.entryPrice * (1 + TP_PERCENT);
        const pnl = Math.round((exitPrice - pos.entryPrice) * pos.shares);
        await updateSignalExit({
          tradeDate, signalTime: pos.entryTime, symbol, direction: "long",
          exitPrice, exitTime: candleTime, exitReason: "tp", virtualPnl: pnl, holdBars,
        });
        console.log(`[3PeakDetector] LONG TP: @${pos.entryPrice}→${exitPrice.toFixed(0)} PnL:+${pnl}円 [${holdBars}本]`);
        openPosition = null;
        return null;
      }
    }

    // EOD判定
    if (candleTime >= FORCE_EXIT_TIME) {
      const exitPrice = close;
      const pnl = pos.direction === "short"
        ? Math.round((pos.entryPrice - exitPrice) * pos.shares)
        : Math.round((exitPrice - pos.entryPrice) * pos.shares);
      await updateSignalExit({
        tradeDate, signalTime: pos.entryTime, symbol, direction: pos.direction,
        exitPrice, exitTime: candleTime, exitReason: "eod", virtualPnl: pnl, holdBars,
      });
      console.log(`[3PeakDetector] ${pos.direction.toUpperCase()} EOD: @${pos.entryPrice}→${exitPrice.toFixed(0)} PnL:${pnl >= 0 ? "+" : ""}${pnl}円 [${holdBars}本]`);
      openPosition = null;
      return null;
    }

    // ポジション保有中は新規シグナルを出さない
    return null;
  }

  // ---- 新規シグナル検出 ----

  // ウォームアップ
  if (dayBuffer.length < MIN_CANDLES) return null;

  // 時刻フィルター
  if (candleTime < "09:10" || candleTime >= NO_ENTRY_AFTER) return null;

  // 前回シグナルからの間隔
  if (currentIdx - lastSignalIdx < MIN_ENTRY_INTERVAL) return null;

  // 次足が必要なので最後の足ではスキップ（リアルタイムでは前足を判定）
  // リアルタイムでは「前足」の条件を今足で確認する方式に変更
  // つまり: i-1が条件足、iが確認足（次足安値/高値更新チェック）
  if (currentIdx < 2) return null;

  const prevCandle = dayBuffer[currentIdx - 1]; // 条件足
  const currCandle = dayBuffer[currentIdx];     // 確認足（今足）
  const openPrice = dayBuffer[0].open;

  // ---- 3山切り下げv2 (SHORT) ----
  const swingHighs = detectSwingHighs(dayBuffer, currentIdx - 1);
  const consecutiveLH = countConsecutiveLH(swingHighs);

  if (consecutiveLH >= MIN_CONSECUTIVE) {
    // ② 全体の方向が下落（始値 > 前足close）
    if (openPrice > prevCandle.close) {
      // ③ 陰線転換（前々足陽線→前足陰線）
      const prevPrevCandle = dayBuffer[currentIdx - 2];
      const isPrevBearish = prevCandle.close < prevCandle.open;
      const isPrevPrevBullish = prevPrevCandle.close >= prevPrevCandle.open;

      if (isPrevBearish && isPrevPrevBullish) {
        // ④ v2条件: 下降トレンド継続確認
        if (isStillInDowntrend(dayBuffer, swingHighs, currentIdx - 1)) {
          // ⑤ 今足（確認足）で前足安値更新
          if (currCandle.low < prevCandle.low) {
            // シグナル検出！
            const entryPrice = currCandle.close;
            const shares = Math.floor(VIRTUAL_AMOUNT / entryPrice);
            const details = `3山v2 SHORT: LH=${consecutiveLH}, 始値${openPrice}>現値${prevCandle.close}, 陰線転換, 下降継続確認済, 安値更新(${currCandle.low}<${prevCandle.low})`;

            lastSignalIdx = currentIdx;
            openPosition = {
              direction: "short",
              entryPrice,
              entryTime: candleTime,
              entryIdx: currentIdx,
              shares,
              consecutiveCount: consecutiveLH,
              details,
            };

            await insertSignal({
              tradeDate, symbol, direction: "short", signalTime: candleTime,
              entryPrice, shares, consecutiveCount: consecutiveLH, details,
            });

            console.log(`[3PeakDetector] ★SHORT SIGNAL: ${symbol} @${entryPrice} (LH=${consecutiveLH}) ${candleTime}`);
            return { direction: "short", entryPrice };
          }
        }
      }
    }
  }

  // ---- 3谷切り上げv2 (LONG) ----
  const swingLows = detectSwingLows(dayBuffer, currentIdx - 1);
  const consecutiveHL = countConsecutiveHL(swingLows);

  if (consecutiveHL >= MIN_CONSECUTIVE) {
    // ② 全体の方向が上昇（始値 < 前足close）
    if (openPrice < prevCandle.close) {
      // ③ 陽線転換（前々足陰線→前足陽線）
      const prevPrevCandle = dayBuffer[currentIdx - 2];
      const isPrevBullish = prevCandle.close > prevCandle.open;
      const isPrevPrevBearish = prevPrevCandle.close < prevPrevCandle.open;

      if (isPrevBullish && isPrevPrevBearish) {
        // ④ v2条件: 上昇トレンド継続確認
        if (isStillInUptrend(dayBuffer, swingLows, currentIdx - 1)) {
          // ⑤ 今足（確認足）で前足高値更新
          if (currCandle.high > prevCandle.high) {
            // シグナル検出！
            const entryPrice = currCandle.close;
            const shares = Math.floor(VIRTUAL_AMOUNT / entryPrice);
            const details = `3谷v2 LONG: HL=${consecutiveHL}, 始値${openPrice}<現値${prevCandle.close}, 陽線転換, 上昇継続確認済, 高値更新(${currCandle.high}>${prevCandle.high})`;

            lastSignalIdx = currentIdx;
            openPosition = {
              direction: "long",
              entryPrice,
              entryTime: candleTime,
              entryIdx: currentIdx,
              shares,
              consecutiveCount: consecutiveHL,
              details,
            };

            await insertSignal({
              tradeDate, symbol, direction: "long", signalTime: candleTime,
              entryPrice, shares, consecutiveCount: consecutiveHL, details,
            });

            console.log(`[3PeakDetector] ★LONG SIGNAL: ${symbol} @${entryPrice} (HL=${consecutiveHL}) ${candleTime}`);
            return { direction: "long", entryPrice };
          }
        }
      }
    }
  }

  return null;
}

/**
 * 大引け時に未決済の仮想ポジションを強制決済する
 */
export async function forceCloseThreePeakPosition(tradeDate: string, closePrice: number): Promise<void> {
  if (!openPosition) return;
  const pos = openPosition;
  const holdBars = dayBuffer.length - 1 - pos.entryIdx;
  const pnl = pos.direction === "short"
    ? Math.round((pos.entryPrice - closePrice) * pos.shares)
    : Math.round((closePrice - pos.entryPrice) * pos.shares);

  await updateSignalExit({
    tradeDate,
    signalTime: pos.entryTime,
    symbol: TARGET_SYMBOL,
    direction: pos.direction,
    exitPrice: closePrice,
    exitTime: "15:20",
    exitReason: "eod",
    virtualPnl: pnl,
    holdBars,
  });

  console.log(`[3PeakDetector] Force close ${pos.direction.toUpperCase()}: @${pos.entryPrice}→${closePrice} PnL:${pnl >= 0 ? "+" : ""}${pnl}円`);
  openPosition = null;
}

/**
 * 当日の3山v2シグナル結果を取得する（通知用）
 */
export async function getThreePeakSignalsForDate(tradeDate: string): Promise<Array<{
  direction: "short" | "long";
  signalTime: string;
  entryPrice: number;
  exitPrice: number | null;
  exitTime: string | null;
  exitReason: string;
  virtualPnl: number | null;
  shares: number;
  holdBars: number | null;
  consecutiveCount: number;
  details: string | null;
}>> {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(rt3peakSignals)
      .where(and(
        eq(rt3peakSignals.tradeDate, tradeDate),
        eq(rt3peakSignals.symbol, TARGET_SYMBOL),
      ))
      .orderBy(rt3peakSignals.signalTime);
    return rows.map(r => ({
      direction: r.direction,
      signalTime: r.signalTime,
      entryPrice: Number(r.entryPrice),
      exitPrice: r.exitPrice ? Number(r.exitPrice) : null,
      exitTime: r.exitTime,
      exitReason: r.exitReason,
      virtualPnl: r.virtualPnl,
      shares: r.shares,
      holdBars: r.holdBars,
      consecutiveCount: r.consecutiveCount,
      details: r.details,
    }));
  } catch (err) {
    console.error("[3PeakDetector] getSignalsForDate error:", err);
    return [];
  }
}

/**
 * 現在の仮想ポジション状態を返す（デバッグ用）
 */
export function getThreePeakStatus(): {
  hasPosition: boolean;
  position: ThreePeakPosition | null;
  bufferLength: number;
  currentDate: string;
} {
  return {
    hasPosition: openPosition !== null,
    position: openPosition,
    bufferLength: dayBuffer.length,
    currentDate,
  };
}
