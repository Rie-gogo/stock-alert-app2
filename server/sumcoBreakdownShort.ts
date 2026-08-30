/**
 * 3436（SUMCO）前場15本安値更新SHORTのDRY_RUN専用仕様。
 *
 * 保存KABUステーション1分足だけで再監査できるよう、入口判定を純粋関数として分離する。
 * LIVE新規注文は承認されていない。
 */
export const SUMCO_BREAKDOWN_SHORT_SPEC = Object.freeze({
  symbol: "3436",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "09:30",
    endTime: "11:00",
    lookback: 15,
    maPeriod: 8,
    maxMaSlopePct: -0.05,
    minVolumeRatio: 1.0,
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
    slPct: 0.8,
    tpPct: 0.7,
    maxHoldingMinutes: 30,
    maxHoldingExit: "elapsed_boundary_completed_candle_close",
    sameMinuteTpSlPriority: "stop_loss_first",
    genericSignalExit: false,
    boardEntryFilter: false,
    boardEarlyExit: false,
  }),
});

export const SUMCO_BREAKDOWN_SHORT_REASON_PREFIX = "SUMCO専用15本安値更新SHORT";

export function evaluateSumcoBreakdownShortOrderApproval(input: {
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "sumco_breakdown_short_live_not_approved" } {
  const isStrategyEntry = input.instructionType === "entry"
    && input.reason.startsWith(SUMCO_BREAKDOWN_SHORT_REASON_PREFIX);
  if (!isStrategyEntry || input.isDryRun || SUMCO_BREAKDOWN_SHORT_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "sumco_breakdown_short_live_not_approved" };
}

export interface SumcoBreakdownShortCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SumcoBreakdownShortMetrics {
  closeBreaksLow: boolean;
  bearishCandle: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  eligible: boolean;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isSumcoBreakdownShortEntryTime(time: string): boolean {
  const spec = SUMCO_BREAKDOWN_SHORT_SPEC.primary;
  return time >= spec.startTime && time <= spec.endTime;
}

export function calculateSumcoBreakdownShortMetrics(
  buffer: readonly SumcoBreakdownShortCandle[],
): SumcoBreakdownShortMetrics | null {
  const spec = SUMCO_BREAKDOWN_SHORT_SPEC.primary;
  const requiredBars = Math.max(21, spec.lookback + 1, spec.maPeriod + 2);
  if (buffer.length < requiredBars) return null;

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
  const closeBreaksLow = candle.close < Math.min(...previousBars.map(item => item.low));
  const bearishCandle = candle.close < candle.open;
  const eligible = bearishCandle
    && closeBreaksLow
    && maSlope2Pct <= spec.maxMaSlopePct
    && volumeRatio >= spec.minVolumeRatio;

  return {
    closeBreaksLow,
    bearishCandle,
    maSlope2Pct,
    volumeRatio,
    eligible,
  };
}
