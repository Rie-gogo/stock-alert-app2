/**
 * 8035（東京エレクトロン）始値方向付き短期ブレイクのDRY_RUN専用仕様。
 * 保存KABUステーション1分足だけで再監査できるよう、入口判定を純粋関数として分離する。
 */
export const TEL_OPEN_DIRECTION_BREAKOUT_SPEC = Object.freeze({
  symbol: "8035",
  dryRunEnabled: true,
  liveOrderApproved: false,
  primary: Object.freeze({
    startTime: "10:00",
    endTime: "10:30",
    fallbackStartTime: "10:31",
    lookback: 5,
    maPeriod: 8,
    minVolumeRatio: 1.0,
    minOpenDirectionPct: 0.25,
    slPct: 0.6,
    tpPct: 1.2,
    maxHoldingMinutes: 20,
    boardEarlyExit: false,
    nextCandleConfirmation: false,
    engineRejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    dailySlotConsumedOn: "successful_entry_only",
  }),
  fallback: Object.freeze({
    trendLongSlPct: 0.7,
    trendLongTpPct: 1.4,
    trendShortSlPct: 0.6,
    trendShortTpPct: 1.8,
    peakReversalShortEnabled: false,
    maxHoldingMinutes: 22,
  }),
});

export const TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX = "東京エレクトロン短期ブレイク";

export function evaluateTelOpenDirectionBreakoutOrderApproval(input: {
  symbol: string;
  reason: string;
  instructionType: "entry" | "exit" | "force_close";
  isDryRun: boolean;
}): { allowed: true } | { allowed: false; code: "tel_open_direction_breakout_live_not_approved" } {
  const isStrategyEntry = input.symbol === TEL_OPEN_DIRECTION_BREAKOUT_SPEC.symbol
    && input.instructionType === "entry"
    && input.reason.startsWith(TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX);
  if (!isStrategyEntry || input.isDryRun || TEL_OPEN_DIRECTION_BREAKOUT_SPEC.liveOrderApproved) {
    return { allowed: true };
  }
  return { allowed: false, code: "tel_open_direction_breakout_live_not_approved" };
}

export interface TelOpenDirectionBreakoutCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TelOpenDirectionBreakoutMetrics {
  closeBreaksHigh: boolean;
  closeBreaksLow: boolean;
  maSlope2Pct: number;
  volumeRatio: number;
  openGainPct: number;
  longEligible: boolean;
  shortEligible: boolean;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isTelOpenDirectionBreakoutEntryTime(time: string): boolean {
  const spec = TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary;
  return time >= spec.startTime && time <= spec.endTime;
}

export function calculateTelOpenDirectionBreakoutMetrics(
  buffer: readonly TelOpenDirectionBreakoutCandle[],
): TelOpenDirectionBreakoutMetrics | null {
  const spec = TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary;
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
  const openGainPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  const closeBreaksHigh = candle.close > Math.max(...previousBars.map(item => item.high));
  const closeBreaksLow = candle.close < Math.min(...previousBars.map(item => item.low));
  const longEligible = candle.close > candle.open
    && closeBreaksHigh
    && maSlope2Pct > 0
    && volumeRatio >= spec.minVolumeRatio
    && openGainPct >= spec.minOpenDirectionPct;
  const shortEligible = candle.close < candle.open
    && closeBreaksLow
    && maSlope2Pct < 0
    && volumeRatio >= spec.minVolumeRatio
    && openGainPct <= -spec.minOpenDirectionPct;

  return {
    closeBreaksHigh,
    closeBreaksLow,
    maSlope2Pct,
    volumeRatio,
    openGainPct,
    longEligible,
    shortEligible,
  };
}
