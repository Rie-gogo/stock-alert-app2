import { sha256Stable } from "./runtimeIdentity";

export const MARKET_CONTEXT_SELECTOR_SHADOW_VERSION = "market-context-selector-shadow-v3-market-affinity-monitoring";
export const PREMARKET_CONTEXT_RULE_VERSION = "premarket-context-rule-v1-monitoring";

export const MARKET_CONTEXT_CHECKPOINTS = Object.freeze({
  "09:04": "09:05",
  "09:14": "09:15",
  "09:59": "10:00",
  "12:34": "12:35",
  "13:29": "13:30",
} as const);

export type MarketContextBar = {
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose: number | null;
};

export type IntradayMarketState =
  | "waiting_open_confirmation"
  | "strong_up"
  | "up"
  | "mixed"
  | "down"
  | "strong_down"
  | "gap_down_recovery"
  | "gap_up_failure"
  | "unavailable";

export type IntradayMarketRegime = {
  version: typeof MARKET_CONTEXT_SELECTOR_SHADOW_VERSION;
  state: IntradayMarketState;
  confidence: "high" | "medium" | "low" | "unavailable";
  allowedDirections: Array<"long" | "short">;
  observedThrough: string | null;
  checkpoint: boolean;
  decisionAt: string | null;
  reasonCodes: string[];
  metrics: {
    previousClose: number | null;
    openingPrice: number | null;
    latestClose: number | null;
    gapPct: number | null;
    previousCloseReturnPct: number | null;
    fromOpenPct: number | null;
    momentum3Pct: number | null;
    persistentDirection: "up" | "down" | "mixed" | "unavailable";
  };
};

export type PremarketLegStatus = "verified" | "degraded" | "missing";

export type PremarketContextInput = {
  tradeDate: string;
  capturedAtMs: number;
  collectorVersion: string;
  sourceMode: "scheduled_research" | "provider_api" | "manual_review";
  dow: {
    sessionDate: string;
    close: number;
    changePct: number;
    observedAtMs: number;
    sourceUrl: string;
    status: PremarketLegStatus;
  } | null;
  cme: {
    providerSymbol: string;
    contractMonth: string;
    currency: "JPY" | "USD";
    quote: number;
    oseDayClose: number;
    observedAtMs: number;
    sourceUrl: string;
    status: PremarketLegStatus;
  } | null;
  usdJpy: {
    previousRate: number;
    previousAtMs: number;
    currentRate: number;
    currentAtMs: number;
    sourceUrl: string;
    status: PremarketLegStatus;
  } | null;
};

export type PremarketMarketRegime = {
  version: typeof PREMARKET_CONTEXT_RULE_VERSION;
  state: "strong_up" | "up" | "mixed" | "down" | "strong_down" | "unavailable";
  confidence: "high" | "medium" | "low" | "unavailable";
  allowedDirections: Array<"long" | "short">;
  qualityStatus: "verified" | "degraded" | "invalid";
  verifiedLegs: number;
  reasonCodes: string[];
  metrics: {
    dowChangePct: number | null;
    cmeBasisPct: number | null;
    usdJpyChangePct: number | null;
    directionalScore: number;
  };
};

export type CombinedMarketRegime = {
  state: "long" | "short" | "wait";
  confidence: "high" | "medium" | "low" | "unavailable";
  allowedDirections: Array<"long" | "short">;
  reasonCodes: string[];
};

type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(current: number, base: number) {
  return base > 0 ? (current / base - 1) * 100 : null;
}

function directionalVote(value: number | null, mild: number, strong: number): number {
  if (value === null) return 0;
  if (value >= strong) return 2;
  if (value >= mild) return 1;
  if (value <= -strong) return -2;
  if (value <= -mild) return -1;
  return 0;
}

function premarketTemporalViolations(input: PremarketContextInput): string[] {
  const reasons: string[] = [];
  const capturedAtMs = finite(input.capturedAtMs);
  if (capturedAtMs === null || capturedAtMs < 0) return ["captured_at_invalid"];
  const jst = new Date(capturedAtMs + 9 * 60 * 60 * 1000);
  const capturedTradeDate = jst.toISOString().slice(0, 10);
  const capturedMinuteJst = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  if (capturedTradeDate !== input.tradeDate) reasons.push("captured_date_not_trade_date_jst");
  if (capturedMinuteJst >= 9 * 60) reasons.push("captured_at_or_after_cash_open");
  const observedTimes = [input.dow?.observedAtMs, input.cme?.observedAtMs, input.usdJpy?.currentAtMs]
    .filter((value): value is number => value !== null && value !== undefined);
  if (observedTimes.some(value => !Number.isFinite(value) || value > capturedAtMs)) reasons.push("source_observed_after_snapshot_capture");
  if (input.usdJpy && input.usdJpy.previousAtMs > input.usdJpy.currentAtMs) reasons.push("usd_jpy_time_order_invalid");
  return reasons;
}

/**
 * ①〜③を、結果を見て日中変更しない固定v1閾値で分類する。
 * CMEはOSEと直接比較できるJPY建てだけをverified材料として扱う。
 */
export function classifyPremarketContext(input: PremarketContextInput): PremarketMarketRegime {
  const dowVerified = input.dow?.status === "verified";
  const cmeVerified = input.cme?.status === "verified" && input.cme.currency === "JPY";
  const fxVerified = input.usdJpy?.status === "verified";
  const dowChangePct = dowVerified ? finite(input.dow?.changePct) : null;
  const cmeBasisPct = cmeVerified && input.cme ? pct(input.cme.quote, input.cme.oseDayClose) : null;
  const usdJpyChangePct = fxVerified && input.usdJpy ? pct(input.usdJpy.currentRate, input.usdJpy.previousRate) : null;
  const verifiedLegs = [dowVerified, cmeVerified, fxVerified].filter(Boolean).length;
  const reasonCodes: string[] = [];
  if (input.cme?.status === "verified" && input.cme.currency !== "JPY") reasonCodes.push("cme_currency_not_jpy");
  if (!dowVerified) reasonCodes.push("dow_not_verified");
  if (!cmeVerified) reasonCodes.push("cme_jpy_not_verified");
  if (!fxVerified) reasonCodes.push("usd_jpy_not_verified");
  const directionalScore = directionalVote(dowChangePct, 0.3, 1.0)
    + directionalVote(cmeBasisPct, 0.35, 0.9)
    + directionalVote(usdJpyChangePct, 0.2, 0.6);
  const metrics = { dowChangePct, cmeBasisPct, usdJpyChangePct, directionalScore };
  const temporalViolations = premarketTemporalViolations(input);
  if (temporalViolations.length > 0) {
    return {
      version: PREMARKET_CONTEXT_RULE_VERSION,
      state: "unavailable",
      confidence: "unavailable",
      allowedDirections: [],
      qualityStatus: "invalid",
      verifiedLegs,
      reasonCodes: [...reasonCodes, ...temporalViolations],
      metrics,
    };
  }
  if (verifiedLegs < 2) {
    return {
      version: PREMARKET_CONTEXT_RULE_VERSION,
      state: "unavailable",
      confidence: "unavailable",
      allowedDirections: [],
      qualityStatus: verifiedLegs === 0 ? "invalid" : "degraded",
      verifiedLegs,
      reasonCodes: [...reasonCodes, "fewer_than_two_verified_inputs"],
      metrics,
    };
  }
  let state: PremarketMarketRegime["state"] = "mixed";
  let allowedDirections: PremarketMarketRegime["allowedDirections"] = [];
  if (directionalScore >= 4) { state = "strong_up"; allowedDirections = ["long"]; }
  else if (directionalScore >= 2) { state = "up"; allowedDirections = ["long"]; }
  else if (directionalScore <= -4) { state = "strong_down"; allowedDirections = ["short"]; }
  else if (directionalScore <= -2) { state = "down"; allowedDirections = ["short"]; }
  else reasonCodes.push("premarket_inputs_mixed_or_small");
  const qualityStatus = verifiedLegs === 3 ? "verified" as const : "degraded" as const;
  const confidence = Math.abs(directionalScore) >= 4 && verifiedLegs === 3
    ? "high" as const
    : Math.abs(directionalScore) >= 2
      ? "medium" as const
      : "low" as const;
  return {
    version: PREMARKET_CONTEXT_RULE_VERSION,
    state,
    confidence,
    allowedDirections,
    qualityStatus,
    verifiedLegs,
    reasonCodes: [...reasonCodes, `directional_score_${directionalScore}`],
    metrics,
  };
}

/** 開場前①〜③と場中④の固定ルール。保有中ポジションには適用しない。 */
export function combinePremarketAndIntraday(
  premarket: PremarketMarketRegime | null,
  intraday: IntradayMarketRegime,
): CombinedMarketRegime {
  const preDirection = premarket?.allowedDirections[0] ?? null;
  const intraDirection = intraday.allowedDirections[0] ?? null;
  const explicitReversal = intraday.state === "gap_down_recovery" || intraday.state === "gap_up_failure";
  if (!premarket || premarket.state === "unavailable") {
    return intraDirection
      ? { state: intraDirection, confidence: intraday.confidence, allowedDirections: [intraDirection], reasonCodes: ["intraday_only_premarket_unavailable"] }
      : { state: "wait", confidence: "unavailable", allowedDirections: [], reasonCodes: ["premarket_and_intraday_unavailable"] };
  }
  if (explicitReversal && intraDirection) {
    return { state: intraDirection, confidence: intraday.confidence, allowedDirections: [intraDirection], reasonCodes: ["explicit_gap_reversal_overrides_premarket"] };
  }
  if (preDirection && intraDirection && preDirection === intraDirection) {
    return { state: intraDirection, confidence: premarket.confidence === "high" && intraday.confidence === "high" ? "high" : "medium", allowedDirections: [intraDirection], reasonCodes: ["premarket_and_intraday_agree"] };
  }
  if (preDirection && intraDirection && preDirection !== intraDirection) {
    if (intraday.decisionAt === "10:00" || intraday.decisionAt === "12:35" || intraday.decisionAt === "13:30") {
      return { state: intraDirection, confidence: intraday.confidence, allowedDirections: [intraDirection], reasonCodes: ["persistent_intraday_direction_overrides_premarket_after_1000"] };
    }
    return { state: "wait", confidence: "low", allowedDirections: [], reasonCodes: ["premarket_intraday_conflict_wait"] };
  }
  if (preDirection && !intraDirection && premarket.confidence === "high") {
    return { state: preDirection, confidence: "low", allowedDirections: [preDirection], reasonCodes: ["high_confidence_premarket_intraday_mixed"] };
  }
  if (!preDirection && intraDirection) {
    return { state: intraDirection, confidence: intraday.confidence, allowedDirections: [intraDirection], reasonCodes: ["mixed_premarket_intraday_confirmed"] };
  }
  return { state: "wait", confidence: "low", allowedDirections: [], reasonCodes: ["combined_direction_unconfirmed"] };
}

function unavailable(reasonCodes: string[], observedThrough: string | null = null): IntradayMarketRegime {
  return {
    version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
    state: "unavailable",
    confidence: "unavailable",
    allowedDirections: [],
    observedThrough,
    checkpoint: false,
    decisionAt: null,
    reasonCodes,
    metrics: {
      previousClose: null,
      openingPrice: null,
      latestClose: null,
      gapPct: null,
      previousCloseReturnPct: null,
      fromOpenPct: null,
      momentum3Pct: null,
      persistentDirection: "unavailable",
    },
  };
}

/**
 * 日経平均系の保存済み1分足だけから作る監視用分類。
 * 閾値はv1で固定し、将来の成績に合わせて日中に変更しない。
 */
export function classifyIntradayMarketContext(rawBars: MarketContextBar[]): IntradayMarketRegime {
  // relay再起動や補正eventで同じ分が複数保存されても、1分を複数本として数えない。
  // 入力順で最後の行をその分の代表値とし、その後で時刻順に並べる。
  const latestByMinute = new Map<string, MarketContextBar>();
  rawBars
    .filter(bar => bar.candleTime >= "09:00" && bar.candleTime <= "15:30")
    .filter(bar => [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0))
    .forEach(bar => latestByMinute.set(bar.candleTime, bar));
  const bars = Array.from(latestByMinute.values())
    .sort((a, b) => a.candleTime.localeCompare(b.candleTime));
  const latest = bars.at(-1);
  if (!latest) return unavailable(["no_cash_session_market_context"]);
  const checkpointDecisionAt = MARKET_CONTEXT_CHECKPOINTS[latest.candleTime as keyof typeof MARKET_CONTEXT_CHECKPOINTS] ?? null;
  const previousClose = latest.previousClose ?? bars.find(item => item.previousClose !== null)?.previousClose ?? null;
  const opening = bars[0]?.open ?? null;
  if (previousClose === null || previousClose <= 0 || opening === null) {
    return unavailable(["previous_close_or_open_missing"], latest.candleTime);
  }
  const latestClose = latest.close;
  const lastThree = bars.slice(-3).map(item => item.close);
  const persistentUp = lastThree.length === 3 && lastThree[0] <= lastThree[1] && lastThree[1] <= lastThree[2];
  const persistentDown = lastThree.length === 3 && lastThree[0] >= lastThree[1] && lastThree[1] >= lastThree[2];
  const persistentDirection = persistentUp ? "up" as const : persistentDown ? "down" as const : "mixed" as const;
  const gapPct = pct(opening, previousClose);
  const previousCloseReturnPct = pct(latestClose, previousClose);
  const fromOpenPct = pct(latestClose, opening);
  const momentumBase = bars.at(-4)?.close ?? null;
  const momentum3Pct = momentumBase === null ? null : pct(latestClose, momentumBase);
  const metrics = { previousClose, openingPrice: opening, latestClose, gapPct, previousCloseReturnPct, fromOpenPct, momentum3Pct, persistentDirection };
  if (bars.length < 5 || latest.candleTime < "09:04") {
    return {
      version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
      state: "waiting_open_confirmation",
      confidence: "low",
      allowedDirections: [],
      observedThrough: latest.candleTime,
      checkpoint: false,
      decisionAt: null,
      reasonCodes: ["first_five_cash_minutes_not_complete"],
      metrics,
    };
  }

  let state: IntradayMarketState = "mixed";
  let confidence: IntradayMarketRegime["confidence"] = "low";
  let allowedDirections: IntradayMarketRegime["allowedDirections"] = [];
  const reasonCodes: string[] = [];
  if ((gapPct ?? 0) <= -0.5 && (fromOpenPct ?? 0) >= 0.3 && persistentUp) {
    state = "gap_down_recovery";
    confidence = "high";
    allowedDirections = ["long"];
    reasonCodes.push("gap_down_then_three_bar_recovery");
  } else if ((gapPct ?? 0) >= 0.5 && (fromOpenPct ?? 0) <= -0.3 && persistentDown) {
    state = "gap_up_failure";
    confidence = "high";
    allowedDirections = ["short"];
    reasonCodes.push("gap_up_then_three_bar_failure");
  } else if ((previousCloseReturnPct ?? 0) >= 0.8 && (fromOpenPct ?? 0) >= 0.3 && persistentUp) {
    state = "strong_up";
    confidence = "high";
    allowedDirections = ["long"];
    reasonCodes.push("large_positive_return_with_persistent_up_move");
  } else if ((previousCloseReturnPct ?? 0) <= -0.8 && (fromOpenPct ?? 0) <= -0.3 && persistentDown) {
    state = "strong_down";
    confidence = "high";
    allowedDirections = ["short"];
    reasonCodes.push("large_negative_return_with_persistent_down_move");
  } else if (((previousCloseReturnPct ?? 0) >= 0.2 && (fromOpenPct ?? 0) >= 0) || ((fromOpenPct ?? 0) >= 0.25 && persistentUp)) {
    state = "up";
    confidence = persistentUp ? "medium" : "low";
    allowedDirections = ["long"];
    reasonCodes.push("positive_market_direction_confirmed");
  } else if (((previousCloseReturnPct ?? 0) <= -0.2 && (fromOpenPct ?? 0) <= 0) || ((fromOpenPct ?? 0) <= -0.25 && persistentDown)) {
    state = "down";
    confidence = persistentDown ? "medium" : "low";
    allowedDirections = ["short"];
    reasonCodes.push("negative_market_direction_confirmed");
  } else {
    reasonCodes.push("directional_evidence_conflicted");
  }

  return {
    version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
    state,
    confidence,
    allowedDirections,
    observedThrough: latest.candleTime,
    checkpoint: checkpointDecisionAt !== null,
    decisionAt: checkpointDecisionAt,
    reasonCodes,
    metrics,
  };
}

function marketContextCandidate(row: Value) {
  return row.marketContextEligible === true
    || (row.marketContextEligible === undefined && row.selectable === true);
}

type MarketRouteStyle = "trend_long" | "reversal_long" | "trend_short" | "reversal_short";

function marketRouteStyle(row: Value): MarketRouteStyle | null {
  const group = String(row.routeGroupId ?? "").toLowerCase();
  const direction = String(row.direction ?? "");
  if (direction === "long") {
    return group.includes("reversal") || group.includes("low_reversal") || group.includes("deep_reversal")
      ? "reversal_long"
      : "trend_long";
  }
  if (direction === "short") {
    return group.includes("reversal") || group.includes("high_fade") || group.includes("peak_reversal")
      ? "reversal_short"
      : "trend_short";
  }
  return null;
}

function marketAffinity(style: MarketRouteStyle | null, states: string[]) {
  if (!style) return 0;
  return states.reduce((best, state) => {
    let score = 0;
    if (state === "gap_down_recovery") score = style === "reversal_long" ? 5 : style === "trend_long" ? 3 : 0;
    else if (state === "gap_up_failure") score = style === "reversal_short" ? 5 : style === "trend_short" ? 3 : 0;
    else if (state === "strong_up" || state === "up") score = style === "trend_long" ? 4 : style === "reversal_long" ? 2 : 0;
    else if (state === "strong_down" || state === "down") score = style === "trend_short" ? 4 : style === "reversal_short" ? 2 : 0;
    return Math.max(best, score);
  }, 0);
}

function selectMarketContextRoutes(
  rawScores: Value[],
  allowedDirections: Array<"long" | "short">,
  marketStates: string[],
) {
  const symbols = Array.from(new Set(rawScores.map(row => String(row.symbol ?? "")).filter(Boolean))).sort();
  return symbols.map(symbol => {
    const symbolScores = rawScores.filter(row => row.symbol === symbol);
    const candidates = symbolScores
      .filter(marketContextCandidate)
      .filter(row => allowedDirections.includes(String(row.direction) as "long" | "short"))
      .map(row => ({ row, style: marketRouteStyle(row), affinity: marketAffinity(marketRouteStyle(row), marketStates) }))
      .filter(item => item.affinity > 0);
    const bestAffinity = candidates.reduce((best, item) => Math.max(best, item.affinity), 0);
    const best = candidates
      .filter(item => item.affinity === bestAffinity)
      .sort((a, b) => `${a.row.routeGroupId ?? ""}:${a.row.rowId ?? ""}`.localeCompare(`${b.row.routeGroupId ?? ""}:${b.row.rowId ?? ""}`));
    const chosen = best[0] ?? null;
    const selectedAlternatives = best.map(item => ({
      rowId: item.row.rowId ?? null,
      canonicalLogic: item.row.canonicalLogic ?? null,
      strategyVersion: item.row.strategyVersion ?? null,
      routeGroupId: item.row.routeGroupId ?? null,
      direction: item.row.direction ?? null,
      routeStyle: item.style,
      marketAffinityScore: item.affinity,
      completedTrades: finite(item.row.marketContextCompletedTrades),
      recent10PnlPer100: finite(item.row.marketContextRecent10PnlPer100),
      allPnlPer100: finite(item.row.marketContextAllPnlPer100),
    }));
    return {
      symbol,
      selectedRowId: chosen?.row.rowId ?? null,
      selectedCanonicalLogic: chosen?.row.canonicalLogic ?? null,
      selectedStrategyVersion: chosen?.row.strategyVersion ?? null,
      selectedDirection: chosen?.row.direction ?? null,
      routeStyle: chosen?.style ?? null,
      marketAffinityScore: chosen?.affinity ?? null,
      selectedAlternatives,
      unconditionalRecentPnlUsedForSelection: false,
      decision: chosen ? (best.length > 1 ? "selector_shadow_group" : "selector_shadow") : "no_selection",
      reason: chosen
        ? "market_regime_route_style_affinity"
        : allowedDirections.length === 0
          ? "combined_market_direction_unconfirmed"
          : symbolScores.some(marketContextCandidate)
            ? "no_route_style_compatible_with_market_regime"
            : "no_active_route_candidate",
    };
  });
}

/**
 * 前日閉場後に凍結したroute scoreを、場中の市場方向で絞るだけのシャドー選択。
 * source engine、既存shadow、資金配分、注文には接続しない。
 */
export function buildMarketContextSelectorShadowDecision(input: {
  tradeDate: string;
  sourceEventId: string;
  regime: IntradayMarketRegime;
  premarketRegime?: PremarketMarketRegime | null;
  routeSelectorSnapshot: unknown;
}) {
  const snapshot = object(input.routeSelectorSnapshot);
  const rawScores = Array.isArray(snapshot.scores) ? snapshot.scores.map(object) : [];
  const combinedRegime = combinePremarketAndIntraday(input.premarketRegime ?? null, input.regime);
  const selections = selectMarketContextRoutes(
    rawScores,
    combinedRegime.allowedDirections,
    [input.regime.state, input.premarketRegime?.state ?? "unavailable"],
  );
  const result = {
    version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
    tradeDate: input.tradeDate,
    sourceEventId: input.sourceEventId,
    decisionAt: input.regime.decisionAt,
    decisionStage: "intraday_fixed_checkpoint" as const,
    monitoringOnly: true,
    automaticAdoption: false,
    orderInstructionConnection: false,
    selectionPolicy: "market_regime_route_style_affinity_v1",
    unconditionalRecentPnlUsedForSelection: false,
    learningPolicy: "accumulate_outcomes_by_frozen_market_regime_before_conditional_ranking",
    premarketContextIntegrated: input.premarketRegime !== undefined && input.premarketRegime !== null,
    premarketRegime: input.premarketRegime ?? null,
    regime: input.regime,
    combinedRegime,
    selectorSnapshotVersion: snapshot.selectorVersion ?? null,
    selectorSnapshotInputHash: snapshot.inputHash ?? null,
    selections,
  };
  return { ...result, decisionHash: sha256Stable(result) };
}

/** 08:30に①〜③だけで作る、場中判断とは独立した開場前シャドー選択。 */
export function buildPremarketMarketContextSelectorShadowDecision(input: {
  tradeDate: string;
  sourceSnapshotId: string;
  premarketRegime: PremarketMarketRegime;
  routeSelectorSnapshot: unknown;
}) {
  const snapshot = object(input.routeSelectorSnapshot);
  const rawScores = Array.isArray(snapshot.scores) ? snapshot.scores.map(object) : [];
  const allowedDirections = input.premarketRegime.allowedDirections;
  const selections = selectMarketContextRoutes(rawScores, allowedDirections, [input.premarketRegime.state]);
  const result = {
    version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
    tradeDate: input.tradeDate,
    sourceEventId: input.sourceSnapshotId,
    decisionAt: "08:30",
    decisionStage: "premarket_0830" as const,
    monitoringOnly: true,
    automaticAdoption: false,
    orderInstructionConnection: false,
    selectionPolicy: "market_regime_route_style_affinity_v1",
    unconditionalRecentPnlUsedForSelection: false,
    learningPolicy: "accumulate_outcomes_by_frozen_market_regime_before_conditional_ranking",
    premarketContextIntegrated: true,
    premarketRegime: input.premarketRegime,
    regime: null,
    combinedRegime: {
      state: allowedDirections[0] ?? "wait",
      confidence: input.premarketRegime.confidence,
      allowedDirections,
      reasonCodes: allowedDirections.length > 0
        ? ["premarket_direction_applied_before_open"]
        : ["premarket_direction_unconfirmed"],
    },
    selectorSnapshotVersion: snapshot.selectorVersion ?? null,
    selectorSnapshotInputHash: snapshot.inputHash ?? null,
    selections,
  };
  return { ...result, decisionHash: sha256Stable(result) };
}
