import { writeFileSync } from "node:fs";
import { TEN_MONITORED_SYMBOLS } from "../server/multiSymbolMonitoringRegistry.ts";
import { classifyTechnicalMarketRegime } from "../server/technicalMarketRegime.ts";
import {
  applyTechnicalRegimeShadowTransition,
  buildTechnicalRegimePlan,
  createEmptyTechnicalRegimeShadowState,
  type TechnicalRegimePlan,
} from "../server/technicalRegimeShadow.ts";
import { calculateTechnicalIndicators, type TechnicalAnalysisCandle } from "../server/technicalAnalysisShadowV2.ts";
import type { ForwardSourceEventInput } from "../server/forwardShadow.ts";

const symbols = [...TEN_MONITORED_SYMBOLS];
const requestedTargetCount = Math.max(1, Number(process.argv[2] ?? 5));
const fetchFrom = process.argv[3] ?? (requestedTargetCount > 5 ? "2026-07-20" : "2026-08-17");
const fetchThrough = process.argv[4] ?? "2026-10-02";
const targetCoverage = process.argv[5] === "any" ? "any" : "all10";
const targetPolicyArgument = process.argv[6] ?? "current_raw";
const api = "https://stockalert-ulxu9jpf.manus.space/api/trpc/trading.getRtCandles?input=";

const TARGET_POLICIES = [
  "current_raw",
  "current_tick",
  "minimum_05r",
  "minimum_08r",
  "minimum_10r",
  "minimum_12r",
  "next_technical_level",
] as const;
type TargetPolicy = typeof TARGET_POLICIES[number];

type RawRow = Record<string, unknown>;
type Candle = TechnicalAnalysisCandle & { symbol: string; tradeDate: string; candleTime: string };
type FeatureWrapper = {
  symbol: string;
  featureEligible: boolean;
  provenanceStatus: "verified";
  features: Record<string, unknown>;
  technicalRegime?: ReturnType<typeof classifyTechnicalMarketRegime>;
};
type FeatureRow = { tradeDate: string; featuresBySymbol: Record<string, FeatureWrapper> };

function weekdays(from: string, through: string) {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${through}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

async function fetchDate(tradeDate: string) {
  const query = encodeURIComponent(JSON.stringify({ json: { tradeDate } }));
  const response = await fetch(`${api}${query}`);
  if (!response.ok) throw new Error(`candle_fetch_failed:${tradeDate}:${response.status}`);
  const body = await response.json() as { result?: { data?: { json?: RawRow[] } } };
  return body.result?.data?.json ?? [];
}

async function fetchLimited(dates: string[], concurrency = 5) {
  const result = new Map<string, RawRow[]>();
  let cursor = 0;
  async function worker() {
    while (cursor < dates.length) {
      const index = cursor++;
      const date = dates[index];
      result.set(date, await fetchDate(date));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

function asCandle(row: RawRow): Candle | null {
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  const volume = Number(row.volume);
  const symbol = String(row.symbol ?? "");
  const tradeDate = String(row.tradeDate ?? "");
  const candleTime = String(row.candleTime ?? "");
  if (!symbol || !tradeDate || !/^\d{2}:\d{2}$/.test(candleTime)) return null;
  if (![open, high, low, close, volume].every(Number.isFinite)) return null;
  return { symbol, tradeDate, candleTime, time: candleTime, open, high, low, close, volume };
}

function candlesFor(rows: RawRow[], symbol: string, tradeDate: string) {
  const byTime = new Map<string, Candle>();
  for (const row of rows) {
    const candle = asCandle(row);
    if (candle?.symbol === symbol && candle.tradeDate === tradeDate) byTime.set(candle.candleTime, candle);
  }
  return Array.from(byTime.values()).sort((a, b) => a.candleTime.localeCompare(b.candleTime));
}

function continuous(candles: Candle[]) {
  return candles.filter(item => (item.candleTime >= "09:00" && item.candleTime <= "11:29")
    || (item.candleTime >= "12:30" && item.candleTime <= "15:24"));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pct(delta: number, denominator: number | null) {
  return denominator && denominator > 0 ? delta / denominator * 100 : null;
}

function sessionBars60(candles: Candle[]) {
  const sessions = [
    candles.filter(item => item.candleTime >= "09:00" && item.candleTime <= "11:29"),
    candles.filter(item => item.candleTime >= "12:30" && item.candleTime <= "15:24"),
  ];
  return sessions.flatMap((session, sessionIndex) => {
    const output: Record<string, unknown>[] = [];
    for (let offset = 0; offset < session.length; offset += 60) {
      const window = session.slice(offset, offset + 60);
      if (!window.length) continue;
      const first = window[0];
      const last = window.at(-1)!;
      output.push({
        session: sessionIndex === 0 ? "morning" : "afternoon",
        minutes: window.length,
        startTime: first.candleTime,
        endTime: last.candleTime,
        open: first.open,
        high: Math.max(...window.map(item => item.high)),
        low: Math.min(...window.map(item => item.low)),
        close: last.close,
        volume: window.reduce((sum, item) => sum + item.volume, 0),
      });
    }
    return output;
  });
}

function makeFeature(symbol: string, tradeDate: string, dayCandles: Candle[], prior: FeatureRow[]) {
  const bars = continuous(dayCandles);
  const coverage = bars.length / 325;
  const first = bars[0];
  const last = bars.at(-1);
  if (!first || !last || coverage < 0.98) {
    return {
      symbol,
      featureEligible: false,
      provenanceStatus: "verified" as const,
      features: { featureEligible: false, sourceDate: tradeDate, coverage },
    };
  }
  const priorFeatures = prior.flatMap(row => {
    const feature = row.featuresBySymbol[symbol]?.features;
    return feature && Number.isFinite(Number(feature.close)) ? [feature] : [];
  });
  const high = Math.max(...bars.map(item => item.high));
  const low = Math.min(...bars.map(item => item.low));
  const volume = bars.reduce((sum, item) => sum + item.volume, 0);
  const dailyCandles: TechnicalAnalysisCandle[] = [
    ...priorFeatures.map((item, index) => ({
      time: String(item.sourceDate ?? index),
      open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close), volume: Number(item.volume),
    })),
    { time: tradeDate, open: first.open, high, low, close: last.close, volume },
  ];
  const indicators = calculateTechnicalIndicators(dailyCandles);
  const closes = dailyCandles.map(item => item.close);
  const volumes = dailyCandles.map(item => item.volume);
  const movingAverages = Object.fromEntries([5, 10, 20, 21, 25, 50].map(period => {
    const value = closes.length >= period ? average(closes.slice(-period)) : null;
    const previous = closes.length >= period + 1 ? average(closes.slice(-period - 1, -1)) : null;
    return [String(period), {
      value,
      slopePct: value !== null && previous !== null ? pct(value - previous, previous) : null,
      positionPct: value !== null ? pct(last.close - value, value) : null,
    }];
  }));
  const previousClose = priorFeatures.length ? Number(priorFeatures.at(-1)!.close) : null;
  const volume5 = volumes.length >= 6 ? average(volumes.slice(-6, -1)) : null;
  const volume20 = volumes.length >= 21 ? average(volumes.slice(-21, -1)) : null;
  const features: Record<string, unknown> = {
    featureEligible: true,
    sourceDate: tradeDate,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    gapPct: previousClose !== null ? pct(first.open - previousClose, previousClose) : null,
    atr14Pct: indicators.atr14 !== null ? pct(indicators.atr14, last.close) : null,
    movingAverages,
    bollinger20: indicators.bollingerMiddle === null ? null : {
      middle: indicators.bollingerMiddle,
      plus2: indicators.bollingerUpper,
      minus2: indicators.bollingerLower,
      bandwidthPct: indicators.bollingerBandwidthPct,
      percentB: indicators.bollingerPercentB,
    },
    volumeRatio: {
      to5: volume5 !== null ? pct(volume - volume5, volume5) : null,
      to20: volume20 !== null ? pct(volume - volume20, volume20) : null,
    },
    intraday: { sessionBars60: sessionBars60(bars) },
    technicalIndicators: {
      macd: indicators.macd,
      macdSignal: indicators.macdSignal,
      macdHistogram: indicators.macdHistogram,
      rsi14: indicators.rsi14,
      stochasticK: indicators.stochasticK,
      stochasticD: indicators.stochasticD,
      rciShort: indicators.rciShort,
      rciMedium: indicators.rciMedium,
      rciLong: indicators.rciLong,
    },
    coverage,
  };
  return { symbol, featureEligible: true, provenanceStatus: "verified" as const, features };
}

function buildFeatureRows(rowsByDate: Map<string, RawRow[]>, dates: string[]) {
  const output: FeatureRow[] = [];
  for (const tradeDate of dates) {
    const raw = rowsByDate.get(tradeDate) ?? [];
    if (!raw.length) continue;
    const featuresBySymbol: Record<string, FeatureWrapper> = {};
    for (const symbol of symbols) featuresBySymbol[symbol] = makeFeature(symbol, tradeDate, candlesFor(raw, symbol, tradeDate), output);
    for (const symbol of symbols) {
      const current = featuresBySymbol[symbol];
      const history = output.map(item => item.featuresBySymbol[symbol]).filter(Boolean);
      current.technicalRegime = classifyTechnicalMarketRegime({ current, history, universeCurrent: featuresBySymbol });
    }
    output.push({ tradeDate, featuresBySymbol });
  }
  return output;
}

function sourceDateFor(target: string, features: FeatureRow[]) {
  return features.filter(item => item.tradeDate < target).at(-1)?.tradeDate ?? null;
}

function makeInput(candle: Candle, sequence: number): ForwardSourceEventInput {
  const now = Date.parse(`${candle.tradeDate}T${candle.candleTime}:30+09:00`);
  return {
    sourceEventId: `reference:${candle.symbol}:${candle.tradeDate}:${candle.candleTime}`,
    candle: {
      symbol: candle.symbol,
      tradeDate: candle.tradeDate,
      candleTime: candle.candleTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
    // The public candle ledger does not retain raw depth.  One level at the
    // next completed minute's open is an explicitly labelled execution proxy.
    board: { asks: [{ price: candle.open, qty: 10_000 }], bids: [{ price: candle.open, qty: 10_000 }] },
    currentAudit: {
      engineSequence: sequence,
      resultType: "reference_replay",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "reference",
      stateHashAfter: "reference",
      causalityStatus: "reference_proxy",
      causalityReason: "public_candle_ledger_has_no_raw_depth",
      boardObservedAtMs: now,
      relayAssembledAtMs: now + 25,
      relaySentAtMs: now + 50,
      cloudReceivedAtMs: now + 100,
      decisionStartedAtMs: now + 110,
      decisionCompletedAtMs: now + 150,
    },
  };
}

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function inferObservedTick(candles: Candle[]) {
  const scaled = Array.from(new Set(candles.flatMap(candle => [candle.open, candle.high, candle.low, candle.close])
    .filter(Number.isFinite)
    .map(value => Math.round(value * 10))));
  if (scaled.length < 2) return 1;
  const base = scaled[0];
  const common = scaled.slice(1).reduce((value, item) => gcd(value, item - base), 0);
  const raw = common > 0 ? common / 10 : 0.1;
  const allowed = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1_000];
  return allowed.filter(value => value <= raw + 1e-9).at(-1) ?? 0.1;
}

function roundTargetInProfitDirection(side: "long" | "short", target: number, tick: number) {
  const units = target / tick;
  const rounded = side === "long" ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9);
  return rounded * tick;
}

function selectCounterfactualTarget(input: {
  policy: TargetPolicy;
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  currentTarget: number;
  candidates: number[];
  tick: number;
}) {
  const { policy, side, entryPrice, stopPrice, currentTarget, tick } = input;
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (!(risk > 0) || policy === "current_raw") return currentTarget;
  const ordered = Array.from(new Set(input.candidates.filter(Number.isFinite)))
    .filter(value => side === "long" ? value > entryPrice : value < entryPrice)
    .sort((left, right) => side === "long" ? left - right : right - left);
  if (policy === "current_tick") return roundTargetInProfitDirection(side, currentTarget, tick);
  if (policy === "next_technical_level") {
    const target = ordered[1] ?? ordered[0] ?? currentTarget;
    return roundTargetInProfitDirection(side, target, tick);
  }
  const minimumR = policy === "minimum_05r" ? 0.5
    : policy === "minimum_08r" ? 0.8
      : policy === "minimum_10r" ? 1
        : 1.2;
  const candidate = ordered.find(value => {
    const reward = side === "long" ? value - entryPrice : entryPrice - value;
    return reward / risk >= minimumR - 1e-9;
  });
  const fallback = side === "long" ? entryPrice + risk * minimumR : entryPrice - risk * minimumR;
  return roundTargetInProfitDirection(side, candidate ?? fallback, tick);
}

function replay(symbol: string, tradeDate: string, plan: TechnicalRegimePlan, candles: Candle[], targetPolicy: TargetPolicy) {
  let state = createEmptyTechnicalRegimeShadowState(plan, tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  const targetCandidatesBySignal = new Map<string, number[]>();
  const tick = inferObservedTick(candles);
  for (const [index, candle] of candles.entries()) {
    if (candle.candleTime < "09:00" || candle.candleTime > "15:30") continue;
    const transition = applyTechnicalRegimeShadowTransition(state, makeInput(candle, index + 1), "signal_quality");
    const sourceEventId = `reference:${candle.symbol}:${candle.tradeDate}:${candle.candleTime}`;
    for (const action of transition.actions) {
      if (action.type !== "signal_pending_next_event") continue;
      const candidates = Array.isArray(action.targetCandidates)
        ? action.targetCandidates.map(Number).filter(Number.isFinite)
        : [];
      targetCandidatesBySignal.set(sourceEventId, candidates);
    }
    if (transition.openedPosition && targetPolicy !== "current_raw") {
      const position = transition.openedPosition;
      const originalTargetPrice = position.targetPrice;
      const targetPrice = selectCounterfactualTarget({
        policy: targetPolicy,
        side: position.side,
        entryPrice: position.entryPrice,
        stopPrice: position.initialStopPrice,
        currentTarget: originalTargetPrice,
        candidates: targetCandidatesBySignal.get(position.signalSourceEventId) ?? [],
        tick,
      });
      const risk = position.side === "long"
        ? position.entryPrice - position.initialStopPrice
        : position.initialStopPrice - position.entryPrice;
      const reward = position.side === "long"
        ? targetPrice - position.entryPrice
        : position.entryPrice - targetPrice;
      position.targetPrice = targetPrice;
      position.rewardRisk = reward / risk;
      position.tpPct = reward / position.entryPrice * 100;
      if (transition.nextState.position) transition.nextState.position = position;
      for (const action of transition.actions) {
        if (action.type !== "entry") continue;
        action.originalTargetPrice = originalTargetPrice;
        action.targetPrice = targetPrice;
        action.technicalRewardRisk = position.rewardRisk;
        action.targetPolicy = targetPolicy;
        action.observedTickProxy = tick;
      }
    }
    state = transition.nextState;
    actions.push(...transition.actions
      .filter(action => ["signal_pending_next_event", "entry_rejected", "entry", "exit"].includes(String(action.type)))
      .map(action => ({ ...action, eventTime: candle.candleTime, sourceEventId })));
  }
  const entries = actions.filter(action => action.type === "entry");
  const exits = actions.filter(action => action.type === "exit");
  const rejections = actions.filter(action => action.type === "entry_rejected");
  return {
    symbol,
    tradeDate,
    targetPolicy,
    observedTickProxy: tick,
    sourceTradeDate: plan.sourceTradeDate,
    plan: { kind: plan.kind, setup: plan.setup, confidence: plan.confidence, dailyTrend: plan.dailyTrend, reasonCodes: plan.reasonCodes },
    signals: actions.filter(action => action.type === "signal_pending_next_event"),
    entries,
    exits,
    rejections,
    openAtEnd: state.position,
    pnlPer100: exits.reduce((sum, action) => sum + Number(action.pnl ?? 0), 0),
  };
}

const dates = weekdays(fetchFrom, fetchThrough);
const rowsByDate = await fetchLimited(dates);
const targets = dates.filter(date => {
  const observed = new Set((rowsByDate.get(date) ?? []).map(row => String(row.symbol ?? "")));
  return targetCoverage === "any" ? observed.size > 0 : symbols.every(symbol => observed.has(symbol));
}).slice(-requestedTargetCount);
const featureRows = buildFeatureRows(rowsByDate, dates);
const requestedPolicies: TargetPolicy[] = targetPolicyArgument === "compare-targets"
  ? [...TARGET_POLICIES]
  : TARGET_POLICIES.includes(targetPolicyArgument as TargetPolicy)
    ? [targetPolicyArgument as TargetPolicy]
    : ["current_raw"];

function buildDetails(targetPolicy: TargetPolicy) {
  return targets.flatMap(tradeDate => {
    const sourceTradeDate = sourceDateFor(tradeDate, featureRows);
    const source = featureRows.find(item => item.tradeDate === sourceTradeDate);
    const targetRows = rowsByDate.get(tradeDate) ?? [];
    return symbols.map(symbol => {
      const wrapper = source?.featuresBySymbol[symbol];
      const plan = buildTechnicalRegimePlan({ symbol, sourceTradeDate, featureWrapper: wrapper });
      return replay(symbol, tradeDate, plan, candlesFor(targetRows, symbol, tradeDate), targetPolicy);
    });
  });
}

function summarize(details: ReturnType<typeof buildDetails>) {
  const traded = details.filter(item => item.exits.length > 0 || item.openAtEnd);
  const wins = traded.filter(item => item.pnlPer100 > 0).length;
  const losses = traded.filter(item => item.pnlPer100 < 0).length;
  const draws = traded.filter(item => item.pnlPer100 === 0).length;
  return {
    symbolDays: details.length,
    planKinds: Object.fromEntries(["trend_breakout_long", "trend_breakdown_short", "range_reversal", "no_trade"].map(kind => [kind, details.filter(item => item.plan.kind === kind).length])),
    signalDays: details.filter(item => item.signals.length > 0).length,
    entryDays: traded.length,
    rejectedDays: details.filter(item => item.rejections.length > 0).length,
    wins,
    losses,
    draws,
    winRate: wins + losses + draws > 0 ? wins / (wins + losses + draws) * 100 : null,
    pnlPer100: traded.reduce((sum, item) => sum + item.pnlPer100, 0),
  };
}

const detailsByPolicy = Object.fromEntries(requestedPolicies.map(policy => [policy, buildDetails(policy)])) as Record<TargetPolicy, ReturnType<typeof buildDetails>>;
const primaryPolicy = requestedPolicies[0];
const details = detailsByPolicy[primaryPolicy];
const summary = summarize(details);
const output = {
  generatedAt: new Date().toISOString(),
  logicVersion: "technical-analysis-shadow-v2",
  formalForwardScore: false,
  referenceOnly: true,
  targetCoverage,
  coverageByDate: Object.fromEntries(targets.map(date => {
    const observed = new Set((rowsByDate.get(date) ?? []).map(row => String(row.symbol ?? "")));
    return [date, { observedSymbols: symbols.filter(symbol => observed.has(symbol)), observedSymbolCount: symbols.filter(symbol => observed.has(symbol)).length }];
  })),
  targetDates: targets,
  causality: "D-1 daily/hourly frozen; intraday completed one-minute candles processed sequentially",
  executionProxy: "next source minute open; raw same-event directional depth unavailable in public rt_candles",
  featureProxy: "public rt_candles; >=98% continuous-session coverage accepted for the D-1 reference feature",
  targetPolicies: requestedPolicies,
  summary,
  policyComparison: Object.fromEntries(requestedPolicies.map(policy => [policy, summarize(detailsByPolicy[policy])])),
  byDate: targets.map(tradeDate => {
    const rows = details.filter(item => item.tradeDate === tradeDate);
    const dayTrades = rows.filter(item => item.exits.length > 0 || item.openAtEnd);
    return {
      tradeDate,
      signalDays: rows.filter(item => item.signals.length > 0).length,
      trades: dayTrades.length,
      wins: dayTrades.filter(item => item.pnlPer100 > 0).length,
      losses: dayTrades.filter(item => item.pnlPer100 < 0).length,
      pnlPer100: dayTrades.reduce((sum, item) => sum + item.pnlPer100, 0),
    };
  }),
  details,
  detailsByPolicy: targetPolicyArgument === "compare-targets" ? detailsByPolicy : undefined,
};

const coverageSuffix = targetCoverage === "all10" ? "" : `-${targetCoverage}`;
const policySuffix = targetPolicyArgument === "current_raw" ? "" : `-${targetPolicyArgument}`;
const outputPath = `analysis/technical-shadow-v2-last${requestedTargetCount}${coverageSuffix}-${targets[0]?.replaceAll("-", "")}-${targets.at(-1)?.replaceAll("-", "")}${policySuffix}.json`;
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, summary: output.summary, policyComparison: output.policyComparison, byDate: output.byDate }, null, 2));
