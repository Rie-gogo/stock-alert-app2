import { describe, expect, it } from "vitest";
import {
  buildTechnicalAnalysisSnapshot,
  calculateTechnicalIndicators,
  DEFAULT_TECHNICAL_ANALYSIS_CONFIG,
  TECHNICAL_ANALYSIS_SHADOW_VERSION,
  type TechnicalAnalysisCandle,
} from "./technicalAnalysisShadowV2";

function candles(count: number, direction: 1 | -1 | 0 = 1): TechnicalAnalysisCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + direction * index * 0.2;
    return { time: `t${index}`, open: close - direction * 0.08, high: close + 0.25, low: close - 0.25, close, volume: 100 + index };
  });
}

const upContext = {
  trend: "up" as const,
  priorHigh: 110,
  priorLow: 95,
  priorClose: 105,
  atrPrice: 1,
  bollingerMiddle: 104,
  bollingerUpper: 112,
  bollingerLower: 96,
};

describe("technical analysis shadow v2", () => {
  it("calculates the configured SMA/MACD/ATR/RSI/Stochastic/RCI/Bollinger/volume set", () => {
    const result = calculateTechnicalIndicators(candles(80), DEFAULT_TECHNICAL_ANALYSIS_CONFIG);
    expect(result).toMatchObject({ availableBars: 80 });
    for (const key of ["sma5", "sma21", "sma50", "ema12", "ema26", "macd", "macdSignal", "macdHistogram", "atr14", "rsi14", "stochasticK", "stochasticD", "rciShort", "rciMedium", "rciLong", "bollingerMiddle", "volumeAverage20", "volumeRatio20"] as const) {
      expect(result[key], key).not.toBeNull();
    }
  });

  it("does not read a nonexistent previous candle at the start of a session", () => {
    const result = buildTechnicalAnalysisSnapshot({
      oneMinuteCandles: candles(1),
      fiveMinuteCandles: [],
      dailyContext: upContext,
    });
    expect(result.volume.crashReboundCandidate).toBe(false);
  });

  it("keeps 1m/5m/daily states separate and lowers agreement when they conflict", () => {
    const result = buildTechnicalAnalysisSnapshot({ oneMinuteCandles: candles(80, 1), fiveMinuteCandles: candles(60, -1), dailyContext: upContext });
    expect(result.version).toBe(TECHNICAL_ANALYSIS_SHADOW_VERSION);
    expect(result.timeframes.oneMinute.state).toBe("up");
    expect(result.timeframes.fiveMinute.state).toBe("down");
    expect(result.timeframes.daily.state).toBe("up");
    expect(result.timeframeAgreement).toBe("mixed");
    expect(result.combinedState).toBe("hold");
  });

  it("records met and unmet conditions; MACD-only and pattern signals stay display-only", () => {
    const result = buildTechnicalAnalysisSnapshot({ oneMinuteCandles: candles(80, 1), fiveMinuteCandles: candles(60, 1), dailyContext: upContext });
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.every(signal => Array.isArray(signal.metConditions) && Array.isArray(signal.unmetConditions))).toBe(true);
    expect(result.signals.filter(signal => signal.type === "macd_turn" || signal.type === "pattern_candidate").every(signal => signal.executableInShadow === false)).toBe(true);
    expect(result.diagnostics).toContain("confidence_is_condition_completeness_not_predicted_win_rate");
  });

  it("does not change an earlier snapshot when future candles are appended", () => {
    const known = candles(70, 1);
    const before = buildTechnicalAnalysisSnapshot({ oneMinuteCandles: known, fiveMinuteCandles: candles(40, 1), dailyContext: upContext });
    const future = [...known, ...candles(5, -1).map((item, index) => ({ ...item, time: `future${index}` }))];
    buildTechnicalAnalysisSnapshot({ oneMinuteCandles: future, fiveMinuteCandles: candles(45, -1), dailyContext: upContext });
    const repeated = buildTechnicalAnalysisSnapshot({ oneMinuteCandles: known, fiveMinuteCandles: candles(40, 1), dailyContext: upContext });
    expect(repeated).toEqual(before);
  });
});
