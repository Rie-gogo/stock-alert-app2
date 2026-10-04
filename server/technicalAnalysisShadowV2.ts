export const TECHNICAL_ANALYSIS_SHADOW_VERSION = "technical-analysis-shadow-v2";

export type TechnicalAnalysisSide = "long" | "short";
export type TechnicalTimeframe = "one_minute" | "five_minute" | "daily";
export type TechnicalTrendState = "up" | "down" | "range" | "hold" | "unavailable";
export type TechnicalSignalType =
  | "trend_pullback"
  | "trend_retracement"
  | "ma21_turn"
  | "support_resistance_breakout"
  | "macd_turn"
  | "range_reversal"
  | "pattern_candidate";

export interface TechnicalAnalysisCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalAnalysisConfig {
  smaPeriods: readonly [number, number, number];
  emaFast: number;
  emaSlow: number;
  macdSignal: number;
  atrPeriod: number;
  volumePeriod: number;
  rsiPeriod: number;
  stochasticPeriod: number;
  stochasticSmoothK: number;
  stochasticSmoothD: number;
  rciPeriods: readonly [number, number, number];
  bollingerPeriod: number;
  bollingerStdDev: number;
  breakoutVolumeRatio: number;
  weakVolumeRatio: number;
  supportResistanceLookback: number;
  pivotWidth: number;
  volumeProfileBins: number;
  atrStopMultiplier: number;
}

export const DEFAULT_TECHNICAL_ANALYSIS_CONFIG: TechnicalAnalysisConfig = Object.freeze({
  smaPeriods: [5, 21, 50] as const,
  emaFast: 12,
  emaSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  volumePeriod: 20,
  rsiPeriod: 14,
  stochasticPeriod: 14,
  stochasticSmoothK: 3,
  stochasticSmoothD: 3,
  rciPeriods: [9, 26, 52] as const,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  breakoutVolumeRatio: 1.2,
  weakVolumeRatio: 0.7,
  supportResistanceLookback: 50,
  pivotWidth: 2,
  volumeProfileBins: 20,
  atrStopMultiplier: 1,
});

export interface TechnicalIndicatorSet {
  availableBars: number;
  close: number | null;
  sma5: number | null;
  sma21: number | null;
  sma50: number | null;
  sma21SlopePct: number | null;
  ema12: number | null;
  ema26: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  previousMacd: number | null;
  previousMacdSignal: number | null;
  previousMacdHistogram: number | null;
  atr14: number | null;
  rsi14: number | null;
  stochasticK: number | null;
  stochasticD: number | null;
  rciShort: number | null;
  rciMedium: number | null;
  rciLong: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  bollingerPercentB: number | null;
  bollingerBandwidthPct: number | null;
  volumeAverage20: number | null;
  volumeRatio20: number | null;
}

export interface TechnicalTimeframeState {
  timeframe: TechnicalTimeframe;
  state: TechnicalTrendState;
  reasonCodes: string[];
  indicators: TechnicalIndicatorSet;
}

export interface TechnicalLevel {
  price: number;
  touches: number;
  source: "pivot" | "prior_day" | "volume_profile";
}

export interface TechnicalPatternCandidate {
  type: "double_top" | "double_bottom" | "triangle" | "wedge" | "flag" | "box";
  direction: TechnicalAnalysisSide | "neutral";
  status: "candidate" | "confirmed";
  displayOnly: true;
  evidence: string[];
  referencePrice: number | null;
}

export interface TechnicalCondition {
  code: string;
  label: string;
  met: boolean;
  value?: unknown;
}

export interface TechnicalSignalCandidate {
  id: string;
  timeframe: "one_minute";
  side: TechnicalAnalysisSide;
  type: TechnicalSignalType;
  status: "candidate" | "confirmed" | "cancelled";
  executableInShadow: boolean;
  marketState: TechnicalTrendState;
  metConditions: TechnicalCondition[];
  unmetConditions: TechnicalCondition[];
  evidence: string[];
  confidenceCompleteness: number;
  entryCandidate: number | null;
  stopCandidate: number | null;
  targetCandidates: number[];
  cancelReason: string | null;
}

export interface TechnicalVolumeAnalysis {
  average20: number | null;
  ratio20: number | null;
  breakoutExpansion: boolean;
  rapidMove: boolean;
  crashReboundCandidate: boolean;
  highVolumePriceZones: number[];
  lowVolumePriceZones: number[];
  profileApproximation: "typical_price_bins";
}

export interface TechnicalAnalysisSnapshotV2 {
  version: typeof TECHNICAL_ANALYSIS_SHADOW_VERSION;
  asOfTime: string | null;
  timeframes: {
    oneMinute: TechnicalTimeframeState;
    fiveMinute: TechnicalTimeframeState;
    daily: TechnicalTimeframeState;
  };
  combinedState: TechnicalTrendState;
  timeframeAgreement: "aligned" | "mixed" | "unavailable";
  supports: TechnicalLevel[];
  resistances: TechnicalLevel[];
  patterns: TechnicalPatternCandidate[];
  volume: TechnicalVolumeAnalysis;
  signals: TechnicalSignalCandidate[];
  selectedExecutableSignalId: string | null;
  diagnostics: string[];
}

export interface TechnicalDailyContext {
  trend: "up" | "down" | "range" | "unknown";
  priorHigh: number | null;
  priorLow: number | null;
  priorClose: number | null;
  atrPrice: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  sma5?: number | null;
  sma21?: number | null;
  sma50?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  rsi14?: number | null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function smaSeries(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

function emaSeries(values: number[], period: number): Array<number | null> {
  if (!values.length) return [];
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = average(values.slice(0, period))!;
  output[period - 1] = value;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    value = (values[index] - value) * multiplier + value;
    output[index] = value;
  }
  return output;
}

function emaNullableSeries(values: Array<number | null>, period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  const first = values.findIndex(value => value !== null);
  if (first < 0) return output;
  const available = values.slice(first).filter((value): value is number => value !== null);
  const calculated = emaSeries(available, period);
  for (let index = 0; index < calculated.length; index += 1) output[first + index] = calculated[index];
  return output;
}

function trueRangeSeries(candles: TechnicalAnalysisCandle[]): number[] {
  return candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)));
}

function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;
  const changes = values.slice(-(period + 1)).slice(1).map((value, index) => value - values.slice(-(period + 1))[index]);
  const gains = changes.map(value => Math.max(0, value));
  const losses = changes.map(value => Math.max(0, -value));
  const avgGain = average(gains) ?? 0;
  const avgLoss = average(losses) ?? 0;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function rank(values: number[]) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length).fill(0) as number[];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) ranks[sorted[index].index] = averageRank;
    start = end;
  }
  return ranks;
}

function rci(values: number[], period: number): number | null {
  if (values.length < period || period < 2) return null;
  const window = values.slice(-period);
  const priceRanks = rank(window);
  const timeRanks = window.map((_, index) => index + 1);
  const squared = priceRanks.reduce((sum, value, index) => sum + (value - timeRanks[index]) ** 2, 0);
  return (1 - 6 * squared / (period * (period ** 2 - 1))) * 100;
}

function stochastic(candles: TechnicalAnalysisCandle[], config: TechnicalAnalysisConfig) {
  const rawK = candles.map((_, index) => {
    if (index < config.stochasticPeriod - 1) return null;
    const window = candles.slice(index - config.stochasticPeriod + 1, index + 1);
    const high = Math.max(...window.map(item => item.high));
    const low = Math.min(...window.map(item => item.low));
    return high === low ? 50 : (candles[index].close - low) / (high - low) * 100;
  });
  const smooth = (values: Array<number | null>, period: number) => values.map((_, index) => {
    const window = values.slice(Math.max(0, index - period + 1), index + 1).filter((value): value is number => value !== null);
    return window.length === period ? average(window) : null;
  });
  const k = smooth(rawK, config.stochasticSmoothK);
  const d = smooth(k, config.stochasticSmoothD);
  return { k: k.at(-1) ?? null, d: d.at(-1) ?? null };
}

export function calculateTechnicalIndicators(
  candles: TechnicalAnalysisCandle[],
  config: TechnicalAnalysisConfig = DEFAULT_TECHNICAL_ANALYSIS_CONFIG,
): TechnicalIndicatorSet {
  const closes = candles.map(item => item.close);
  const volumes = candles.map(item => item.volume);
  const [shortPeriod, middlePeriod, longPeriod] = config.smaPeriods;
  const sma5Series = smaSeries(closes, shortPeriod);
  const sma21Series = smaSeries(closes, middlePeriod);
  const sma50Series = smaSeries(closes, longPeriod);
  const emaFast = emaSeries(closes, config.emaFast);
  const emaSlow = emaSeries(closes, config.emaSlow);
  const macdSeries = closes.map((_, index) => emaFast[index] !== null && emaSlow[index] !== null ? emaFast[index]! - emaSlow[index]! : null);
  const signalSeries = emaNullableSeries(macdSeries, config.macdSignal);
  const histogram = macdSeries.map((value, index) => value !== null && signalSeries[index] !== null ? value - signalSeries[index]! : null);
  const atrSeries = smaSeries(trueRangeSeries(candles), config.atrPeriod);
  const volumeAverage = smaSeries(volumes, config.volumePeriod).at(-1) ?? null;
  const bollingerValues = closes.slice(-config.bollingerPeriod);
  const bollingerMiddle = bollingerValues.length === config.bollingerPeriod ? average(bollingerValues) : null;
  const variance = bollingerMiddle === null ? null : average(bollingerValues.map(value => (value - bollingerMiddle) ** 2));
  const standardDeviation = variance === null ? null : Math.sqrt(variance);
  const bollingerUpper = bollingerMiddle !== null && standardDeviation !== null ? bollingerMiddle + standardDeviation * config.bollingerStdDev : null;
  const bollingerLower = bollingerMiddle !== null && standardDeviation !== null ? bollingerMiddle - standardDeviation * config.bollingerStdDev : null;
  const close = closes.at(-1) ?? null;
  const stoch = stochastic(candles, config);
  const [rciShort, rciMedium, rciLong] = config.rciPeriods;
  const currentSma21 = sma21Series.at(-1) ?? null;
  const previousSma21 = sma21Series.at(-2) ?? null;
  return {
    availableBars: candles.length,
    close,
    sma5: sma5Series.at(-1) ?? null,
    sma21: currentSma21,
    sma50: sma50Series.at(-1) ?? null,
    sma21SlopePct: currentSma21 !== null && previousSma21 !== null && previousSma21 !== 0 ? (currentSma21 - previousSma21) / previousSma21 * 100 : null,
    ema12: emaFast.at(-1) ?? null,
    ema26: emaSlow.at(-1) ?? null,
    macd: macdSeries.at(-1) ?? null,
    macdSignal: signalSeries.at(-1) ?? null,
    macdHistogram: histogram.at(-1) ?? null,
    previousMacd: macdSeries.at(-2) ?? null,
    previousMacdSignal: signalSeries.at(-2) ?? null,
    previousMacdHistogram: histogram.at(-2) ?? null,
    atr14: atrSeries.at(-1) ?? null,
    rsi14: rsi(closes, config.rsiPeriod),
    stochasticK: stoch.k,
    stochasticD: stoch.d,
    rciShort: rci(closes, rciShort),
    rciMedium: rci(closes, rciMedium),
    rciLong: rci(closes, rciLong),
    bollingerMiddle,
    bollingerUpper,
    bollingerLower,
    bollingerPercentB: close !== null && bollingerUpper !== null && bollingerLower !== null && bollingerUpper > bollingerLower
      ? (close - bollingerLower) / (bollingerUpper - bollingerLower) * 100
      : null,
    bollingerBandwidthPct: bollingerMiddle !== null && standardDeviation !== null && bollingerMiddle !== 0
      ? standardDeviation * config.bollingerStdDev * 2 / bollingerMiddle * 100
      : null,
    volumeAverage20: volumeAverage,
    volumeRatio20: volumeAverage !== null && volumeAverage > 0 ? (volumes.at(-1) ?? 0) / volumeAverage : null,
  };
}

function stateFor(timeframe: TechnicalTimeframe, indicators: TechnicalIndicatorSet): TechnicalTimeframeState {
  const required = [indicators.close, indicators.sma5, indicators.sma21];
  if (required.some(value => value === null)) return { timeframe, state: "unavailable", reasonCodes: ["insufficient_bars_for_sma21"], indicators };
  const close = indicators.close!;
  const slope = indicators.sma21SlopePct ?? 0;
  const bullish = close > indicators.sma21! && indicators.sma5! > indicators.sma21! && slope > 0;
  const bearish = close < indicators.sma21! && indicators.sma5! < indicators.sma21! && slope < 0;
  const compressed = indicators.bollingerBandwidthPct !== null && indicators.bollingerBandwidthPct <= 1;
  const state: TechnicalTrendState = bullish ? "up" : bearish ? "down" : compressed ? "range" : "hold";
  return {
    timeframe,
    state,
    reasonCodes: bullish ? ["close_and_sma5_above_rising_sma21"]
      : bearish ? ["close_and_sma5_below_falling_sma21"]
        : compressed ? ["bollinger_bandwidth_compressed"] : ["price_structure_not_aligned"],
    indicators,
  };
}

function dailyState(context: TechnicalDailyContext): TechnicalTimeframeState {
  const state: TechnicalTrendState = context.trend === "up" || context.trend === "down" || context.trend === "range" ? context.trend : "unavailable";
  return {
    timeframe: "daily",
    state,
    reasonCodes: state === "unavailable" ? ["d_minus_1_daily_state_unavailable"] : ["d_minus_1_daily_state_frozen"],
    indicators: {
      availableBars: 0,
      close: context.priorClose,
      sma5: context.sma5 ?? null,
      sma21: context.sma21 ?? null,
      sma50: context.sma50 ?? null,
      sma21SlopePct: null,
      ema12: null,
      ema26: null,
      macd: context.macd ?? null,
      macdSignal: context.macdSignal ?? null,
      macdHistogram: context.macd !== null && context.macd !== undefined && context.macdSignal !== null && context.macdSignal !== undefined ? context.macd - context.macdSignal : null,
      previousMacd: null,
      previousMacdSignal: null,
      previousMacdHistogram: null,
      atr14: context.atrPrice,
      rsi14: context.rsi14 ?? null,
      stochasticK: null,
      stochasticD: null,
      rciShort: null,
      rciMedium: null,
      rciLong: null,
      bollingerMiddle: context.bollingerMiddle,
      bollingerUpper: context.bollingerUpper,
      bollingerLower: context.bollingerLower,
      bollingerPercentB: null,
      bollingerBandwidthPct: null,
      volumeAverage20: null,
      volumeRatio20: null,
    },
  };
}

function pivots(candles: TechnicalAnalysisCandle[], kind: "high" | "low", width: number) {
  const output: Array<{ price: number; index: number }> = [];
  for (let index = width; index < candles.length - width; index += 1) {
    const value = candles[index][kind];
    const neighbours = candles.slice(index - width, index + width + 1).filter((_, neighbourIndex) => neighbourIndex !== width);
    const pivot = kind === "high" ? neighbours.every(item => value >= item.high) : neighbours.every(item => value <= item.low);
    if (pivot) output.push({ price: value, index });
  }
  return output;
}

function clusterLevels(prices: number[], tolerance: number, source: TechnicalLevel["source"]): TechnicalLevel[] {
  const clusters: Array<{ prices: number[] }> = [];
  for (const price of [...prices].sort((a, b) => a - b)) {
    const cluster = clusters.find(item => Math.abs((average(item.prices) ?? price) - price) <= tolerance);
    if (cluster) cluster.prices.push(price); else clusters.push({ prices: [price] });
  }
  return clusters.map(item => ({ price: average(item.prices)!, touches: item.prices.length, source }));
}

function volumeProfile(candles: TechnicalAnalysisCandle[], bins: number) {
  if (!candles.length) return { high: [] as number[], low: [] as number[] };
  const minimum = Math.min(...candles.map(item => item.low));
  const maximum = Math.max(...candles.map(item => item.high));
  if (maximum <= minimum) return { high: [minimum], low: [minimum] };
  const width = (maximum - minimum) / bins;
  const values = Array(bins).fill(0) as number[];
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const index = Math.min(bins - 1, Math.max(0, Math.floor((typical - minimum) / width)));
    values[index] += candle.volume;
  }
  const centers = values.map((volume, index) => ({ volume, price: minimum + width * (index + 0.5) }));
  return {
    high: [...centers].sort((a, b) => b.volume - a.volume).slice(0, 3).map(item => item.price),
    low: [...centers].filter(item => item.volume > 0).sort((a, b) => a.volume - b.volume).slice(0, 3).map(item => item.price),
  };
}

function detectPatterns(candles: TechnicalAnalysisCandle[], atr: number | null, config: TechnicalAnalysisConfig): TechnicalPatternCandidate[] {
  if (candles.length < 12) return [];
  const highs = pivots(candles, "high", config.pivotWidth);
  const lows = pivots(candles, "low", config.pivotWidth);
  const current = candles.at(-1)!;
  const tolerance = Math.max((atr ?? current.close * 0.005) * 0.35, current.close * 0.001);
  const output: TechnicalPatternCandidate[] = [];
  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  if (recentHighs.length >= 2 && Math.abs(recentHighs.at(-1)!.price - recentHighs.at(-2)!.price) <= tolerance) {
    const neckline = Math.min(...candles.slice(recentHighs.at(-2)!.index, recentHighs.at(-1)!.index + 1).map(item => item.low));
    output.push({ type: "double_top", direction: "short", status: current.close < neckline ? "confirmed" : "candidate", displayOnly: true, evidence: ["two_similar_pivot_highs", current.close < neckline ? "neckline_broken" : "neckline_not_broken"], referencePrice: neckline });
  }
  if (recentLows.length >= 2 && Math.abs(recentLows.at(-1)!.price - recentLows.at(-2)!.price) <= tolerance) {
    const neckline = Math.max(...candles.slice(recentLows.at(-2)!.index, recentLows.at(-1)!.index + 1).map(item => item.high));
    output.push({ type: "double_bottom", direction: "long", status: current.close > neckline ? "confirmed" : "candidate", displayOnly: true, evidence: ["two_similar_pivot_lows", current.close > neckline ? "neckline_broken" : "neckline_not_broken"], referencePrice: neckline });
  }
  if (recentHighs.length >= 3 && recentLows.length >= 3) {
    const descendingHighs = recentHighs[2].price < recentHighs[1].price && recentHighs[1].price < recentHighs[0].price;
    const ascendingLows = recentLows[2].price > recentLows[1].price && recentLows[1].price > recentLows[0].price;
    if (descendingHighs && ascendingLows) {
      const upper = recentHighs.at(-1)!.price;
      const lower = recentLows.at(-1)!.price;
      const direction = current.close > upper ? "long" : current.close < lower ? "short" : "neutral";
      output.push({ type: "triangle", direction, status: direction === "neutral" ? "candidate" : "confirmed", displayOnly: true, evidence: ["descending_pivot_highs", "ascending_pivot_lows"], referencePrice: direction === "short" ? lower : upper });
    }
    const highSlope = recentHighs[2].price - recentHighs[0].price;
    const lowSlope = recentLows[2].price - recentLows[0].price;
    if (Math.sign(highSlope) === Math.sign(lowSlope) && Math.abs(highSlope - lowSlope) > tolerance) {
      output.push({ type: "wedge", direction: highSlope > 0 ? "short" : "long", status: "candidate", displayOnly: true, evidence: ["same_direction_converging_pivots"], referencePrice: null });
    }
  }
  const last20 = candles.slice(-21, -1);
  const range = Math.max(...last20.map(item => item.high)) - Math.min(...last20.map(item => item.low));
  if (atr !== null && range <= atr * 2.2) {
    const upper = Math.max(...last20.map(item => item.high));
    const lower = Math.min(...last20.map(item => item.low));
    output.push({ type: "box", direction: current.close > upper ? "long" : current.close < lower ? "short" : "neutral", status: current.close > upper || current.close < lower ? "confirmed" : "candidate", displayOnly: true, evidence: ["twenty_bar_range_compression"], referencePrice: current.close > upper ? upper : current.close < lower ? lower : null });
  }
  if (candles.length >= 15 && atr !== null) {
    const impulse = candles.at(-6)!.close - candles.at(-15)!.open;
    const consolidation = Math.max(...candles.slice(-5).map(item => item.high)) - Math.min(...candles.slice(-5).map(item => item.low));
    if (Math.abs(impulse) >= atr * 2 && consolidation <= Math.abs(impulse) * 0.5) {
      output.push({ type: "flag", direction: impulse > 0 ? "long" : "short", status: "candidate", displayOnly: true, evidence: ["large_impulse", "small_following_consolidation"], referencePrice: impulse > 0 ? Math.max(...candles.slice(-5).map(item => item.high)) : Math.min(...candles.slice(-5).map(item => item.low)) });
    }
  }
  return output;
}

function condition(code: string, label: string, met: boolean, value?: unknown): TechnicalCondition {
  return { code, label, met, value };
}

function targets(side: TechnicalAnalysisSide, entry: number, risk: number, levels: TechnicalLevel[], context: TechnicalDailyContext) {
  const candidates = side === "long"
    ? [...levels.map(item => item.price), context.priorHigh, context.bollingerMiddle, context.bollingerUpper, entry + risk * 1.2, entry + risk * 2]
    : [...levels.map(item => item.price), context.priorLow, context.bollingerMiddle, context.bollingerLower, entry - risk * 1.2, entry - risk * 2];
  return Array.from(new Set(candidates.map(finite).filter((value): value is number => value !== null)
    .filter(value => side === "long" ? value > entry : value < entry)))
    .sort((a, b) => side === "long" ? a - b : b - a);
}

function makeSignal(input: {
  id: string;
  side: TechnicalAnalysisSide;
  type: TechnicalSignalType;
  marketState: TechnicalTrendState;
  conditions: TechnicalCondition[];
  requiredCodes: string[];
  executable: boolean;
  entry: number | null;
  stop: number | null;
  targetCandidates: number[];
  cancelReason?: string | null;
}): TechnicalSignalCandidate {
  const metConditions = input.conditions.filter(item => item.met);
  const unmetConditions = input.conditions.filter(item => !item.met);
  const required = input.conditions.filter(item => input.requiredCodes.includes(item.code));
  const confirmed = required.length > 0 && required.every(item => item.met) && !input.cancelReason;
  return {
    id: input.id,
    timeframe: "one_minute",
    side: input.side,
    type: input.type,
    status: input.cancelReason ? "cancelled" : confirmed ? "confirmed" : "candidate",
    executableInShadow: input.executable && confirmed,
    marketState: input.marketState,
    metConditions,
    unmetConditions,
    evidence: metConditions.map(item => item.code),
    confidenceCompleteness: input.conditions.length ? metConditions.length / input.conditions.length : 0,
    entryCandidate: input.entry,
    stopCandidate: input.stop,
    targetCandidates: input.targetCandidates,
    cancelReason: input.cancelReason ?? null,
  };
}

function signalCandidates(input: {
  candles: TechnicalAnalysisCandle[];
  one: TechnicalTimeframeState;
  five: TechnicalTimeframeState;
  daily: TechnicalTimeframeState;
  supports: TechnicalLevel[];
  resistances: TechnicalLevel[];
  context: TechnicalDailyContext;
  config: TechnicalAnalysisConfig;
  patterns: TechnicalPatternCandidate[];
}) {
  const { candles, one, five, daily, supports, resistances, context, config } = input;
  if (candles.length < 22) return [];
  const current = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const previousIndicators = calculateTechnicalIndicators(candles.slice(0, -1), config);
  const indicator = one.indicators;
  const atr = indicator.atr14 ?? context.atrPrice ?? current.close * 0.005;
  const volumeOkay = indicator.volumeRatio20 === null || indicator.volumeRatio20 >= config.weakVolumeRatio;
  const volumeBreakout = indicator.volumeRatio20 !== null && indicator.volumeRatio20 >= config.breakoutVolumeRatio;
  const macdUp = indicator.macd !== null && indicator.macdSignal !== null && indicator.macd >= indicator.macdSignal && (indicator.macdHistogram ?? -Infinity) >= (indicator.previousMacdHistogram ?? -Infinity);
  const macdDown = indicator.macd !== null && indicator.macdSignal !== null && indicator.macd <= indicator.macdSignal && (indicator.macdHistogram ?? Infinity) <= (indicator.previousMacdHistogram ?? Infinity);
  const bullishCandle = current.close > current.open;
  const bearishCandle = current.close < current.open;
  const sma21 = indicator.sma21;
  const previousSma21 = previousIndicators.sma21;
  const nearestSupport = [...supports].filter(item => item.price < current.close).sort((a, b) => b.price - a.price)[0]?.price ?? context.priorLow;
  const nearestResistance = [...resistances].filter(item => item.price > current.close).sort((a, b) => a.price - b.price)[0]?.price ?? context.priorHigh;
  const swingLow = Math.min(...candles.slice(-8).map(item => item.low));
  const swingHigh = Math.max(...candles.slice(-8).map(item => item.high));
  const longStop = Math.min(swingLow, nearestSupport ?? swingLow, current.close - atr * config.atrStopMultiplier);
  const shortStop = Math.max(swingHigh, nearestResistance ?? swingHigh, current.close + atr * config.atrStopMultiplier);
  const longRisk = Math.max(current.close - longStop, atr * 0.1);
  const shortRisk = Math.max(shortStop - current.close, atr * 0.1);
  const longTargets = targets("long", current.close, longRisk, resistances, context);
  const shortTargets = targets("short", current.close, shortRisk, supports, context);
  const higherLong = daily.state === "up" || five.state === "up";
  const higherShort = daily.state === "down" || five.state === "down";
  const disagreementLong = daily.state === "down" && five.state === "down";
  const disagreementShort = daily.state === "up" && five.state === "up";
  const nearSma21 = sma21 !== null && current.low <= sma21 + atr * 0.15 && current.high >= sma21 - atr * 0.15;
  const crossedUp = sma21 !== null && previousSma21 !== null && previous.close <= previousSma21 && current.close > sma21;
  const crossedDown = sma21 !== null && previousSma21 !== null && previous.close >= previousSma21 && current.close < sma21;
  const resistance = context.priorHigh ?? resistances[0]?.price ?? null;
  const support = context.priorLow ?? supports[0]?.price ?? null;
  const previousAboveResistance = resistance !== null && previous.close > resistance;
  const previousBelowSupport = support !== null && previous.close < support;
  const breakoutLong = resistance !== null && current.close > resistance;
  const breakoutShort = support !== null && current.close < support;
  const longRetest = resistance !== null && previousAboveResistance && current.low <= resistance + atr * 0.15 && current.close > resistance;
  const shortRetest = support !== null && previousBelowSupport && current.high >= support - atr * 0.15 && current.close < support;
  const signals: TechnicalSignalCandidate[] = [];

  signals.push(makeSignal({
    id: `trend_pullback_long:${current.time}`, side: "long", type: "trend_pullback", marketState: one.state,
    conditions: [
      condition("higher_timeframe_up", "上位足が上昇方向", higherLong, { daily: daily.state, fiveMinute: five.state }),
      condition("sma21_pullback_touch", "SMA21付近まで押した", nearSma21, { sma21, low: current.low }),
      condition("sma21_reclaimed", "終値でSMA21を回復", sma21 !== null && current.close > sma21, { close: current.close, sma21 }),
      condition("bullish_confirmation_candle", "反発陽線が確定", bullishCandle),
      condition("macd_supports_long", "MACDが上向き", macdUp, { macd: indicator.macd, signal: indicator.macdSignal }),
      condition("volume_not_weak", "出来高が極端に弱くない", volumeOkay, indicator.volumeRatio20),
      condition("higher_timeframe_not_bearish", "日足と5分足がともに下降ではない", !disagreementLong),
    ],
    requiredCodes: ["higher_timeframe_up", "sma21_pullback_touch", "sma21_reclaimed", "bullish_confirmation_candle", "volume_not_weak", "higher_timeframe_not_bearish"],
    executable: true, entry: current.close, stop: longStop, targetCandidates: longTargets,
  }));
  signals.push(makeSignal({
    id: `trend_retracement_short:${current.time}`, side: "short", type: "trend_retracement", marketState: one.state,
    conditions: [
      condition("higher_timeframe_down", "上位足が下降方向", higherShort, { daily: daily.state, fiveMinute: five.state }),
      condition("sma21_retracement_touch", "SMA21付近まで戻した", nearSma21, { sma21, high: current.high }),
      condition("sma21_rejected", "終値でSMA21の下へ戻った", sma21 !== null && current.close < sma21, { close: current.close, sma21 }),
      condition("bearish_confirmation_candle", "反落陰線が確定", bearishCandle),
      condition("macd_supports_short", "MACDが下向き", macdDown, { macd: indicator.macd, signal: indicator.macdSignal }),
      condition("volume_not_weak", "出来高が極端に弱くない", volumeOkay, indicator.volumeRatio20),
      condition("higher_timeframe_not_bullish", "日足と5分足がともに上昇ではない", !disagreementShort),
    ],
    requiredCodes: ["higher_timeframe_down", "sma21_retracement_touch", "sma21_rejected", "bearish_confirmation_candle", "volume_not_weak", "higher_timeframe_not_bullish"],
    executable: true, entry: current.close, stop: shortStop, targetCandidates: shortTargets,
  }));
  signals.push(makeSignal({
    id: `ma21_turn_long:${current.time}`, side: "long", type: "ma21_turn", marketState: one.state,
    conditions: [
      condition("price_crossed_sma21_up", "価格がSMA21を上抜いた", crossedUp),
      condition("sma21_flat_or_rising", "SMA21が横ばいまたは上向き", (indicator.sma21SlopePct ?? -Infinity) >= 0, indicator.sma21SlopePct),
      condition("macd_cross_or_rising", "MACDが上向き", macdUp),
      condition("recent_high_confirmed", "直近高値を更新または上で維持", current.close >= Math.max(...candles.slice(-6, -1).map(item => item.high))),
      condition("daily_not_down", "日足が明確な下降ではない", daily.state !== "down"),
    ],
    requiredCodes: ["price_crossed_sma21_up", "sma21_flat_or_rising", "macd_cross_or_rising", "recent_high_confirmed", "daily_not_down"],
    executable: true, entry: current.close, stop: longStop, targetCandidates: longTargets,
  }));
  signals.push(makeSignal({
    id: `ma21_turn_short:${current.time}`, side: "short", type: "ma21_turn", marketState: one.state,
    conditions: [
      condition("price_crossed_sma21_down", "価格がSMA21を下抜いた", crossedDown),
      condition("sma21_flat_or_falling", "SMA21が横ばいまたは下向き", (indicator.sma21SlopePct ?? Infinity) <= 0, indicator.sma21SlopePct),
      condition("macd_cross_or_falling", "MACDが下向き", macdDown),
      condition("recent_low_confirmed", "直近安値を更新または下で維持", current.close <= Math.min(...candles.slice(-6, -1).map(item => item.low))),
      condition("daily_not_up", "日足が明確な上昇ではない", daily.state !== "up"),
    ],
    requiredCodes: ["price_crossed_sma21_down", "sma21_flat_or_falling", "macd_cross_or_falling", "recent_low_confirmed", "daily_not_up"],
    executable: true, entry: current.close, stop: shortStop, targetCandidates: shortTargets,
  }));
  signals.push(makeSignal({
    id: `breakout_long:${current.time}`, side: "long", type: "support_resistance_breakout", marketState: one.state,
    conditions: [
      condition("resistance_close_break", "終値で抵抗線を上抜いた", breakoutLong, { resistance }),
      condition("breakout_volume_expansion", "出来高が20本平均を上回った", volumeBreakout, indicator.volumeRatio20),
      condition("breakout_hold_or_retest", "上抜け維持または再確認反発", longRetest || (previousAboveResistance && breakoutLong)),
      condition("not_daily_down", "日足が下降ではない", daily.state !== "down"),
    ],
    requiredCodes: ["resistance_close_break", "breakout_volume_expansion", "breakout_hold_or_retest", "not_daily_down"],
    executable: true, entry: current.close, stop: resistance === null ? longStop : Math.min(longStop, resistance - atr * 0.1), targetCandidates: longTargets,
    cancelReason: previousAboveResistance && resistance !== null && current.close < resistance ? "false_break_returned_inside_resistance" : null,
  }));
  signals.push(makeSignal({
    id: `breakout_short:${current.time}`, side: "short", type: "support_resistance_breakout", marketState: one.state,
    conditions: [
      condition("support_close_break", "終値で支持線を下抜いた", breakoutShort, { support }),
      condition("breakout_volume_expansion", "出来高が20本平均を上回った", volumeBreakout, indicator.volumeRatio20),
      condition("breakout_hold_or_retest", "下抜け維持または再確認反落", shortRetest || (previousBelowSupport && breakoutShort)),
      condition("not_daily_up", "日足が上昇ではない", daily.state !== "up"),
    ],
    requiredCodes: ["support_close_break", "breakout_volume_expansion", "breakout_hold_or_retest", "not_daily_up"],
    executable: true, entry: current.close, stop: support === null ? shortStop : Math.max(shortStop, support + atr * 0.1), targetCandidates: shortTargets,
    cancelReason: previousBelowSupport && support !== null && current.close > support ? "false_break_returned_inside_support" : null,
  }));
  const nearSupport = nearestSupport !== null && nearestSupport !== undefined && current.low <= nearestSupport + atr * 0.2 && current.close > nearestSupport;
  const nearResistance = nearestResistance !== null && nearestResistance !== undefined && current.high >= nearestResistance - atr * 0.2 && current.close < nearestResistance;
  signals.push(makeSignal({
    id: `range_reversal_long:${current.time}`, side: "long", type: "range_reversal", marketState: one.state,
    conditions: [condition("range_state", "レンジ状態", one.state === "range" || five.state === "range"), condition("support_reaction", "支持線付近で反発", nearSupport), condition("bullish_candle", "陽線確定", bullishCandle), condition("oscillator_not_overbought", "RSIまたはストキャスが買われ過ぎではない", (indicator.rsi14 ?? 50) <= 55 || (indicator.stochasticK ?? 50) <= 35)],
    requiredCodes: ["range_state", "support_reaction", "bullish_candle"], executable: true, entry: current.close, stop: longStop, targetCandidates: longTargets,
  }));
  signals.push(makeSignal({
    id: `range_reversal_short:${current.time}`, side: "short", type: "range_reversal", marketState: one.state,
    conditions: [condition("range_state", "レンジ状態", one.state === "range" || five.state === "range"), condition("resistance_reaction", "抵抗線付近で反落", nearResistance), condition("bearish_candle", "陰線確定", bearishCandle), condition("oscillator_not_oversold", "RSIまたはストキャスが売られ過ぎではない", (indicator.rsi14 ?? 50) >= 45 || (indicator.stochasticK ?? 50) >= 65)],
    requiredCodes: ["range_state", "resistance_reaction", "bearish_candle"], executable: true, entry: current.close, stop: shortStop, targetCandidates: shortTargets,
  }));
  signals.push(makeSignal({
    id: `macd_turn_long:${current.time}`, side: "long", type: "macd_turn", marketState: one.state,
    conditions: [condition("macd_bullish_cross", "MACDがシグナルを上抜いた", indicator.previousMacd !== null && indicator.previousMacdSignal !== null && indicator.macd !== null && indicator.macdSignal !== null && indicator.previousMacd <= indicator.previousMacdSignal && indicator.macd > indicator.macdSignal), condition("macd_above_zero", "MACDがゼロライン上", (indicator.macd ?? -Infinity) > 0), condition("price_above_sma21", "価格がSMA21上", sma21 !== null && current.close > sma21)],
    requiredCodes: ["macd_bullish_cross", "price_above_sma21"], executable: false, entry: current.close, stop: longStop, targetCandidates: longTargets,
  }));
  signals.push(makeSignal({
    id: `macd_turn_short:${current.time}`, side: "short", type: "macd_turn", marketState: one.state,
    conditions: [condition("macd_bearish_cross", "MACDがシグナルを下抜いた", indicator.previousMacd !== null && indicator.previousMacdSignal !== null && indicator.macd !== null && indicator.macdSignal !== null && indicator.previousMacd >= indicator.previousMacdSignal && indicator.macd < indicator.macdSignal), condition("macd_below_zero", "MACDがゼロライン下", (indicator.macd ?? Infinity) < 0), condition("price_below_sma21", "価格がSMA21下", sma21 !== null && current.close < sma21)],
    requiredCodes: ["macd_bearish_cross", "price_below_sma21"], executable: false, entry: current.close, stop: shortStop, targetCandidates: shortTargets,
  }));
  for (const pattern of input.patterns) {
    if (pattern.direction === "neutral") continue;
    signals.push(makeSignal({ id: `pattern_${pattern.type}_${pattern.direction}:${current.time}`, side: pattern.direction, type: "pattern_candidate", marketState: one.state, conditions: pattern.evidence.map(code => condition(code, code, true)), requiredCodes: pattern.evidence, executable: false, entry: current.close, stop: pattern.direction === "long" ? longStop : shortStop, targetCandidates: pattern.direction === "long" ? longTargets : shortTargets }));
  }
  return signals;
}

export function buildTechnicalAnalysisSnapshot(input: {
  oneMinuteCandles: TechnicalAnalysisCandle[];
  fiveMinuteCandles: TechnicalAnalysisCandle[];
  dailyContext: TechnicalDailyContext;
  config?: TechnicalAnalysisConfig;
}): TechnicalAnalysisSnapshotV2 {
  const config = input.config ?? DEFAULT_TECHNICAL_ANALYSIS_CONFIG;
  const oneMinute = input.oneMinuteCandles.slice(-Math.max(64, config.rciPeriods[2] + 2));
  const fiveMinute = input.fiveMinuteCandles.slice(-Math.max(64, config.rciPeriods[2] + 2));
  const oneState = stateFor("one_minute", calculateTechnicalIndicators(oneMinute, config));
  const fiveState = stateFor("five_minute", calculateTechnicalIndicators(fiveMinute, config));
  const dayState = dailyState(input.dailyContext);
  const current = oneMinute.at(-1) ?? null;
  const atr = oneState.indicators.atr14 ?? input.dailyContext.atrPrice;
  const window = oneMinute.slice(-config.supportResistanceLookback);
  const tolerance = Math.max((atr ?? (current?.close ?? 1) * 0.005) * 0.2, (current?.close ?? 1) * 0.0005);
  const pivotSupports = clusterLevels(pivots(window, "low", config.pivotWidth).map(item => item.price), tolerance, "pivot");
  const pivotResistances = clusterLevels(pivots(window, "high", config.pivotWidth).map(item => item.price), tolerance, "pivot");
  const profile = volumeProfile(window, config.volumeProfileBins);
  const priorLevels: TechnicalLevel[] = [input.dailyContext.priorLow, input.dailyContext.priorHigh]
    .flatMap(price => price === null ? [] : [{ price, touches: 1, source: "prior_day" as const }]);
  const supports = [...pivotSupports, ...priorLevels.filter(item => current && item.price <= current.close), ...profile.high.filter(price => current && price <= current.close).map(price => ({ price, touches: 1, source: "volume_profile" as const }))]
    .sort((a, b) => b.price - a.price).slice(0, 6);
  const resistances = [...pivotResistances, ...priorLevels.filter(item => current && item.price >= current.close), ...profile.high.filter(price => current && price >= current.close).map(price => ({ price, touches: 1, source: "volume_profile" as const }))]
    .sort((a, b) => a.price - b.price).slice(0, 6);
  const patterns = detectPatterns(window, atr, config);
  const recentReturn = oneMinute.length >= 6 && current ? Math.abs(current.close - oneMinute.at(-6)!.open) : 0;
  const crashWindow = oneMinute.slice(-6);
  const crashMove = crashWindow.length >= 6 ? crashWindow.at(-2)!.close - crashWindow[0].open : 0;
  const previous = oneMinute.length >= 2 ? oneMinute.at(-2)! : null;
  const crashReboundCandidate = current !== null && previous !== null && atr !== null && crashMove <= -atr * 1.5 && current.close > current.open && current.close > previous.close;
  const volume: TechnicalVolumeAnalysis = {
    average20: oneState.indicators.volumeAverage20,
    ratio20: oneState.indicators.volumeRatio20,
    breakoutExpansion: (oneState.indicators.volumeRatio20 ?? 0) >= config.breakoutVolumeRatio,
    rapidMove: atr !== null && recentReturn >= atr * 1.5,
    crashReboundCandidate,
    highVolumePriceZones: profile.high,
    lowVolumePriceZones: profile.low,
    profileApproximation: "typical_price_bins",
  };
  const availableStates = [dayState.state, fiveState.state, oneState.state].filter(state => state !== "unavailable" && state !== "hold");
  const directional = availableStates.filter(state => state === "up" || state === "down");
  const timeframeAgreement = directional.length >= 2 && new Set(directional).size === 1 ? "aligned" : availableStates.length >= 2 ? "mixed" : "unavailable";
  const combinedState: TechnicalTrendState = timeframeAgreement === "aligned" ? directional[0] as TechnicalTrendState : oneState.state === "range" && fiveState.state === "range" ? "range" : "hold";
  const patternsForSignals = patterns;
  const signals = signalCandidates({ candles: oneMinute, one: oneState, five: fiveState, daily: dayState, supports, resistances, context: input.dailyContext, config, patterns: patternsForSignals });
  const selected = signals.filter(signal => signal.executableInShadow && signal.status === "confirmed")
    .sort((a, b) => b.confidenceCompleteness - a.confidenceCompleteness || a.id.localeCompare(b.id))[0] ?? null;
  return {
    version: TECHNICAL_ANALYSIS_SHADOW_VERSION,
    asOfTime: current?.time ?? null,
    timeframes: { oneMinute: oneState, fiveMinute: fiveState, daily: dayState },
    combinedState,
    timeframeAgreement,
    supports,
    resistances,
    patterns,
    volume,
    signals,
    selectedExecutableSignalId: selected?.id ?? null,
    diagnostics: [
      "confidence_is_condition_completeness_not_predicted_win_rate",
      "pattern_candidates_are_display_only",
      "volume_profile_is_typical_price_bin_approximation",
      "completed_candles_only",
      "no_order_instruction_connection",
    ],
  };
}
