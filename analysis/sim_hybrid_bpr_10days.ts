/**
 * sim_hybrid_bpr_10days.ts
 *
 * ハイブリッド方式シミュレーション（シグナル＋BPR確認）
 * 
 * コンセプト:
 * - シグナル（パターン認識）が発生 → 即エントリーせず「BPR確認待機ステート」に入る
 * - 次の足以降で、boardSnapshotのBPR確認が同方向と確認できたらエントリー
 *   - LONG: avgBprIn10s（または従来のbuyPressureRatio）≥ 閾値 + bprDelta > 0 + iceberg≥1
 *   - SHORT: avgBprIn10s ≤ 閾値 + bprDelta < 0 + iceberg≥1
 * - 最大待機: 5分（5本）。確認できなければキャンセル
 * 
 * データ対応:
 * - 6/25〜7/2: 従来の`buyPressureRatio`フィールドで代替（avgBprIn10sが存在しない）
 * - 7/3: `avgBprIn10s`と`bprDeltaIn10s`を使用
 * 
 * 複数閾値パターンでスイープ:
 * - A) ベースライン（BPR確認なし、現行方式）
 * - B) BPR≥1.10/≤0.90 + Delta同方向
 * - C) BPR≥1.15/≤0.85 + Delta同方向
 * - D) BPR≥1.20/≤0.80 + Delta同方向
 * - E) BPR≥1.10/≤0.90 + Delta同方向 + iceberg≥1
 * - F) BPR≥1.15/≤0.85 + Delta同方向 + iceberg≥1
 * - G) BPR≥1.15/≤0.85 のみ（Deltaなし、icebergなし）
 * - H) BPR≥1.10/≤0.90 + iceberg≥1（Deltaなし）
 */

import { getDb } from "../server/db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calcATR } from "../server/intradayRegime";
import { TARGET_STOCKS, getStockName } from "../shared/stocks";

// ============================================================
// シナリオ定義
// ============================================================
interface Scenario {
  name: string;
  bprThresholdLong: number;   // LONGエントリーに必要なBPR下限
  bprThresholdShort: number;  // SHORTエントリーに必要なBPR上限
  requireDelta: boolean;      // bprDeltaの方向一致を要求するか
  requireIceberg: boolean;    // アイスバーグ検出を要求するか
  maxWaitBars: number;        // 最大待機本数（分）
  description: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "A) ベースライン（現行方式）",
    bprThresholdLong: 0, bprThresholdShort: 999,
    requireDelta: false, requireIceberg: false,
    maxWaitBars: 0,
    description: "BPR確認なし、即エントリー"
  },
  {
    name: "B) BPR≥1.10/≤0.90 + Delta",
    bprThresholdLong: 1.10, bprThresholdShort: 0.90,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 5,
    description: "緩い閾値+方向一致"
  },
  {
    name: "C) BPR≥1.15/≤0.85 + Delta",
    bprThresholdLong: 1.15, bprThresholdShort: 0.85,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 5,
    description: "中程度の閾値+方向一致"
  },
  {
    name: "D) BPR≥1.20/≤0.80 + Delta",
    bprThresholdLong: 1.20, bprThresholdShort: 0.80,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 5,
    description: "厳しい閾値+方向一致"
  },
  {
    name: "E) BPR≥1.10/≤0.90 + Delta + Iceberg",
    bprThresholdLong: 1.10, bprThresholdShort: 0.90,
    requireDelta: true, requireIceberg: true,
    maxWaitBars: 5,
    description: "緩い閾値+方向+アイスバーグ"
  },
  {
    name: "F) BPR≥1.15/≤0.85 + Delta + Iceberg",
    bprThresholdLong: 1.15, bprThresholdShort: 0.85,
    requireDelta: true, requireIceberg: true,
    maxWaitBars: 5,
    description: "中程度の閾値+方向+アイスバーグ"
  },
  {
    name: "G) BPR≥1.15/≤0.85 のみ",
    bprThresholdLong: 1.15, bprThresholdShort: 0.85,
    requireDelta: false, requireIceberg: false,
    maxWaitBars: 5,
    description: "BPR閾値のみ（Deltaなし、icebergなし）"
  },
  {
    name: "H) BPR≥1.10/≤0.90 + Iceberg",
    bprThresholdLong: 1.10, bprThresholdShort: 0.90,
    requireDelta: false, requireIceberg: true,
    maxWaitBars: 5,
    description: "緩い閾値+アイスバーグ（Deltaなし）"
  },
  {
    name: "I) BPR≥1.05/≤0.95 + Delta",
    bprThresholdLong: 1.05, bprThresholdShort: 0.95,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 5,
    description: "非常に緩い閾値+方向一致"
  },
  {
    name: "J) BPR≥1.05/≤0.95 のみ",
    bprThresholdLong: 1.05, bprThresholdShort: 0.95,
    requireDelta: false, requireIceberg: false,
    maxWaitBars: 5,
    description: "非常に緩い閾値のみ"
  },
  {
    name: "K) BPR≥1.10/≤0.90 + Delta (10分待機)",
    bprThresholdLong: 1.10, bprThresholdShort: 0.90,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 10,
    description: "緩い閾値+方向+長い待機"
  },
  {
    name: "L) BPR≥1.05/≤0.95 + Delta (10分待機)",
    bprThresholdLong: 1.05, bprThresholdShort: 0.95,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 10,
    description: "非常に緩い閾値+方向+長い待機"
  },
  {
    name: "M) BPR≥1.15/≤0.85 + Delta (10分待機)",
    bprThresholdLong: 1.15, bprThresholdShort: 0.85,
    requireDelta: true, requireIceberg: false,
    maxWaitBars: 10,
    description: "中程度の閾値+方向+長い待機"
  },
  {
    name: "N) BPR≥1.10/≤0.90 のみ",
    bprThresholdLong: 1.10, bprThresholdShort: 0.90,
    requireDelta: false, requireIceberg: false,
    maxWaitBars: 5,
    description: "緩い閾値のみ（Deltaなし）"
  },
];

// ============================================================
// 定数（本番と完全一致）
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const BE_TRIGGER_PERCENT = 0.5;
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const MARKET_CLOSE_TIME = "15:30";
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const VWAP_DROP_FILTER_5BARS = -0.8;
const VWAP_DROP_FILTER_3BARS = -0.6;
const MIN_CANDLES_FOR_SIGNAL = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
const B2_THRESHOLD = 0.2;

const TEN_SYMBOLS = TARGET_STOCKS.map(s => s.symbol);

// ============================================================
// 型定義
// ============================================================
interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  confidence: SignalConfidence;
  beTriggered: boolean;
}

interface PullbackState {
  recentSwingLow: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

interface RoundLevelPendingState {
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

interface BprPendingState {
  symbol: string;
  side: "long" | "short";
  signalPrice: number;
  signalTime: string;
  reason: string;
  waitBars: number;
  buffer: CandleWithSignal[];
  bpr: number | null;
  bprHist: number[];
}

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  beTriggered: boolean; session: "am" | "pm"; shares: number;
  delayed: boolean; // BPR確認後の遅延エントリーかどうか
}

interface ScenarioResult {
  name: string;
  description: string;
  trades: Trade[];
  totalPnl: number;
  winRate: number;
  pf: number;
  tradeCount: number;
  blockedCount: number;
  delayedCount: number;
  immediateCount: number;
}

// ============================================================
// ヘルパー関数
// ============================================================
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean {
  if (buffer.length < 10) return false;
  const lookback = Math.min(buffer.length, 20);
  const recent = buffer.slice(buffer.length - lookback);
  const zeroCount = recent.filter(c => c.volume === 0).length;
  return (zeroCount / lookback) >= VOLUME_UNAVAILABLE_RATIO;
}

function getHigherTfTrend(buffer: CandleWithSignal[], currentIdx: number): "up" | "down" | "neutral" {
  const candlesSoFar = buffer.slice(0, currentIdx + 1);
  const htf: { close: number }[] = [];
  let group: CandleWithSignal[] = [];
  let currentBarIdx = -1;
  
  for (const c of candlesSoFar) {
    const timeStr = (c as any).time;
    let barIdx = currentBarIdx;
    if (timeStr) {
      const parts = timeStr.split("T");
      const timePart = parts.length > 1 ? parts[1] : parts[0];
      const [hStr, mStr] = timePart.split(":");
      const totalMin = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
      barIdx = Math.floor(totalMin / 5);
    }
    if (group.length > 0 && barIdx !== currentBarIdx) {
      htf.push({ close: group[group.length - 1].close });
      group = [];
    }
    currentBarIdx = barIdx;
    group.push(c);
  }
  if (group.length > 0) {
    htf.push({ close: group[group.length - 1].close });
  }
  
  if (htf.length < 25) return "neutral";
  
  const closes = htf.map(c => c.close);
  const fast5 = closes.slice(closes.length - 5).reduce((s, v) => s + v, 0) / 5;
  const slow25 = closes.slice(closes.length - 25).reduce((s, v) => s + v, 0) / 25;
  
  if (fast5 > slow25) return "up";
  if (fast5 < slow25) return "down";
  return "neutral";
}

/** 板読みスコア完全版（7要素）— DBのboardSnapshotを直接使用 */
function boardReadingScore(
  side: "long" | "short",
  snapshot: any | null,
  bprHistory: number[]
): number {
  if (!snapshot) return 1;
  
  const bpr = snapshot.buyPressureRatio ?? 1.0;
  let score = 0;
  
  // 要素A: アグレッシブ注文検出 (±2)
  if ((snapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  
  // 要素B: 厚い板のアノマリー (±1)
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;
    if (snapshot.largeBuyWall) score -= 1;
  } else {
    if (snapshot.largeBuyWall) score += 1;
    if (snapshot.largeSellWall) score -= 1;
  }
  
  // 要素C: 板圧力トレンド (±1)
  if (bprHistory.length >= 3) {
    const oldest = bprHistory[0];
    const newest = bprHistory[bprHistory.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  
  // 要素D: 相場モード判定 (+1/-2)
  const cancelDetected = !!(snapshot.askCancelDetected || snapshot.bidCancelDetected);
  let mode: "active" | "building" | "trap" | "quiet";
  if (cancelDetected) {
    mode = "trap";
  } else if (bprHistory.length >= 3) {
    const allNeutral = bprHistory.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) {
      mode = "quiet";
    } else if (bpr > 1.2 || bpr < 0.8) {
      mode = "active";
    } else {
      const oldest = bprHistory[0];
      const newest = bprHistory[bprHistory.length - 1];
      if (Math.abs(newest - oldest) >= 0.1) {
        mode = "building";
      } else {
        mode = "trap";
      }
    }
  } else {
    mode = (bpr > 1.2 || bpr < 0.8) ? "active" : "trap";
  }
  if (mode === "active" || mode === "building") score += 1;
  else if (mode === "trap" || mode === "quiet") score -= 2;
  
  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  
  // 要素F: 歩み値方向推定 (±2)
  let tickDir: "uptick" | "downtick" | "neutral" = "neutral";
  const mod = snapshot.marketOrderDirection;
  if (mod === "buy") tickDir = "uptick";
  else if (mod === "sell") tickDir = "downtick";
  else if (bprHistory.length >= 3) {
    const first = bprHistory[0];
    const last = bprHistory[bprHistory.length - 1];
    const trend = last - first;
    if (trend >= 0.2) tickDir = "uptick";
    else if (trend <= -0.2) tickDir = "downtick";
    else if (last >= 1.3) tickDir = "uptick";
    else if (last <= 0.7) tickDir = "downtick";
  }
  if (tickDir === "uptick") {
    if (side === "long") score += 2; else score -= 2;
  } else if (tickDir === "downtick") {
    if (side === "short") score += 2; else score -= 2;
  }
  
  // 要素G: アイスバーグ検出 (±1)
  let icebergSide: "buy" | "sell" | null = null;
  if (snapshot.icebergAskDetected) icebergSide = "buy";
  if (snapshot.icebergBidDetected) icebergSide = "sell";
  if (icebergSide) {
    if (side === "long" && icebergSide === "buy") score += 1;
    else if (side === "short" && icebergSide === "sell") score += 1;
    else if (side === "long" && icebergSide === "sell") score -= 1;
    else if (side === "short" && icebergSide === "buy") score -= 1;
  }
  
  return score;
}

function getBoardSignal(snapshot: any | null): "buy_pressure" | "sell_pressure" | "neutral" {
  if (!snapshot) return "neutral";
  const sig = snapshot.signal;
  if (sig === "buy_pressure" || sig === "large_buy_wall") return "buy_pressure";
  if (sig === "sell_pressure" || sig === "large_sell_wall") return "sell_pressure";
  return "neutral";
}

function shouldBoardEarlyExit(
  pos: OpenPosition,
  currentPrice: number,
  snapshot: any | null
): boolean {
  if (!snapshot) return false;
  
  const pnlPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  
  if (pnlPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  
  if (pos.side === "long") {
    return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
  } else {
    return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
  }
}

/**
 * BPR確認ロジック
 * 6/25〜7/2: buyPressureRatio（従来フィールド）を使用
 * 7/3以降: avgBprIn10s, bprDeltaIn10sを使用
 */
function checkBprConfirmation(
  side: "long" | "short",
  boardSnap: any | null,
  scenario: Scenario,
  date: string
): boolean {
  if (!boardSnap) return false;
  
  // BPR値の取得（日付に応じて使用するフィールドを切り替え）
  const useNewFields = date >= "2026-07-03";
  const bprValue = useNewFields
    ? (boardSnap.avgBprIn10s ?? boardSnap.buyPressureRatio ?? 1.0)
    : (boardSnap.buyPressureRatio ?? 1.0);
  
  // BPR Delta
  const bprDelta = useNewFields
    ? (boardSnap.bprDeltaIn10s ?? 0)
    : 0; // 7/2以前はbprDeltaIn10sが存在しないため、BPR履歴から推定
  
  // アイスバーグ検出
  const hasIceberg = useNewFields
    ? ((boardSnap.icebergAskCount ?? 0) + (boardSnap.icebergBidCount ?? 0)) >= 1
    : !!(boardSnap.icebergAskDetected || boardSnap.icebergBidDetected);
  
  // 方向別アイスバーグ
  let icebergOk = true;
  if (scenario.requireIceberg) {
    if (useNewFields) {
      if (side === "long") icebergOk = (boardSnap.icebergBidCount ?? 0) >= 1;
      else icebergOk = (boardSnap.icebergAskCount ?? 0) >= 1;
    } else {
      if (side === "long") icebergOk = !!boardSnap.icebergBidDetected;
      else icebergOk = !!boardSnap.icebergAskDetected;
    }
  }
  
  // BPR閾値チェック
  let bprOk = true;
  if (side === "long") {
    bprOk = bprValue >= scenario.bprThresholdLong;
  } else {
    bprOk = bprValue <= scenario.bprThresholdShort;
  }
  
  // Delta方向チェック
  let deltaOk = true;
  if (scenario.requireDelta) {
    if (useNewFields) {
      // 7/3以降: bprDeltaIn10sを直接使用
      if (side === "long") deltaOk = bprDelta > 0;
      else deltaOk = bprDelta < 0;
    } else {
      // 7/2以前: BPR値自体の方向性で代替（BPRが閾値を超えていれば方向一致とみなす）
      // 従来データにはdeltaがないため、BPR閾値超えをもって方向一致と判断
      deltaOk = bprOk; // BPR閾値を超えていれば方向OKとみなす
    }
  }
  
  return bprOk && deltaOk && icebergOk;
}

// ============================================================
// メインシミュレーション
// ============================================================
async function main() {
  const db = await getDb();
  
  // 日付範囲: 6/25〜7/3
  const [dateRows] = await db.execute(
    `SELECT DISTINCT tradeDate FROM rt_candles 
     WHERE tradeDate >= '2026-06-25' AND tradeDate <= '2026-07-03'
     ORDER BY tradeDate`
  ) as any;
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate);
  console.log(`=== ハイブリッド方式シミュレーション（${dates.length}日間: ${dates[0]}〜${dates[dates.length - 1]}） ===`);
  console.log(`シナリオ数: ${SCENARIOS.length}\n`);
  
  // 全日付の全ローソク足データを事前ロード
  const allCandlesByDate = new Map<string, any[]>();
  for (const date of dates) {
    const [candles] = await db.execute(
      `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
       FROM rt_candles
       WHERE tradeDate = '${date}'
       ORDER BY candleTime, symbol`
    ) as any;
    allCandlesByDate.set(date, candles as any[]);
  }
  console.log(`データロード完了: ${dates.length}日間\n`);
  
  const results: ScenarioResult[] = [];
  
  // ============================================================
  // シナリオ別シミュレーション
  // ============================================================
  for (const scenario of SCENARIOS) {
    const allTrades: Trade[] = [];
    let totalBlocked = 0;
    let totalDelayed = 0;
    let totalImmediate = 0;
    
    for (const date of dates) {
      // ---- 日次状態リセット ----
      const openPositions = new Map<string, OpenPosition>();
      const pullbackStates = new Map<string, PullbackState>();
      const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();
      const roundPullbackStates = new Map<string, RoundPullbackState>();
      const bprPendingStates = new Map<string, BprPendingState>(); // ★ ハイブリッド用
      const candleBuffers = new Map<string, CandleWithSignal[]>();
      const bprHistories = new Map<string, number[]>();
      const lastStopLossTime = new Map<string, string>();
      let b2Direction: "bullish" | "bearish" | "neutral" = "neutral";
      let b2Determined = false;
      
      const candles = allCandlesByDate.get(date) ?? [];
      if (candles.length === 0) continue;
      
      const processCandleCount = new Map<string, number>();
      
      for (const row of candles) {
        const symbol = row.symbol;
        const candleTime = row.candleTime;
        const open = Number(row.open);
        const high = Number(row.high);
        const low = Number(row.low);
        const close = Number(row.close);
        const volume = row.volume ?? 0;
        
        if (!TEN_SYMBOLS.includes(symbol)) continue;
        if (candleTime >= "11:30" && candleTime < "12:30") continue;
        
        // 板情報取得
        let bpr: number | null = null;
        let boardSnap: any | null = null;
        if (row.boardSnapshot) {
          try {
            boardSnap = typeof row.boardSnapshot === "string" ? JSON.parse(row.boardSnapshot) : row.boardSnapshot;
            bpr = boardSnap.buyPressureRatio ?? null;
          } catch {}
        }
        
        // BPR履歴更新
        if (bpr !== null) {
          const hist = bprHistories.get(symbol) ?? [];
          hist.push(bpr);
          if (hist.length > 5) hist.shift();
          bprHistories.set(symbol, hist);
        }
        
        // バッファに追加
        if (!candleBuffers.has(symbol)) candleBuffers.set(symbol, []);
        const buffer = candleBuffers.get(symbol)!;
        
        const candleForSignal: CandleWithSignal = {
          time: `${date}T${candleTime}:00`,
          dayKey: date,
          timestamp: new Date(`${date}T${candleTime}:00+09:00`).getTime(),
          open, high, low, close, volume,
          ma5: null, ma25: null, rsi: null,
          bbUpper: null, bbMiddle: null, bbLower: null,
        };
        buffer.push(candleForSignal);
        
        // MA/RSI/BB計算
        const closes = buffer.map(c => c.close);
        const ma5Series = calcMA(closes, 5);
        const ma25Series = calcMA(closes, 25);
        const rsiSeries = calcRSI(closes, 14);
        const bbSeries = calcBollinger(closes, 20);
        const lastIdx = buffer.length - 1;
        buffer[lastIdx].ma5 = ma5Series[lastIdx];
        buffer[lastIdx].ma25 = ma25Series[lastIdx];
        buffer[lastIdx].rsi = rsiSeries[lastIdx];
        buffer[lastIdx].bbUpper = bbSeries.upper[lastIdx];
        buffer[lastIdx].bbMiddle = bbSeries.middle[lastIdx];
        buffer[lastIdx].bbLower = bbSeries.lower[lastIdx];
        
        if (candleTime < "09:30") continue;
        
        const pcCount = (processCandleCount.get(symbol) ?? 0) + 1;
        processCandleCount.set(symbol, pcCount);
        
        if (pcCount < MIN_CANDLES_FOR_SIGNAL) continue;
        
        const timeMin = timeToMinutes(candleTime);
        const isAM = timeMin < 11 * 60 + 30;
        const boardSignal = getBoardSignal(boardSnap);
        const bprHist = bprHistories.get(symbol) ?? [];
        
        // ---- 既存ポジションの決済チェック ----
        const existingPos = openPositions.get(symbol);
        if (existingPos) {
          let exitPrice: number | null = null;
          let exitReason = "";
          
          // BEトリガー
          if (!existingPos.beTriggered) {
            const beLine = existingPos.side === "long"
              ? existingPos.entryPrice * (1 + BE_TRIGGER_PERCENT / 100)
              : existingPos.entryPrice * (1 - BE_TRIGGER_PERCENT / 100);
            const beHit = existingPos.side === "long" ? high >= beLine : low <= beLine;
            if (beHit) existingPos.beTriggered = true;
          }
          
          // SL/BE決済
          if (existingPos.side === "long") {
            const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
            if (low <= stopLine) {
              exitPrice = stopLine;
              exitReason = existingPos.beTriggered ? "BE" : "SL";
            }
            const tpLine = existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
            if (high >= tpLine && exitPrice === null) {
              exitPrice = tpLine;
              exitReason = "TP";
            }
          } else {
            const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
            if (high >= stopLine) {
              exitPrice = stopLine;
              exitReason = existingPos.beTriggered ? "BE" : "SL";
            }
            const tpLine = existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
            if (low <= tpLine && exitPrice === null) {
              exitPrice = tpLine;
              exitReason = "TP";
            }
          }
          
          // シグナル反転決済
          if (exitPrice === null && buffer.length >= 2) {
            const prevCandle = buffer[buffer.length - 2];
            if (prevCandle.signal) {
              if (existingPos.side === "long" && prevCandle.signal.type === "sell") {
                exitPrice = close;
                exitReason = "REVERSAL";
              } else if (existingPos.side === "short" && prevCandle.signal.type === "buy") {
                exitPrice = close;
                exitReason = "REVERSAL";
              }
            }
          }
          
          // 板読み早期利確
          if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnap)) {
            exitPrice = close;
            exitReason = "BOARD_EXIT";
          }
          
          // 大引け強制決済
          if (exitPrice === null && candleTime >= MARKET_CLOSE_TIME) {
            exitPrice = close;
            exitReason = "EOD";
          }
          
          if (exitPrice !== null) {
            const pnl = existingPos.side === "long"
              ? Math.round((exitPrice - existingPos.entryPrice) * existingPos.shares)
              : Math.round((existingPos.entryPrice - exitPrice) * existingPos.shares);
            
            allTrades.push({
              date, symbol, side: existingPos.side,
              entryTime: existingPos.entryTime, entryPrice: existingPos.entryPrice,
              exitTime: candleTime, exitPrice,
              pnl, exitReason,
              signalReason: existingPos.entryReason,
              confidence: existingPos.confidence,
              beTriggered: existingPos.beTriggered,
              session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
              shares: existingPos.shares,
              delayed: existingPos.entryReason.includes("[BPR確認]"),
            });
            
            openPositions.delete(symbol);
            if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
            continue;
          }
          
          continue; // ポジションあり → 新規エントリーしない
        }
        
        // ---- ★ BPR確認待機ステートの処理 ----
        const bprPending = bprPendingStates.get(symbol);
        if (bprPending) {
          bprPending.waitBars++;
          
          // BPR確認
          const confirmed = checkBprConfirmation(bprPending.side, boardSnap, scenario, date);
          
          if (confirmed) {
            // エントリー実行
            const entryResult = tryEnterPosition(
              bprPending.side, symbol, close, candleTime, date,
              `[BPR確認] ${bprPending.reason}`,
              buffer, bpr, bprHist, openPositions, lastStopLossTime
            );
            if (entryResult) {
              openPositions.set(symbol, entryResult);
              totalDelayed++;
            }
            bprPendingStates.delete(symbol);
          } else if (bprPending.waitBars >= scenario.maxWaitBars) {
            // タイムアウト → キャンセル
            totalBlocked++;
            bprPendingStates.delete(symbol);
          }
          continue;
        }
        
        // ---- 時間帯制限 ----
        if (candleTime < NO_ENTRY_BEFORE) continue;
        if (candleTime >= NO_ENTRY_AFTER) continue;
        if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
        if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
        
        // ---- B2方式: 9:30時点の市場方向性判定 ----
        if (!b2Determined && candleTime >= "09:30") {
          let totalChange = 0, count = 0;
          for (const [sym, buf] of Array.from(candleBuffers.entries())) {
            if (buf.length >= 2) {
              const firstC = buf[0];
              const latestC = buf[buf.length - 1];
              const changeRate = (latestC.close - firstC.open) / firstC.open * 100;
              totalChange += changeRate;
              count++;
            }
          }
          if (count >= 3) {
            const avg = totalChange / count;
            if (avg >= B2_THRESHOLD) b2Direction = "bullish";
            else if (avg <= -B2_THRESHOLD) b2Direction = "bearish";
            else b2Direction = "neutral";
            b2Determined = true;
          }
        }
        
        // ---- ステートマシン処理: 押し目確認（ダウ理論上昇） ----
        const pullbackState = pullbackStates.get(symbol);
        if (pullbackState) {
          pullbackState.waitCount++;
          
          if (low < pullbackState.recentSwingLow) {
            pullbackStates.delete(symbol);
            continue;
          }
          if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
            pullbackStates.delete(symbol);
            continue;
          }
          if (!pullbackState.pulledBack && close < pullbackState.signalPrice) {
            pullbackState.pulledBack = true;
          }
          if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
            pullbackStates.delete(symbol);
            if (boardSignal === "sell_pressure") continue;
            const brScore = boardReadingScore("long", boardSnap, bprHist);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            
            // ★ ハイブリッド: ステートマシン経由のエントリーもBPR確認
            const reason = `押し目確認: ${pullbackState.reason}`;
            if (scenario.maxWaitBars > 0) {
              // 現在の足で即確認
              const immediateConfirm = checkBprConfirmation("long", boardSnap, scenario, date);
              if (immediateConfirm) {
                const entryResult = tryEnterPosition(
                  "long", symbol, close, candleTime, date,
                  `[BPR確認] ${reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
              } else {
                bprPendingStates.set(symbol, {
                  symbol, side: "long", signalPrice: close, signalTime: candleTime,
                  reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
                });
              }
            } else {
              const entryResult = tryEnterPosition(
                "long", symbol, close, candleTime, date, reason,
                buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
            }
            continue;
          }
          continue;
        }
        
        // ---- ステートマシン処理: 大台確認バー ----
        const roundPending = roundLevelPendingStates.get(symbol);
        if (roundPending) {
          if (openPositions.has(symbol)) {
            roundLevelPendingStates.delete(symbol);
          } else {
            const stillValid = roundPending.direction === "buy"
              ? close >= roundPending.level
              : close <= roundPending.level;
            
            if (stillValid) {
              roundPending.confirmCount++;
              if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
                roundLevelPendingStates.delete(symbol);
                if (candleTime < NO_ENTRY_AFTER) {
                  roundPullbackStates.set(symbol, {
                    direction: roundPending.direction,
                    level: roundPending.level,
                    signalPrice: close,
                    waitCount: 0,
                    pulledBack: false,
                    reason: `大台確認(${ROUND_LEVEL_CONFIRM_BARS}本維持): ${roundPending.reason}`,
                  });
                }
              }
            } else {
              roundLevelPendingStates.delete(symbol);
            }
            continue;
          }
        }
        
        // ---- ステートマシン処理: 大台確認後の押し目待ち ----
        const roundPb = roundPullbackStates.get(symbol);
        if (roundPb) {
          roundPb.waitCount++;
          const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";
          
          if (roundPb.direction === "buy" && close < roundPb.level) {
            roundPullbackStates.delete(symbol);
            continue;
          }
          if (roundPb.direction === "sell" && close > roundPb.level) {
            roundPullbackStates.delete(symbol);
            continue;
          }
          
          // タイムアウト → 強トレンドエントリー
          if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
            roundPullbackStates.delete(symbol);
            if (side === "long" && boardSignal === "sell_pressure") continue;
            if (side === "short" && boardSignal === "buy_pressure") continue;
            const brScore = boardReadingScore(side, boardSnap, bprHist);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            
            const reason = `${roundPb.reason} (押し目なし・強トレンド)`;
            if (scenario.maxWaitBars > 0) {
              const immediateConfirm = checkBprConfirmation(side, boardSnap, scenario, date);
              if (immediateConfirm) {
                const entryResult = tryEnterPosition(
                  side, symbol, close, candleTime, date,
                  `[BPR確認] ${reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
              } else {
                bprPendingStates.set(symbol, {
                  symbol, side, signalPrice: close, signalTime: candleTime,
                  reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
                });
              }
            } else {
              const entryResult = tryEnterPosition(
                side, symbol, close, candleTime, date, reason,
                buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
            }
            continue;
          }
          
          // 押し目判定
          if (roundPb.direction === "buy") {
            if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
            if (roundPb.pulledBack && close > roundPb.signalPrice) {
              roundPullbackStates.delete(symbol);
              if (boardSignal === "sell_pressure") continue;
              const brScore = boardReadingScore("long", boardSnap, bprHist);
              if (brScore < BOARD_SCORE_THRESHOLD) continue;
              
              const reason = `${roundPb.reason} (押し目確認後)`;
              if (scenario.maxWaitBars > 0) {
                const immediateConfirm = checkBprConfirmation("long", boardSnap, scenario, date);
                if (immediateConfirm) {
                  const entryResult = tryEnterPosition(
                    "long", symbol, close, candleTime, date,
                    `[BPR確認] ${reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
                  );
                  if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
                } else {
                  bprPendingStates.set(symbol, {
                    symbol, side: "long", signalPrice: close, signalTime: candleTime,
                    reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
                  });
                }
              } else {
                const entryResult = tryEnterPosition(
                  "long", symbol, close, candleTime, date, reason,
                  buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
              }
              continue;
            }
          } else {
            if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
            if (roundPb.pulledBack && close < roundPb.signalPrice) {
              roundPullbackStates.delete(symbol);
              if (boardSignal === "buy_pressure") continue;
              const brScore = boardReadingScore("short", boardSnap, bprHist);
              if (brScore < BOARD_SCORE_THRESHOLD) continue;
              
              const reason = `${roundPb.reason} (押し目確認後)`;
              if (scenario.maxWaitBars > 0) {
                const immediateConfirm = checkBprConfirmation("short", boardSnap, scenario, date);
                if (immediateConfirm) {
                  const entryResult = tryEnterPosition(
                    "short", symbol, close, candleTime, date,
                    `[BPR確認] ${reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
                  );
                  if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
                } else {
                  bprPendingStates.set(symbol, {
                    symbol, side: "short", signalPrice: close, signalTime: candleTime,
                    reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
                  });
                }
              } else {
                const entryResult = tryEnterPosition(
                  "short", symbol, close, candleTime, date, reason,
                  buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
              }
              continue;
            }
          }
          continue;
        }
        
        // ---- シグナル検出 ----
        const withSignals = detectSignals(buffer);
        const latestSignal = withSignals[withSignals.length - 1];
        buffer[buffer.length - 1] = latestSignal;
        
        if (!latestSignal.signal) continue;
        const sig = latestSignal.signal;
        
        // ---- 買いエントリー ----
        if (sig.type === "buy") {
          if (sig.reason.includes("VWAPクロス上抜け")) continue;
          if (boardSignal === "sell_pressure") continue;
          const brScore = boardReadingScore("long", boardSnap, bprHist);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          
          // ダウ理論上昇 → 押し目確認ステートマシンへ
          if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1);
            if (htfTrend !== "up") continue;
            if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
              const window = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
              const swingHigh = Math.max(...window.map(c => c.high));
              const swingLow = Math.min(...window.map(c => c.low));
              if (swingHigh > swingLow) {
                const depth = (swingHigh - close) / (swingHigh - swingLow);
                if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) continue;
              }
            }
            pullbackStates.set(symbol, {
              recentSwingLow: sig.recentSwingLow,
              signalPrice: close,
              waitCount: 0,
              pulledBack: false,
              reason: sig.reason,
            });
            continue;
          }
          
          // 大台超え → 確認バーステートマシンへ
          if (sig.reason.startsWith("大台超え")) {
            const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
            const level = m ? parseFloat(m[1]) : close;
            roundLevelPendingStates.set(symbol, {
              direction: "buy", level, confirmCount: 0, reason: sig.reason,
            });
            continue;
          }
          
          // BUY medium全ブロック
          if (sig.confidence === "medium") continue;
          
          // ★ ハイブリッド: strong直接エントリー → BPR確認
          if (scenario.maxWaitBars > 0) {
            const immediateConfirm = checkBprConfirmation("long", boardSnap, scenario, date);
            if (immediateConfirm) {
              const entryResult = tryEnterPosition(
                "long", symbol, close, candleTime, date,
                `[BPR確認] ${sig.reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
            } else {
              bprPendingStates.set(symbol, {
                symbol, side: "long", signalPrice: close, signalTime: candleTime,
                reason: sig.reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
              });
            }
          } else {
            const entryResult = tryEnterPosition(
              "long", symbol, close, candleTime, date, sig.reason,
              buffer, bpr, bprHist, openPositions, lastStopLossTime
            );
            if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
          }
          continue;
        }
        
        // ---- 売りエントリー ----
        if (sig.type === "sell") {
          if (boardSignal === "buy_pressure") continue;
          
          // VWAP急落フィルター
          if (sig.reason.includes("VWAPクロス下抜け") && buffer.length >= 5) {
            const len = buffer.length;
            const close5ago = buffer[len - 5].close;
            const close3ago = buffer[len - 3].close;
            const drop5 = ((close - close5ago) / close5ago) * 100;
            const drop3 = ((close - close3ago) / close3ago) * 100;
            if (drop5 <= VWAP_DROP_FILTER_5BARS || drop3 <= VWAP_DROP_FILTER_3BARS) continue;
          }
          
          const brScore = boardReadingScore("short", boardSnap, bprHist);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          
          // ダウ理論SHORT
          if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1);
            if (htfTrend !== "down") continue;
            if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
              const window = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
              const swingHigh = Math.max(...window.map(c => c.high));
              const swingLow = Math.min(...window.map(c => c.low));
              if (swingHigh > swingLow) {
                const depth = (close - swingLow) / (swingHigh - swingLow);
                if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) continue;
              }
            }
          }
          
          // 大台割れ → 確認バーステートマシンへ
          if (sig.reason.startsWith("大台割れ")) {
            const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
            const level = m ? parseFloat(m[1]) : close;
            roundLevelPendingStates.set(symbol, {
              direction: "sell", level, confirmCount: 0, reason: sig.reason,
            });
            continue;
          }
          
          // SHORT medium: B2方式
          if (sig.confidence === "medium") {
            if (isAM && b2Direction === "bullish") continue;
          }
          
          // 後場BPRフィルター
          if (candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) continue;
          
          // ★ ハイブリッド: エントリー → BPR確認
          if (scenario.maxWaitBars > 0) {
            const immediateConfirm = checkBprConfirmation("short", boardSnap, scenario, date);
            if (immediateConfirm) {
              const entryResult = tryEnterPosition(
                "short", symbol, close, candleTime, date,
                `[BPR確認] ${sig.reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) { openPositions.set(symbol, entryResult); totalDelayed++; }
            } else {
              bprPendingStates.set(symbol, {
                symbol, side: "short", signalPrice: close, signalTime: candleTime,
                reason: sig.reason, waitBars: 0, buffer: [...buffer], bpr, bprHist: [...bprHist],
              });
            }
          } else {
            const entryResult = tryEnterPosition(
              "short", symbol, close, candleTime, date, sig.reason,
              buffer, bpr, bprHist, openPositions, lastStopLossTime
            );
            if (entryResult) { openPositions.set(symbol, entryResult); totalImmediate++; }
          }
          continue;
        }
      }
      
      // ---- 日末: 残ポジション強制決済 ----
      for (const [symbol, pos] of Array.from(openPositions.entries())) {
        const lastCandle = candleBuffers.get(symbol);
        if (!lastCandle || lastCandle.length === 0) continue;
        const lastClose = lastCandle[lastCandle.length - 1].close;
        const pnl = pos.side === "long"
          ? Math.round((lastClose - pos.entryPrice) * pos.shares)
          : Math.round((pos.entryPrice - lastClose) * pos.shares);
        allTrades.push({
          date, symbol, side: pos.side,
          entryTime: pos.entryTime, entryPrice: pos.entryPrice,
          exitTime: "15:30", exitPrice: lastClose,
          pnl, exitReason: "EOD",
          signalReason: pos.entryReason, confidence: pos.confidence,
          beTriggered: pos.beTriggered,
          session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
          shares: pos.shares,
          delayed: pos.entryReason.includes("[BPR確認]"),
        });
      }
      
      // BPR待機中のシグナルもキャンセル扱い
      totalBlocked += bprPendingStates.size;
    }
    
    // ---- シナリオ集計 ----
    const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = allTrades.filter(t => t.pnl > 0);
    const losses = allTrades.filter(t => t.pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
    const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;
    
    results.push({
      name: scenario.name,
      description: scenario.description,
      trades: allTrades,
      totalPnl,
      winRate,
      pf,
      tradeCount: allTrades.length,
      blockedCount: totalBlocked,
      delayedCount: totalDelayed,
      immediateCount: totalImmediate,
    });
    
    console.log(`${scenario.name.padEnd(40)} | ${allTrades.length.toString().padStart(3)}件 | ` +
      `勝率${winRate.toFixed(1).padStart(5)}% | PF ${pf.toFixed(2).padStart(5)} | ` +
      `${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString().padStart(10)}円 | ` +
      `即${totalImmediate} 遅${totalDelayed} 却${totalBlocked}`);
  }
  
  // ============================================================
  // 詳細レポート
  // ============================================================
  console.log("\n" + "=".repeat(100));
  console.log("=== 詳細比較レポート ===\n");
  
  const baseline = results[0];
  console.log("--- ベースラインとの比較 ---");
  console.log(`${"シナリオ".padEnd(38)} | ${"取引数".padStart(5)} | ${"勝率".padStart(6)} | ${"PF".padStart(5)} | ${"総損益".padStart(12)} | ${"差分".padStart(12)} | ${"改善率".padStart(7)}`);
  console.log("-".repeat(110));
  
  for (const r of results) {
    const diff = r.totalPnl - baseline.totalPnl;
    const improvement = baseline.totalPnl !== 0 ? ((diff / Math.abs(baseline.totalPnl)) * 100).toFixed(1) : "N/A";
    console.log(
      `${r.name.padEnd(38)} | ${r.tradeCount.toString().padStart(5)} | ` +
      `${r.winRate.toFixed(1).padStart(5)}% | ${r.pf.toFixed(2).padStart(5)} | ` +
      `${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toLocaleString().padStart(10)}円 | ` +
      `${(diff >= 0 ? "+" : "") + diff.toLocaleString().padStart(10)}円 | ` +
      `${diff >= 0 ? "+" : ""}${improvement}%`
    );
  }
  
  // ベストシナリオの詳細
  const best = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
  console.log(`\n★ 最良シナリオ: ${best.name}`);
  console.log(`  総損益: ${best.totalPnl >= 0 ? "+" : ""}${best.totalPnl.toLocaleString()}円`);
  console.log(`  取引数: ${best.tradeCount}件`);
  console.log(`  勝率: ${best.winRate.toFixed(1)}%`);
  console.log(`  PF: ${best.pf.toFixed(2)}`);
  console.log(`  即エントリー: ${best.immediateCount}件`);
  console.log(`  BPR確認後エントリー: ${best.delayedCount}件`);
  console.log(`  BPR未確認キャンセル: ${best.blockedCount}件`);
  
  // ベストシナリオの日別推移
  console.log(`\n--- ${best.name} 日別推移 ---`);
  let cumPnl = 0;
  for (const date of dates) {
    const dayTrades = best.trades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    const dayWins = dayTrades.filter(t => t.pnl > 0).length;
    console.log(`${date} | ${dayTrades.length.toString().padStart(3)}件 | ` +
      `勝率${dayTrades.length > 0 ? ((dayWins / dayTrades.length) * 100).toFixed(1) : "0.0"}% | ` +
      `${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString().padStart(10)}円 | ` +
      `累計${cumPnl >= 0 ? "+" : ""}${cumPnl.toLocaleString()}円`);
  }
  
  // LONG/SHORT別
  console.log(`\n--- ${best.name} LONG/SHORT別 ---`);
  const bestLongs = best.trades.filter(t => t.side === "long");
  const bestShorts = best.trades.filter(t => t.side === "short");
  const longPnl = bestLongs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = bestShorts.reduce((s, t) => s + t.pnl, 0);
  console.log(`LONG:  ${bestLongs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toLocaleString()}円 | 勝率${bestLongs.length > 0 ? ((bestLongs.filter(t => t.pnl > 0).length / bestLongs.length) * 100).toFixed(1) : "0"}%`);
  console.log(`SHORT: ${bestShorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toLocaleString()}円 | 勝率${bestShorts.length > 0 ? ((bestShorts.filter(t => t.pnl > 0).length / bestShorts.length) * 100).toFixed(1) : "0"}%`);
  
  // 決済理由別
  console.log(`\n--- ${best.name} 決済理由別 ---`);
  const reasons = ["SL", "BE", "TP", "REVERSAL", "BOARD_EXIT", "EOD"];
  for (const r of reasons) {
    const rTrades = best.trades.filter(t => t.exitReason === r);
    if (rTrades.length === 0) continue;
    const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`${r.padEnd(12)} | ${rTrades.length.toString().padStart(3)}件 | ${rPnl >= 0 ? "+" : ""}${rPnl.toLocaleString()}円`);
  }
  
  // 7/3の比較（新フィールド使用日）
  console.log("\n--- 7/3 シナリオ別比較 ---");
  for (const r of results) {
    const jul3Trades = r.trades.filter(t => t.date === "2026-07-03");
    const jul3Pnl = jul3Trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`${r.name.padEnd(38)} | ${jul3Trades.length.toString().padStart(3)}件 | ${jul3Pnl >= 0 ? "+" : ""}${jul3Pnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}

// ============================================================
// enterPosition相当（フィルター適用）
// ============================================================
function tryEnterPosition(
  side: "long" | "short",
  symbol: string,
  price: number,
  candleTime: string,
  date: string,
  reason: string,
  buffer: CandleWithSignal[],
  bpr: number | null,
  bprHist: number[],
  openPositions: Map<string, OpenPosition>,
  lastStopLossTime: Map<string, string>,
): OpenPosition | null {
  const shares = calcShares(price);
  const amount = price * shares;
  
  // 出来高取得不可フィルター
  const isVolumeUnavailable = checkVolumeUnavailable(buffer);
  if (isVolumeUnavailable) {
    if (candleTime >= "12:00" && candleTime <= "12:59") return null;
    const lastSL = lastStopLossTime.get(symbol);
    if (lastSL) {
      const minSinceStop = timeToMinutes(candleTime) - timeToMinutes(lastSL);
      if (minSinceStop >= 0 && minSinceStop < NO_REENTRY_AFTER_STOPLOSS_MIN) return null;
    }
  }
  
  // ATRフィルター
  if (buffer.length >= ATR_FILTER_PERIOD + 1) {
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closes = buffer.map(c => c.close);
    const atrSeries = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);
    const latestATR = atrSeries[atrSeries.length - 1];
    if (latestATR !== null && price > 0) {
      const atrRatio = (latestATR as number) / price;
      if (atrRatio < ATR_FILTER_THRESHOLD) return null;
    }
  }
  
  // 後場BPRフィルター（SHORTのみ）
  if (side === "short" && candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) {
    return null;
  }
  
  // エクスポージャー制限
  let currentExposure = 0;
  for (const pos of Array.from(openPositions.values())) {
    currentExposure += pos.entryPrice * pos.shares;
  }
  if (currentExposure + amount > MAX_TOTAL_EXPOSURE) return null;
  
  // 信頼度計算
  let confidence: SignalConfidence = "medium";
  if (buffer.length > 1) {
    const volumes = buffer.map(c => c.volume);
    const closes = buffer.map(c => c.close);
    const idx = buffer.length - 1;
    const ma5Val = buffer[idx]?.ma5 ?? null;
    const ma25Val = buffer[idx]?.ma25 ?? null;
    const confResult = evaluateConfirmation({
      type: side === "long" ? "buy" : "sell",
      close: price,
      volume: buffer[idx].volume,
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: ma5Val,
      ma25: ma25Val,
      momentum: priceMomentum(closes, idx, 3),
    });
    confidence = confResult.confidence;
  }
  
  return {
    symbol, side, entryPrice: price, shares,
    entryTime: candleTime, entryReason: reason,
    confidence, beTriggered: false,
  };
}

main().catch(console.error);
