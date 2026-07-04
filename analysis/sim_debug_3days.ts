/**
 * sim_debug_3days.ts
 * 2026-06-30, 07-01, 07-02 の3日間を詳細ログ付きでシミュレーション
 * ① 設定値 ② 個別取引一覧 ③ シグナル発生ログ を出力
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and, inArray, asc } from "drizzle-orm";
import { detectSignals } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";

// ============================================================
// ① 設定値（エンジンと完全一致）
// ============================================================
const CONFIG = {
  stop_loss_rate: 0.5,           // %
  take_profit_rate: 1.5,         // %
  be_stop_trigger_rate: null,    // 撤廃（+D構成）
  exit_delay_bars: 0,            // 即時決済（遅延なし）
  confidence_threshold: "medium", // medium以上でシグナル検出されるが…
  medium_block: true,            // medium品質は全ブロック（BUY/SHORT共）
  reentry_cooldown_bars: 30,     // 損切り後30分（出来高不可時のみ適用）
  board_score_min: 1,            // 板読みスコア最低1
  is_bullish_short_block: true,  // isBullish方式: 始値比+0.2%以上でSHORT全禁止
  is_bullish_threshold: 0.2,     // %
  use_state_machine: true,       // ダウ理論→押し目確認、大台→確認バー
  signal_reverse_exit: true,     // シグナル反転で決済
  board_early_exit: true,        // 板読み早期利確（+0.05%以上利益時）
  board_early_exit_min_profit: 0.05, // %
  pm_bpr_filter: true,           // 後場BPRフィルター
  pm_bpr_start: "13:00",        // 開始時刻
  pm_bpr_threshold: 0.65,       // BPR閾値
  vwap_drop_filter: false,       // 撤廃
  atr_filter_period: 7,
  atr_filter_threshold: 0.0012,  // 0.12%
  pullback_depth_min: 0.3,       // 30%
  pullback_depth_max: 0.7,       // 70%
  pullback_depth_lookback: 20,
  pullback_max_wait: 5,          // 本
  round_level_confirm_bars: 5,   // 本
  round_pullback_max_wait: 5,    // 本
  no_entry_before: "09:30",
  no_entry_after: "15:15",
  no_entry_pre_lunch: "11:00-11:30",
  no_entry_post_lunch: "12:30-13:00",
  market_close_time: "15:30",
  min_candles_for_signal: 30,
  lot_ratio: 0.9,
  initial_capital: 3000000,
  max_total_exposure: 8910000,
  max_concurrent_positions: 3,
  max_per_sector: 2,
};

// ============================================================
// 型定義
// ============================================================
interface CandleWithSignal {
  time: string;
  dayKey: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  signal?: any;
}

interface BoardSnapshot {
  buyPressureRatio: number;
  signal: string;
  marketOrderRatio?: number;
  marketOrderDirection?: string;
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  cancelRatio?: number;
  cancelSide?: string;
  icebergDetected?: boolean;
  icebergSide?: string;
  icebergAskCount?: number;
  icebergBidCount?: number;
  largeTradeDirection?: string;
}

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  confidence: string;
}

interface TradeRecord {
  symbol: string;
  symbolName: string;
  side: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  exitReason: string;
}

interface SignalLog {
  symbol: string;
  symbolName: string;
  time: string;
  type: string;
  confidence: string;
  reason: string;
  blocked: boolean;
  blockReason: string;
}

// ============================================================
// ヘルパー関数
// ============================================================
const SECTOR_MAP: Record<string, string> = {};
const NAME_MAP: Record<string, string> = {};
TARGET_STOCKS.forEach(s => {
  SECTOR_MAP[s.symbol] = s.sector;
  NAME_MAP[s.symbol] = s.name;
});

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcRSI(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [null];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (i <= period) {
      if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
      if (i === period) {
        avgGain /= period; avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      } else { result.push(null); }
    } else {
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }
  return result;
}

function calcBollinger(data: number[], period: number): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = [];
  const middle: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { upper.push(null); middle.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (data[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    middle.push(mean);
    upper.push(mean + 2 * std);
    lower.push(mean - 2 * std);
  }
  return { upper, middle, lower };
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [null];
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
    if (trs.length < period) { result.push(null); continue; }
    if (trs.length === period) {
      result.push(trs.reduce((a, b) => a + b, 0) / period);
    } else {
      const prev = result[result.length - 1]!;
      result.push((prev * (period - 1) + tr) / period);
    }
  }
  return result;
}

function getHigherTfTrend(buffer: CandleWithSignal[], currentIdx: number, tfMinutes: number): "up" | "down" | "neutral" {
  const barsNeeded = 25 * tfMinutes;
  if (currentIdx + 1 < barsNeeded) return "neutral";
  const startIdx = Math.max(0, currentIdx + 1 - barsNeeded);
  const subset = buffer.slice(startIdx, currentIdx + 1);
  const htfCandles: number[] = [];
  for (let i = 0; i < subset.length; i += tfMinutes) {
    const chunk = subset.slice(i, i + tfMinutes);
    if (chunk.length === 0) continue;
    htfCandles.push(chunk[chunk.length - 1].close);
  }
  if (htfCandles.length < 25) return "neutral";
  const ma5 = htfCandles.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma25 = htfCandles.slice(-25).reduce((a, b) => a + b, 0) / 25;
  if (ma5 > ma25) return "up";
  if (ma5 < ma25) return "down";
  return "neutral";
}

function boardReadingScore(symbol: string, side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 0;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  const mor = snapshot.marketOrderRatio ?? 0;
  const moDir = snapshot.marketOrderDirection ?? "neutral";

  // A: アグレッシブ注文 (±2)
  if (mor >= 0.08) {
    if (moDir === "buy") { if (side === "long") score += 2; else score -= 2; }
    else if (moDir === "sell") { if (side === "short") score += 2; else score -= 2; }
  }
  // B: 厚い板 (±1)
  if (snapshot.largeBuyWall) { if (side === "long") score += 1; else score -= 1; }
  if (snapshot.largeSellWall) { if (side === "short") score += 1; else score -= 1; }
  // C: BPRトレンド (±1) - simplified
  // D: 相場モード (±1/-2) - simplified
  if (bpr > 1.2 || bpr < 0.8) {
    score += 1; // active
  }
  // E: 板圧力 (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  // F: 歩み値方向 (±2) - simplified based on moDir + bpr
  if (moDir === "buy" && bpr > 1.0) { if (side === "long") score += 2; else score -= 2; }
  else if (moDir === "sell" && bpr < 1.0) { if (side === "short") score += 2; else score -= 2; }
  // G: アイスバーグ (±1)
  if (snapshot.icebergDetected && snapshot.icebergSide) {
    if (side === "long" && snapshot.icebergSide === "buy") score += 1;
    else if (side === "short" && snapshot.icebergSide === "sell") score += 1;
    else if (side === "long" && snapshot.icebergSide === "sell") score -= 1;
    else if (side === "short" && snapshot.icebergSide === "buy") score -= 1;
  }
  // H: 10秒集約アイスバーグ (±2)
  const snap = snapshot as any;
  if ((snap.icebergAskCount ?? 0) >= 2) { if (side === "short") score += 2; else score -= 2; }
  if ((snap.icebergBidCount ?? 0) >= 2) { if (side === "long") score += 2; else score -= 2; }
  // I: 大口約定方向 (±1)
  if (snap.largeTradeDirection === "buy") { if (side === "long") score += 1; else score -= 1; }
  else if (snap.largeTradeDirection === "sell") { if (side === "short") score += 1; else score -= 1; }

  return score;
}

function evaluateConfidence(type: "buy" | "sell", close: number, volume: number, avgVolume: number, ma5: number | null, ma25: number | null, momentum: number): string {
  let score = 0;
  if (avgVolume > 0 && volume >= avgVolume * 1.2) score++;
  if (ma5 !== null && ma25 !== null) {
    if (type === "buy" && ma5 > ma25) score++;
    if (type === "sell" && ma5 < ma25) score++;
  }
  if (type === "buy" && momentum > 0) score++;
  if (type === "sell" && momentum < 0) score++;
  if (score >= 3) return "strong";
  if (score >= 2) return "medium";
  return "weak";
}

function priceMomentum(closes: number[], idx: number, lookback: number): number {
  if (idx < lookback) return 0;
  return closes[idx] - closes[idx - lookback];
}

function trailingAvgVolume(volumes: number[], idx: number, lookback: number): number {
  const start = Math.max(0, idx - lookback);
  const slice = volumes.slice(start, idx);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcShares(price: number): number {
  const raw = Math.floor(CONFIG.initial_capital * CONFIG.lot_ratio / price);
  const lots = Math.max(1, Math.floor(raw / 100)) * 100;
  return lots;
}

// ============================================================
// メイン実行
// ============================================================
const TARGET_DATES = ["2026-06-30", "2026-07-01", "2026-07-02"];
const SYMBOLS = TARGET_STOCKS.map(s => s.symbol);

async function main() {
  // ① 設定値出力
  console.log("=" .repeat(80));
  console.log("① 設定値（CONFIG）");
  console.log("=" .repeat(80));
  console.log(JSON.stringify(CONFIG, null, 2));
  console.log("");

  const allTrades: TradeRecord[] = [];
  const allSignals: SignalLog[] = [];

  for (const date of TARGET_DATES) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`処理日: ${date}`);
    console.log(`${"=".repeat(80)}`);

    // 日次状態リセット
    const openPositions = new Map<string, OpenPosition>();
    const candleBuffers = new Map<string, CandleWithSignal[]>();
    const bprHistory = new Map<string, number[]>();
    const pullbackStates = new Map<string, any>();
    const roundLevelPendingStates = new Map<string, any>();
    const roundPullbackStates = new Map<string, any>();
    const lastStopLossTime = new Map<string, string>();
    let dailyTrades: TradeRecord[] = [];
    let dailySignals: SignalLog[] = [];

    // DB から当日の1分足を取得
    const db = await getDb();
    const candles = await db.select().from(rtCandles)
      .where(and(eq(rtCandles.tradeDate, date), inArray(rtCandles.symbol, SYMBOLS)))
      .orderBy(asc(rtCandles.candleTime));

    // 時刻順にグループ化
    const timeGroups = new Map<string, typeof candles>();
    for (const c of candles) {
      const key = c.candleTime;
      if (!timeGroups.has(key)) timeGroups.set(key, []);
      timeGroups.get(key)!.push(c);
    }

    const sortedTimes = [...timeGroups.keys()].sort();

    for (const time of sortedTimes) {
      // 昼休みスキップ
      if (time >= "11:30" && time < "12:30") continue;

      const group = timeGroups.get(time)!;

      for (const candle of group) {
        const symbol = candle.symbol;
        if (!SYMBOLS.includes(symbol)) continue;

        const open = Number(candle.open);
        const high = Number(candle.high);
        const low = Number(candle.low);
        const close = Number(candle.close);
        const volume = candle.volume ?? 0;
        const boardSnapshot: BoardSnapshot | null = candle.boardSnapshot
          ? (typeof candle.boardSnapshot === 'string' ? JSON.parse(candle.boardSnapshot) : candle.boardSnapshot as any)
          : null;

        // BPR履歴更新
        if (boardSnapshot) {
          const hist = bprHistory.get(symbol) ?? [];
          hist.push(boardSnapshot.buyPressureRatio);
          if (hist.length > 5) hist.shift();
          bprHistory.set(symbol, hist);
        }

        // バッファ追加
        if (!candleBuffers.has(symbol)) candleBuffers.set(symbol, []);
        const buffer = candleBuffers.get(symbol)!;
        const candleForSignal: CandleWithSignal = {
          time: `${date}T${time}:00`,
          dayKey: date,
          timestamp: new Date(`${date}T${time}:00+09:00`).getTime(),
          open, high, low, close, volume,
          ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null,
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

        // ウォームアップ
        if (buffer.length < CONFIG.min_candles_for_signal) continue;

        // ---- 既存ポジションの決済チェック ----
        const existingPos = openPositions.get(symbol);
        if (existingPos) {
          let exitPrice: number | null = null;
          let exitReason = "";

          if (existingPos.side === "long") {
            const stopLine = existingPos.entryPrice * (1 - CONFIG.stop_loss_rate / 100);
            const tpLine = existingPos.entryPrice * (1 + CONFIG.take_profit_rate / 100);
            if (low <= stopLine) { exitPrice = stopLine; exitReason = `SL (${stopLine.toFixed(0)}円)`; }
            else if (high >= tpLine) { exitPrice = tpLine; exitReason = `TP (${tpLine.toFixed(0)}円)`; }
          } else {
            const stopLine = existingPos.entryPrice * (1 + CONFIG.stop_loss_rate / 100);
            const tpLine = existingPos.entryPrice * (1 - CONFIG.take_profit_rate / 100);
            if (high >= stopLine) { exitPrice = stopLine; exitReason = `SL (${stopLine.toFixed(0)}円)`; }
            else if (low <= tpLine) { exitPrice = tpLine; exitReason = `TP (${tpLine.toFixed(0)}円)`; }
          }

          // シグナル反転決済
          if (exitPrice === null && CONFIG.signal_reverse_exit) {
            const withSigs = detectSignals(buffer);
            const latestSig = withSigs[withSigs.length - 1];
            if (latestSig.signal) {
              if (existingPos.side === "long" && latestSig.signal.type === "sell") {
                exitPrice = close; exitReason = `シグナル反転: ${latestSig.signal.reason}`;
              } else if (existingPos.side === "short" && latestSig.signal.type === "buy") {
                exitPrice = close; exitReason = `シグナル反転: ${latestSig.signal.reason}`;
              }
            }
          }

          // 板読み早期利確
          if (exitPrice === null && CONFIG.board_early_exit && boardSnapshot) {
            const pnlPct = existingPos.side === "long"
              ? (close - existingPos.entryPrice) / existingPos.entryPrice * 100
              : (existingPos.entryPrice - close) / existingPos.entryPrice * 100;
            if (pnlPct >= CONFIG.board_early_exit_min_profit) {
              if (existingPos.side === "long" && (boardSnapshot.signal === "sell_pressure" || boardSnapshot.signal === "large_sell_wall")) {
                exitPrice = close; exitReason = `板読み早期利確 (${boardSnapshot.signal})`;
              } else if (existingPos.side === "short" && (boardSnapshot.signal === "buy_pressure" || boardSnapshot.signal === "large_buy_wall")) {
                exitPrice = close; exitReason = `板読み早期利確 (${boardSnapshot.signal})`;
              }
            }
          }

          // 大引け強制決済
          if (exitPrice === null && time >= CONFIG.market_close_time) {
            exitPrice = close; exitReason = "大引け強制決済";
          }

          if (exitPrice !== null) {
            const pnl = existingPos.side === "long"
              ? Math.round((exitPrice - existingPos.entryPrice) * existingPos.shares)
              : Math.round((existingPos.entryPrice - exitPrice) * existingPos.shares);
            const trade: TradeRecord = {
              symbol, symbolName: NAME_MAP[symbol] ?? symbol,
              side: existingPos.side, entryTime: existingPos.entryTime, exitTime: time,
              entryPrice: existingPos.entryPrice, exitPrice, shares: existingPos.shares,
              pnl, exitReason,
            };
            dailyTrades.push(trade);
            openPositions.delete(symbol);
            if (exitReason.startsWith("SL")) lastStopLossTime.set(symbol, time);
            continue;
          }
        }

        // 大引け後はエントリーしない
        if (time >= CONFIG.market_close_time) continue;
        // エントリー時間制限
        if (time < CONFIG.no_entry_before) continue;
        if (time >= CONFIG.no_entry_after) continue;
        if (time >= "11:00" && time < "11:30") continue;
        if (time >= "12:30" && time < "13:00") continue;
        // 既にポジションあり
        if (openPositions.has(symbol)) continue;

        // ---- シグナル検出 ----
        const withSignals = detectSignals(buffer);
        const latestSignal = withSignals[withSignals.length - 1];
        buffer[buffer.length - 1] = latestSignal;

        if (!latestSignal.signal) continue;
        const sig = latestSignal.signal;

        // isBullish計算
        const isBullish = (() => {
          if (buffer.length < 2) return false;
          const openPrice = buffer[0].open;
          return (close - openPrice) / openPrice * 100 >= CONFIG.is_bullish_threshold;
        })();

        // ---- 押し目確認ステートマシン処理 ----
        const pullbackState = pullbackStates.get(symbol);
        if (pullbackState) {
          pullbackState.waitCount++;
          if (low < pullbackState.recentSwingLow) { pullbackStates.delete(symbol); continue; }
          if (pullbackState.waitCount > CONFIG.pullback_max_wait) { pullbackStates.delete(symbol); continue; }
          if (!pullbackState.pulledBack && close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
            pullbackStates.delete(symbol);
            if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
            const brScore = boardReadingScore(symbol, "long", boardSnapshot);
            if (brScore < CONFIG.board_score_min) continue;
            // エントリー
            const shares = calcShares(close);
            const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
            if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;
            openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: time, entryReason: `押し目確認: ${pullbackState.reason}`, confidence: "strong" });
            dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "BUY", confidence: "strong", reason: `押し目確認: ${pullbackState.reason}`, blocked: false, blockReason: "" });
          }
          continue;
        }

        // ---- 大台確認バーステートマシン ----
        const roundPending = roundLevelPendingStates.get(symbol);
        if (roundPending) {
          if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); continue; }
          const stillValid = roundPending.direction === "buy" ? close >= roundPending.level : close <= roundPending.level;
          if (stillValid) {
            roundPending.confirmCount++;
            if (roundPending.confirmCount >= CONFIG.round_level_confirm_bars) {
              roundLevelPendingStates.delete(symbol);
              if (time < CONFIG.no_entry_after) {
                roundPullbackStates.set(symbol, {
                  direction: roundPending.direction, level: roundPending.level,
                  signalPrice: close, waitCount: 0, pulledBack: false,
                  reason: `大台確認(${CONFIG.round_level_confirm_bars}本維持): ${roundPending.reason}`,
                });
              }
            }
          } else { roundLevelPendingStates.delete(symbol); }
          continue;
        }

        // ---- 大台確認後押し目待ち ----
        const roundPb = roundPullbackStates.get(symbol);
        if (roundPb) {
          roundPb.waitCount++;
          const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";
          if (roundPb.direction === "buy" && close < roundPb.level) { roundPullbackStates.delete(symbol); continue; }
          if (roundPb.direction === "sell" && close > roundPb.level) { roundPullbackStates.delete(symbol); continue; }
          if (roundPb.waitCount > CONFIG.round_pullback_max_wait) {
            roundPullbackStates.delete(symbol);
            if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
            if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
            const brScore = boardReadingScore(symbol, side, boardSnapshot);
            if (brScore < CONFIG.board_score_min) continue;
            const shares = calcShares(close);
            const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
            if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;
            if (side === "short" && isBullish) continue;
            if (side === "short" && time >= CONFIG.pm_bpr_start && boardSnapshot && boardSnapshot.buyPressureRatio >= CONFIG.pm_bpr_threshold) continue;
            openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: time, entryReason: `${roundPb.reason} (押し目なし)`, confidence: "strong" });
            dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: side === "long" ? "BUY" : "SELL", confidence: "strong", reason: `${roundPb.reason} (押し目なし)`, blocked: false, blockReason: "" });
            continue;
          }
          if (roundPb.direction === "buy") {
            if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
            if (roundPb.pulledBack && close > roundPb.signalPrice) {
              roundPullbackStates.delete(symbol);
              if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
              const brScore = boardReadingScore(symbol, "long", boardSnapshot);
              if (brScore < CONFIG.board_score_min) continue;
              const shares = calcShares(close);
              const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
              if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;
              openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: time, entryReason: `${roundPb.reason} (押し目確認後)`, confidence: "strong" });
              dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "BUY", confidence: "strong", reason: `${roundPb.reason} (押し目確認後)`, blocked: false, blockReason: "" });
            }
          } else {
            if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
            if (roundPb.pulledBack && close < roundPb.signalPrice) {
              roundPullbackStates.delete(symbol);
              if (boardSnapshot && boardSnapshot.signal === "buy_pressure") continue;
              if (isBullish) continue;
              const brScore = boardReadingScore(symbol, "short", boardSnapshot);
              if (brScore < CONFIG.board_score_min) continue;
              const shares = calcShares(close);
              const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
              if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;
              if (time >= CONFIG.pm_bpr_start && boardSnapshot && boardSnapshot.buyPressureRatio >= CONFIG.pm_bpr_threshold) continue;
              openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: time, entryReason: `${roundPb.reason} (押し目確認後)`, confidence: "strong" });
              dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "SELL", confidence: "strong", reason: `${roundPb.reason} (押し目確認後)`, blocked: false, blockReason: "" });
            }
          }
          continue;
        }

        // ---- BUYエントリー ----
        if (sig.type === "buy") {
          let blocked = false;
          let blockReason = "";

          // VWAPクロス上抜け無効化
          if (sig.reason.includes("VWAPクロス上抜け")) { blocked = true; blockReason = "VWAPクロス上抜け無効化"; }
          // sell_pressure時LONG禁止
          if (!blocked && boardSnapshot && boardSnapshot.signal === "sell_pressure") { blocked = true; blockReason = "sell_pressure時LONG禁止"; }
          // 板読みスコア
          if (!blocked) {
            const brScore = boardReadingScore(symbol, "long", boardSnapshot);
            if (brScore < CONFIG.board_score_min) { blocked = true; blockReason = `板読みスコア不足(${brScore})`; }
          }
          // ダウ理論→押し目確認ステートマシン
          if (!blocked && sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
            if (htfTrend !== "up") { blocked = true; blockReason = `5分足フィルター(${htfTrend})`; }
            if (!blocked && buffer.length >= CONFIG.pullback_depth_lookback) {
              const lookback = buffer.slice(buffer.length - CONFIG.pullback_depth_lookback);
              const swH = Math.max(...lookback.map(c => c.high));
              const swL = Math.min(...lookback.map(c => c.low));
              if (swH > swL) {
                const depth = (swH - close) / (swH - swL);
                if (depth < CONFIG.pullback_depth_min || depth > CONFIG.pullback_depth_max) {
                  blocked = true; blockReason = `押し目深さ(${(depth*100).toFixed(1)}%)`;
                }
              }
            }
            if (!blocked) {
              pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason });
              dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "BUY", confidence: sig.confidence ?? "medium", reason: sig.reason + " → 押し目待機", blocked: false, blockReason: "" });
              continue;
            }
          }
          // 大台超え→確認バーステートマシン
          if (!blocked && sig.reason.startsWith("大台超え")) {
            const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
            const level = m ? parseFloat(m[1]) : close;
            roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
            dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "BUY", confidence: sig.confidence ?? "medium", reason: sig.reason + " → 大台確認待機", blocked: false, blockReason: "" });
            continue;
          }
          // medium全ブロック
          if (!blocked && sig.confidence === "medium") { blocked = true; blockReason = "BUY medium全ブロック"; }

          // confidence計算
          const volumes = buffer.map(c => c.volume);
          const closesArr = buffer.map(c => c.close);
          const idx = buffer.length - 1;
          const conf = evaluateConfidence("buy", close, volume, trailingAvgVolume(volumes, idx, 10), buffer[idx].ma5, buffer[idx].ma25, priceMomentum(closesArr, idx, 3));

          dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "BUY", confidence: conf, reason: sig.reason, blocked, blockReason });

          if (blocked) continue;

          // ATRフィルター
          if (buffer.length >= CONFIG.atr_filter_period + 1) {
            const highs = buffer.map(c => c.high);
            const lows = buffer.map(c => c.low);
            const cls = buffer.map(c => c.close);
            const atrSeries = calcATR(highs, lows, cls, CONFIG.atr_filter_period);
            const latestATR = atrSeries[atrSeries.length - 1];
            if (latestATR !== null && close > 0 && latestATR / close < CONFIG.atr_filter_threshold) continue;
          }

          // 証拠金チェック
          const shares = calcShares(close);
          const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
          if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;

          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: time, entryReason: sig.reason, confidence: conf });
        }

        // ---- SHORTエントリー ----
        if (sig.type === "sell") {
          let blocked = false;
          let blockReason = "";

          // buy_pressure時SHORT禁止
          if (boardSnapshot && boardSnapshot.signal === "buy_pressure") { blocked = true; blockReason = "buy_pressure時SHORT禁止"; }
          // isBullish方式
          if (!blocked && isBullish) { blocked = true; blockReason = `isBullishブロック(始値比+0.2%以上)`; }
          // 板読みスコア
          if (!blocked) {
            const brScore = boardReadingScore(symbol, "short", boardSnapshot);
            if (brScore < CONFIG.board_score_min) { blocked = true; blockReason = `板読みスコア不足(${brScore})`; }
          }
          // ダウ理論SHORT 5分足フィルター
          if (!blocked && sig.reason.startsWith("ダウ理論: 直近安値更新")) {
            const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
            if (htfTrend !== "down") { blocked = true; blockReason = `5分足フィルター(${htfTrend})`; }
            if (!blocked && buffer.length >= CONFIG.pullback_depth_lookback) {
              const lookback = buffer.slice(buffer.length - CONFIG.pullback_depth_lookback);
              const swH = Math.max(...lookback.map(c => c.high));
              const swL = Math.min(...lookback.map(c => c.low));
              if (swH > swL) {
                const depth = (close - swL) / (swH - swL);
                if (depth < CONFIG.pullback_depth_min || depth > CONFIG.pullback_depth_max) {
                  blocked = true; blockReason = `押し目深さ(${(depth*100).toFixed(1)}%)`;
                }
              }
            }
          }
          // 大台割れ→確認バーステートマシン
          if (!blocked && sig.reason.startsWith("大台割れ")) {
            const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
            const level = m ? parseFloat(m[1]) : close;
            roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
            dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "SELL", confidence: sig.confidence ?? "medium", reason: sig.reason + " → 大台確認待機", blocked: false, blockReason: "" });
            continue;
          }
          // SHORT medium全ブロック
          if (!blocked && sig.confidence === "medium") { blocked = true; blockReason = "SHORT medium全ブロック"; }

          // confidence計算
          const volumes = buffer.map(c => c.volume);
          const closesArr = buffer.map(c => c.close);
          const idx = buffer.length - 1;
          const conf = evaluateConfidence("sell", close, volume, trailingAvgVolume(volumes, idx, 10), buffer[idx].ma5, buffer[idx].ma25, priceMomentum(closesArr, idx, 3));

          dailySignals.push({ symbol, symbolName: NAME_MAP[symbol] ?? symbol, time, type: "SELL", confidence: conf, reason: sig.reason, blocked, blockReason });

          if (blocked) continue;

          // 後場BPRフィルター
          if (time >= CONFIG.pm_bpr_start && boardSnapshot && boardSnapshot.buyPressureRatio >= CONFIG.pm_bpr_threshold) continue;

          // ATRフィルター
          if (buffer.length >= CONFIG.atr_filter_period + 1) {
            const highs = buffer.map(c => c.high);
            const lows = buffer.map(c => c.low);
            const cls = buffer.map(c => c.close);
            const atrSeries = calcATR(highs, lows, cls, CONFIG.atr_filter_period);
            const latestATR = atrSeries[atrSeries.length - 1];
            if (latestATR !== null && close > 0 && latestATR / close < CONFIG.atr_filter_threshold) continue;
          }

          // 証拠金チェック
          const shares = calcShares(close);
          const currentExposure = [...openPositions.values()].reduce((sum, p) => sum + p.entryPrice * p.shares, 0);
          if (currentExposure + close * shares > CONFIG.max_total_exposure) continue;

          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: time, entryReason: sig.reason, confidence: conf });
        }
      }
    }

    // 日終了: 未決済ポジションを大引け決済
    for (const [symbol, pos] of openPositions) {
      const buffer = candleBuffers.get(symbol);
      const lastCandle = buffer ? buffer[buffer.length - 1] : null;
      const exitPrice = lastCandle ? lastCandle.close : pos.entryPrice;
      const pnl = pos.side === "long"
        ? Math.round((exitPrice - pos.entryPrice) * pos.shares)
        : Math.round((pos.entryPrice - exitPrice) * pos.shares);
      dailyTrades.push({
        symbol, symbolName: NAME_MAP[symbol] ?? symbol,
        side: pos.side, entryTime: pos.entryTime, exitTime: "15:30(EOD)",
        entryPrice: pos.entryPrice, exitPrice, shares: pos.shares,
        pnl, exitReason: "大引け強制決済(EOD)",
      });
    }

    allTrades.push(...dailyTrades);
    allSignals.push(...dailySignals);

    // 日次サマリー
    const dayPnl = dailyTrades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`  取引数: ${dailyTrades.length}件 | 日次損益: ${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString()}円`);
  }

  // ② 個別取引一覧
  console.log(`\n${"=".repeat(80)}`);
  console.log("② 個別取引一覧（6/30, 7/1, 7/2）");
  console.log("=".repeat(80));
  console.log("日付 | 銘柄 | 方向 | entry時刻 | exit時刻 | entry価格 | exit価格 | 株数 | 損益 | 決済理由");
  console.log("-".repeat(120));
  for (const t of allTrades) {
    const dateStr = t.entryTime ? TARGET_DATES.find(d => true) : "";
    console.log(
      `${t.symbolName}(${t.symbol}) | ${t.side.toUpperCase()} | ${t.entryTime} | ${t.exitTime} | ` +
      `${t.entryPrice.toFixed(0)}円 | ${t.exitPrice.toFixed(0)}円 | ${t.shares}株 | ` +
      `${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 | ${t.exitReason}`
    );
  }

  // ③ シグナル発生ログ
  console.log(`\n${"=".repeat(80)}`);
  console.log("③ シグナル発生ログ（6/30, 7/1, 7/2）");
  console.log("=".repeat(80));
  console.log("銘柄 | 時刻 | BUY/SELL | confidence | 理由 | ブロック | ブロック理由");
  console.log("-".repeat(140));
  for (const s of allSignals) {
    console.log(
      `${s.symbolName}(${s.symbol}) | ${s.time} | ${s.type} | ${s.confidence} | ` +
      `${s.reason.substring(0, 60)} | ${s.blocked ? "YES" : "NO"} | ${s.blockReason}`
    );
  }

  console.log(`\n合計: 取引${allTrades.length}件, シグナル${allSignals.length}件`);
  const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`3日間合計損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
