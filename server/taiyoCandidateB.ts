/**
 * 6976候補B（最大30分）のDRY_RUN仕様。
 *
 * LIVE注文は承認されていない。realtimeSimEngineの架空取引経路だけで使用し、
 * 保存済みKABUステーション1分足から同じ判定を再監査できるよう純粋関数へ分離する。
 */
export const TAIYO_CANDIDATE_B_SPEC = Object.freeze({
  symbol: "6976",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "09:45",
    initialTriggerEndTime: "10:59",
    confirmationEndTime: "11:00",
    lookback: 10,
    maPeriod: 8,
    minAbsMaSlopePct: 0.05,
    minVolumeRatio: 1.0,
    dayOpenAnchor: "first_candle_at_or_after_09:00",
    requireDirectionalDayOpenPosition: true,
    confirmationBars: 1,
    confirmationFailureTransition: "same_candle_fall_through_and_redetect",
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
    slPct: 1.0,
    tpPct: 0.6,
    maxHoldingMinutes: 30,
    maxHoldingExit: "elapsed_boundary_completed_candle_close",
    sameMinuteTpSlPriority: "stop_loss_first",
    genericSignalExit: false,
    boardEntryFilter: false,
    boardEarlyExit: false,
  }),
  routes: Object.freeze({
    taiyoMorningInitialShort: false,
    taiyoAfternoonReversalLong: false,
    taiyoAfternoonReversalShort: true,
    afternoonShortAllowedAfterPrimaryEntry: true,
  }),
  commonEngineEntryGate: Object.freeze({
    atrPeriod: 7,
    minAtrPct: 0.12,
    marginLimitYen: 8_910_000,
    rejectedAttemptRecorded: true,
  }),
});

export const TAIYO_CANDIDATE_B_REASON_PREFIX = "太陽誘電候補B";

export function evaluateTaiyoCandidateBOrderApproval(input: {
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "candidate_b_live_not_approved" } {
  const isCandidateBEntry = input.instructionType === "entry"
    && input.reason.startsWith(TAIYO_CANDIDATE_B_REASON_PREFIX);
  if (!isCandidateBEntry || input.isDryRun || TAIYO_CANDIDATE_B_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "candidate_b_live_not_approved" };
}

export type TaiyoCandidateBSide = "long" | "short";

export interface TaiyoCandidateBCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TaiyoCandidateBMetrics {
  side: TaiyoCandidateBSide | null;
  closeBreaksHigh: boolean;
  closeBreaksLow: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  openMovePct: number;
}

export interface TaiyoCandidateBPending {
  side: TaiyoCandidateBSide;
  triggerClose: number;
  triggerTime: string;
  triggerMaSlope2Pct: number;
  triggerVolumeRatio: number;
  triggerOpenMovePct: number;
}

export type TaiyoCandidateBRejectionCode =
  | "confirm_price"
  | "confirm_candle_color";

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isTaiyoCandidateBInitialTriggerTime(time: string): boolean {
  const spec = TAIYO_CANDIDATE_B_SPEC.primary;
  return time >= spec.startTime && time <= spec.initialTriggerEndTime;
}

export function isTaiyoCandidateBConfirmationTime(time: string): boolean {
  const spec = TAIYO_CANDIDATE_B_SPEC.primary;
  return time > spec.startTime && time <= spec.confirmationEndTime;
}

export function getTaiyoCandidateBDayOpen(
  candles: readonly TaiyoCandidateBCandle[],
): number | null {
  return candles.find(candle => candle.time >= "09:00")?.open ?? null;
}

export function calculateTaiyoCandidateBMetrics(
  buffer: readonly TaiyoCandidateBCandle[],
  dayOpen: number,
): TaiyoCandidateBMetrics | null {
  const spec = TAIYO_CANDIDATE_B_SPEC.primary;
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
  const openMovePct = (candle.close - dayOpen) / dayOpen * 100;

  let side: TaiyoCandidateBSide | null = null;
  if (
    candle.close > candle.open &&
    candle.close > dayOpen &&
    closeBreaksHigh &&
    maSlope2Pct >= spec.minAbsMaSlopePct &&
    volumeRatio >= spec.minVolumeRatio
  ) {
    side = "long";
  } else if (
    candle.close < candle.open &&
    candle.close < dayOpen &&
    closeBreaksLow &&
    maSlope2Pct <= -spec.minAbsMaSlopePct &&
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
    openMovePct,
  };
}

export function evaluateTaiyoCandidateBConfirmation(input: {
  pending: TaiyoCandidateBPending;
  candle: TaiyoCandidateBCandle;
}): { allowed: true } | { allowed: false; codes: TaiyoCandidateBRejectionCode[] } {
  const { pending, candle } = input;
  const isLong = pending.side === "long";
  const codes: TaiyoCandidateBRejectionCode[] = [];

  if (isLong ? candle.close <= pending.triggerClose : candle.close >= pending.triggerClose) {
    codes.push("confirm_price");
  }
  if (isLong ? candle.close <= candle.open : candle.close >= candle.open) {
    codes.push("confirm_candle_color");
  }

  return codes.length === 0 ? { allowed: true } : { allowed: false, codes };
}
