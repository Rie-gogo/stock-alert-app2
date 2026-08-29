import type { BoardSnapshot } from "../drizzle/schema";

/**
 * 6976候補Aは本番ロジックではない。
 * Vitestから明示的に有効化した場合だけ、realtimeSimEngineの実エンジン経路で再生する監査仕様である。
 */
export const TAIYO_CANDIDATE_A_SPEC = Object.freeze({
  symbol: "6976",
  productionEnabled: false,
  primary: Object.freeze({
    startTime: "09:45",
    endTime: "10:30",
    lookback: 5,
    maPeriod: 8,
    minVolumeRatio: 1.0,
    minDirectionalOpenMovePct: 1.6,
    minBodyPct: 0.275,
    maSlopeEvaluatedOn: "initial_break_candle",
    volumeEvaluatedOn: "initial_break_candle",
    directionalOpenMoveEvaluatedOn: "confirmation_candle",
    bodyEvaluatedOn: "confirmation_candle",
    confirmationBars: 1,
    confirmationFailureTransition: "same_candle_fall_through_and_redetect",
    slPct: 0.8,
    tpPct: 1.1,
    maxHoldingMinutes: 5,
    maxHoldingExit: "next_candle_open",
    sameMinuteTpSlPriority: "stop_loss_first",
    boardEarlyExit: true,
  }),
  board: Object.freeze({
    evaluatedOn: "initial_break_candle",
    genericBoardReadingScoreUsedForEntry: false,
    longBprMinInclusive: 0.8,
    shortBprMaxInclusive: 1.2,
    longRejectedMarketOrderDirection: "sell",
    shortRejectedMarketOrderDirection: "buy",
    longRejectedSignals: Object.freeze(["sell_pressure", "large_sell_wall"]),
    shortRejectedSignals: Object.freeze(["buy_pressure", "large_buy_wall"]),
    missingSnapshot: "allow_as_neutral_score_1",
  }),
  fallback: Object.freeze({
    startTime: "10:31",
    onlyWhenPrimaryDidNotEnter: true,
    enabledRoutes: Object.freeze(["taiyo_morning_initial_short", "taiyo_afternoon_reversal_short"]),
    disabledRoutes: Object.freeze(["taiyo_afternoon_reversal_long"]),
  }),
  commonEngineEntryGate: Object.freeze({
    atrPeriod: 7,
    minAtrPct: 0.12,
    note: "候補A固有条件の後、realtimeSimEngine.enterPositionの共通ATRゲートを通過する",
  }),
});

export type TaiyoCandidateASide = "long" | "short";

export interface TaiyoCandidateACandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TaiyoCandidateAMetrics {
  side: TaiyoCandidateASide | null;
  closeBreaksHigh: boolean;
  closeBreaksLow: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  directionalOpenMovePct: number;
  bodyPct: number;
}

export interface TaiyoCandidateAPending {
  side: TaiyoCandidateASide;
  triggerClose: number;
  triggerTime: string;
  boardDetail?: string;
}

export type TaiyoCandidateARejectionCode =
  | "confirm_price"
  | "confirm_candle_color"
  | "confirm_ma_slope"
  | "confirm_open_move"
  | "confirm_body"
  | "confirm_volume"
  | "board_signal"
  | "board_bpr"
  | "board_score";

export type TaiyoCandidateABoardDecision =
  | { allowed: true; source: "snapshot" | "missing_snapshot"; detail: string }
  | { allowed: false; code: "board_signal" | "board_bpr"; detail: string };

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateTaiyoCandidateAMetrics(
  buffer: readonly TaiyoCandidateACandle[],
  dayOpen: number,
): TaiyoCandidateAMetrics | null {
  const spec = TAIYO_CANDIDATE_A_SPEC.primary;
  const requiredBars = Math.max(21, spec.lookback + 1, spec.maPeriod + 2);
  if (buffer.length < requiredBars || dayOpen <= 0) return null;

  const candle = buffer[buffer.length - 1];
  const previousBars = buffer.slice(buffer.length - spec.lookback - 1, buffer.length - 1);
  const previousTwenty = buffer.slice(buffer.length - 21, buffer.length - 1);
  const currentMa = average(buffer.slice(buffer.length - spec.maPeriod).map(item => item.close));
  const twoBarsAgoMa = average(
    buffer.slice(buffer.length - spec.maPeriod - 2, buffer.length - 2).map(item => item.close),
  );
  const maSlope2Pct = twoBarsAgoMa > 0 ? (currentMa - twoBarsAgoMa) / twoBarsAgoMa * 100 : 0;
  const avgVolume = average(previousTwenty.map(item => item.volume));
  const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
  const closeBreaksHigh = candle.close > Math.max(...previousBars.map(item => item.high));
  const closeBreaksLow = candle.close < Math.min(...previousBars.map(item => item.low));
  const directionalOpenMovePct = (candle.close - dayOpen) / dayOpen * 100;
  const bodyPct = candle.open > 0 ? Math.abs(candle.close - candle.open) / candle.open * 100 : 0;

  let side: TaiyoCandidateASide | null = null;
  if (
    candle.close > candle.open &&
    closeBreaksHigh &&
    maSlope2Pct > 0 &&
    volumeRatio >= spec.minVolumeRatio
  ) {
    side = "long";
  } else if (
    candle.close < candle.open &&
    closeBreaksLow &&
    maSlope2Pct < 0 &&
    volumeRatio >= spec.minVolumeRatio
  ) {
    side = "short";
  }

  return {
    side,
    closeBreaksHigh,
    closeBreaksLow,
    maSlope2Pct,
    volumeRatio,
    directionalOpenMovePct,
    bodyPct,
  };
}

export function evaluateTaiyoCandidateABoard(
  side: TaiyoCandidateASide,
  snapshot: BoardSnapshot | null,
): TaiyoCandidateABoardDecision {
  const spec = TAIYO_CANDIDATE_A_SPEC.board;
  if (!snapshot) {
    return { allowed: true, source: "missing_snapshot", detail: "boardSnapshot=null" };
  }

  const rejectedSignals = side === "long" ? spec.longRejectedSignals : spec.shortRejectedSignals;
  const rejectedDirection = side === "long"
    ? spec.longRejectedMarketOrderDirection
    : spec.shortRejectedMarketOrderDirection;
  if (rejectedSignals.includes(snapshot.signal as never) || snapshot.marketOrderDirection === rejectedDirection) {
    return {
      allowed: false,
      code: "board_signal",
      detail: `signal=${snapshot.signal},marketOrderDirection=${snapshot.marketOrderDirection ?? "neutral"}`,
    };
  }

  const bpr = snapshot.buyPressureRatio;
  const bprRejected = side === "long"
    ? bpr < spec.longBprMinInclusive
    : bpr > spec.shortBprMaxInclusive;
  if (bprRejected) {
    return { allowed: false, code: "board_bpr", detail: `BPR=${bpr.toFixed(3)}` };
  }

  return {
    allowed: true,
    source: "snapshot",
    detail: `BPR=${bpr.toFixed(3)},signal=${snapshot.signal},marketOrderDirection=${snapshot.marketOrderDirection ?? "neutral"}`,
  };
}

export function evaluateTaiyoCandidateAConfirmation(input: {
  pending: TaiyoCandidateAPending;
  candle: TaiyoCandidateACandle;
  metrics: TaiyoCandidateAMetrics;
}): { allowed: true } | { allowed: false; codes: TaiyoCandidateARejectionCode[] } {
  const { pending, candle, metrics } = input;
  const spec = TAIYO_CANDIDATE_A_SPEC.primary;
  const isLong = pending.side === "long";
  const codes: TaiyoCandidateARejectionCode[] = [];

  if (isLong ? candle.close <= pending.triggerClose : candle.close >= pending.triggerClose) {
    codes.push("confirm_price");
  }
  if (isLong ? candle.close <= candle.open : candle.close >= candle.open) {
    codes.push("confirm_candle_color");
  }
  if (
    isLong
      ? metrics.directionalOpenMovePct < spec.minDirectionalOpenMovePct
      : metrics.directionalOpenMovePct > -spec.minDirectionalOpenMovePct
  ) {
    codes.push("confirm_open_move");
  }
  if (metrics.bodyPct < spec.minBodyPct) {
    codes.push("confirm_body");
  }
  return codes.length === 0 ? { allowed: true } : { allowed: false, codes };
}
