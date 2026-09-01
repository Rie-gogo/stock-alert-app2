/**
 * 285A（キオクシア）確認型前場10本高値更新LONGのDRY_RUN専用仕様。
 *
 * 保存KABUステーション1分足だけで再監査できるよう、入口判定を純粋関数として分離する。
 * LIVE新規注文は承認されていない。
 */
export const KIOXIA_CONFIRMED_MORNING_LONG_SPEC = Object.freeze({
  symbol: "285A",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "09:45",
    endTime: "11:20",
    lookback: 10,
    maPeriod: 8,
    minBodyPct: 0.2,
    minMaSlopePct: 0,
    minVolumeRatio: 1.2,
    minOpenGainPct: 0.5,
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingExit: "existing_am_forced_close",
    sameMinuteTpSlPriority: "stop_loss_first",
    genericSignalExit: true,
    boardEntryFilter: false,
    boardEarlyExit: true,
    nextCandleConfirmation: false,
  }),
});

export const KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX = "キオクシア確認型前場LONG";

export function evaluateKioxiaConfirmedMorningLongOrderApproval(input: {
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "kioxia_confirmed_morning_long_live_not_approved" } {
  const isStrategyEntry = input.instructionType === "entry"
    && input.reason.startsWith(KIOXIA_CONFIRMED_MORNING_LONG_REASON_PREFIX);
  if (!isStrategyEntry || input.isDryRun || KIOXIA_CONFIRMED_MORNING_LONG_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "kioxia_confirmed_morning_long_live_not_approved" };
}

export interface KioxiaConfirmedMorningLongCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KioxiaConfirmedMorningLongMetrics {
  closeBreaksHigh: boolean;
  bodyPct: number;
  maSlope2Pct: number;
  volumeRatio: number;
  openGainPct: number;
  eligible: boolean;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isKioxiaConfirmedMorningLongEntryTime(time: string): boolean {
  const spec = KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary;
  return time >= spec.startTime && time <= spec.endTime;
}

export function calculateKioxiaConfirmedMorningLongMetrics(
  buffer: readonly KioxiaConfirmedMorningLongCandle[],
): KioxiaConfirmedMorningLongMetrics | null {
  const spec = KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary;
  const requiredBars = Math.max(21, spec.lookback + 1, spec.maPeriod + 2);
  if (buffer.length < requiredBars) return null;

  const candle = buffer[buffer.length - 1];
  const dayOpen = buffer[0]?.open ?? candle.open;
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
  const bodyPct = candle.open > 0 ? (candle.close - candle.open) / candle.open * 100 : 0;
  const openGainPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  const eligible = closeBreaksHigh
    && bodyPct >= spec.minBodyPct
    && maSlope2Pct >= spec.minMaSlopePct
    && volumeRatio >= spec.minVolumeRatio
    && openGainPct >= spec.minOpenGainPct;

  return { closeBreaksHigh, bodyPct, maSlope2Pct, volumeRatio, openGainPct, eligible };
}
