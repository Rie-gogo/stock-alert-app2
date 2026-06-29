/**
 * compare_state_machine.ts
 * 「戻り終了確認ステートマシン」の比較バックテスト
 * 
 * データ: rt_candles（KABUステーションAPI取得の1分足）
 * 比較: 現行（即エントリー）vs 新方式（ステートマシン経由）
 * 
 * 対象シグナル（SHORT側）:
 * 1. VWAPクロス下抜け
 * 2. VWAP反落（戻り売り）
 * 3. 下落相場の戻り売り
 * 4. ダウ理論：直近安値更新（三尊含む）
 * 5. 大台割れ
 * 
 * ステートマシン仕様:
 * - シグナル発生→即エントリーせず待機
 * - 2〜5本待機中に「戻り条件」を満たすか確認
 * - 戻り確認後、「戻り終了」を確認してエントリー
 * - 5本超過でキャンセル
 */

import { getDb } from "../server/db";
import { rtCandles, rtTrades } from "../drizzle/schema";
import { eq, and, asc } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// 定数（現行システムと同一）
// ============================================================
const INITIAL_CAPITAL = 3_000_000;
const STOP_LOSS_RATIO = 0.005;    // 0.5%
const TAKE_PROFIT_RATIO = 0.015;  // 1.5%
const TRAIL_TRIGGER = 0.01;       // +1%でトレイリング開始
const TRAIL_GAP = 0.005;          // ピークから0.5%戻しで利確
const BREAKEVEN_TRIGGER = 0.005;  // +0.5%で同値ストップ
const LOT_RATIO = 0.30;           // 資金の30%
const MAX_TRADES_PER_DAY = 10;
const WARMUP_BARS = 10;           // MA計算用ウォームアップ
const SHORT_MAX_HOLD_BARS = 60;
const SLOPE_THRESHOLD = 0.0001;
const SHORT_RSI_MIN = 40;
const SHORT_NEAR_MA = 0.003;      // MA25近辺判定
const ATR_BLOCK_THRESHOLD = 0.0012; // ATR率0.12%未満ブロック

// ============================================================
// ステートマシン定数
// ============================================================
const SM_MIN_WAIT = 2;            // 最低2本待つ
const SM_MAX_WAIT = 5;            // 最大5本まで待つ
const SM_PULLBACK_RATIO = 0.001;  // signalPriceから0.10%以上戻る
const SM_VWAP_NEAR = 0.002;       // VWAP接近: ±0.20%以内
const SM_MA5_NEAR = 0.002;        // MA5接近: ±0.20%以内
const SM_REVERSAL_CANDLE_BODY = 0.0005; // 戻り終了: 陰線実体0.05%以上
const SM_MOMENTUM_BARS = 3;       // 直近3本の高値切り下げ確認

// ============================================================
// テクニカル指標計算
// ============================================================
interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // computed
  ma5?: number;
  ma25?: number;
  rsi?: number;
  vwap?: number;
  bbUpper?: number;
  bbLower?: number;
  atr?: number;
}

function computeIndicators(candles: Candle[]): void {
  // VWAP (cumulative)
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    c.vwap = cumVol > 0 ? cumPV / cumVol : c.close;
  }

  // MA5, MA25
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

  // RSI (14-period)
  for (let i = 14; i < candles.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - 13; j <= i; j++) {
      const diff = candles[j].close - candles[j - 1].close;
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    candles[i].rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // BB (20-period, 2σ)
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

  // ATR (14-period)
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    (candles[i] as any)._tr = tr;
  }
  for (let i = 14; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += (candles[j] as any)._tr || 0;
    candles[i].atr = sum / 14;
  }
}

function getSlope(candles: Candle[], i: number, period: number = 10): number {
  if (i < period) return 0;
  const start = candles[i - period].close;
  const end = candles[i].close;
  return (end - start) / start / period;
}

function trailingAvgVolume(candles: Candle[], i: number, period: number): number {
  if (i < period) return candles[i].volume;
  let sum = 0;
  for (let j = i - period; j < i; j++) sum += candles[j].volume;
  return sum / period;
}

// ============================================================
// シグナル検出（現行ロジック再現）
// ============================================================
type SignalType = "vwap_cross_down" | "vwap_bearish_bounce" | "pullback_short" | "head_shoulders" | "round_number_break" | "breakdown_short" | "other_short";

interface ShortSignal {
  type: SignalType;
  bar: number;
  price: number;
  reason: string;
  isStateMachineTarget: boolean; // ステートマシン対象かどうか
}

function detectShortSignals(candles: Candle[], i: number): ShortSignal[] {
  const signals: ShortSignal[] = [];
  if (i < WARMUP_BARS || i < 2) return signals;

  const curr = candles[i];
  const prev = candles[i - 1];
  const slope = getSlope(candles, i);
  
  // ATRフィルター
  const atrRatio = curr.atr ? curr.atr / curr.close : 0;
  if (atrRatio < ATR_BLOCK_THRESHOLD) return signals;

  // レジーム判定（簡易版: slopeベース）
  const isStrongUp = slope > SLOPE_THRESHOLD * 3;
  if (isStrongUp) return signals; // 強い上昇トレンドではショート禁止

  // 出来高確認
  const avgVol = trailingAvgVolume(candles, i, 10);
  const volConfirmed = curr.volume >= avgVol * 0.8;
  if (!volConfirmed) return signals;

  // 1. VWAPクロス下抜け
  if (curr.vwap && prev.vwap && prev.close > prev.vwap && curr.close <= curr.vwap && slope < 0) {
    signals.push({
      type: "vwap_cross_down",
      bar: i,
      price: curr.close,
      reason: `VWAPクロス下抜け (VWAP:${curr.vwap.toFixed(1)})`,
      isStateMachineTarget: true,
    });
  }

  // 2. VWAP反落（戻り売り）
  if (i >= 3 && curr.vwap && prev.vwap) {
    const prev2 = candles[i - 2];
    const vwapPrev2 = prev2.vwap;
    if (vwapPrev2 && prev2.close > vwapPrev2 && prev.high >= prev.vwap! * 0.998 && curr.close < curr.vwap && curr.close < curr.open && slope < 0) {
      signals.push({
        type: "vwap_bearish_bounce",
        bar: i,
        price: curr.close,
        reason: `VWAP反落(戻り売り)`,
        isStateMachineTarget: true,
      });
    }
  }

  // 3. 下落相場の戻り売り
  const stockTrendDown = slope < -SLOPE_THRESHOLD;
  const nearMA25 = curr.ma25 && Math.abs(curr.close - curr.ma25) / curr.ma25 <= SHORT_NEAR_MA;
  if (stockTrendDown && (curr.rsi ?? 50) >= SHORT_RSI_MIN && nearMA25 && curr.close <= curr.ma25!) {
    signals.push({
      type: "pullback_short",
      bar: i,
      price: curr.close,
      reason: `下落トレンド戻り売り (RSI:${curr.rsi?.toFixed(1)}, MA25近辺)`,
      isStateMachineTarget: true,
    });
  }

  // 4. 三尊/ダウ理論（簡易: 直近高値の切り下げパターン）
  if (i >= 40) {
    // 簡易三尊検出: 3つのピークで中央が最高
    const lookback = candles.slice(i - 39, i + 1);
    const highs = lookback.map(c => c.high);
    const maxIdx = highs.indexOf(Math.max(...highs));
    if (maxIdx >= 10 && maxIdx <= 30) {
      const leftPeak = Math.max(...highs.slice(0, maxIdx - 3));
      const rightPeak = Math.max(...highs.slice(maxIdx + 3));
      const centerPeak = highs[maxIdx];
      if (centerPeak > leftPeak && centerPeak > rightPeak && 
          leftPeak > curr.close && rightPeak > curr.close &&
          Math.abs(leftPeak - rightPeak) / centerPeak < 0.005) {
        const neckline = Math.min(...lookback.slice(maxIdx - 5, maxIdx + 5).map(c => c.low));
        if (curr.close < neckline && prev.close >= neckline) {
          signals.push({
            type: "head_shoulders",
            bar: i,
            price: curr.close,
            reason: `三尊(ネックライン:${neckline.toFixed(1)}割れ)`,
            isStateMachineTarget: true,
          });
        }
      }
    }
  }

  // 5. 大台割れ
  const roundUnit = curr.close >= 10000 ? 100 : curr.close >= 1000 ? 100 : 10;
  const prevRound = Math.ceil(prev.close / roundUnit) * roundUnit;
  const currRound = Math.ceil(curr.close / roundUnit) * roundUnit;
  if (currRound < prevRound && curr.close < prevRound - roundUnit * 0.1) {
    // 5本維持確認（簡易: 直近5本が大台以下）
    let maintained = true;
    for (let j = Math.max(0, i - 4); j < i; j++) {
      if (candles[j].close > prevRound) { maintained = false; break; }
    }
    if (maintained && slope <= 0) {
      signals.push({
        type: "round_number_break",
        bar: i,
        price: curr.close,
        reason: `大台割れ (${prevRound}円割り込み)`,
        isStateMachineTarget: true,
      });
    }
  }

  // その他のショートシグナル（ステートマシン対象外）
  // RSI買われすぎ+BB上限
  if ((curr.rsi ?? 50) >= 70 && curr.bbUpper && curr.close >= curr.bbUpper) {
    signals.push({
      type: "other_short",
      bar: i,
      price: curr.close,
      reason: `RSI買われすぎ+BB上限 (RSI:${curr.rsi?.toFixed(1)})`,
      isStateMachineTarget: false,
    });
  }

  // 長い上ヒゲ
  const bodySize = Math.abs(curr.open - curr.close);
  const upperShadow = curr.high - Math.max(curr.open, curr.close);
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;
  if (bodySize > 0.01 && upperShadow >= bodySize * 2 && lowerShadow <= bodySize * 0.5 && (curr.rsi ?? 50) >= 55) {
    signals.push({
      type: "other_short",
      bar: i,
      price: curr.close,
      reason: `長い上ヒゲ (天井シグナル)`,
      isStateMachineTarget: false,
    });
  }

  return signals;
}

// ============================================================
// ステートマシン
// ============================================================
interface PendingSignal {
  signal: ShortSignal;
  signalPrice: number;
  waitStartBar: number;
  state: "waiting_pullback" | "waiting_reversal";
  pullbackConfirmedBar?: number;
  pullbackHighPrice?: number; // 戻りの最高値
}

function evaluateStateMachine(
  pending: PendingSignal,
  candles: Candle[],
  currentBar: number
): { action: "wait" | "enter" | "cancel"; reason?: string } {
  const elapsed = currentBar - pending.waitStartBar;
  const curr = candles[currentBar];
  
  // 5本超過 → キャンセル
  if (elapsed > SM_MAX_WAIT) {
    return { action: "cancel", reason: "5本超過キャンセル" };
  }

  // 最低2本は待つ
  if (elapsed < SM_MIN_WAIT) {
    // ただし戻り条件のチェックは開始
    if (pending.state === "waiting_pullback") {
      // 戻り条件チェック
      const pullbackOk = checkPullbackCondition(pending, candles, currentBar);
      if (pullbackOk) {
        pending.state = "waiting_reversal";
        pending.pullbackConfirmedBar = currentBar;
        pending.pullbackHighPrice = curr.high;
      }
    }
    return { action: "wait" };
  }

  // 2〜5本の間
  if (pending.state === "waiting_pullback") {
    // 戻り条件チェック
    const pullbackOk = checkPullbackCondition(pending, candles, currentBar);
    if (pullbackOk) {
      pending.state = "waiting_reversal";
      pending.pullbackConfirmedBar = currentBar;
      pending.pullbackHighPrice = curr.high;
      // 同じ足で戻り終了も確認
      const reversalOk = checkReversalCondition(pending, candles, currentBar);
      if (reversalOk) {
        return { action: "enter", reason: "戻り確認→即反転" };
      }
    }
    return { action: "wait" };
  }

  if (pending.state === "waiting_reversal") {
    // 戻りの最高値を更新
    if (curr.high > (pending.pullbackHighPrice || 0)) {
      pending.pullbackHighPrice = curr.high;
    }
    // 戻り終了確認
    const reversalOk = checkReversalCondition(pending, candles, currentBar);
    if (reversalOk) {
      return { action: "enter", reason: "戻り終了確認" };
    }
    return { action: "wait" };
  }

  return { action: "wait" };
}

function checkPullbackCondition(pending: PendingSignal, candles: Candle[], i: number): boolean {
  const curr = candles[i];
  const signalPrice = pending.signalPrice;

  // SHORT: 現在価格がsignalPriceより0.10%以上上に戻る
  if (curr.close > signalPrice * (1 + SM_PULLBACK_RATIO)) {
    return true;
  }

  // VWAP接近
  if (curr.vwap && Math.abs(curr.close - curr.vwap) / curr.vwap <= SM_VWAP_NEAR) {
    return true;
  }

  // MA5接近
  if (curr.ma5 && Math.abs(curr.close - curr.ma5) / curr.ma5 <= SM_MA5_NEAR) {
    return true;
  }

  return false;
}

function checkReversalCondition(pending: PendingSignal, candles: Candle[], i: number): boolean {
  const curr = candles[i];

  // 条件1: 陰線（実体が0.05%以上）
  const bodyRatio = (curr.open - curr.close) / curr.close;
  const isBearishCandle = bodyRatio >= SM_REVERSAL_CANDLE_BODY;

  // 条件2: 直近3本の高値切り下げ（モメンタム反転）
  let highsDecreasing = false;
  if (i >= 2) {
    const h1 = candles[i - 2].high;
    const h2 = candles[i - 1].high;
    const h3 = curr.high;
    highsDecreasing = h3 < h2 && h2 <= h1;
  }

  // 条件3: 現在価格がsignalPrice以下に戻った（戻り終了）
  const belowSignal = curr.close <= pending.signalPrice * 1.001;

  // いずれか2つ以上で戻り終了と判定
  const score = (isBearishCandle ? 1 : 0) + (highsDecreasing ? 1 : 0) + (belowSignal ? 1 : 0);
  return score >= 2;
}

// ============================================================
// シミュレーション実行
// ============================================================
interface TradeResult {
  date: string;
  symbol: string;
  entryBar: number;
  entryTime: string;
  entryPrice: number;
  exitBar: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlRate: number;
  reason: string;
  exitReason: string;
  signalType: string;
}

interface SimResult {
  totalPnl: number;
  trades: TradeResult[];
  wins: number;
  losses: number;
  avgWin: number;
  avgLoss: number;
  maxLoss: number;
  maxDD: number;
  stopLossCount: number;
  takeProfitCount: number;
  profitFactor: number;
  entryCount: number;
  // ステートマシン固有
  skippedCount?: number;
  skippedSavedLoss?: number;   // 見送りで損切り回避できた件数
  skippedMissedProfit?: number; // 見送りで利益機会を逃した件数
}

function simulateDay(
  candles: Candle[],
  symbol: string,
  date: string,
  useStateMachine: boolean
): { trades: TradeResult[]; skipped: { savedLoss: number; missedProfit: number; total: number } } {
  computeIndicators(candles);

  const trades: TradeResult[] = [];
  let capital = INITIAL_CAPITAL;
  let shortShares = 0;
  let shortEntryPrice = 0;
  let shortLowWater = 0;
  let shortEntryBar = -1;
  let tradeCount = 0;
  let shortEntryReason = "";
  let shortSignalType = "";

  // ステートマシン用
  const pendingSignals: PendingSignal[] = [];
  const skippedResults = { savedLoss: 0, missedProfit: 0, total: 0 };

  // 時間帯フィルター
  function isBlockedTime(time: string): boolean {
    const [h, m] = time.split(":").map(Number);
    const mins = h * 60 + m;
    // 11:00〜11:30, 12:30〜13:00
    if (mins >= 660 && mins <= 690) return true;
    if (mins >= 750 && mins <= 780) return true;
    return false;
  }

  for (let i = 0; i < candles.length; i++) {
    const curr = candles[i];
    const currTime = curr.time;

    // ステートマシン: pending signalの評価
    if (useStateMachine && shortShares === 0) {
      for (let p = pendingSignals.length - 1; p >= 0; p--) {
        const pending = pendingSignals[p];
        const result = evaluateStateMachine(pending, candles, i);
        
        if (result.action === "cancel") {
          // キャンセル: 現行なら即エントリーしていた場合の結果を追跡
          pendingSignals.splice(p, 1);
          skippedResults.total++;
          // この後の価格推移で損切りになったか利確になったかを簡易判定
          const wouldHavePnl = simulateHypotheticalTrade(candles, pending.signal.bar, pending.signalPrice);
          if (wouldHavePnl < 0) skippedResults.savedLoss++;
          else if (wouldHavePnl > 0) skippedResults.missedProfit++;
        } else if (result.action === "enter" && shortShares === 0 && tradeCount < MAX_TRADES_PER_DAY) {
          // エントリー実行
          const maxSpend = capital * LOT_RATIO;
          const shares = Math.floor(maxSpend / curr.close / 100) * 100;
          if (shares > 0) {
            shortShares = shares;
            shortEntryPrice = curr.close;
            shortLowWater = curr.close;
            shortEntryBar = i;
            capital -= shares * curr.close;
            shortEntryReason = pending.signal.reason + " [SM確認後]";
            shortSignalType = pending.signal.type;
          }
          pendingSignals.splice(p, 1);
          break; // 1つエントリーしたら他のpendingはクリア
        }
      }
      // エントリーしたら残りのpendingをクリア
      if (shortShares > 0) {
        pendingSignals.length = 0;
      }
    }

    // ショートポジション管理（エグジット）
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
        exitReason = "同値損切り";
      }

      // 利確チェック
      const profitRate = (shortEntryPrice - curr.close) / shortEntryPrice;
      if (profitRate >= TAKE_PROFIT_RATIO) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({
          date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time,
          entryPrice: shortEntryPrice, exitBar: i, exitTime: currTime,
          exitPrice: curr.close, pnl, pnlRate: profitRate,
          reason: shortEntryReason, exitReason: "利確", signalType: shortSignalType,
        });
        shortShares = 0; shortEntryPrice = 0; shortLowWater = 0; shortEntryBar = -1;
        tradeCount++;
        continue;
      }

      // 損切り/トレイリング
      if (curr.close >= stopPrice) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({
          date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time,
          entryPrice: shortEntryPrice, exitBar: i, exitTime: currTime,
          exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice,
          reason: shortEntryReason, exitReason, signalType: shortSignalType,
        });
        shortShares = 0; shortEntryPrice = 0; shortLowWater = 0; shortEntryBar = -1;
        tradeCount++;
        continue;
      }

      // 最大保有時間
      if (i - shortEntryBar >= SHORT_MAX_HOLD_BARS) {
        const pnl = (shortEntryPrice - curr.close) * shortShares;
        capital += shortShares * shortEntryPrice + pnl;
        trades.push({
          date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time,
          entryPrice: shortEntryPrice, exitBar: i, exitTime: currTime,
          exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice,
          reason: shortEntryReason, exitReason: "最大保有時間超過", signalType: shortSignalType,
        });
        shortShares = 0; shortEntryPrice = 0; shortLowWater = 0; shortEntryBar = -1;
        tradeCount++;
        continue;
      }
    }

    // シグナル検出（ポジションなしの場合のみ）
    if (shortShares === 0 && tradeCount < MAX_TRADES_PER_DAY && !isBlockedTime(currTime)) {
      const signals = detectShortSignals(candles, i);
      
      for (const sig of signals) {
        if (useStateMachine && sig.isStateMachineTarget) {
          // ステートマシン: pendingに追加
          pendingSignals.push({
            signal: sig,
            signalPrice: sig.price,
            waitStartBar: i,
            state: "waiting_pullback",
          });
        } else if (!useStateMachine || !sig.isStateMachineTarget) {
          // 即エントリー（現行方式 or 非対象シグナル）
          if (shortShares === 0) {
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
    }

    // 大引け強制決済
    if (shortShares > 0 && i === candles.length - 1) {
      const pnl = (shortEntryPrice - curr.close) * shortShares;
      capital += shortShares * shortEntryPrice + pnl;
      trades.push({
        date, symbol, entryBar: shortEntryBar, entryTime: candles[shortEntryBar].time,
        entryPrice: shortEntryPrice, exitBar: i, exitTime: currTime,
        exitPrice: curr.close, pnl, pnlRate: (shortEntryPrice - curr.close) / shortEntryPrice,
        reason: shortEntryReason, exitReason: "大引け強制決済", signalType: shortSignalType,
      });
      shortShares = 0; tradeCount++;
    }
  }

  return { trades, skipped: skippedResults };
}

// 仮想取引シミュレーション（見送った場合に損切りになったか利確になったかを判定）
function simulateHypotheticalTrade(candles: Candle[], entryBar: number, entryPrice: number): number {
  let lowWater = entryPrice;
  for (let i = entryBar + 1; i < Math.min(entryBar + SHORT_MAX_HOLD_BARS, candles.length); i++) {
    const c = candles[i];
    if (c.close < lowWater) lowWater = c.close;
    const gain = (entryPrice - lowWater) / entryPrice;
    
    // 損切り
    if (c.close >= entryPrice * (1 + STOP_LOSS_RATIO)) {
      return -(STOP_LOSS_RATIO * entryPrice * 100); // 概算損失
    }
    // 利確
    if ((entryPrice - c.close) / entryPrice >= TAKE_PROFIT_RATIO) {
      return TAKE_PROFIT_RATIO * entryPrice * 100; // 概算利益
    }
    // トレイリング
    if (gain >= TRAIL_TRIGGER && c.close >= lowWater * (1 + TRAIL_GAP)) {
      return (entryPrice - c.close) * 100;
    }
  }
  // 時間切れ: 最終足で判定
  const lastBar = Math.min(entryBar + SHORT_MAX_HOLD_BARS - 1, candles.length - 1);
  return (entryPrice - candles[lastBar].close) * 100;
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  // 全日付・全銘柄のrt_candlesを取得
  const allCandles = await db.select().from(rtCandles).orderBy(asc(rtCandles.tradeDate), asc(rtCandles.candleTime));
  
  console.log(`Total candles: ${allCandles.length}`);

  // 日付×銘柄でグループ化
  const grouped: Record<string, Record<string, Candle[]>> = {};
  for (const c of allCandles) {
    const date = c.tradeDate;
    const sym = c.symbol;
    if (!grouped[date]) grouped[date] = {};
    if (!grouped[date][sym]) grouped[date][sym] = [];
    grouped[date][sym].push({
      time: c.candleTime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    });
  }

  const dates = Object.keys(grouped).sort();
  console.log(`Dates: ${dates.join(", ")}`);

  // 現行方式と新方式の両方でシミュレーション
  const currentTrades: TradeResult[] = [];
  const smTrades: TradeResult[] = [];
  let totalSkipped = { savedLoss: 0, missedProfit: 0, total: 0 };

  for (const date of dates) {
    const symbols = Object.keys(grouped[date]);
    for (const symbol of symbols) {
      const candles = grouped[date][symbol];
      if (candles.length < 30) continue; // データ不足スキップ

      // 現行方式
      const currentResult = simulateDay([...candles.map(c => ({ ...c }))], symbol, date, false);
      currentTrades.push(...currentResult.trades);

      // ステートマシン方式
      const smResult = simulateDay([...candles.map(c => ({ ...c }))], symbol, date, true);
      smTrades.push(...smResult.trades);
      totalSkipped.savedLoss += smResult.skipped.savedLoss;
      totalSkipped.missedProfit += smResult.skipped.missedProfit;
      totalSkipped.total += smResult.skipped.total;
    }
  }

  // 結果集計
  function aggregate(trades: TradeResult[]): SimResult {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;
    const stopLossCount = trades.filter(t => t.exitReason === "損切り").length;
    const takeProfitCount = trades.filter(t => t.exitReason === "利確" || t.exitReason === "トレイリング利確").length;
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // 最大DD計算
    let peak = 0, maxDD = 0, cumPnl = 0;
    // 日付順にソート
    const sorted = [...trades].sort((a, b) => `${a.date}${a.exitTime}`.localeCompare(`${b.date}${b.exitTime}`));
    for (const t of sorted) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      totalPnl,
      trades,
      wins: wins.length,
      losses: losses.length,
      avgWin,
      avgLoss,
      maxLoss,
      maxDD,
      stopLossCount,
      takeProfitCount,
      profitFactor,
      entryCount: trades.length,
    };
  }

  const currentStats = aggregate(currentTrades);
  const smStats = aggregate(smTrades);

  // レポート出力
  console.log("\n" + "=".repeat(70));
  console.log("  戻り終了確認ステートマシン 比較バックテスト結果");
  console.log("  データ: rt_candles (KABUステーションAPI) " + dates[0] + " ~ " + dates[dates.length - 1]);
  console.log("=".repeat(70));

  console.log("\n【総合比較】");
  console.log(`${"指標".padEnd(20)}${"現行".padStart(15)}${"SM方式".padStart(15)}${"差分".padStart(15)}`);
  console.log("-".repeat(65));
  const metrics = [
    ["総損益", currentStats.totalPnl, smStats.totalPnl],
    ["エントリー数", currentStats.entryCount, smStats.entryCount],
    ["勝ち数", currentStats.wins, smStats.wins],
    ["負け数", currentStats.losses, smStats.losses],
    ["勝率(%)", currentStats.entryCount > 0 ? (currentStats.wins / currentStats.entryCount * 100) : 0, smStats.entryCount > 0 ? (smStats.wins / smStats.entryCount * 100) : 0],
    ["平均利益", currentStats.avgWin, smStats.avgWin],
    ["平均損失", currentStats.avgLoss, smStats.avgLoss],
    ["最大損失", currentStats.maxLoss, smStats.maxLoss],
    ["損切り回数", currentStats.stopLossCount, smStats.stopLossCount],
    ["利確回数", currentStats.takeProfitCount, smStats.takeProfitCount],
    ["Profit Factor", currentStats.profitFactor, smStats.profitFactor],
    ["最大DD", currentStats.maxDD, smStats.maxDD],
  ];

  for (const [name, curr, sm] of metrics) {
    const diff = (sm as number) - (curr as number);
    const diffStr = diff > 0 ? `+${typeof curr === "number" && curr > 100 ? diff.toLocaleString() : diff.toFixed(2)}` : `${typeof curr === "number" && Math.abs(curr as number) > 100 ? diff.toLocaleString() : diff.toFixed(2)}`;
    console.log(`${(name as string).padEnd(20)}${String(typeof curr === "number" && Math.abs(curr) > 100 ? Math.round(curr).toLocaleString() : (curr as number).toFixed(2)).padStart(15)}${String(typeof sm === "number" && Math.abs(sm) > 100 ? Math.round(sm).toLocaleString() : (sm as number).toFixed(2)).padStart(15)}${diffStr.padStart(15)}`);
  }

  console.log("\n【ステートマシン固有指標】");
  console.log(`  見送り数: ${totalSkipped.total}`);
  console.log(`  見送り→損切り回避: ${totalSkipped.savedLoss} (${totalSkipped.total > 0 ? (totalSkipped.savedLoss / totalSkipped.total * 100).toFixed(1) : 0}%)`);
  console.log(`  見送り→利益逸失: ${totalSkipped.missedProfit} (${totalSkipped.total > 0 ? (totalSkipped.missedProfit / totalSkipped.total * 100).toFixed(1) : 0}%)`);

  // 合格基準チェック
  console.log("\n【合格基準チェック】");
  const currentWinRate = currentStats.entryCount > 0 ? currentStats.wins / currentStats.entryCount : 0;
  const smWinRate = smStats.entryCount > 0 ? smStats.wins / smStats.entryCount : 0;
  const entryReduction = currentStats.entryCount > 0 ? (currentStats.entryCount - smStats.entryCount) / currentStats.entryCount : 0;
  const stopReduction = currentStats.stopLossCount > 0 ? (currentStats.stopLossCount - smStats.stopLossCount) / currentStats.stopLossCount : 0;

  const criteria = [
    { name: "平均損失が現行より増えない", pass: Math.abs(smStats.avgLoss) <= Math.abs(currentStats.avgLoss) * 1.01 },
    { name: "最大損失が現行より増えない", pass: Math.abs(smStats.maxLoss) <= Math.abs(currentStats.maxLoss) * 1.01 },
    { name: "損切り回数が20%以上減る", pass: stopReduction >= 0.20 },
    { name: "総損益が悪化しない", pass: smStats.totalPnl >= currentStats.totalPnl * 0.95 },
    { name: "エントリー数の減少は30%以内", pass: entryReduction <= 0.30 },
    { name: "Profit Factorが現行以上", pass: smStats.profitFactor >= currentStats.profitFactor * 0.95 },
  ];

  let passCount = 0;
  for (const c of criteria) {
    const mark = c.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${mark} ${c.name}`);
    if (c.pass) passCount++;
  }
  console.log(`\n  合格: ${passCount}/${criteria.length}`);

  // シグナル別分析
  console.log("\n【シグナル別分析（現行）】");
  const signalTypes = [...new Set(currentTrades.map(t => t.signalType))];
  for (const st of signalTypes) {
    const stTrades = currentTrades.filter(t => t.signalType === st);
    const stWins = stTrades.filter(t => t.pnl > 0).length;
    const stPnl = stTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${st}: ${stTrades.length}件, ${stWins}W/${stTrades.length - stWins}L, P&L: ${Math.round(stPnl).toLocaleString()}円`);
  }

  console.log("\n【シグナル別分析（SM方式）】");
  const smSignalTypes = [...new Set(smTrades.map(t => t.signalType))];
  for (const st of smSignalTypes) {
    const stTrades = smTrades.filter(t => t.signalType === st);
    const stWins = stTrades.filter(t => t.pnl > 0).length;
    const stPnl = stTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${st}: ${stTrades.length}件, ${stWins}W/${stTrades.length - stWins}L, P&L: ${Math.round(stPnl).toLocaleString()}円`);
  }

  // 日別分析
  console.log("\n【日別損益比較】");
  console.log(`${"日付".padEnd(12)}${"現行".padStart(12)}${"SM方式".padStart(12)}${"差分".padStart(12)}`);
  for (const date of dates) {
    const currDay = currentTrades.filter(t => t.date === date);
    const smDay = smTrades.filter(t => t.date === date);
    const currPnl = currDay.reduce((s, t) => s + t.pnl, 0);
    const smPnl = smDay.reduce((s, t) => s + t.pnl, 0);
    const diff = smPnl - currPnl;
    console.log(`${date.padEnd(12)}${Math.round(currPnl).toLocaleString().padStart(12)}${Math.round(smPnl).toLocaleString().padStart(12)}${(diff > 0 ? "+" : "") + Math.round(diff).toLocaleString()}`.padStart(12));
  }

  // JSONファイルに詳細保存
  const reportData = {
    summary: { current: currentStats, stateMachine: smStats, skipped: totalSkipped },
    criteria: criteria.map(c => ({ ...c })),
    currentTrades,
    smTrades,
  };
  const outPath = path.join(process.cwd(), "analysis", "state_machine_comparison.json");
  fs.writeFileSync(outPath, JSON.stringify(reportData, (key, val) => key === "trades" && Array.isArray(val) && val.length > 100 ? `[${val.length} trades]` : val, 2));
  console.log(`\nDetailed data saved to: ${outPath}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
