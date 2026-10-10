import {
  AI_DAILY_FORECAST_SYMBOLS,
  type QuantBaseline,
} from "./aiDailyForecastService";
import { sha256Stable } from "./runtimeIdentity";

type RecordValue = Record<string, unknown>;
type LearningMode = "cold_start" | "learned";
type Side = "long" | "short" | "wait";

const asRecord = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value: number | null, digits = 6) =>
  value === null ? null : Number(value.toFixed(digits));

function bucket(
  value: number | null,
  thresholds: readonly number[],
  labels: readonly string[]
) {
  if (value === null) return "unavailable";
  for (let index = 0; index < thresholds.length; index += 1)
    if (value < thresholds[index]!) return labels[index]!;
  return labels.at(-1)!;
}

function sideForBaseline(baseline: QuantBaseline): Side {
  if (baseline.direction === "strong_up" || baseline.direction === "up")
    return "long";
  if (baseline.direction === "strong_down" || baseline.direction === "down")
    return "short";
  return "wait";
}

function expectedRr(baseline: QuantBaseline): number | null {
  if (
    baseline.confirmPrice === null ||
    baseline.firstTarget === null ||
    baseline.stopReference === null
  )
    return null;
  const side = sideForBaseline(baseline);
  if (side === "wait") return null;
  const reward =
    side === "long"
      ? baseline.firstTarget / baseline.confirmPrice - 1
      : baseline.confirmPrice / baseline.firstTarget - 1;
  const risk =
    side === "long"
      ? baseline.confirmPrice / baseline.stopReference - 1
      : baseline.stopReference / baseline.confirmPrice - 1;
  return reward > 0 && risk > 0 ? round(reward / risk) : null;
}

export type LearningApplicationAudit = {
  schemaVersion: "ai-forecast-learning-application-v4";
  checkpoint: string;
  learningMode: LearningMode;
  learningApplied: boolean;
  learningExampleCount: number;
  coldStartReason: string | null;
  sourceLearningSnapshot: {
    sourceSnapshotId: string;
    asOfDate: string;
    modelVersion: string;
    payloadHash: string;
  } | null;
  frozenQuantBaseline: { id: string; hash: string };
  automaticRuleMutation: false;
  symbols: Array<{
    symbol: string;
    targetContext: RecordValue;
    eligibleExampleCount: number;
    excludedExampleCount: number;
    exclusionReasonCounts: Record<string, number>;
    nearestCandidates: Array<RecordValue>;
    noSimilarAnalog: boolean;
    sameCondition: {
      count: number;
      wins: number;
      losses: number;
      winRatePct: number | null;
      averagePnl: number | null;
      totalR: number;
      averageR: number | null;
    };
    expectedRewardRisk: {
      expectedRewardPct: number | null;
      expectedRiskPct: number | null;
      expectedRR: number | null;
    };
    appliedEvidence: string[];
    notAppliedEvidence: Array<{ reason: string; detail: string }>;
  }>;
  priorPlanDifference: {
    status: "not_applicable" | "pending_server_comparison";
  };
};

type AnalogCase = {
  identity: RecordValue;
  side: Side;
  checkpoint: string | null;
  gapBucket: string;
  fiveMinuteSma20Direction: string;
  bbPositionBucket: string;
  rsiBucket: string;
  macroRegime: string;
  expectedRrBucket: string;
  pnl: number | null;
  realizedR: number | null;
};

function normalizeAnalogCase(value: unknown): AnalogCase | null {
  const row = asRecord(value);
  const side = row.side;
  if (side !== "long" && side !== "short") return null;
  const identity = asRecord(row.identity);
  if (!identity.tradeDate || !identity.symbol || !identity.entryCandleTime)
    return null;
  return {
    identity,
    side,
    checkpoint: typeof row.checkpoint === "string" ? row.checkpoint : null,
    gapBucket: String(row.gapBucket ?? "unavailable"),
    fiveMinuteSma20Direction: String(
      row.fiveMinuteSma20Direction ?? "unavailable"
    ),
    bbPositionBucket: String(row.bbPositionBucket ?? "unavailable"),
    rsiBucket: String(row.rsiBucket ?? "unavailable"),
    macroRegime: String(row.macroRegime ?? "unavailable"),
    expectedRrBucket: String(row.expectedRrBucket ?? "unavailable"),
    pnl: finite(row.pnl),
    realizedR: finite(row.realizedR),
  };
}

function targetContext(input: {
  baseline: QuantBaseline;
  checkpoint: string;
  macroRegime: string | null;
  gapPct: number | null;
  technical?: RecordValue;
}) {
  const side = sideForBaseline(input.baseline);
  const technical = input.technical ?? {};
  const oneMinute = asRecord(technical.oneMinute);
  const bb = asRecord(oneMinute.bollinger20);
  return {
    side,
    checkpoint: input.checkpoint,
    gapBucket: bucket(
      input.gapPct,
      [-1.5, -0.3, 0.3, 1.5],
      ["large_down", "down", "flat", "up", "large_up"]
    ),
    fiveMinuteSma20Direction: String(
      technical.fiveMinuteSma20Direction ?? "unavailable"
    ),
    bbPositionBucket: bucket(
      finite(bb.zScore),
      [-1, 1, 2],
      ["lower", "middle", "upper", "outer"]
    ),
    rsiBucket: bucket(
      finite(oneMinute.rsi14),
      [30, 45, 55, 70],
      ["oversold", "low", "neutral", "high", "overbought"]
    ),
    macroRegime: input.macroRegime ?? "unavailable",
    expectedRrBucket: bucket(
      expectedRr(input.baseline),
      [1, 1.5, 2],
      ["below_1", "1_to_1_5", "1_5_to_2", "at_least_2"]
    ),
    expectedRR: expectedRr(input.baseline),
  };
}

function candidateDistance(target: RecordValue, candidate: AnalogCase) {
  const dimensions: Array<{
    name: string;
    weight: number;
    target: string;
    actual: string;
  }> = [
    {
      name: "side",
      weight: 4,
      target: String(target.side),
      actual: candidate.side,
    },
    {
      name: "checkpoint",
      weight: 3,
      target: String(target.checkpoint),
      actual: candidate.checkpoint ?? "unavailable",
    },
    {
      name: "gapBucket",
      weight: 1,
      target: String(target.gapBucket),
      actual: candidate.gapBucket,
    },
    {
      name: "fiveMinuteSma20Direction",
      weight: 2,
      target: String(target.fiveMinuteSma20Direction),
      actual: candidate.fiveMinuteSma20Direction,
    },
    {
      name: "bbPositionBucket",
      weight: 1,
      target: String(target.bbPositionBucket),
      actual: candidate.bbPositionBucket,
    },
    {
      name: "rsiBucket",
      weight: 1,
      target: String(target.rsiBucket),
      actual: candidate.rsiBucket,
    },
    {
      name: "macroRegime",
      weight: 1,
      target: String(target.macroRegime),
      actual: candidate.macroRegime,
    },
    {
      name: "expectedRrBucket",
      weight: 2,
      target: String(target.expectedRrBucket),
      actual: candidate.expectedRrBucket,
    },
  ];
  const matchedDimensions = dimensions
    .filter(dimension => dimension.target === dimension.actual)
    .map(dimension => dimension.name);
  const mismatchedDimensions = dimensions
    .filter(dimension => dimension.target !== dimension.actual)
    .map(dimension => dimension.name);
  return {
    distance: dimensions
      .filter(dimension => dimension.target !== dimension.actual)
      .reduce((sum, dimension) => sum + dimension.weight, 0),
    matchedDimensions,
    mismatchedDimensions,
  };
}

/**
 * Produces immutable, auditable similarity evidence from a prior closed-date learning
 * snapshot only. It never changes a strategy rule or parameter.
 */
export function buildLearningApplicationAudit(input: {
  checkpoint: string;
  baselines: Array<{
    symbol: string;
    baseline: QuantBaseline;
    technical?: RecordValue;
  }>;
  macroRegime: string | null;
  gapPctBySymbol?: Record<string, number | null>;
  learningSnapshot: {
    sourceSnapshotId: string;
    asOfDate: string;
    modelVersion: string;
    payloadHash: string;
    learning: unknown;
  } | null;
}): LearningApplicationAudit {
  const baselineHash = sha256Stable(
    input.baselines.map(item => ({
      symbol: item.symbol,
      baseline: item.baseline,
    }))
  );
  const learningPayload = asRecord(input.learningSnapshot?.learning);
  const sourceSymbols = Array.isArray(learningPayload.symbols)
    ? learningPayload.symbols.map(asRecord)
    : [];
  const sourceBySymbol = new Map(
    sourceSymbols.map(item => [String(item.symbol), item])
  );
  const generatedFrom = asRecord(learningPayload.generatedFrom);
  const coldStart =
    !input.learningSnapshot || generatedFrom.learningMode === "cold_start";
  const mode: LearningMode = coldStart ? "cold_start" : "learned";
  const coldStartReason = coldStart
    ? String(
        generatedFrom.coldStartReason ??
          "verified_learning_snapshot_before_trade_date_missing"
      )
    : null;

  return {
    schemaVersion: "ai-forecast-learning-application-v4",
    checkpoint: input.checkpoint,
    learningMode: mode,
    learningApplied: false,
    learningExampleCount: sourceSymbols.reduce(
      (sum, item) =>
        sum + (Array.isArray(item.analogCases) ? item.analogCases.length : 0),
      0
    ),
    coldStartReason,
    sourceLearningSnapshot: input.learningSnapshot
      ? {
          sourceSnapshotId: input.learningSnapshot.sourceSnapshotId,
          asOfDate: input.learningSnapshot.asOfDate,
          modelVersion: input.learningSnapshot.modelVersion,
          payloadHash: input.learningSnapshot.payloadHash,
        }
      : null,
    frozenQuantBaseline: {
      id: `quant-baseline:${input.checkpoint}:${baselineHash.slice(0, 16)}`,
      hash: baselineHash,
    },
    automaticRuleMutation: false,
    symbols: input.baselines.map(item => {
      const target = targetContext({
        baseline: item.baseline,
        checkpoint: input.checkpoint,
        macroRegime: input.macroRegime,
        gapPct: input.gapPctBySymbol?.[item.symbol] ?? null,
        technical: item.technical,
      });
      const source = sourceBySymbol.get(item.symbol) ?? {};
      const analogCases = (
        Array.isArray(source.analogCases) ? source.analogCases : []
      )
        .map(normalizeAnalogCase)
        .filter((value): value is AnalogCase => value !== null);
      const exclusionReasonCounts: Record<string, number> = {};
      const eligible = analogCases.flatMap(candidate => {
        if (candidate.side !== target.side || target.side === "wait") {
          exclusionReasonCounts.side_mismatch =
            (exclusionReasonCounts.side_mismatch ?? 0) + 1;
          return [];
        }
        const distance = candidateDistance(target, candidate);
        if (distance.distance > 4 || distance.matchedDimensions.length < 4) {
          exclusionReasonCounts.distance_or_match_threshold =
            (exclusionReasonCounts.distance_or_match_threshold ?? 0) + 1;
          return [];
        }
        return [{ candidate, ...distance }];
      });
      const nearest = eligible
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            String(right.candidate.identity.tradeDate).localeCompare(
              String(left.candidate.identity.tradeDate)
            ) ||
            String(left.candidate.identity.entryCandleTime).localeCompare(
              String(right.candidate.identity.entryCandleTime)
            )
        )
        .slice(0, 3);
      const wins = nearest.filter(item => (item.candidate.pnl ?? 0) > 0);
      const losses = nearest.filter(item => (item.candidate.pnl ?? 0) < 0);
      const realizedRs = nearest
        .map(item => item.candidate.realizedR)
        .filter((value): value is number => value !== null);
      const pnls = nearest
        .map(item => item.candidate.pnl)
        .filter((value): value is number => value !== null);
      const applied = mode === "learned" && nearest.length > 0;
      return {
        symbol: item.symbol,
        targetContext: target,
        eligibleExampleCount: eligible.length,
        excludedExampleCount: analogCases.length - eligible.length,
        exclusionReasonCounts,
        nearestCandidates: nearest.map(item => ({
          identity: item.candidate.identity,
          distance: item.distance,
          matchingDimensions: item.matchedDimensions,
          mismatchingDimensions: item.mismatchedDimensions,
          pnl: item.candidate.pnl,
          realizedR: item.candidate.realizedR,
          outcome:
            (item.candidate.pnl ?? 0) > 0
              ? "win"
              : (item.candidate.pnl ?? 0) < 0
                ? "loss"
                : "flat",
        })),
        noSimilarAnalog: applied === false,
        sameCondition: {
          count: nearest.length,
          wins: wins.length,
          losses: losses.length,
          winRatePct: nearest.length
            ? round((wins.length / nearest.length) * 100)
            : null,
          averagePnl: pnls.length
            ? round(pnls.reduce((sum, value) => sum + value, 0) / pnls.length)
            : null,
          totalR:
            round(
              realizedRs.reduce((sum, value) => sum + value, 0),
              6
            ) ?? 0,
          averageR: realizedRs.length
            ? round(
                realizedRs.reduce((sum, value) => sum + value, 0) /
                  realizedRs.length
              )
            : null,
        },
        expectedRewardRisk: {
          expectedRewardPct:
            item.baseline.confirmPrice !== null &&
            item.baseline.firstTarget !== null
              ? round(
                  Math.abs(
                    item.baseline.firstTarget / item.baseline.confirmPrice - 1
                  ) * 100
                )
              : null,
          expectedRiskPct:
            item.baseline.confirmPrice !== null &&
            item.baseline.stopReference !== null
              ? round(
                  Math.abs(
                    item.baseline.confirmPrice / item.baseline.stopReference - 1
                  ) * 100
                )
              : null,
          expectedRR: target.expectedRR as number | null,
        },
        appliedEvidence: applied
          ? [
              `similarity_candidates:${nearest.length}`,
              "closed_prior_trade_examples_only",
              "diagnosis_only_never_mutates_strategy_rules",
            ]
          : [],
        notAppliedEvidence: applied
          ? []
          : [
              {
                reason:
                  mode === "cold_start" ? "cold_start" : "no_similar_analog",
                detail:
                  mode === "cold_start"
                    ? coldStartReason!
                    : "distance_above_4_or_matching_dimensions_below_4",
              },
            ],
      };
    }),
    priorPlanDifference: { status: "not_applicable" },
  };
}

export function appendLearningAuditToForecast<T extends RecordValue>(input: {
  forecast: T;
  audit: LearningApplicationAudit;
  priorForecast?: RecordValue | null;
}) {
  const prior = input.priorForecast ?? null;
  const currentRows = Array.isArray(input.forecast.forecasts)
    ? input.forecast.forecasts.map(asRecord)
    : [];
  const priorRows =
    prior && Array.isArray(prior.forecasts)
      ? prior.forecasts.map(asRecord)
      : [];
  const priorBySymbol = new Map(
    priorRows.map(row => [String(row.symbol), row])
  );
  const differences = currentRows.map(row => {
    const previous = priorBySymbol.get(String(row.symbol));
    const fields = [
      "direction",
      "forecastLow",
      "forecastHigh",
      "zoneLow",
      "zoneHigh",
      "confirmPrice",
      "firstTarget",
      "stretchTarget",
      "entryWindowStart",
      "entryWindowEnd",
      "forceExitTime",
      "openPositionAction",
    ];
    const changed = fields.filter(
      field => JSON.stringify(row[field]) !== JSON.stringify(previous?.[field])
    );
    return {
      symbol: row.symbol,
      previousAvailable: Boolean(previous),
      changedFields: changed,
      changeReason:
        row.aiAdjustment && asRecord(row.aiAdjustment).reason
          ? asRecord(row.aiAdjustment).reason
          : "initial_or_unchanged_plan",
    };
  });
  return {
    ...input.forecast,
    learningApplicationAudit: {
      ...input.audit,
      learningApplied: input.audit.symbols.some(
        item => item.appliedEvidence.length > 0
      ),
      priorPlanDifference: {
        status: prior ? "pending_server_comparison" : "not_applicable",
        bySymbol: differences,
      },
    },
  };
}

export const _aiForecastLearningAuditTest = {
  buildLearningApplicationAudit,
  appendLearningAuditToForecast,
};
