/**
 * realtimeSimEngine.ts
 *
 * リアルタイム取引シミュレーションエンジン
 *
 * 動作フロー:
 * 1. Windows中継スクリプトから1分足OHLCVを受信
 * 2. 受信した足をメモリ上の蓄積バッファに追加
 * 3. detectSignals()でシグナルを判定
 * 4. 買い/売りシグナルが出たら架空取引をDBに記録
 * 5. 大引け（15:30）後に全ポジションを強制決済
 *
 * 板情報（kabu STATION APIの板データ）はオプションの補助条件として使用:
 * - 買い板圧力が強い場合: 買いシグナルの確度を高める
 * - 売り板圧力が強い場合: 売りシグナルの確度を高める
 * - 大口壁がある場合: 逆方向シグナルを抑制
 */

import { insertRtCandle, insertRtTrade, upsertRtDailySummary, getRtTradesForDate, getRtCandlesAllForDate } from "./db";
import { detectSignals, type CandleWithSignal } from "./routers/stockData";
import { getOrderBook, analyzeOrderBook } from "./kabuStation";
import { getStockName } from "../shared/stocks";
import type { BoardSnapshot } from "../drizzle/schema";

// ============================================================
// 定数
// ============================================================

/** 元金（円）: 5銘柄 × 300万円 */
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;

/** ロット計算: 元金の何%を1トレードに使うか */
const LOT_RATIO = 0.9;

/** 損切り率（%）: エントリー価格から何%下落で損切り（プランB: -0.7%/高安値トリガー） */
const STOP_LOSS_PERCENT = 0.7;

/** 利確率（%）: エントリー価格から何%上昇で利確 */
const TAKE_PROFIT_PERCENT = 1.5;

/** 大引け強制決済の時刻 (HH:MM) */
const MARKET_CLOSE_TIME = "15:30";

/** 午後エントリー禁止の時刻 (HH:MM) - この時刻以降は新規エントリーしない（プランB: 15:15） */
const NO_ENTRY_AFTER = "15:15";

/** ウォームアップに必要な最低足数（MA25計算のため） */
const MIN_CANDLES_FOR_SIGNAL = 30;

// ============================================================
// 型定義
// ============================================================

export interface RtCandle1Min {
  symbol: string;
  tradeDate: string;   // YYYY-MM-DD
  candleTime: string;  // HH:MM
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  boardSignal?: string;
}

// ============================================================
// メモリ上の状態管理（プロセス再起動でリセット）
// ============================================================

/** 銘柄ごとの蓄積1分足バッファ（当日分のみ） */
const candleBuffers = new Map<string, CandleWithSignal[]>();

/** 銘柄ごとのオープンポジション（1銘柄1ポジションまで） */
const openPositions = new Map<string, OpenPosition>();

/** 当日の日付（日付が変わったらバッファをリセット） */
let currentTradeDate = "";

/** 当日の受信足数カウンター */
const candleCounters = new Map<string, number>();

/** 起動時バッファ復元が完了したか（複数回実行を防ぐ） */
let bufferRestored = false;

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * 現在の日本時間の日付を YYYY-MM-DD 形式で返す
 */
function getTodayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 日付が変わった場合にバッファをリセットする
 */
function resetIfNewDay(tradeDate: string): void {
  if (tradeDate !== currentTradeDate) {
    console.log(`[RealtimeSim] 新しい取引日: ${tradeDate}（前日: ${currentTradeDate}）`);
    candleBuffers.clear();
    openPositions.clear();
    candleCounters.clear();
    currentTradeDate = tradeDate;
    bufferRestored = false; // 日付変更時は復元フラグもリセット
  }
}

/**
 * サーバー起動時にDBから当日の1分足を読み込んでcandleBuffersを復元する
 *
 * サーバーが取引時間中に再起動した場合でも、既にDBに保存済みの足からシグナル判定を即座に再開できる。
 */
export async function restoreBuffersFromDb(): Promise<void> {
  if (bufferRestored) return;

  const today = getTodayJst();
  try {
    const rows = await getRtCandlesAllForDate(today);
    if (rows.length === 0) {
      console.log(`[RealtimeSim] バッファ復元: ${today} の足なし（初回起動）`);
      bufferRestored = true;
      currentTradeDate = today;
      return;
    }

    // 銀柄ごとにグループ化してバッファに追加
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
      grouped.get(row.symbol)!.push(row);
    }

    for (const [symbol, candles] of Array.from(grouped.entries())) {
      const buf: CandleWithSignal[] = candles.map((c) => ({
        time: `${c.tradeDate}T${c.candleTime}:00`,
        dayKey: c.tradeDate,
        timestamp: new Date(`${c.tradeDate}T${c.candleTime}:00+09:00`).getTime(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume ?? 0,
        ma5: null,
        ma25: null,
        rsi: null,
        bbUpper: null,
        bbMiddle: null,
        bbLower: null,
      }));

      // detectSignalsでMA/RSI/BBを一括計算してバッファを初期化
      const withSignals = detectSignals(buf);
      candleBuffers.set(symbol, withSignals);
      candleCounters.set(symbol, candles.length);
    }

    currentTradeDate = today;
    bufferRestored = true;
    console.log(`[RealtimeSim] バッファ復元完了: ${today} / ${grouped.size}銘柄 / 合計1分足${rows.length}本`);
  } catch (err) {
    console.error("[RealtimeSim] バッファ復元エラー:", err);
    // エラー時は復元済みにしない（次回のリクエストで再試行する）
  }
}

/**
 * ロット計算: 元金 × LOT_RATIO / 株価 → 株数（100株単位切り捨て）
 */
function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

/**
 * 板情報から BoardSnapshot を生成する
 */
function getBoardSnapshot(symbol: string): BoardSnapshot | null {
  const book = getOrderBook(symbol);
  if (!book) return null;

  const signals = analyzeOrderBook(book);
  const totalBidQty = book.bids.reduce((s, b) => s + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((s, a) => s + a.qty, 0) + book.overSellQty;
  const totalMarketQty = book.marketOrderBuyQty + book.marketOrderSellQty;
  const totalAll = totalBidQty + totalAskQty + totalMarketQty;

  const buyPressureRatio = totalAskQty > 0 ? totalBidQty / totalAskQty : 1.0;
  const marketOrderRatio = totalAll > 0 ? totalMarketQty / totalAll : 0;
  const largeBuyWall = signals.some(s => s.type === "large_bid_wall");
  const largeSellWall = signals.some(s => s.type === "large_ask_wall");

  let signal: BoardSnapshot["signal"] = "neutral";
  if (signals.some(s => s.type === "board_buy_pressure")) signal = "buy_pressure";
  else if (signals.some(s => s.type === "board_sell_pressure")) signal = "sell_pressure";
  else if (largeBuyWall) signal = "large_buy_wall";
  else if (largeSellWall) signal = "large_sell_wall";
  else if (signals.some(s => s.type === "market_order_surge")) signal = "market_surge";

  return {
    buyPressureRatio: Math.round(buyPressureRatio * 100) / 100,
    largeBuyWall,
    largeSellWall,
    marketOrderRatio: Math.round(marketOrderRatio * 1000) / 1000,
    signal,
  };
}

/**
 * 板情報シグナルが買いを補強するか
 */
function isBoardBullish(snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return true; // 板情報なし → 中立（シグナルを通す）
  return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
}

/**
 * 板情報シグナルが売りを補強するか
 */
function isBoardBearish(snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return true; // 板情報なし → 中立（シグナルを通す）
  return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
}

/**
 * 板情報が逆方向の大口壁を示しているか（エントリー抑制条件）
 */
function hasBoardCounterWall(snapshot: BoardSnapshot | null, side: "long" | "short"): boolean {
  if (!snapshot) return false;
  if (side === "long" && snapshot.largeSellWall) return true;  // 買いエントリーに大口売り壁
  if (side === "short" && snapshot.largeBuyWall) return true;  // 売りエントリーに大口買い壁
  return false;
}

// ============================================================
// メインエンジン
// ============================================================

/**
 * 1分足を受信してシミュレーションを実行するメイン関数
 *
 * @param candle 受信した1分足データ
 * @returns 実行結果（取引が発生した場合はその情報）
 */
export async function processCandle(candle: RtCandle1Min): Promise<{
  symbol: string;
  tradeDate: string;
  candleTime: string;
  action: "entry" | "exit" | "stop_loss" | "take_profit" | "forced_close" | "none";
  reason?: string;
  pnl?: number;
}> {
  const { symbol, tradeDate, candleTime } = candle;

  // 日付変更チェック
  resetIfNewDay(tradeDate);

  // 1分足をDBに保存
  const boardSnapshot = getBoardSnapshot(symbol);
  await insertRtCandle({
    symbol,
    tradeDate,
    candleTime,
    open: String(candle.open),
    high: String(candle.high),
    low: String(candle.low),
    close: String(candle.close),
    volume: candle.volume,
    boardSnapshot,
  });

  // バッファに追加
  if (!candleBuffers.has(symbol)) {
    candleBuffers.set(symbol, []);
  }
  const buffer = candleBuffers.get(symbol)!;

  // CandleWithSignal形式に変換してバッファに追加
  const candleForSignal: CandleWithSignal = {
    time: `${tradeDate}T${candleTime}:00`,
    dayKey: tradeDate,
    timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  };

  // MA/RSI/BBを計算するため、バッファに追加してからdetectSignalsを実行
  buffer.push(candleForSignal);

  // カウンター更新
  candleCounters.set(symbol, (candleCounters.get(symbol) ?? 0) + 1);

  // 日次サマリーを更新（受信足数のみ）
  await updateDailySummary(tradeDate);

  // ウォームアップ期間中はシグナル判定しない
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 既存ポジションの損切り・利確チェック ----
  const existingPos = openPositions.get(symbol);
  if (existingPos) {
    const result = await checkExitConditions(existingPos, candle, tradeDate, candleTime, boardSnapshot);
    if (result.action !== "none") {
      return result;
    }
  }

  // ---- 大引け強制決済チェック ----
  if (candleTime >= MARKET_CLOSE_TIME && existingPos) {
    return await forceClosePosition(existingPos, candle, tradeDate, candleTime, "大引け強制決済");
  }

  // ---- 午後エントリー禁止 ----
  if (candleTime >= NO_ENTRY_AFTER) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 既にポジションがある場合は新規エントリーしない ----
  if (existingPos) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- シグナル検出 ----
  // バッファ全体にdetectSignalsを適用（MA/RSI/BBを計算するため）
  const withSignals = detectSignals(buffer);
  const latestSignal = withSignals[withSignals.length - 1];

  // バッファのMA/RSI/BB値を更新（次回以降の計算効率化）
  buffer[buffer.length - 1] = latestSignal;

  if (!latestSignal.signal) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  const sig = latestSignal.signal;

  // ---- HybridAフィルター: 地合い判定 ----
  // 始値比±0.2%で地合いを判定
  // BULLISH（上昇相場）: LONGのみ許可、SHORT禁止
  // BEARISH/NEUTRAL: LONGもSHORTも両方OK
  const firstCandle = buffer[0];
  const openPrice = firstCandle?.open ?? candle.close;
  const priceChangeRatio = (candle.close - openPrice) / openPrice * 100;
  const isBullish = priceChangeRatio >= 0.2;   // 始値比+0.2%以上 → 上昇相場
  // const isBearish = priceChangeRatio <= -0.2; // 始値比-0.2%以下 → 下落相場（LONGもSHORTもOK）

  // ---- 買いエントリー ----
  if (sig.type === "buy") {
    // 板情報で大口売り壁がある場合は抑制
    if (hasBoardCounterWall(boardSnapshot, "long")) {
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // 板情報が売り優勢の場合も抑制
    if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    return await enterPosition("long", candle, tradeDate, candleTime, sig.reason, boardSnapshot);
  }

  // ---- 売り（空売り）エントリー ----
  if (sig.type === "sell") {
    // HybridAフィルター: BULLISH相場ではSHORT禁止
    if (isBullish) {
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // 板情報で大口買い壁がある場合は抑制
    if (hasBoardCounterWall(boardSnapshot, "short")) {
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // 板情報が買い優勢の場合も抑制
    if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    return await enterPosition("short", candle, tradeDate, candleTime, sig.reason, boardSnapshot);
  }

  return { symbol, tradeDate, candleTime, action: "none" };
}

/**
 * ポジションをエントリーする
 */
async function enterPosition(
  side: "long" | "short",
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  reason: string,
  boardSnapshot: BoardSnapshot | null,
): Promise<ReturnType<typeof processCandle>> {
  const { symbol } = candle;
  const price = candle.close;
  const shares = calcShares(price);
  const amount = price * shares;
  const action = side === "long" ? "buy" : "short";
  const boardSignal = boardSnapshot?.signal ?? undefined;

  const pos: OpenPosition = {
    symbol,
    side,
    entryPrice: price,
    shares,
    entryTime: candleTime,
    entryReason: reason,
    boardSignal,
  };

  openPositions.set(symbol, pos);

  await insertRtTrade({
    tradeDate,
    symbol,
    symbolName: getStockName(symbol),
    action,
    price: String(price),
    shares,
    amount,
    pnl: null,
    reason,
    tradeTime: candleTime,
    side,
    boardSignal: boardSignal ?? null,
  });

  console.log(`[RealtimeSim] ${symbol} ${action} @${price}円 ×${shares}株 (${reason})`);

  return { symbol, tradeDate, candleTime, action: "entry", reason };
}

/**
 * 損切り・利確チェック
 */
async function checkExitConditions(
  pos: OpenPosition,
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  boardSnapshot: BoardSnapshot | null,
): Promise<ReturnType<typeof processCandle>> {
  const { symbol, side, entryPrice, shares } = pos;
  const { high, low, close } = candle;

  let exitPrice: number | null = null;
  let exitReason = "";
  let action: "exit" | "stop_loss" | "take_profit" = "exit";

  if (side === "long") {
    // 損切り: 安値が損切りラインを下回った
    const stopLine = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
    if (low <= stopLine) {
      exitPrice = stopLine;
      exitReason = `損切り (損切りライン:${stopLine.toFixed(0)}円)`;
      action = "stop_loss";
    }
    // 利確: 高値が利確ラインを上回った
    const tpLine = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
    if (high >= tpLine && exitPrice === null) {
      exitPrice = tpLine;
      exitReason = `利確 (利確ライン:${tpLine.toFixed(0)}円)`;
      action = "take_profit";
    }
  } else {
    // 空売り: 損切り（高値が損切りラインを上回った）
    const stopLine = entryPrice * (1 + STOP_LOSS_PERCENT / 100);
    if (high >= stopLine) {
      exitPrice = stopLine;
      exitReason = `損切り (損切りライン:${stopLine.toFixed(0)}円)`;
      action = "stop_loss";
    }
    // 空売り: 利確（安値が利確ラインを下回った）
    const tpLine = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
    if (low <= tpLine && exitPrice === null) {
      exitPrice = tpLine;
      exitReason = `利確 (利確ライン:${tpLine.toFixed(0)}円)`;
      action = "take_profit";
    }
  }

  // シグナル反転による決済
  if (exitPrice === null) {
    const buffer = candleBuffers.get(symbol);
    if (buffer && buffer.length > 0) {
      const latest = buffer[buffer.length - 1];
      if (latest.signal) {
        if (side === "long" && latest.signal.type === "sell") {
          exitPrice = close;
          exitReason = `シグナル反転決済: ${latest.signal.reason}`;
          action = "exit";
        } else if (side === "short" && latest.signal.type === "buy") {
          exitPrice = close;
          exitReason = `シグナル反転決済: ${latest.signal.reason}`;
          action = "exit";
        }
      }
    }
  }

  if (exitPrice === null) {
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  return await closePosition(pos, exitPrice, exitReason, action, tradeDate, candleTime, boardSnapshot);
}

/**
 * 大引け強制決済
 */
async function forceClosePosition(
  pos: OpenPosition,
  candle: RtCandle1Min,
  tradeDate: string,
  candleTime: string,
  reason: string,
): Promise<ReturnType<typeof processCandle>> {
  return await closePosition(pos, candle.close, reason, "exit", tradeDate, candleTime, null);
}

/**
 * ポジションを決済する
 */
async function closePosition(
  pos: OpenPosition,
  exitPrice: number,
  reason: string,
  action: "exit" | "stop_loss" | "take_profit",
  tradeDate: string,
  candleTime: string,
  boardSnapshot: BoardSnapshot | null,
): Promise<ReturnType<typeof processCandle>> {
  const { symbol, side, entryPrice, shares } = pos;
  const exitAction = side === "long" ? "sell" : "cover";
  const amount = exitPrice * shares;

  // 損益計算
  const pnl = side === "long"
    ? Math.round((exitPrice - entryPrice) * shares)
    : Math.round((entryPrice - exitPrice) * shares);

  openPositions.delete(symbol);

  await insertRtTrade({
    tradeDate,
    symbol,
    symbolName: getStockName(symbol),
    action: exitAction,
    price: String(exitPrice),
    shares,
    amount,
    pnl,
    reason,
    tradeTime: candleTime,
    side,
    boardSignal: boardSnapshot?.signal ?? null,
  });

  console.log(`[RealtimeSim] ${symbol} ${exitAction} @${exitPrice}円 ×${shares}株 損益:${pnl >= 0 ? "+" : ""}${pnl}円 (${reason})`);

  // 日次サマリーを更新
  await updateDailySummary(tradeDate);

  return { symbol, tradeDate, candleTime, action, reason, pnl };
}

/**
 * 日次サマリーをDBに更新する
 */
async function updateDailySummary(tradeDate: string): Promise<void> {
  try {
    const trades = await getRtTradesForDate(tradeDate);

    // 決済済みトレードのみ集計（buy/shortはエントリー、sell/coverは決済）
    const closedTrades = trades.filter(t => t.action === "sell" || t.action === "cover");
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const winCount = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const lossCount = closedTrades.filter(t => (t.pnl ?? 0) <= 0).length;

    // 全銘柄の受信足数合計
    let totalCandles = 0;
    for (const count of Array.from(candleCounters.values())) {
      totalCandles += count;
    }

    await upsertRtDailySummary({
      tradeDate,
      initialCapital: INITIAL_CAPITAL_PER_STOCK * 5, // 5銘柄分
      totalPnl,
      tradesCount: closedTrades.length,
      winCount,
      lossCount,
      candlesReceived: totalCandles,
    });
  } catch (err) {
    console.error("[RealtimeSim] 日次サマリー更新エラー:", err);
  }
}

/**
 * 大引け後の全ポジション強制決済（スケジューラーから呼ばれる）
 *
 * @param tradeDate 対象日 (YYYY-MM-DD)
 * @param closingPrices 銘柄コード → 引け値のマップ
 */
export async function forceCloseAllPositions(
  tradeDate: string,
  closingPrices: Map<string, number>,
): Promise<void> {
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  const jstMin = now.getUTCMinutes();
  const closeTime = `${String(jstHour).padStart(2, "0")}:${String(jstMin).padStart(2, "0")}`;

  for (const [symbol, pos] of Array.from(openPositions.entries()) as [string, OpenPosition][]) {
    const price = closingPrices.get(symbol) ?? pos.entryPrice;
    const fakeCandle: RtCandle1Min = {
      symbol,
      tradeDate,
      candleTime: closeTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    await forceClosePosition(pos, fakeCandle, tradeDate, closeTime, "大引け強制決済（スケジューラー）");
  }
}

/**
 * 現在のオープンポジション一覧を返す（UI表示用）
 */
export function getOpenPositions(): OpenPosition[] {
  return Array.from(openPositions.values());
}

/**
 * 当日の受信足数を返す（UI表示用）
 */
export function getCandleCounters(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sym, count] of Array.from(candleCounters.entries())) {
    result[sym] = count;
  }
  return result;
}
