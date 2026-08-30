/**
 * 9984（ソフトバンクグループ）前場10本高値更新LONGのDRY_RUN専用仕様。
 *
 * 保存KABUステーション1分足だけで再監査できるよう、入口判定を純粋関数として分離する。
 * LIVE新規注文は承認されていない。
 */
export const SOFTBANK_BREAKOUT_LONG_SPEC = Object.freeze({
  symbol: "9984",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "09:40",
    endTime: "10:30",
    lookback: 10,
    maPeriod: 8,
    minMaSlopePct: 0.02,
    minVolumeRatio: 1.2,
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
    slPct: 0.8,
    tpPct: 0.3,
    maxHoldingMinutes: 45,
    maxHoldingExit: "elapsed_boundary_completed_candle_close",
    sameMinuteTpSlPriority: "stop_loss_first",
    genericSignalExit: false,
    boardEntryFilter: false,
    boardEarlyExit: false,
    nextCandleConfirmation: false,
  }),
});

export const SOFTBANK_BREAKOUT_LONG_REASON_PREFIX = "ソフトバンクG専用10本高値更新LONG";

export function evaluateSoftbankBreakoutLongOrderApproval(input: {
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "softbank_breakout_long_live_not_approved" } {
  const isStrategyEntry = input.instructionType === "entry"
    && input.reason.startsWith(SOFTBANK_BREAKOUT_LONG_REASON_PREFIX);
  if (!isStrategyEntry || input.isDryRun || SOFTBANK_BREAKOUT_LONG_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "softbank_breakout_long_live_not_approved" };
}

export interface SoftbankBreakoutLongCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SoftbankBreakoutLongMetrics {
  closeBreaksHigh: boolean;
  bullishCandle: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  eligible: boolean;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isSoftbankBreakoutLongEntryTime(time: string): boolean {
  const spec = SOFTBANK_BREAKOUT_LONG_SPEC.primary;
  return time >= spec.startTime && time <= spec.endTime;
}

export function calculateSoftbankBreakoutLongMetrics(
  buffer: readonly SoftbankBreakoutLongCandle[],
): SoftbankBreakoutLongMetrics | null {
  const spec = SOFTBANK_BREAKOUT_LONG_SPEC.primary;
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
  const closeBreaksHigh = candle.close > Math.max(...previousBars.map(item => item.high));
  const bullishCandle = candle.close > candle.open;
  const eligible = bullishCandle
    && closeBreaksHigh
    && maSlope2Pct >= spec.minMaSlopePct
    && volumeRatio >= spec.minVolumeRatio;

  return {
    closeBreaksHigh,
    bullishCandle,
    maSlope2Pct,
    volumeRatio,
    eligible,
  };
}
