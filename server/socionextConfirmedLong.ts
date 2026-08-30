/**
 * 6526（ソシオネクスト）前場確認型ブレイクLONGのDRY_RUN専用仕様。
 *
 * 保存KABUステーション1分足だけで再監査できるよう、初動判定と次足確認を
 * 純粋関数として分離する。LIVE新規注文は承認されていない。
 */
export const SOCIONEXT_CONFIRMED_LONG_SPEC = Object.freeze({
  symbol: "6526",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "09:30",
    initialTriggerEndTime: "10:59",
    confirmationEndTime: "11:00",
    lookback: 10,
    maPeriod: 8,
    minMaSlopePct: 0.05,
    minVolumeRatio: 1.2,
    dayOpenAnchor: "first_candle_at_or_after_09:00",
    requireCloseAtOrAboveDayOpen: true,
    confirmationBars: 1,
    confirmationFailureTransition: "same_candle_fall_through_and_redetect",
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
    slPct: 0.8,
    tpPct: 0.5,
    maxHoldingMinutes: 20,
    maxHoldingExit: "elapsed_boundary_completed_candle_close",
    sameMinuteTpSlPriority: "stop_loss_first",
    genericSignalExit: false,
    boardEntryFilter: false,
    boardEarlyExit: false,
  }),
});

export const SOCIONEXT_CONFIRMED_LONG_REASON_PREFIX = "ソシオネクスト確認型LONG";

export function evaluateSocionextConfirmedLongOrderApproval(input: {
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "socionext_confirmed_long_live_not_approved" } {
  const isStrategyEntry = input.instructionType === "entry"
    && input.reason.startsWith(SOCIONEXT_CONFIRMED_LONG_REASON_PREFIX);
  if (!isStrategyEntry || input.isDryRun || SOCIONEXT_CONFIRMED_LONG_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "socionext_confirmed_long_live_not_approved" };
}

export interface SocionextConfirmedLongCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SocionextConfirmedLongMetrics {
  closeBreaksHigh: boolean;
  bullishCandle: boolean;
  atOrAboveDayOpen: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  openMovePct: number;
  eligible: boolean;
}

export interface SocionextConfirmedLongPending {
  triggerClose: number;
  triggerTime: string;
  triggerMaSlope2Pct: number;
  triggerVolumeRatio: number;
  triggerOpenMovePct: number;
}

export type SocionextConfirmedLongRejectionCode = "confirm_price";

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isSocionextConfirmedLongInitialTriggerTime(time: string): boolean {
  const spec = SOCIONEXT_CONFIRMED_LONG_SPEC.primary;
  return time >= spec.startTime && time <= spec.initialTriggerEndTime;
}

export function isSocionextConfirmedLongConfirmationTime(time: string): boolean {
  const spec = SOCIONEXT_CONFIRMED_LONG_SPEC.primary;
  return time > spec.startTime && time <= spec.confirmationEndTime;
}

export function getSocionextConfirmedLongDayOpen(
  candles: readonly SocionextConfirmedLongCandle[],
): number | null {
  return candles.find(candle => candle.time >= "09:00")?.open ?? null;
}

export function calculateSocionextConfirmedLongMetrics(
  buffer: readonly SocionextConfirmedLongCandle[],
  dayOpen: number,
): SocionextConfirmedLongMetrics | null {
  const spec = SOCIONEXT_CONFIRMED_LONG_SPEC.primary;
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
  const bullishCandle = candle.close > candle.open;
  const atOrAboveDayOpen = candle.close >= dayOpen;
  const openMovePct = (candle.close - dayOpen) / dayOpen * 100;
  const eligible = bullishCandle
    && atOrAboveDayOpen
    && closeBreaksHigh
    && maSlope2Pct >= spec.minMaSlopePct
    && volumeRatio >= spec.minVolumeRatio;

  return {
    closeBreaksHigh,
    bullishCandle,
    atOrAboveDayOpen,
    maSlope2Pct,
    volumeRatio,
    openMovePct,
    eligible,
  };
}

export function evaluateSocionextConfirmedLongConfirmation(input: {
  pending: SocionextConfirmedLongPending;
  candle: SocionextConfirmedLongCandle;
}): { allowed: true } | { allowed: false; codes: SocionextConfirmedLongRejectionCode[] } {
  if (input.candle.close > input.pending.triggerClose) return { allowed: true };
  return { allowed: false, codes: ["confirm_price"] };
}
