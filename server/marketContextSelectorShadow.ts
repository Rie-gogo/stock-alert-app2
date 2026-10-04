import { sha256Stable } from "./runtimeIdentity";

export const MARKET_CONTEXT_SELECTOR_SHADOW_VERSION = "market-context-selector-shadow-v1-monitoring";

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

/**
 * 前日閉場後に凍結したroute scoreを、場中の市場方向で絞るだけのシャドー選択。
 * source engine、既存shadow、資金配分、注文には接続しない。
 */
export function buildMarketContextSelectorShadowDecision(input: {
  tradeDate: string;
  sourceEventId: string;
  regime: IntradayMarketRegime;
  routeSelectorSnapshot: unknown;
}) {
  const snapshot = object(input.routeSelectorSnapshot);
  const rawScores = Array.isArray(snapshot.scores) ? snapshot.scores.map(object) : [];
  const symbols = Array.from(new Set(rawScores.map(row => String(row.symbol ?? "")).filter(Boolean))).sort();
  const selections = symbols.map(symbol => {
    const candidates = rawScores
      .filter(row => row.symbol === symbol)
      .filter(row => row.selectable === true)
      .filter(row => input.regime.allowedDirections.includes(String(row.direction) as "long" | "short"))
      .filter(row => (finite(row.expectedDailyPnlPer100) ?? 0) > 0)
      .sort((a, b) => {
        const expected = (finite(b.expectedDailyPnlPer100) ?? 0) - (finite(a.expectedDailyPnlPer100) ?? 0);
        return expected !== 0 ? expected : (finite(b.recentTrendRankingPnlPerTrade) ?? 0) - (finite(a.recentTrendRankingPnlPerTrade) ?? 0);
      });
    const chosen = candidates[0] ?? null;
    return {
      symbol,
      selectedRowId: chosen?.rowId ?? null,
      selectedCanonicalLogic: chosen?.canonicalLogic ?? null,
      selectedStrategyVersion: chosen?.strategyVersion ?? null,
      selectedDirection: chosen?.direction ?? null,
      expectedDailyPnlPer100: finite(chosen?.expectedDailyPnlPer100),
      decision: chosen ? "selector_shadow" : "no_selection",
      reason: chosen ? "d_minus_1_route_score_filtered_by_intraday_market_context" : input.regime.allowedDirections.length === 0 ? "market_direction_unconfirmed" : "no_positive_eligible_route_for_market_direction",
    };
  });
  const result = {
    version: MARKET_CONTEXT_SELECTOR_SHADOW_VERSION,
    tradeDate: input.tradeDate,
    sourceEventId: input.sourceEventId,
    decisionAt: input.regime.decisionAt,
    monitoringOnly: true,
    automaticAdoption: false,
    orderInstructionConnection: false,
    premarketContextIntegrated: false,
    regime: input.regime,
    selectorSnapshotVersion: snapshot.selectorVersion ?? null,
    selectorSnapshotInputHash: snapshot.inputHash ?? null,
    selections,
  };
  return { ...result, decisionHash: sha256Stable(result) };
}
