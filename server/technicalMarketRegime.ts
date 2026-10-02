import { calcADX } from "./intradayRegime";

export const TECHNICAL_MARKET_REGIME_VERSION = "technical-market-regime-v1";

export type TechnicalDirection = "up" | "down" | "range" | "unknown";
export type TechnicalVolatility = "expanding" | "normal" | "compressing" | "unknown";
export type TechnicalLocation = "upper" | "middle" | "lower" | "unknown";
export type TechnicalSetup =
  | "up_breakout"
  | "up_trend"
  | "down_breakout"
  | "down_trend"
  | "upper_reversal"
  | "lower_reversal"
  | "range_compression"
  | "range"
  | "unknown";

export type TechnicalMarketRegime = {
  version: typeof TECHNICAL_MARKET_REGIME_VERSION;
  eligible: boolean;
  setup: TechnicalSetup;
  trend: TechnicalDirection;
  volatility: TechnicalVolatility;
  location: TechnicalLocation;
  breadth: "bullish" | "bearish" | "mixed" | "unknown";
  allowedDirections: Array<"long" | "short">;
  confidence: "high" | "medium" | "low" | "unavailable";
  directionalScore: number;
  full: string;
  reasonCodes: string[];
  indicators: Record<string, unknown>;
  evidence: Array<{ name: string; direction: "bullish" | "bearish" | "neutral"; weight: number; value: unknown }>;
};

type RecordValue = Record<string, unknown>;
export type TechnicalFeatureTimelineRow = {
  tradeDate: string;
  featuresBySymbol: Record<string, unknown>;
};

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rawFeature(wrapper: unknown): RecordValue {
  const item = object(wrapper);
  return object(item.features);
}

function featureEligible(wrapper: unknown): boolean {
  const item = object(wrapper);
  const provenance = String(item.provenanceStatus ?? "");
  return item.featureEligible === true && (provenance === "verified" || provenance === "provenance_present");
}

function percentileRank(value: number | null, history: number[]): number | null {
  if (value === null || history.length < 5) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const belowOrEqual = sorted.filter(item => item <= value).length;
  return belowOrEqual / sorted.length;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function movingAverage(values: number[], period: number): number | null {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function directionalMovement(highs: number[], lows: number[], period = 14) {
  if (highs.length < period + 1 || lows.length !== highs.length) return { plus: null, minus: null };
  let plus = 0;
  let minus = 0;
  for (let index = highs.length - period; index < highs.length; index += 1) {
    if (index <= 0) continue;
    const upMove = highs[index] - highs[index - 1];
    const downMove = lows[index - 1] - lows[index];
    if (upMove > downMove && upMove > 0) plus += upMove;
    if (downMove > upMove && downMove > 0) minus += downMove;
  }
  return { plus, minus };
}

function hourlyBars(features: RecordValue[]) {
  return features.flatMap(feature => {
    const bars = object(feature.intraday).sessionBars60;
    return Array.isArray(bars) ? bars.map(object) : [];
  }).filter(bar => finite(bar.close) !== null);
}

function technicalBreadth(universeCurrent: Record<string, unknown>) {
  const eligible = Object.values(universeCurrent).filter(featureEligible);
  if (eligible.length < 5) return { label: "unknown" as const, eligible: eligible.length, bullishRatio: null };
  const bullish = eligible.filter(wrapper => {
    const feature = rawFeature(wrapper);
    const close = finite(feature.close);
    const ma20 = finite(object(object(feature.movingAverages)["20"]).value);
    return close !== null && ma20 !== null && close > ma20;
  }).length;
  const ratio = bullish / eligible.length;
  return {
    label: ratio >= 0.6 ? "bullish" as const : ratio <= 0.4 ? "bearish" as const : "mixed" as const,
    eligible: eligible.length,
    bullishRatio: ratio,
  };
}

function unavailable(reasonCodes: string[]): TechnicalMarketRegime {
  return {
    version: TECHNICAL_MARKET_REGIME_VERSION,
    eligible: false,
    setup: "unknown",
    trend: "unknown",
    volatility: "unknown",
    location: "unknown",
    breadth: "unknown",
    allowedDirections: [],
    confidence: "unavailable",
    directionalScore: 0,
    full: "unknown",
    reasonCodes,
    indicators: {},
    evidence: [],
  };
}

/**
 * D日の閉場後だけに計算する純粋な相場状態分類。
 * currentより後の足・損益・結果は受け取らず、固定ルールを最適化しない。
 */
export function classifyTechnicalMarketRegime(input: {
  current: unknown;
  history: unknown[];
  universeCurrent: Record<string, unknown>;
}): TechnicalMarketRegime {
  if (!featureEligible(input.current)) return unavailable(["feature_or_provenance_unavailable"]);
  const current = rawFeature(input.current);
  const history = input.history.filter(featureEligible).map(rawFeature);
  const series = [...history, current];
  const close = finite(current.close);
  const open = finite(current.open);
  const high = finite(current.high);
  const low = finite(current.low);
  if (close === null || open === null || high === null || low === null || close <= 0 || high < low) {
    return unavailable(["invalid_daily_ohlc"]);
  }

  const ma = (period: number) => object(object(current.movingAverages)[String(period)]);
  const ma5 = finite(ma(5).value);
  const ma20 = finite(ma(20).value);
  const ma25 = finite(ma(25).value);
  const ma50 = finite(ma(50).value);
  const ma20Slope = finite(ma(20).slopePct);
  const ma50Slope = finite(ma(50).slopePct);
  const bollinger = object(current.bollinger20);
  const percentB = finite(bollinger.percentB);
  const bandwidth = finite(bollinger.bandwidthPct);
  const priorBandwidths = history.slice(-60).map(item => finite(object(item.bollinger20).bandwidthPct)).filter((value): value is number => value !== null);
  const bandwidthPercentile = percentileRank(bandwidth, priorBandwidths);
  const previousBandwidth = priorBandwidths.at(-1) ?? null;
  const atr = finite(current.atr14Pct);
  const priorAtr = history.slice(-60).map(item => finite(item.atr14Pct)).filter((value): value is number => value !== null);
  const atrPercentile = percentileRank(atr, priorAtr);

  const dailyHighs = series.map(item => finite(item.high)).filter((value): value is number => value !== null);
  const dailyLows = series.map(item => finite(item.low)).filter((value): value is number => value !== null);
  const dailyCloses = series.map(item => finite(item.close)).filter((value): value is number => value !== null);
  const adx = dailyHighs.length === dailyLows.length && dailyLows.length === dailyCloses.length
    ? calcADX(dailyHighs, dailyLows, dailyCloses, 14).at(-1) ?? null
    : null;
  const dm = directionalMovement(dailyHighs, dailyLows);

  const lastThreeHighs = dailyHighs.slice(-3);
  const lastThreeLows = dailyLows.slice(-3);
  const dowUp = lastThreeHighs.length === 3 && lastThreeLows.length === 3
    && lastThreeHighs[2] > lastThreeHighs[1] && lastThreeHighs[1] >= lastThreeHighs[0]
    && lastThreeLows[2] > lastThreeLows[1] && lastThreeLows[1] >= lastThreeLows[0];
  const dowDown = lastThreeHighs.length === 3 && lastThreeLows.length === 3
    && lastThreeHighs[2] < lastThreeHighs[1] && lastThreeHighs[1] <= lastThreeHighs[0]
    && lastThreeLows[2] < lastThreeLows[1] && lastThreeLows[1] <= lastThreeLows[0];

  const bars = hourlyBars(series);
  const hourlyCloses = bars.map(bar => finite(bar.close)).filter((value): value is number => value !== null);
  const hourlySma20 = movingAverage(hourlyCloses, 20);
  const hourlyPreviousSma20 = hourlyCloses.length >= 21 ? average(hourlyCloses.slice(-21, -1)) : null;
  const hourlySlope = hourlySma20 !== null && hourlyPreviousSma20 !== null && hourlyPreviousSma20 !== 0
    ? (hourlySma20 - hourlyPreviousSma20) / hourlyPreviousSma20 * 100
    : finite(object(object(current.intraday).sixtyMinute).slopePct);
  const hourlyClose = hourlyCloses.at(-1) ?? close;

  const range = high - low;
  const body = close - open;
  const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
  const upperWickRatio = range > 0 ? (high - Math.max(open, close)) / range : 0;
  const lowerWickRatio = range > 0 ? (Math.min(open, close) - low) / range : 0;
  const candle = bodyRatio <= 0.2
    ? "indecision"
    : close > open && lowerWickRatio >= 0.35
      ? "bullish_rejection"
      : close < open && upperWickRatio >= 0.35
        ? "bearish_rejection"
        : close > open && bodyRatio >= 0.5
          ? "bullish_body"
          : close < open && bodyRatio >= 0.5
            ? "bearish_body"
            : "neutral";

  const breadth = technicalBreadth(input.universeCurrent);
  const evidence: TechnicalMarketRegime["evidence"] = [];
  const add = (name: string, direction: "bullish" | "bearish" | "neutral", weight: number, value: unknown) => evidence.push({ name, direction, weight, value });

  if (ma5 !== null && ma20 !== null && close > ma20 && ma5 > ma20) add("daily_ma_alignment", "bullish", 2, { close, ma5, ma20 });
  else if (ma5 !== null && ma20 !== null && close < ma20 && ma5 < ma20) add("daily_ma_alignment", "bearish", 2, { close, ma5, ma20 });
  else add("daily_ma_alignment", "neutral", 0, { close, ma5, ma20 });

  const slowMa = ma50 ?? ma25;
  const slowSlope = ma50 !== null ? ma50Slope : finite(ma(25).slopePct);
  if (ma20 !== null && slowMa !== null && ma20 > slowMa && (ma20Slope ?? 0) > 0 && (slowSlope ?? 0) >= 0) add("daily_ma_slope", "bullish", 1, { ma20, slowMa, ma20Slope, slowSlope });
  else if (ma20 !== null && slowMa !== null && ma20 < slowMa && (ma20Slope ?? 0) < 0 && (slowSlope ?? 0) <= 0) add("daily_ma_slope", "bearish", 1, { ma20, slowMa, ma20Slope, slowSlope });
  else add("daily_ma_slope", "neutral", 0, { ma20, slowMa, ma20Slope, slowSlope });

  if (dowUp) add("dow_high_low_structure", "bullish", 2, { highs: lastThreeHighs, lows: lastThreeLows });
  else if (dowDown) add("dow_high_low_structure", "bearish", 2, { highs: lastThreeHighs, lows: lastThreeLows });
  else add("dow_high_low_structure", "neutral", 0, { highs: lastThreeHighs, lows: lastThreeLows });

  if (dm.plus !== null && dm.minus !== null && dm.plus > dm.minus) add("directional_movement", "bullish", adx !== null && adx >= 20 ? 2 : 1, { ...dm, adx });
  else if (dm.plus !== null && dm.minus !== null && dm.minus > dm.plus) add("directional_movement", "bearish", adx !== null && adx >= 20 ? 2 : 1, { ...dm, adx });
  else add("directional_movement", "neutral", 0, { ...dm, adx });

  if (hourlySma20 !== null && hourlyClose > hourlySma20 && (hourlySlope ?? 0) > 0) add("hourly_trend", "bullish", 1, { hourlyClose, hourlySma20, hourlySlope });
  else if (hourlySma20 !== null && hourlyClose < hourlySma20 && (hourlySlope ?? 0) < 0) add("hourly_trend", "bearish", 1, { hourlyClose, hourlySma20, hourlySlope });
  else add("hourly_trend", "neutral", 0, { hourlyClose, hourlySma20, hourlySlope });

  if (candle === "bullish_body" || candle === "bullish_rejection") add("daily_candle", "bullish", 1, candle);
  else if (candle === "bearish_body" || candle === "bearish_rejection") add("daily_candle", "bearish", 1, candle);
  else add("daily_candle", "neutral", 0, candle);

  if (breadth.label === "bullish") add("ten_symbol_breadth", "bullish", 1, breadth);
  else if (breadth.label === "bearish") add("ten_symbol_breadth", "bearish", 1, breadth);
  else add("ten_symbol_breadth", "neutral", 0, breadth);

  const bullishScore = evidence.filter(item => item.direction === "bullish").reduce((sum, item) => sum + item.weight, 0);
  const bearishScore = evidence.filter(item => item.direction === "bearish").reduce((sum, item) => sum + item.weight, 0);
  const directionalScore = bullishScore - bearishScore;
  const trend: TechnicalDirection = directionalScore >= 3 ? "up" : directionalScore <= -3 ? "down" : "range";

  const bandwidthRising = bandwidth !== null && previousBandwidth !== null && bandwidth > previousBandwidth;
  const volatility: TechnicalVolatility = atrPercentile === null || bandwidthPercentile === null
    ? "unknown"
    : atrPercentile >= 0.65 && bandwidthPercentile >= 0.65 && bandwidthRising
      ? "expanding"
      : atrPercentile <= 0.35 && bandwidthPercentile <= 0.35
        ? "compressing"
        : "normal";
  const location: TechnicalLocation = percentB === null ? "unknown" : percentB >= 80 ? "upper" : percentB <= 20 ? "lower" : "middle";

  const setup: TechnicalSetup = trend === "up"
    ? volatility === "expanding" ? "up_breakout" : "up_trend"
    : trend === "down"
      ? volatility === "expanding" ? "down_breakout" : "down_trend"
      : volatility === "compressing"
        ? "range_compression"
        : location === "upper" && (candle === "bearish_body" || candle === "bearish_rejection")
          ? "upper_reversal"
          : location === "lower" && (candle === "bullish_body" || candle === "bullish_rejection")
            ? "lower_reversal"
            : "range";
  const allowedDirections: Array<"long" | "short"> = setup === "up_breakout" || setup === "up_trend" || setup === "lower_reversal"
    ? ["long"]
    : setup === "down_breakout" || setup === "down_trend" || setup === "upper_reversal"
      ? ["short"]
      : ["long", "short"];
  const directionalEvidenceCount = evidence.filter(item => item.direction !== "neutral").length;
  const confidence = directionalEvidenceCount >= 5 && Math.abs(directionalScore) >= 5
    ? "high" as const
    : directionalEvidenceCount >= 3
      ? "medium" as const
      : "low" as const;
  const reasonCodes = history.length < 5 ? ["fewer_than_5_prior_feature_days"] : ["eligible"];

  return {
    version: TECHNICAL_MARKET_REGIME_VERSION,
    eligible: true,
    setup,
    trend,
    volatility,
    location,
    breadth: breadth.label,
    allowedDirections,
    confidence,
    directionalScore,
    full: `${setup}|${volatility}|${location}|${breadth.label}`,
    reasonCodes,
    indicators: {
      ma5, ma20, ma25, ma50, ma20Slope, ma50Slope,
      dowUp, dowDown, adx, directionalMovement: dm,
      hourlySma20, hourlySlope,
      atrPct: atr, atrPercentile,
      bollingerPercentB: percentB, bollingerBandwidthPct: bandwidth, bandwidthPercentile,
      candle, bodyRatio, upperWickRatio, lowerWickRatio,
      breadth,
      volumeRatioTo20Pct: finite(object(current.volumeRatio).to20),
      gapPct: finite(current.gapPct),
    },
    evidence,
  };
}

/** Builds every day's state with only the rows available through that date. */
export function buildTechnicalMarketRegimeTimeline(
  rows: TechnicalFeatureTimelineRow[],
  symbols: readonly string[],
): Record<string, Record<string, TechnicalMarketRegime>> {
  const ordered = [...rows].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const result: Record<string, Record<string, TechnicalMarketRegime>> = {};
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    result[row.tradeDate] = {};
    for (const symbol of symbols) {
      const history = ordered.slice(0, index).map(item => item.featuresBySymbol[symbol]).filter(Boolean);
      result[row.tradeDate][symbol] = classifyTechnicalMarketRegime({
        current: row.featuresBySymbol[symbol],
        history,
        universeCurrent: row.featuresBySymbol,
      });
    }
  }
  return result;
}
