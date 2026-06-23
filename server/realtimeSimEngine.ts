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
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "./routers/stockData";
import { getOrderBook, analyzeOrderBook, calcExtendedBoardFields } from "./kabuStation";
import { getHigherTfTrend } from "./vwap";
import { calcATR } from "./intradayRegime";
import { getStockName, TARGET_STOCKS } from "../shared/stocks";

import type { BoardSnapshot } from "../drizzle/schema";

// TARGET_STOCKSに含まれる銘柄のみ処理対象（除外銘柄はスキップ）
const ALLOWED_SYMBOLS: Set<string> = new Set(TARGET_STOCKS.map(s => s.symbol));

// ============================================================
// 定数
// ============================================================

/** 元金（円）: 5銘柄 × 300万円 */
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;

/** ロット計算: 元金の何%を1トレードに使うか */
const LOT_RATIO = 0.9;

/** 損切り率（%）: エントリー価格から何%下落で損切り（6/11良い結果: -0.7%/高安値トリガー） */
const STOP_LOSS_PERCENT = 0.5; // 改善③: 0.7→0.5に引き締め (2026-06-16検証済み)

/** 利確率（%）: エントリー価格から何%上昇で利確 */
const TAKE_PROFIT_PERCENT = 1.5;

/** 証拠金（元金）: 現物300万円 */
const MARGIN_CAPITAL = 3_000_000;

/** 信用倍率: 3.3倍 */
const MARGIN_MULTIPLIER = 3.3;

/** 最大使用率: 証拠金 × 信用倍率 × この割合を超えたらエントリー停止 */
const MARGIN_USAGE_LIMIT = 0.9; // 90% → 990万 × 90% = 891万円

/** 最大投資可能額 = 300万 × 3.3倍 × 90% = 8,910,000円 */
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;

/** 大引け強制決済の時刻 (HH:MM) */
const MARKET_CLOSE_TIME = "15:30";

/** 午後エントリー禁止の時刻 (HH:MM) - この時刻以降は新規エントリーしない（6/11良い結果: 15:15） */
const NO_ENTRY_AFTER = "15:15";
/** 改善④: 09:30以前はエントリー禁止（寄り付きダマシ排除） */
const NO_ENTRY_BEFORE = "09:30";

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

/**
 * ダウ理論（上昇）押し目確認ステートマシン
 * 高値更新シグナル受信後、一度押し（下落）が入り直近安値を割らずに再上昇した足でエントリーする。
 */
interface PullbackState {
  recentSwingLow: number;  // 損切りライン（この安値を割ったらキャンセル）
  signalPrice: number;     // シグナル発生時の価格
  waitCount: number;       // 待機足数カウンター
  pulledBack: boolean;     // 一度押しが入ったか
  reason: string;          // エントリー理由
  boardSignal?: string;    // 板情報シグナル
}

/** 銘柄ごとの押し目確認待ちステート（ダウ理論上昇のみ） */
const pullbackStates = new Map<string, PullbackState>();

/** 押し目確認の最大待機足数 */
const PULLBACK_MAX_WAIT = 5;

/**
 * 大台超え/割れ 確認バーステートマシン
 * 大台シグナル発生後、N本連続してキリ番の上/下を維持したらエントリーする。
 */
interface RoundLevelPendingState {
  direction: "buy" | "sell";  // エントリー方向
  level: number;              // キリ番価格
  confirmCount: number;       // 維持確認本数カウンター
  reason: string;             // エントリー理由
  boardSignal?: string;       // 板情報シグナル
}

/** 改善⑤: 大台確認後の押し目待ちステート */
interface RoundPullbackState {
  direction: "buy" | "sell";  // エントリー方向
  level: number;              // キリ番価格
  signalPrice: number;        // 確認完了時の価格
  waitCount: number;          // 待機足数カウンター
  pulledBack: boolean;        // 一度押しが入ったか
  reason: string;             // エントリー理由
}

/** 銘柄ごとの大台確認待ちステート */
const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();

/** 銘柄ごとの大台確認後押し目待ちステート */
const roundPullbackStates = new Map<string, RoundPullbackState>();

/** 大台確認に必要な維持本数（5本 = 5分間維持） */
const ROUND_LEVEL_CONFIRM_BARS = 5;

/** 大台確認後の押し目待ち最大足数 */
const ROUND_PULLBACK_MAX_WAIT = 5;

/** ★v6: 板読みスコア閾値（この値以上でエントリー許可） */
const BOARD_SCORE_THRESHOLD = 1;

/** ★ATRフィルター: 直近N本のATR率がこの値以下ならエントリーしない */
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012; // 0.12%

/** ★押し目深さフィルター: ダウ理論シグナルの押し目深さが範囲外ならブロック */
const PULLBACK_DEPTH_MIN = 0.30; // 30% — これ以下は「浅すぎる押し目」（高値づかみリスク）
const PULLBACK_DEPTH_MAX = 0.70; // 70% — これ以上は「深すぎる押し目」（トレンド崩壊リスク）
const PULLBACK_DEPTH_LOOKBACK = 20; // 直近20本のスイング高値/安値を参照

/** ★v6: 板読み早期利確の最低利益率（%） */
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;

/** 当日の日付（日付が変わったらバッファをリセット） */
let currentTradeDate = "";

/** 当日の受信足数カウンター */
const candleCounters = new Map<string, number>();

/** 起動時バッファ復元が完了したか（複数回実行を防ぐ） */
let bufferRestored = false;

/** 最後に1分足を受信した時刻（ISO文字列、接続監視用） */
let lastCandleReceivedAt: string | null = null;

/** 銘柄ごとの確定損益（当日分） */
const symbolPnlMap = new Map<string, number>();

/** 当日の全シグナル履歴（最新200件まで） */
const signalHistory: Array<{
  time: string;       // HH:MM
  symbol: string;
  symbolName: string;
  action: string;     // buy/sell/short/cover/stop_loss/take_profit/forced_close
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
}> = [];

/** シグナル履歴の最大件数 */
const MAX_SIGNAL_HISTORY = 200;

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
    pullbackStates.clear(); // 日付変更時に押し目確認ステートもリセット
    roundLevelPendingStates.clear(); // 日付変更時に大台確認待ちステートもリセット
    roundPullbackStates.clear(); // 日付変更時に大台押し目待ちステートもリセット
    symbolPnlMap.clear(); // 日付変更時に銘柄別損益もリセット
    signalHistory.length = 0; // 日付変更時にシグナル履歴もリセット
    bprHistory.clear(); // ★v6: 板圧力履歴もリセット
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

      // MA5・MA25・RSI・BBを事前計算してバッファに設定
      // （detectSignalsは入力のma5/ma25/rsi/bbをそのまま使うため、事前計算が必須）
      const closesForRestore = buf.map(c => c.close);
      const ma5R = calcMA(closesForRestore, 5);
      const ma25R = calcMA(closesForRestore, 25);
      const rsiR = calcRSI(closesForRestore, 14);
      const bbR = calcBollinger(closesForRestore, 20);
      buf.forEach((c, i) => {
        c.ma5 = ma5R[i];
        c.ma25 = ma25R[i];
        c.rsi = rsiR[i];
        c.bbUpper = bbR.upper[i];
        c.bbMiddle = bbR.middle[i];
        c.bbLower = bbR.lower[i];
      });

      // detectSignalsでシグナルを一括計算してバッファを初期化
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
 * 現在のオープンポジション合計投資額を計算する
 */
function calcCurrentExposure(): number {
  let total = 0;
  for (const pos of Array.from(openPositions.values())) {
    total += pos.entryPrice * pos.shares;
  }
  return total;
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

  // v5拡張フィールドを計算
  const extended = calcExtendedBoardFields(book);

  return {
    buyPressureRatio: Math.round(buyPressureRatio * 100) / 100,
    largeBuyWall,
    largeSellWall,
    marketOrderRatio: Math.round(marketOrderRatio * 1000) / 1000,
    signal,
    ...extended,
  };
}

/** ★v6: 銀柄ごとのbuyPressureRatio履歴（直近5本分） */
const bprHistory = new Map<string, number[]>();

/**
 * ★v6: 板読みスコアを計算する
 *
 * 5要素の統合スコア:
 * A) アグレッシブ注文検出 (±2): marketOrderRatio≧0.08で方向判定
 * B) 厚い板のアノマリー (±1): largeBuyWall/largeSellWall
 * C) 板圧力トレンド (±1): 直近5本のbpr変化量≧0.15
 * D) 相場モード判定 (+1/-2): active/building→+1, trap/quiet→-2
 * E) 板圧力の強さ (±1): bpr≧1.4(買い圧力強) or bpr≦0.65(売り圧力強)
 */
export function boardReadingScore(symbol: string, side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1; // 板情報なし → 中立（シグナルを通す）

  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  // 「板の厚い方に動く」→ 逆側の壁はブレイクスルーのサイン
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;  // 売り壁を突破する勢い
    if (snapshot.largeBuyWall) score -= 1;   // 買い壁がサポート→過信になりやすい
  } else {
    if (snapshot.largeBuyWall) score += 1;   // 買い壁を突破する勢い
    if (snapshot.largeSellWall) score -= 1;  // 売り壁がサポート→過信になりやすい
  }

  // 要素C: 板圧力トレンド (±1)
  const history = bprHistory.get(symbol) ?? [];
  if (history.length >= 3) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }

  // 要素D: 相場モード判定 (+1/-2)
  const mode = detectMarketMode(symbol, snapshot);
  if (mode === "active" || mode === "building") {
    score += 1;
  } else if (mode === "trap" || mode === "quiet") {
    score -= 2;
  }

  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;

  return score;
}

/**
 * ★v6: 相場モード判定
 * - active: 板圧力が明確に一方向（bpr > 1.2 or bpr < 0.8）
 * - building: 板圧力が徐々に変化中（0.8≤bpr≤1.2でトレンドあり）
 * - trap: 板圧力が強いのに価格が動かない（大口の罠）
 * - quiet: 出来高が極端に少ない（様子見相場）
 */
export function detectMarketMode(symbol: string, snapshot: BoardSnapshot): "active" | "building" | "trap" | "quiet" {
  const bpr = snapshot.buyPressureRatio;
  const history = bprHistory.get(symbol) ?? [];

  // quiet: 板圧力がほぼ1.0で変化がない
  if (history.length >= 3) {
    const allNeutral = history.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  }

  // active: 板圧力が明確に一方向
  if (bpr > 1.2 || bpr < 0.8) return "active";

  // building: 変化トレンドがある
  if (history.length >= 3) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const delta = Math.abs(newest - oldest);
    if (delta >= 0.1) return "building";
  }

  // trap: 板圧力はあるが変化がない（大口が板を固めている）
  return "trap";
}

/**
 * ★v6: 板読み早期利確チェック
 * 保有中に逆方向の強い板シグナルが出た場合、利益があれば早期利確する
 */
export function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;

  const pnlPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

  // 利益が最低利益率以上ある場合のみ
  if (pnlPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;

  // 逆方向の強い板シグナルを検出
  if (pos.side === "long") {
    // ロング保有中に売り圧力が強い
    return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
  } else {
    // ショート保有中に買い圧力が強い
    return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
  }
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

  // 除外銘柄チェック: TARGET_STOCKSに含まれない銘柄は即スキップ
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return { symbol, tradeDate, candleTime, action: "none" as const };
  }

  // 日付変更チェック
  resetIfNewDay(tradeDate);

  // 1分足をDBに保存
  const boardSnapshot = getBoardSnapshot(symbol);

  // ★v6: buyPressureRatio履歴を更新（直近5本分保持）
  if (boardSnapshot) {
    const history = bprHistory.get(symbol) ?? [];
    history.push(boardSnapshot.buyPressureRatio);
    if (history.length > 5) history.shift();
    bprHistory.set(symbol, history);
  }

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

  // バッファに追加
  buffer.push(candleForSignal);

  // MA5・MA25・RSI・BBを計算してバッファの最新足に設定
  // （detectSignalsは入力のma5/ma25/rsi/bbをそのまま使うため、事前計算が必須）
  const closes = buffer.map(c => c.close);
  const ma5Series = calcMA(closes, 5);
  const ma25SeriesCalc = calcMA(closes, 25);
  const rsiSeries = calcRSI(closes, 14);
  const bbSeries = calcBollinger(closes, 20);
  const lastIdx = buffer.length - 1;
  buffer[lastIdx].ma5 = ma5Series[lastIdx];
  buffer[lastIdx].ma25 = ma25SeriesCalc[lastIdx];
  buffer[lastIdx].rsi = rsiSeries[lastIdx];
  buffer[lastIdx].bbUpper = bbSeries.upper[lastIdx];
  buffer[lastIdx].bbMiddle = bbSeries.middle[lastIdx];
  buffer[lastIdx].bbLower = bbSeries.lower[lastIdx];

  // カウンター更新
  candleCounters.set(symbol, (candleCounters.get(symbol) ?? 0) + 1);
  // 最後受信時刻を更新（接続監視用）
  lastCandleReceivedAt = new Date().toISOString();

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

  // ---- 改善④: 09:30以前エントリー禁止 ----
  if (candleTime < NO_ENTRY_BEFORE) {
    return { symbol, tradeDate, candleTime, action: "none" };
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

  // ---- 押し目確認ステートマシン処理 (ダウ理論上昇のみ) ----
  const pullbackState = pullbackStates.get(symbol);
  if (pullbackState) {
    pullbackState.waitCount++;

    // 直近安値を割ったらキャンセル
    if (candle.low < pullbackState.recentSwingLow) {
      pullbackStates.delete(symbol);
      console.log(`[RealtimeSim] ${symbol} 押し目確認キャンセル: 安値割れ (${candle.low} < ${pullbackState.recentSwingLow})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 最大待機足数超過でキャンセル
    if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
      pullbackStates.delete(symbol);
      console.log(`[RealtimeSim] ${symbol} 押し目確認キャンセル: 待機タイムアウト (${pullbackState.waitCount}本超過)`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 押しが入ったか確認（現在足の終値がシグナル発生時価格より下）
    if (!pullbackState.pulledBack && candle.close < pullbackState.signalPrice) {
      pullbackState.pulledBack = true;
    }

    // 押し後に再上昇した足でエントリー
    if (pullbackState.pulledBack && candle.close > pullbackState.signalPrice) {
      pullbackStates.delete(symbol);
      // ★v6b対策A: sell_pressure時のプルバック経由LONG禁止
      if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
        console.log(`[RealtimeSim] ${symbol} 押し目確認: sell_pressure時LONG禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ★v6: 板読みスコアで統合判定
      const brScore = boardReadingScore(symbol, "long", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) {
        console.log(`[RealtimeSim] ${symbol} 押し目確認: 板読みスコア不足(${brScore})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      console.log(`[RealtimeSim] ${symbol} 押し目確認後エントリー: ${pullbackState.reason} (板スコア:${brScore})`);
      return await enterPosition("long", candle, tradeDate, candleTime, `押し目確認: ${pullbackState.reason}`, boardSnapshot);
    }

    // まだ待機中
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 大台確認バーステートマシン処理 ----
  const roundPending = roundLevelPendingStates.get(symbol);
  if (roundPending) {
    // ポジションが入ったらキャンセル
    if (openPositions.has(symbol)) {
      roundLevelPendingStates.delete(symbol);
    } else {
      const stillValid =
        roundPending.direction === "buy"
          ? candle.close >= roundPending.level
          : candle.close <= roundPending.level;

      if (stillValid) {
        roundPending.confirmCount++;
        if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
          roundLevelPendingStates.delete(symbol);
          // 改善⑤: 確認完了 → 即エントリーせず押し目待ちステートに移行
          if (candleTime < NO_ENTRY_AFTER) {
            console.log(`[RealtimeSim] ${symbol} 大台確認完了(${ROUND_LEVEL_CONFIRM_BARS}本維持) → 押し目待ち開始: ${roundPending.reason}`);
            roundPullbackStates.set(symbol, {
              direction: roundPending.direction,
              level: roundPending.level,
              signalPrice: candle.close,
              waitCount: 0,
              pulledBack: false,
              reason: `大台確認(${ROUND_LEVEL_CONFIRM_BARS}本維持): ${roundPending.reason}`,
            });
          }
        }
      } else {
        // キリ番を維持できなかった → キャンセル
        console.log(`[RealtimeSim] ${symbol} 大台確認キャンセル: キリ番割れ (${candle.close} vs ${roundPending.level})`);
        roundLevelPendingStates.delete(symbol);
      }
      return { symbol, tradeDate, candleTime, action: "none" };
    }
  }

  // ---- 改善⑤: 大台確認後の押し目待ちステートマシン処理 ----
  const roundPb = roundPullbackStates.get(symbol);
  if (roundPb) {
    roundPb.waitCount++;
    const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";

    // キリ番を割り込んだらキャンセル
    if (roundPb.direction === "buy" && candle.close < roundPb.level) {
      console.log(`[RealtimeSim] ${symbol} 大台押し目待ちキャンセル: キリ番割れ (${candle.close} < ${roundPb.level})`);
      roundPullbackStates.delete(symbol);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    if (roundPb.direction === "sell" && candle.close > roundPb.level) {
      console.log(`[RealtimeSim] ${symbol} 大台押し目待ちキャンセル: キリ番上拜り (${candle.close} > ${roundPb.level})`);
      roundPullbackStates.delete(symbol);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // タイムアウト: 押し目なし＝強トレンド → そのままエントリー
    if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
      roundPullbackStates.delete(symbol);
      // ★v6b対策A: プルバック経由の板圧力チェック
      if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") {
        console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: sell_pressure時LONG禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") {
        console.log(`[RealtimeSim] ${symbol} 大台押し目タイムアウト: buy_pressure時SHORT禁止(プルバック経由)`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ★v6: 板読みスコアで統合判定
      const brScoreTimeout = boardReadingScore(symbol, side, boardSnapshot);
      if (brScoreTimeout < BOARD_SCORE_THRESHOLD) {
        console.log(`[RealtimeSim] ${symbol} 大台押し目待ちタイムアウト: 板読みスコア不足(${brScoreTimeout})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      console.log(`[RealtimeSim] ${symbol} 大台押し目なし・強トレンドエントリー: ${roundPb.reason} (板スコア:${brScoreTimeout})`);
      return await enterPosition(side, candle, tradeDate, candleTime, `${roundPb.reason} (押し目なし・強トレンド)`, boardSnapshot);
    }

    // 押し目判定
    if (roundPb.direction === "buy") {
      // 買い: 一度下がった（close < signalPrice）→ 再上昇（close > signalPrice）でエントリー
      if (!roundPb.pulledBack && candle.close < roundPb.signalPrice) {
        roundPb.pulledBack = true;
      }
      if (roundPb.pulledBack && candle.close > roundPb.signalPrice) {
        roundPullbackStates.delete(symbol);
        // ★v6b対策A: sell_pressure時の大台プルバック経由LONG禁止
        if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: sell_pressure時LONG禁止(プルバック経由)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        // ★v6: 板読みスコアで統合判定
        const brScoreBuy = boardReadingScore(symbol, "long", boardSnapshot);
        if (brScoreBuy < BOARD_SCORE_THRESHOLD) {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 板読みスコア不足(${brScoreBuy})`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        console.log(`[RealtimeSim] ${symbol} 大台押し目確認後エントリー: ${roundPb.reason} (板スコア:${brScoreBuy})`);
        return await enterPosition("long", candle, tradeDate, candleTime, `${roundPb.reason} (押し目確認後)`, boardSnapshot);
      }
    } else {
      // 売り: 一度上がった（close > signalPrice）→ 再下落（close < signalPrice）でエントリー
      if (!roundPb.pulledBack && candle.close > roundPb.signalPrice) {
        roundPb.pulledBack = true;
      }
      if (roundPb.pulledBack && candle.close < roundPb.signalPrice) {
        roundPullbackStates.delete(symbol);
        // ★v6b対策A: buy_pressure時の大台プルバック経由SHORT禁止
        if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: buy_pressure時SHORT禁止(プルバック経由)`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        // ★v6: 板読みスコアで統合判定
        const brScoreSell = boardReadingScore(symbol, "short", boardSnapshot);
        if (brScoreSell < BOARD_SCORE_THRESHOLD) {
          console.log(`[RealtimeSim] ${symbol} 大台押し目確認: 板読みスコア不足(${brScoreSell})`);
          return { symbol, tradeDate, candleTime, action: "none" };
        }
        console.log(`[RealtimeSim] ${symbol} 大台押し目確認後エントリー: ${roundPb.reason} (板スコア:${brScoreSell})`);
        return await enterPosition("short", candle, tradeDate, candleTime, `${roundPb.reason} (押し目確認後)`, boardSnapshot);
      }
    }

    // まだ待機中
    return { symbol, tradeDate, candleTime, action: "none" };
  }

  // ---- 買いエントリー ----
  if (sig.type === "buy") {
    // ★VWAPクロス上抜けシグナル無効化（5日間検証で0勝4敗, -69,803円のため除外）
    if (sig.reason.includes("VWAPクロス上抜け")) {
      console.log(`[RealtimeSim] ${symbol} VWAPクロス上抜けシグナル: 無効化によりブロック (${sig.reason.substring(0, 40)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // ★v6b: sell_pressure時のLONG禁止（板が売り圧力時に買いエントリーをブロック）
    if (boardSnapshot && boardSnapshot.signal === "sell_pressure") {
      console.log(`[RealtimeSim] ${symbol} BUYシグナル: sell_pressure時LONG禁止 (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // ★v6: 板読みスコアで統合判定
    const brScoreBuy = boardReadingScore(symbol, "long", boardSnapshot);
    if (brScoreBuy < BOARD_SCORE_THRESHOLD) {
      console.log(`[RealtimeSim] ${symbol} BUYシグナル: 板読みスコア不足(${brScoreBuy}) (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // ダウ理論（上昇）シグナルは押し目確認ステートマシンに登録して待機
    if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
      // ---- 5分足上位足フィルター ----
      // 5分足 MA5 > MA25（上昇トレンド）のときのみエントリーを許可する
      const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htfTrend !== "up") {
        console.log(`[RealtimeSim] ${symbol} ダウ理論上昇シグナル: 5分足フィルターにより抑制 (上位足トレンド: ${htfTrend})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ---- ★押し目深さフィルター (LONG) ----
      // 直近20本のスイング高値/安値を基準に、現在価格の押し目深さを計算
      // 30-70%の範囲外ならブロック（浅すぎ=高値づかみ、深すぎ=トレンド崩壊）
      if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK, buffer.length);
        const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
        const swingLow = Math.min(...lookbackWindow.map(c => c.low));
        if (swingHigh > swingLow) {
          const pullbackDepth = (swingHigh - candle.close) / (swingHigh - swingLow);
          if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) {
            console.log(
              `[RealtimeSim] ${symbol} ダウ理論LONG: 押し目深さフィルターによりブロック ` +
              `(深さ=${(pullbackDepth * 100).toFixed(1)}%, 許可範囲=${(PULLBACK_DEPTH_MIN * 100).toFixed(0)}-${(PULLBACK_DEPTH_MAX * 100).toFixed(0)}%)`
            );
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
      }
      pullbackStates.set(symbol, {
        recentSwingLow: sig.recentSwingLow,
        signalPrice: candle.close,
        waitCount: 0,
        pulledBack: false,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 押し目待機開始: ${sig.reason} (SwingLow:${sig.recentSwingLow})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }

    // 大台超えシグナルは確認バーステートマシンに登録して待機
    if (sig.reason.startsWith("大台超え")) {
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
      const level = m ? parseFloat(m[1]) : candle.close;
      roundLevelPendingStates.set(symbol, {
        direction: "buy",
        level,
        confirmCount: 0,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 大台超え確認待機開始: ${sig.reason} (キリ番:${level}円)`);
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
    // ★v6b: buy_pressure時のSHORT禁止（板が買い圧力時に売りエントリーをブロック）
    if (boardSnapshot && boardSnapshot.signal === "buy_pressure") {
      console.log(`[RealtimeSim] ${symbol} SHORTシグナル: buy_pressure時SHORT禁止 (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // ★v6: 板読みスコアで統合判定
    const brScoreShort = boardReadingScore(symbol, "short", boardSnapshot);
    if (brScoreShort < BOARD_SCORE_THRESHOLD) {
      console.log(`[RealtimeSim] ${symbol} SHORTシグナル: 板読みスコア不足(${brScoreShort}) (${sig.reason.substring(0, 30)})`);
      return { symbol, tradeDate, candleTime, action: "none" };
    }
    // 改善①: ダウ理論SHORTにも5分足フィルター追加（5分足MA5<MA25確認）
    if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
      const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htfTrend !== "down") {
        console.log(`[RealtimeSim] ${symbol} ダウ理論SHORTシグナル: 5分足フィルターにより抑制 (上位足トレンド: ${htfTrend})`);
        return { symbol, tradeDate, candleTime, action: "none" };
      }
      // ---- ★押し目深さフィルター (SHORT) ----
      // 直近20本のスイング高値/安値を基準に、現在価格の戻り深さを計算
      // 30-70%の範囲外ならブロック（浅すぎ=安値圈、深すぎ=トレンド崩壊）
      if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK, buffer.length);
        const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
        const swingLow = Math.min(...lookbackWindow.map(c => c.low));
        if (swingHigh > swingLow) {
          // SHORTの押し目深さ: 安値からどれだけ戻したか
          const pullbackDepth = (candle.close - swingLow) / (swingHigh - swingLow);
          if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) {
            console.log(
              `[RealtimeSim] ${symbol} ダウ理論SHORT: 押し目深さフィルターによりブロック ` +
              `(深さ=${(pullbackDepth * 100).toFixed(1)}%, 許可範囲=${(PULLBACK_DEPTH_MIN * 100).toFixed(0)}-${(PULLBACK_DEPTH_MAX * 100).toFixed(0)}%)`
            );
            return { symbol, tradeDate, candleTime, action: "none" };
          }
        }
      }
    }

    // 大台割れシグナルは確認バーステートマシンに登録して待機
    if (sig.reason.startsWith("大台割れ")) {
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
      const level = m ? parseFloat(m[1]) : candle.close;
      roundLevelPendingStates.set(symbol, {
        direction: "sell",
        level,
        confirmCount: 0,
        reason: sig.reason,
        boardSignal: boardSnapshot?.signal ?? undefined,
      });
      console.log(`[RealtimeSim] ${symbol} 大台割れ確認待機開始: ${sig.reason} (キリ番:${level}円)`);
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

  // ---- ★ATRフィルター: 低ボラティリティ銀柄のエントリーをブロック ----
  const buffer = candleBuffers.get(symbol);
  if (buffer && buffer.length >= ATR_FILTER_PERIOD + 1) {
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closes = buffer.map(c => c.close);
    const atrSeries = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);
    const latestATR = atrSeries[atrSeries.length - 1];
    if (latestATR !== null && price > 0) {
      const atrRatio = latestATR / price;
      if (atrRatio < ATR_FILTER_THRESHOLD) {
        console.log(
          `[RealtimeSim] ATRフィルター: ${symbol} エントリーブロック ` +
          `(ATR率=${(atrRatio * 100).toFixed(4)}% < 閾値${(ATR_FILTER_THRESHOLD * 100).toFixed(2)}%)`
        );
        return { symbol, tradeDate, candleTime, action: "none" };
      }
    }
  }

  // ---- 証拠金使用率制限チェック ----
  // 現在のオープンポジション合計 + 今回の投資額が MAX_TOTAL_EXPOSURE を超える場合はエントリー停止
  const currentExposure = calcCurrentExposure();
  if (currentExposure + amount > MAX_TOTAL_EXPOSURE) {
    console.log(
      `[RealtimeSim] 証拠金使用率制限: ${symbol} エントリーキャンセル ` +
      `(現在${(currentExposure / 10000).toFixed(0)}万円 + 今回${(amount / 10000).toFixed(0)}万円 = ` +
      `${((currentExposure + amount) / 10000).toFixed(0)}万円 > 上限${(MAX_TOTAL_EXPOSURE / 10000).toFixed(0)}万円)`
    );
    return { symbol, tradeDate, candleTime, action: "none" };
  }

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

  // シグナル履歴に追加（エントリー）
  signalHistory.unshift({
    time: candleTime,
    symbol,
    symbolName: getStockName(symbol),
    action,
    price,
    shares,
    pnl: null,
    reason,
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;

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

  // ★v6: 板読み早期利確
  if (exitPrice === null && shouldBoardEarlyExit(pos, close, boardSnapshot)) {
    exitPrice = close;
    exitReason = `板読み早期利確 (逆方向板圧力検出)`;
    action = "take_profit";
    console.log(`[RealtimeSim] ${symbol} 板読み早期利確: @${close}円 (bpr:${boardSnapshot?.buyPressureRatio}, signal:${boardSnapshot?.signal})`);
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

  // 銘柄別損益を更新
  symbolPnlMap.set(symbol, (symbolPnlMap.get(symbol) ?? 0) + pnl);

  // シグナル履歴に追加（決済エントリ）
  signalHistory.unshift({
    time: candleTime,
    symbol,
    symbolName: getStockName(symbol),
    action: action === "stop_loss" ? "stop_loss" : action === "take_profit" ? "take_profit" : exitAction,
    price: exitPrice,
    shares,
    pnl,
    reason,
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.length = MAX_SIGNAL_HISTORY;

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
 * DBから復元したエントリーレコードをメモリ上のopenPositions Mapに復元する。
 * サーバー再起動後にスケジューラーが大引け強制決済を行う際に使用する。
 */
export function restoreOpenPositions(entries: Array<{
  symbol: string;
  side: "long" | "short";
  price: string | number;
  shares: number;
  tradeTime: string;
  reason: string;
}>): void {
  for (const entry of entries) {
    if (!openPositions.has(entry.symbol)) {
      openPositions.set(entry.symbol, {
        symbol: entry.symbol,
        side: entry.side,
        entryPrice: Number(entry.price),
        shares: entry.shares,
        entryTime: entry.tradeTime,
        entryReason: entry.reason,
      });
      console.log(`[RealtimeSim] Restored open position from DB: ${entry.symbol} ${entry.side} @${entry.price}円 ×${entry.shares}株`);
    }
  }
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

/**
 * 最後に1分足を受信した時刻を返す（接続監視用）
 */
export function getLastCandleReceivedAt(): string | null {
  return lastCandleReceivedAt;
}

/**
 * 銘柄ごとの確定損益（当日分）を返す
 */
export function getSymbolPnlMap(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sym, pnl] of Array.from(symbolPnlMap.entries())) {
    result[sym] = pnl;
  }
  return result;
}

/**
 * 当日のシグナル履歴を返す（最新N件）
 */
export function getSignalHistory(limit = 50): typeof signalHistory {
  return signalHistory.slice(0, limit);
}

/**
 * ダッシュボード用の統合ステータスを返す
 */
export function getDashboardStatus(): {
  lastCandleReceivedAt: string | null;
  currentTradeDate: string;
  totalCandlesReceived: number;
  openPositionCount: number;
  symbolPnl: Record<string, number>;
  totalPnl: number;
  candleCounters: Record<string, number>;
  signalHistory: typeof signalHistory;
} {
  const symbolPnl = getSymbolPnlMap();
  const totalPnl = Object.values(symbolPnl).reduce((sum, v) => sum + v, 0);
  let totalCandlesReceived = 0;
  const counters: Record<string, number> = {};
  for (const [sym, count] of Array.from(candleCounters.entries())) {
    counters[sym] = count;
    totalCandlesReceived += count;
  }
  return {
    lastCandleReceivedAt,
    currentTradeDate,
    totalCandlesReceived,
    openPositionCount: openPositions.size,
    symbolPnl,
    totalPnl,
    candleCounters: counters,
    signalHistory: signalHistory.slice(0, 100),
  };
}
