import {
  aiPositionManagementPlanSchema,
  aiPositionId,
  type AiPositionManagementPlan,
} from "./aiPositionManagement";
import { randomUUID } from "node:crypto";
import type {
  ForwardEvaluationMode,
  ForwardSourceEventInput,
} from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtForwardShadowState,
  getRtStrategyVersion,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtForwardShadowEvent,
  updateRtStrategyVersionStatus,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import {
  AI_DAILY_FORECAST_VERSIONS,
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS,
  RETIRED_AI_DAILY_FORECAST_V1_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS,
  RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import { calculateDepthVwap } from "./telExecutableConfirmDepth";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  getAiDailyForecastDashboard,
  type AiDailyForecastSymbol,
} from "./aiDailyForecastService";
import {
  AI_INTRADAY_CHECKPOINTS,
  getAiIntradayCheckpointSpec,
  getEffectiveAiIntradayForecastSnapshot,
} from "./aiIntradayForecastService";

export const AI_DAILY_FORECAST_LEARNING_CUTOFF_DATE = "2026-10-10";
/** v5と同日混在させない、v6の最初のJPX営業日。 */
export const AI_DAILY_FORECAST_COLLECTION_START_DATE = "2026-10-15";
export const AI_DAILY_FORECAST_STRATEGY_VERSIONS =
  AI_DAILY_FORECAST_VERSIONS as Record<AiDailyForecastSymbol, string>;
const MODES: readonly ForwardEvaluationMode[] =
  FORWARD_EVALUATION_POLICY.evaluationModes;
const symbols = new Set<string>(AI_DAILY_FORECAST_SYMBOLS);
const ensured = new Set<string>();
const planDataCache = new Map<
  string,
  Promise<{
    dashboard: Awaited<ReturnType<typeof getAiDailyForecastDashboard>>;
    intradaySnapshot: Awaited<
      ReturnType<typeof getEffectiveAiIntradayForecastSnapshot>
    >;
  }>
>();

type Side = "long" | "short";
export type AiDailyForecastPlan = {
  sourceSnapshotId: string;
  qualityStatus: string;
  symbol: string;
  direction: string;
  forecastLow: number;
  forecastHigh: number;
  zoneLow: number;
  zoneHigh: number;
  confirmPrice: number;
  protectiveStop?: number;
  knowledgeIds?: string[];
  firstTarget: number;
  stretchTarget: number;
  atr5: number;
  stopPrice: number;
  entryPolicy?: "entry_allowed" | "manage_only";
  entryBlockedByRevision: boolean;
  entryBlockReason?: string | null;
  checkpoint: string;
  entryWindowStart: string;
  entryWindowEnd: string;
  forceExitTime: string;
  openPositionAction:
    | "keep"
    | "tighten_only"
    | "exit_next_event_if_direction_changed";
};
type Plan = AiDailyForecastPlan;
type PlanSelection = {
  managementReceivedAtMs?: number;
  managementPlans?: AiPositionManagementPlan[];
  activePlanId: string | null;
  plan: Plan | null;
  disabledReason: string | null;
  openPositionAction:
    | "keep"
    | "tighten_only"
    | "exit_next_event_if_direction_changed";
};
type Position = {
  managementVersion?: "checkpoint_v1";
  positionId?: string;
  managementPlan?: AiPositionManagementPlan;
  consumedManagementPlanIds?: string[];
  managementExpired?: boolean;
  pendingManagementExit?: string;
  knowledgeIds?: string[];
  side: Side;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  targetPrice: number;
  stretchTarget?: number;
  stopPrice: number;
  initialRiskPerShare: number;
  shares: number;
  sourceBoardAgeMs: number;
  deliveryBoardAgeMs: number | null;
  planSnapshotId: string;
  forceExitTime: string;
  /** New v6 positions treat firstTarget as a protection decision, not a fill. */
  firstTargetDecisionEnabled?: boolean;
  successorWaitEnabled?: boolean;
  revalidationObservationEnabled?: boolean;
  profitProtectionArmed?: boolean;
  protectionLine?: number | null;
  pendingProtectionExit?: { signalTime: string; line: number } | null;
  pendingTightening?: {
    decisionTime: string;
    stopPrice: number;
    targetPrice: number;
    stretchTarget: number;
  } | null;
  firstTargetReachedAt?: string | null;
  adverseSma20Consecutive?: number;
  lastSma20?: number | null;
  awaitingSuccessorPlan?: {
    checkpoint: string;
    validUntil: string;
    startedAt: string;
    priorPlanId: string;
  } | null;
};
type State = {
  tradeDate: string;
  activePlanId: string | null;
  plan: Plan | null;
  touched: { sourceEventId: string; time: string; side: Side } | null;
  position: Position | null;
  /** 成功entry済みのimmutable AI plan/revision ID。日次回数制限ではない。 */
  executedPlanIds: string[];
  /** Fixed-size observation buffer; never read by the normal trading engine. */
  recentCloses?: number[];
  recentCandles?: Array<{ time: string; low: number; high: number }>;
  lastSourceEventId: string | null;
  lastActions: Array<Record<string, unknown>>;
};

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function hasOpenPosition(value: unknown) {
  const position = object(value).position;
  return Boolean(
    position && typeof position === "object" && !Array.isArray(position)
  );
}
function minute(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
function formatMinute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function successorDeadline(forceExitTime: string) {
  const expiredAt = minute(forceExitTime);
  const successor = AI_INTRADAY_CHECKPOINTS.find(
    checkpoint => minute(checkpoint) >= expiredAt
  );
  const validUntil = successor
    ? getAiIntradayCheckpointSpec(successor)?.validUntil
    : null;
  return Math.min(minute(validUntil ?? "15:20"), minute("15:20"));
}
function currentJstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}
function emptyState(tradeDate: string): State {
  return {
    tradeDate,
    activePlanId: null,
    plan: null,
    touched: null,
    position: null,
    executedPlanIds: [],
    recentCloses: [],
    lastSourceEventId: null,
    lastActions: [],
  };
}
function normalizeState(value: unknown, tradeDate: string): State {
  const raw = object(value);
  if (raw.tradeDate !== tradeDate) return emptyState(tradeDate);
  const plan =
    raw.plan && typeof raw.plan === "object" ? (raw.plan as Plan) : null;
  const positionRaw =
    raw.position && typeof raw.position === "object"
      ? (raw.position as Position)
      : null;
  const position = positionRaw
    ? {
        ...positionRaw,
        initialRiskPerShare:
          positionRaw.initialRiskPerShare ??
          Math.abs(positionRaw.entryPrice - positionRaw.stopPrice),
        planSnapshotId:
          positionRaw.planSnapshotId ?? plan?.sourceSnapshotId ?? "legacy",
        forceExitTime: positionRaw.forceExitTime ?? "15:20",
        stretchTarget: positionRaw.stretchTarget ?? positionRaw.targetPrice,
        firstTargetDecisionEnabled:
          positionRaw.firstTargetDecisionEnabled ?? false,
        successorWaitEnabled: positionRaw.successorWaitEnabled ?? false,
        revalidationObservationEnabled:
          positionRaw.revalidationObservationEnabled ?? false,
        profitProtectionArmed: positionRaw.profitProtectionArmed ?? false,
        firstTargetReachedAt: positionRaw.firstTargetReachedAt ?? null,
        adverseSma20Consecutive: positionRaw.adverseSma20Consecutive ?? 0,
        lastSma20: positionRaw.lastSma20 ?? null,
        awaitingSuccessorPlan: positionRaw.awaitingSuccessorPlan ?? null,
      }
    : null;
  return {
    tradeDate,
    activePlanId:
      typeof raw.activePlanId === "string"
        ? raw.activePlanId
        : (plan?.sourceSnapshotId ?? null),
    plan,
    touched:
      raw.touched && typeof raw.touched === "object"
        ? (raw.touched as State["touched"])
        : null,
    position,
    // v4以前の停止済みstateを読み込む場合だけ、旧slot消費を当時の計画IDへ互換投影する。
    // v5の新stateでは日次回数上限を保持しない。
    executedPlanIds: Array.isArray(raw.executedPlanIds)
      ? Array.from(
          new Set(
            raw.executedPlanIds.filter(
              (value): value is string => typeof value === "string"
            )
          )
        )
      : raw.dailySlotConsumed === true && typeof raw.activePlanId === "string"
        ? [raw.activePlanId]
        : [],
    recentCandles: Array.isArray(raw.recentCandles)
      ? (raw.recentCandles.slice(-3) as State["recentCandles"])
      : [],
    recentCloses: Array.isArray(raw.recentCloses)
      ? raw.recentCloses
          .map(number)
          .filter((value): value is number => value !== null)
          .slice(-20)
      : [],
    lastSourceEventId:
      typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastActions: Array.isArray(raw.lastActions)
      ? (raw.lastActions as Array<Record<string, unknown>>)
      : [],
  };
}

function planFromSnapshot(
  snapshot: Awaited<ReturnType<typeof getAiDailyForecastDashboard>>["snapshot"],
  symbol: string,
  entryBlockedByRevision: boolean
): Plan | null {
  if (!snapshot || snapshot.qualityStatus === "invalid") return null;
  const frozenInput = object(snapshot.inputJson);
  const learningAudit = object(frozenInput.learningApplicationAudit);
  const coldStartAllowed =
    learningAudit.learningMode === "cold_start" &&
    learningAudit.learningApplied === false;
  const learnedValid =
    object(frozenInput.learningSnapshot).sourceSnapshotId !== undefined;
  if (!coldStartAllowed && !learnedValid) return null;
  const payload = object(snapshot.forecastJson);
  const output = object(payload.aiFinalForecast);
  const forecasts = Array.isArray(output.forecasts) ? output.forecasts : [];
  const row = forecasts.find(item => object(item).symbol === symbol);
  const values = object(row);
  const baseline = (
    Array.isArray(payload.quantBaseline) ? payload.quantBaseline : []
  ).find(item => object(item).symbol === symbol);
  const base = object(baseline);
  const direction = String(values.direction ?? "");
  const directional =
    direction === "strong_up" ||
    direction === "up" ||
    direction === "strong_down" ||
    direction === "down";
  const forecastLow = number(values.forecastLow),
    forecastHigh = number(values.forecastHigh),
    zoneLow = number(values.zoneLow),
    zoneHigh = number(values.zoneHigh),
    confirmPrice = number(values.confirmPrice),
    firstTarget = number(values.firstTarget),
    stretchTarget = number(values.stretchTarget),
    atr5 = number(base.atr5);
  if (
    !directional ||
    forecastLow === null ||
    forecastHigh === null ||
    zoneLow === null ||
    zoneHigh === null ||
    confirmPrice === null ||
    firstTarget === null ||
    stretchTarget === null ||
    atr5 === null
  )
    return null;
  const long = direction === "strong_up" || direction === "up";
  const stopPrice = long
    ? Math.min(forecastLow, zoneLow - 0.15 * atr5)
    : Math.max(forecastHigh, zoneHigh + 0.15 * atr5);
  if (
    !(
      forecastLow < zoneLow &&
      zoneLow <= zoneHigh &&
      zoneHigh < forecastHigh
    ) ||
    !(stopPrice > 0)
  )
    return null;
  return {
    sourceSnapshotId: snapshot.sourceSnapshotId,
    qualityStatus: snapshot.qualityStatus,
    symbol,
    direction,
    forecastLow,
    forecastHigh,
    zoneLow,
    zoneHigh,
    confirmPrice,
    protectiveStop: number(values.protectiveStop) ?? undefined,
    knowledgeIds: Array.isArray(values.knowledgeIds)
      ? values.knowledgeIds.map(String)
      : [],
    firstTarget,
    stretchTarget,
    atr5,
    stopPrice,
    entryBlockedByRevision,
    entryBlockReason: entryBlockedByRevision
      ? "market_context_revision_invalidated_unentered_signals"
      : null,
    checkpoint: "08:30",
    entryWindowStart: "09:00",
    entryWindowEnd: "15:19",
    forceExitTime: "15:20",
    openPositionAction: "keep",
  };
}
export function selectAiDailyPlanForTest(
  snapshot: {
    sourceSnapshotId: string;
    qualityStatus: string;
    forecastJson: unknown;
    inputJson: unknown;
  } | null,
  symbol: string
) {
  return planFromSnapshot(
    snapshot as Awaited<
      ReturnType<typeof getAiDailyForecastDashboard>
    >["snapshot"],
    symbol,
    false
  );
}

function planFromIntradaySnapshot(
  snapshot: Awaited<ReturnType<typeof getEffectiveAiIntradayForecastSnapshot>>,
  symbol: string
): PlanSelection | null {
  if (!snapshot || snapshot.qualityStatus === "invalid") return null;
  const payload = object(snapshot.forecastJson);
  const final = object(payload.aiFinalForecast);
  const managementPlans = (
    Array.isArray(final.managementPlans) ? final.managementPlans : []
  ).flatMap(value => {
    const parsed = aiPositionManagementPlanSchema.safeParse(value);
    return parsed.success && parsed.data.symbol === symbol ? [parsed.data] : [];
  });
  const forecast = object(final.forecast);
  const rows = Array.isArray(forecast.forecasts) ? forecast.forecasts : [];
  const values = object(rows.find(item => object(item).symbol === symbol));
  const controls = Array.isArray(final.controls) ? final.controls : [];
  const control = object(controls.find(item => object(item).symbol === symbol));
  const input = object(snapshot.inputJson);
  const priorData = object(input.priorData);
  const priorSymbols = Array.isArray(priorData.symbols)
    ? priorData.symbols
    : [];
  const priorSymbol = object(
    priorSymbols.find(item => object(item).symbol === symbol)
  );
  const baseline = object(priorSymbol.baseline);
  const direction = String(values.direction ?? "");
  const directional =
    direction === "strong_up" ||
    direction === "up" ||
    direction === "strong_down" ||
    direction === "down";
  const action =
    control.openPositionAction === "tighten_only" ||
    control.openPositionAction === "exit_next_event_if_direction_changed"
      ? control.openPositionAction
      : "keep";
  const activationAudit = object(
    object(snapshot.validationJson).activationAudit
  );
  const activationSymbols = Array.isArray(activationAudit.symbols)
    ? activationAudit.symbols
    : [];
  const activationSymbol = object(
    activationSymbols.find(item => object(item).symbol === symbol)
  );
  const missedMove =
    activationSymbol.entryDisposition === "missed_move_no_entry";
  if (control.planDecision === "disabled" || !directional)
    return {
      managementReceivedAtMs: number(activationAudit.receivedAtMs) ?? undefined,
      managementPlans,
      activePlanId: snapshot.sourceRevisionId,
      plan: null,
      disabledReason: String(
        control.changeReason ?? "ai_intraday_plan_disabled"
      ),
      openPositionAction: action,
    };
  const forecastLow = number(values.forecastLow),
    forecastHigh = number(values.forecastHigh),
    zoneLow = number(values.zoneLow),
    zoneHigh = number(values.zoneHigh),
    confirmPrice = number(values.confirmPrice),
    firstTarget = number(values.firstTarget),
    stretchTarget = number(values.stretchTarget),
    atr5 = number(baseline.atr5);
  if (
    forecastLow === null ||
    forecastHigh === null ||
    zoneLow === null ||
    zoneHigh === null ||
    confirmPrice === null ||
    firstTarget === null ||
    stretchTarget === null ||
    atr5 === null
  )
    return {
      managementReceivedAtMs: number(activationAudit.receivedAtMs) ?? undefined,
      managementPlans,
      activePlanId: snapshot.sourceRevisionId,
      plan: null,
      disabledReason: "ai_intraday_directional_prices_invalid",
      openPositionAction: action,
    };
  const long = direction === "strong_up" || direction === "up";
  const stopPrice = long
    ? Math.min(forecastLow, zoneLow - 0.15 * atr5)
    : Math.max(forecastHigh, zoneHigh + 0.15 * atr5);
  if (
    !(
      forecastLow < zoneLow &&
      zoneLow <= zoneHigh &&
      zoneHigh < forecastHigh
    ) ||
    !(stopPrice > 0)
  )
    return {
      managementReceivedAtMs: number(activationAudit.receivedAtMs) ?? undefined,
      managementPlans,
      activePlanId: snapshot.sourceRevisionId,
      plan: null,
      disabledReason: "ai_intraday_price_order_invalid",
      openPositionAction: action,
    };
  return {
    managementReceivedAtMs: number(activationAudit.receivedAtMs) ?? undefined,
    managementPlans,
    activePlanId: snapshot.sourceRevisionId,
    disabledReason: missedMove ? "missed_move_no_entry" : null,
    openPositionAction: action,
    plan: {
      sourceSnapshotId: snapshot.sourceRevisionId,
      qualityStatus: snapshot.qualityStatus,
      symbol,
      direction,
      forecastLow,
      forecastHigh,
      zoneLow,
      zoneHigh,
      confirmPrice,
      protectiveStop: number(values.protectiveStop) ?? undefined,
      knowledgeIds: Array.isArray(values.knowledgeIds)
        ? values.knowledgeIds.map(String)
        : [],
      firstTarget,
      stretchTarget,
      atr5,
      stopPrice,
      entryPolicy:
        control.entryPolicy === "manage_only" ? "manage_only" : "entry_allowed",
      entryBlockedByRevision: missedMove,
      entryBlockReason: missedMove ? "missed_move_no_entry" : null,
      checkpoint: snapshot.checkpoint,
      entryWindowStart: String(control.entryWindowStart ?? snapshot.checkpoint),
      entryWindowEnd: String(control.entryWindowEnd ?? "15:19"),
      forceExitTime: String(control.forceExitTime ?? "15:20"),
      openPositionAction: action,
    },
  };
}
export function selectAiIntradayPlanForTest(
  snapshot: {
    sourceRevisionId: string;
    qualityStatus: string;
    checkpoint: string;
    forecastJson: unknown;
    inputJson: unknown;
    validationJson: unknown;
  } | null,
  symbol: string
) {
  return planFromIntradaySnapshot(
    snapshot as Awaited<
      ReturnType<typeof getEffectiveAiIntradayForecastSnapshot>
    >,
    symbol
  );
}
function sideForPlan(plan: Plan): Side {
  return plan.direction === "strong_up" || plan.direction === "up"
    ? "long"
    : "short";
}
function getPlanData(
  tradeDate: string,
  candleTime: string,
  engineSequence: number | null
) {
  const key = `${tradeDate}:${candleTime}:${engineSequence ?? "missing"}`;
  const existing = planDataCache.get(key);
  if (existing) return existing;
  const created = Promise.all([
    getAiDailyForecastDashboard(tradeDate),
    getEffectiveAiIntradayForecastSnapshot(
      tradeDate,
      candleTime,
      engineSequence
    ),
  ]).then(([dashboard, intradaySnapshot]) => ({ dashboard, intradaySnapshot }));
  planDataCache.set(key, created);
  while (planDataCache.size > 8)
    planDataCache.delete(planDataCache.keys().next().value!);
  return created;
}
function boardExecution(
  source: ForwardSourceEventInput,
  side: Side,
  mode: ForwardEvaluationMode,
  exitShares?: number
) {
  const audit = source.currentAudit;
  const boardAge =
    audit?.boardObservedAtMs !== null &&
    audit?.boardObservedAtMs !== undefined &&
    audit?.relayAssembledAtMs !== null &&
    audit?.relayAssembledAtMs !== undefined
      ? audit.relayAssembledAtMs - audit.boardObservedAtMs
      : null;
  const causal = boardAge !== null && boardAge >= 0 && boardAge <= 5_000;
  if (!causal)
    return {
      valid: false as const,
      reason:
        boardAge === null
          ? "board_timestamps_missing"
          : boardAge < 0
            ? "board_future_or_noncausal"
            : "board_stale",
    };
  const shares =
    exitShares ??
    (mode === "signal_quality"
      ? 100
      : Math.max(
          100,
          Math.floor(2_700_000 / Math.max(1, source.candle.close) / 100) * 100
        ));
  const vwap = calculateDepthVwap({ board: source.board, side, shares });
  if (!vwap)
    return { valid: false as const, reason: "directional_depth_insufficient" };
  const delivery =
    audit?.cloudReceivedAtMs !== null &&
    audit?.cloudReceivedAtMs !== undefined &&
    audit?.decisionCompletedAtMs !== undefined
      ? Math.max(
          0,
          (audit.relaySentAtMs ?? audit.relayAssembledAtMs ?? 0) -
            (audit.boardObservedAtMs ?? 0)
        ) + Math.max(0, audit.decisionCompletedAtMs - audit.cloudReceivedAtMs)
      : null;
  return {
    valid: true as const,
    price: vwap.price,
    shares,
    boardAge,
    delivery,
  };
}
/** New positions alone use explicit checkpoint decisions; persisted legacy positions drain unchanged. */
function manageCheckpointPosition(
  next: State,
  previous: State,
  source: ForwardSourceEventInput,
  selection: PlanSelection,
  mode: ForwardEvaluationMode
) {
  let p = next.position!;
  const c = source.candle;
  const actions: Array<Record<string, unknown>> = [];
  const execution = boardExecution(
    source,
    p.side === "long" ? "short" : "long",
    mode,
    p.shares
  );
  const executablePrice = execution.valid ? execution.price : c.open;
  const done = (reason?: string, price = executablePrice) => {
    next = { ...next, position: reason ? null : p };
    const pnl = Math.round(
      (p.side === "long" ? price - p.entryPrice : p.entryPrice - price) *
        p.shares
    );
    const risk = p.initialRiskPerShare * p.shares;
    return {
      next,
      resultType: reason ? ("exit" as const) : ("hold" as const),
      opened: null,
      closed: reason
        ? {
            position: p,
            price,
            reason,
            pnl,
            realizedR: risk > 0 ? pnl / risk : 0,
          }
        : null,
      actions: reason
        ? [
            ...actions,
            {
              type: "exit",
              reason,
              price,
              shares: p.shares,
              managementPlanId: p.managementPlan?.planId,
              knowledgeIds: p.knowledgeIds ?? [],
            },
          ]
        : actions.length
          ? actions
          : [{ type: "hold" }],
    };
  };
  // Never apply a newly arrived instruction retroactively to the same source event.
  if (previous.lastSourceEventId === source.sourceEventId) return done();
  if (
    !p.firstTargetReachedAt &&
    (p.side === "long" ? c.high >= p.targetPrice : c.low <= p.targetPrice)
  ) {
    p = { ...p, firstTargetReachedAt: c.candleTime };
    actions.push({
      type: "first_target_reached",
      automaticExitApplied: false,
      automaticLineUpdate: false,
    });
  }
  const deadline = p.managementPlan?.validUntil ?? p.forceExitTime;
  const successorEnd = successorDeadline(deadline);
  const lateReceipt =
    selection.managementReceivedAtMs !== undefined &&
    (selection.managementPlans ?? []).some(
      command => command.positionId === p.positionId
    ) &&
    selection.managementReceivedAtMs >=
      Date.parse(`${next.tradeDate}T${formatMinute(successorEnd)}:00+09:00`);
  if (minute(c.candleTime) >= successorEnd || lateReceipt)
    p = { ...p, managementExpired: true };
  // Existing hard/protective stops stay active throughout successor waiting.
  const broken = (line: number, price: number) =>
    p.side === "long" ? price <= line : price >= line;
  const effectiveStop =
    p.protectionLine == null
      ? p.stopPrice
      : p.side === "long"
        ? Math.max(p.stopPrice, p.protectionLine)
        : Math.min(p.stopPrice, p.protectionLine);
  if (
    broken(effectiveStop, p.side === "long" ? c.low : c.high) ||
    (execution.valid && broken(effectiveStop, execution.price))
  ) {
    p = {
      ...p,
      pendingManagementExit:
        p.pendingManagementExit ??
        (effectiveStop === p.stopPrice ? "stop_loss" : "ai_protective_stop"),
    };
  }
  if (p.managementExpired)
    p = {
      ...p,
      pendingManagementExit:
        p.pendingManagementExit ?? "ai_management_successor_missing_exit",
    };
  if (!execution.valid) {
    actions.push({
      type: "management_awaiting_executable_event",
      reason: execution.reason,
      expiryLatched: Boolean(p.managementExpired),
      pendingExit: p.pendingManagementExit ?? null,
    });
    return done();
  }
  if (p.pendingManagementExit) return done(p.pendingManagementExit);
  const consumed = new Set(p.consumedManagementPlanIds ?? []);
  let accepted = false;
  for (const command of selection.managementPlans ?? []) {
    if (
      command.positionId !== p.positionId ||
      command.symbol !== c.symbol ||
      command.side !== p.side ||
      consumed.has(command.planId)
    )
      continue;
    if (command.basedOnEventId === source.sourceEventId) continue;
    consumed.add(command.planId);
    p = { ...p, consumedManagementPlanIds: Array.from(consumed) };
    const tighter = (value: number, old: number) =>
      p.side === "long" ? value >= old : value <= old;
    const rejected =
      command.validUntil <= c.candleTime ||
      command.validUntil > "15:20" ||
      !tighter(command.hardStop ?? p.stopPrice, p.stopPrice) ||
      !tighter(command.protectiveStop, p.protectionLine ?? p.stopPrice) ||
      !tighter(command.protectiveStop, command.hardStop ?? p.stopPrice);
    if (rejected) {
      actions.push({
        type: "management_plan_rejected",
        planId: command.planId,
        reason: "expired_or_stop_relaxation",
        priorValidUntil: deadline,
      });
      continue;
    }
    p = {
      ...p,
      managementPlan: command,
      stopPrice: command.hardStop ?? p.stopPrice,
      protectionLine: command.protectiveStop,
      forceExitTime: command.validUntil,
      knowledgeIds: command.knowledgeIds,
      awaitingSuccessorPlan: null,
    };
    accepted = true;
    actions.push({
      type: "management_plan_applied",
      planId: command.planId,
      basedOnEventId: command.basedOnEventId,
      reason: command.reason,
      knowledgeIds: command.knowledgeIds,
      effectiveSourceEventId: source.sourceEventId,
    });
    if (command.action !== "hold")
      return done(
        command.action === "take_profit"
          ? "ai_management_take_profit"
          : "ai_management_exit"
      );
    if (
      broken(command.protectiveStop, executablePrice) ||
      broken(p.stopPrice, executablePrice)
    )
      return done("ai_protective_stop_broken_on_arrival");
    break;
  }
  if (!accepted && c.candleTime >= deadline) {
    p = {
      ...p,
      awaitingSuccessorPlan: {
        checkpoint: deadline,
        validUntil: formatMinute(successorEnd),
        startedAt: p.awaitingSuccessorPlan?.startedAt ?? c.candleTime,
        priorPlanId: p.managementPlan?.planId ?? p.planSnapshotId,
      },
    };
    actions.push({
      type: "awaiting_management_successor",
      validUntil: formatMinute(successorEnd),
      stopRemainsActive: true,
    });
  }
  return done();
}

function transition(
  state: State,
  source: ForwardSourceEventInput,
  selection: PlanSelection,
  mode: ForwardEvaluationMode
) {
  const planChanged = state.activePlanId !== selection.activePlanId;
  const sameSourceEvent = state.lastSourceEventId === source.sourceEventId;
  const trackRevalidation =
    !state.position || state.position.revalidationObservationEnabled === true;
  const recentCloses = trackRevalidation
    ? [...(state.recentCloses ?? []), source.candle.close].slice(-20)
    : (state.recentCloses ?? []);
  let next = {
    ...state,
    activePlanId: selection.activePlanId,
    plan: selection.plan,
    touched: planChanged && !state.position ? null : state.touched,
    recentCloses,
    recentCandles: [
      ...(state.recentCandles ?? []).filter(
        bar => bar.time !== source.candle.candleTime
      ),
      {
        time: source.candle.candleTime,
        low: source.candle.low,
        high: source.candle.high,
      },
    ].slice(-3),
    lastSourceEventId: source.sourceEventId,
    lastActions: [] as Array<Record<string, unknown>>,
  };
  const c = source.candle;
  const plan = selection.plan;
  if (next.position?.managementVersion === "checkpoint_v1") {
    return manageCheckpointPosition(next, state, source, selection, mode);
  }
  if (next.position) {
    let p = next.position;
    if (
      p.pendingTightening &&
      c.candleTime > (p.pendingTightening.decisionTime ?? "")
    ) {
      const { decisionTime: _decisionTime, ...prices } = p.pendingTightening;
      p = { ...p, ...prices, pendingTightening: null };
    }
    if (p.awaitingSuccessorPlan) {
      p = {
        ...p,
        awaitingSuccessorPlan: {
          ...p.awaitingSuccessorPlan,
          validUntil: formatMinute(
            Math.min(
              minute(p.awaitingSuccessorPlan.validUntil),
              successorDeadline(p.forceExitTime)
            )
          ),
        },
      };
    }
    const positionActions: Array<Record<string, unknown>> = [];
    const sma20 =
      p.revalidationObservationEnabled && recentCloses.length === 20
        ? recentCloses.reduce((sum, value) => sum + value, 0) / 20
        : null;
    const adverseToSma20 =
      sma20 === null
        ? false
        : p.side === "long"
          ? c.close < sma20
          : c.close > sma20;
    p = {
      ...p,
      lastSma20: sma20,
      adverseSma20Consecutive: adverseToSma20
        ? (p.adverseSma20Consecutive ?? 0) + 1
        : 0,
    };
    next = { ...next, position: p };
    const revisedSide = plan ? sideForPlan(plan) : null;
    const directionRevisionExit =
      planChanged &&
      p.planSnapshotId !== selection.activePlanId &&
      (!plan || revisedSide !== p.side) &&
      selection.openPositionAction === "exit_next_event_if_direction_changed";

    // A plan that was fixed no later than the position's existing deadline may
    // carry a same-direction position into the next checkpoint.  A later plan
    // must never revive a position whose deadline had already passed.
    const causalSameDirectionTightening =
      planChanged &&
      p.planSnapshotId !== selection.activePlanId &&
      plan &&
      revisedSide === p.side &&
      plan.openPositionAction === "tighten_only" &&
      minute(plan.checkpoint) <= minute(p.forceExitTime) &&
      minute(c.candleTime) < successorDeadline(p.forceExitTime) &&
      (!p.awaitingSuccessorPlan ||
        c.candleTime < p.awaitingSuccessorPlan.validUntil);
    if (causalSameDirectionTightening) {
      const oldStop = p.stopPrice;
      const oldTarget = p.targetPrice;
      const oldForceExitTime = p.forceExitTime;
      const tighterStop =
        p.side === "long" &&
        plan.stopPrice > p.stopPrice &&
        plan.stopPrice < c.close
          ? plan.stopPrice
          : p.side === "short" &&
              plan.stopPrice < p.stopPrice &&
              plan.stopPrice > c.close
            ? plan.stopPrice
            : p.stopPrice;
      const desiredTarget = p.profitProtectionArmed
        ? plan.stretchTarget
        : plan.firstTarget;
      const executableTarget =
        (p.side === "long" &&
          desiredTarget > c.close &&
          desiredTarget <= p.targetPrice) ||
        (p.side === "short" &&
          desiredTarget < c.close &&
          desiredTarget >= p.targetPrice)
          ? desiredTarget
          : p.targetPrice;
      p = {
        ...p,
        pendingTightening: {
          decisionTime: c.candleTime,
          stopPrice: tighterStop,
          targetPrice: executableTarget,
          stretchTarget: p.profitProtectionArmed
            ? executableTarget
            : plan.stretchTarget,
        },
        forceExitTime: plan.forceExitTime,
        planSnapshotId: plan.sourceSnapshotId,
        awaitingSuccessorPlan: null,
      };
      next = { ...next, position: p };
      positionActions.push({
        type: "position_plan_tightened",
        oldStop,
        newStop: tighterStop,
        oldTarget,
        newTarget: executableTarget,
        oldForceExitTime,
        newForceExitTime: plan.forceExitTime,
        revisedBy: plan.sourceSnapshotId,
        effectiveFrom: "next_tradable_candle",
      });
    }
    let exit: { price: number; reason: string } | null = null;
    if (
      p.pendingProtectionExit &&
      c.candleTime > p.pendingProtectionExit.signalTime
    )
      exit = { price: c.open, reason: "profit_protection_next_open" };
    else if (p.side === "long" && c.low <= p.stopPrice)
      exit = {
        price: Math.min(c.open, p.stopPrice),
        reason: "stop_loss",
      };
    else if (p.side === "short" && c.high >= p.stopPrice)
      exit = {
        price: Math.max(c.open, p.stopPrice),
        reason: "stop_loss",
      };
    else if (
      p.firstTargetDecisionEnabled &&
      !p.profitProtectionArmed &&
      ((p.side === "long" && c.high >= p.targetPrice) ||
        (p.side === "short" && c.low <= p.targetPrice))
    ) {
      const oldStop = p.stopPrice;
      const reachedFirstTarget = p.targetPrice;
      const protectedStop = p.stopPrice;
      p = {
        ...p,
        stopPrice: protectedStop,
        targetPrice: p.stretchTarget ?? p.targetPrice,
        profitProtectionArmed: true,
        pendingTightening: p.pendingTightening
          ? {
              ...p.pendingTightening,
              targetPrice: p.pendingTightening.stretchTarget,
            }
          : null,
        firstTargetReachedAt: c.candleTime,
      };
      next = { ...next, position: p };
      positionActions.push({
        type: "profit_protection_armed",
        decisionPoint: "first_target",
        reachedFirstTarget,
        oldStop,
        newStop: protectedStop,
        nextTarget: p.targetPrice,
        sharesRetained: p.shares,
        automaticFullExit: false,
      });
    } else if (
      p.profitProtectionArmed &&
      p.firstTargetReachedAt !== c.candleTime &&
      ((p.side === "long" && c.high >= p.targetPrice) ||
        (p.side === "short" && c.low <= p.targetPrice))
    )
      exit = { price: p.targetPrice, reason: "stretch_target" };
    else if (
      !p.firstTargetDecisionEnabled &&
      ((p.side === "long" && c.high >= p.targetPrice) ||
        (p.side === "short" && c.low <= p.targetPrice))
    )
      exit = { price: p.targetPrice, reason: "first_target" };
    // The current decision candle is deliberately excluded from the reference.
    const priorBars = (state.recentCandles ?? [])
      .filter(bar => bar.time < c.candleTime)
      .slice(-3);
    if (
      !exit &&
      state.position?.profitProtectionArmed &&
      p.firstTargetReachedAt !== c.candleTime &&
      priorBars.length === 3
    ) {
      const reference =
        p.side === "long"
          ? Math.min(...priorBars.map(bar => bar.low))
          : Math.max(...priorBars.map(bar => bar.high));
      const line =
        p.protectionLine == null
          ? reference
          : p.side === "long"
            ? Math.max(p.protectionLine, reference)
            : Math.min(p.protectionLine, reference);
      const broken = p.side === "long" ? c.close < line : c.close > line;
      p = {
        ...p,
        protectionLine: line,
        pendingProtectionExit: broken
          ? { signalTime: c.candleTime, line }
          : p.pendingProtectionExit,
      };
      next = { ...next, position: p };
      positionActions.push({
        type: "profit_protection_observed",
        line,
        reference,
        exitReserved: broken,
        fillPolicy: "next_tradable_open",
      });
    }
    if (exit) {
      const pnl = Math.round(
        (p.side === "long"
          ? exit.price - p.entryPrice
          : p.entryPrice - exit.price) * p.shares
      );
      const risk = p.initialRiskPerShare * p.shares;
      next = { ...next, position: null };
      return {
        next,
        resultType: "exit" as const,
        opened: null,
        closed: {
          position: p,
          price: exit.price,
          reason: exit.reason,
          pnl,
          realizedR: risk > 0 ? pnl / risk : 0,
        },
        actions: [
          {
            type: "exit",
            ...exit,
            stopFirst:
              exit.reason === "stop_loss" ||
              exit.reason === "profit_protection_exit",
          },
        ],
      };
    }
    if (directionRevisionExit) {
      const pnl = Math.round(
        (p.side === "long" ? c.close - p.entryPrice : p.entryPrice - c.close) *
          p.shares
      );
      const risk = p.initialRiskPerShare * p.shares;
      next = { ...next, position: null };
      return {
        next,
        resultType: "exit" as const,
        opened: null,
        closed: {
          position: p,
          price: c.close,
          reason: "ai_direction_revision_exit",
          pnl,
          realizedR: risk > 0 ? pnl / risk : 0,
        },
        actions: [
          {
            type: "exit",
            price: c.close,
            reason: "ai_direction_revision_exit",
            revisedBy: selection.activePlanId,
          },
        ],
      };
    }
    const successorRejected =
      p.awaitingSuccessorPlan &&
      c.candleTime < p.awaitingSuccessorPlan.validUntil &&
      planChanged &&
      p.planSnapshotId !== selection.activePlanId &&
      !causalSameDirectionTightening;
    if (successorRejected) {
      const exitPrice = c.close;
      const pnl = Math.round(
        (p.side === "long"
          ? exitPrice - p.entryPrice
          : p.entryPrice - exitPrice) * p.shares
      );
      const risk = p.initialRiskPerShare * p.shares;
      next = { ...next, position: null };
      return {
        next,
        resultType: "exit" as const,
        opened: null,
        closed: {
          position: p,
          price: exitPrice,
          reason: "ai_successor_plan_rejected_exit",
          pnl,
          realizedR: risk > 0 ? pnl / risk : 0,
        },
        actions: [
          {
            type: "exit",
            price: exitPrice,
            reason: "ai_successor_plan_rejected_exit",
            successorPlanId: selection.activePlanId,
          },
        ],
      };
    }
    if (
      p.awaitingSuccessorPlan &&
      c.candleTime >= p.awaitingSuccessorPlan.validUntil
    ) {
      const exitPrice = c.close;
      const pnl = Math.round(
        (p.side === "long"
          ? exitPrice - p.entryPrice
          : p.entryPrice - exitPrice) * p.shares
      );
      const risk = p.initialRiskPerShare * p.shares;
      next = { ...next, position: null };
      return {
        next,
        resultType: "exit" as const,
        opened: null,
        closed: {
          position: p,
          price: exitPrice,
          reason: "ai_successor_plan_missing_exit",
          pnl,
          realizedR: risk > 0 ? pnl / risk : 0,
        },
        actions: [
          {
            type: "exit",
            price: exitPrice,
            reason: "ai_successor_plan_missing_exit",
            awaitedCheckpoint: p.awaitingSuccessorPlan.checkpoint,
          },
        ],
      };
    }
    if (c.candleTime >= p.forceExitTime) {
      const successor = getAiIntradayCheckpointSpec(p.forceExitTime);
      if (p.awaitingSuccessorPlan) {
        // The stop and the original position remain active while the already
        // recorded wait runs to the canonical checkpoint deadline.
      } else if (
        p.successorWaitEnabled &&
        successor &&
        selection.activePlanId === p.planSnapshotId &&
        minute(c.candleTime) < successorDeadline(p.forceExitTime)
      ) {
        p = {
          ...p,
          awaitingSuccessorPlan: {
            checkpoint: p.forceExitTime,
            validUntil: formatMinute(successorDeadline(p.forceExitTime)),
            startedAt: c.candleTime,
            priorPlanId: p.planSnapshotId,
          },
        };
        next = { ...next, position: p };
        positionActions.push({
          type: "awaiting_successor_plan",
          checkpoint: p.forceExitTime,
          validUntil: formatMinute(successorDeadline(p.forceExitTime)),
          stopRemainsActive: true,
          newEntriesAllowed: false,
        });
      } else {
        const missingSuccessor =
          p.successorWaitEnabled &&
          successor &&
          selection.activePlanId === p.planSnapshotId &&
          minute(c.candleTime) >= successorDeadline(p.forceExitTime);
        const forceExitReason = missingSuccessor
          ? "ai_successor_plan_missing_exit"
          : "ai_force_exit_time";
        const exitPrice = c.close;
        const pnl = Math.round(
          (p.side === "long"
            ? exitPrice - p.entryPrice
            : p.entryPrice - exitPrice) * p.shares
        );
        const risk = p.initialRiskPerShare * p.shares;
        next = { ...next, position: null };
        return {
          next,
          resultType: "exit" as const,
          opened: null,
          closed: {
            position: p,
            price: exitPrice,
            reason: forceExitReason,
            pnl,
            realizedR: risk > 0 ? pnl / risk : 0,
          },
          actions: [
            { type: "exit", price: exitPrice, reason: forceExitReason },
          ],
        };
      }
    }
    if (p.revalidationObservationEnabled)
      positionActions.push({
        type: "position_revalidation_observed",
        status: "observation_only",
        sma20,
        close: c.close,
        adverseToSma20,
        adverseSma20Consecutive: p.adverseSma20Consecutive ?? 0,
        automaticExitApplied: false,
      });
    return {
      next,
      resultType: "hold" as const,
      opened: null,
      closed: null,
      actions:
        positionActions.length > 1
          ? positionActions
          : positionActions.length === 1 &&
              positionActions[0]?.type !== "position_revalidation_observed"
            ? positionActions
            : [{ type: "hold" }, ...positionActions],
    };
  }
  // A position may have just been closed on this same source event.  The next
  // immutable AI plan can be considered only from a later source event.
  if (sameSourceEvent)
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason: "same_source_event_reentry_blocked",
        },
      ],
    };
  if (
    plan &&
    !next.executedPlanIds.includes(plan.sourceSnapshotId) &&
    (sideForPlan(plan) === "long"
      ? c.high >= plan.firstTarget
      : c.low <= plan.firstTarget)
  ) {
    next = {
      ...next,
      touched: null,
      executedPlanIds: [...next.executedPlanIds, plan.sourceSnapshotId],
    };
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason: "flat_plan_first_target_consumed",
          planSnapshotId: plan.sourceSnapshotId,
        },
      ],
    };
  }
  if (plan?.entryPolicy === "manage_only")
    return {
      next: { ...next, touched: null },
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [{ type: "no_trade", reason: "plan_management_only" }],
    };
  if (plan?.checkpoint === "11:30")
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason: "lunch_position_management_only",
          planSnapshotId: plan.sourceSnapshotId,
        },
      ],
    };
  if (!plan)
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason: "ai_snapshot_missing_invalid_or_non_directional",
        },
      ],
    };
  if (plan.entryBlockedByRevision)
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason:
            plan.entryBlockReason ??
            "market_context_revision_invalidated_unentered_signals",
        },
      ],
    };
  const planAlreadyExecuted = next.executedPlanIds.includes(
    plan.sourceSnapshotId
  );
  if (
    planAlreadyExecuted ||
    c.candleTime < plan.entryWindowStart ||
    c.candleTime > plan.entryWindowEnd
  )
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        {
          type: "no_trade",
          reason: planAlreadyExecuted
            ? "ai_plan_entry_already_executed"
            : "outside_active_ai_entry_window",
          planSnapshotId: plan.sourceSnapshotId,
        },
      ],
    };
  const side = sideForPlan(plan);
  if (!next.touched) {
    const touched =
      side === "long"
        ? c.low <= plan.zoneHigh && c.high >= plan.zoneLow
        : c.high >= plan.zoneLow && c.low <= plan.zoneHigh;
    if (touched) {
      next = {
        ...next,
        touched: {
          sourceEventId: source.sourceEventId,
          time: c.candleTime,
          side,
        },
      };
      return {
        next,
        resultType: "pending" as const,
        opened: null,
        closed: null,
        actions: [
          { type: "zone_touched", side, sourceEventId: source.sourceEventId },
        ],
      };
    }
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [{ type: "no_trade", reason: "zone_not_touched" }],
    };
  }
  if (next.touched.sourceEventId === source.sourceEventId)
    return {
      next,
      resultType: "pending" as const,
      opened: null,
      closed: null,
      actions: [{ type: "await_separate_confirmation_event" }],
    };
  const confirmed =
    side === "long"
      ? c.close >= plan.confirmPrice
      : c.close <= plan.confirmPrice;
  if (!confirmed)
    return {
      next,
      resultType: "pending" as const,
      opened: null,
      closed: null,
      actions: [{ type: "await_confirmation_price" }],
    };
  const execution = boardExecution(source, side, mode);
  if (!execution.valid)
    return {
      next,
      resultType: "rejected" as const,
      opened: null,
      closed: null,
      actions: [{ type: "entry_rejected", reason: execution.reason }],
    };
  const targetValid =
    side === "long"
      ? plan.firstTarget > execution.price
      : plan.firstTarget < execution.price;
  const stopValid =
    side === "long"
      ? plan.stopPrice < execution.price
      : plan.stopPrice > execution.price;
  if (!targetValid || !stopValid)
    return {
      next,
      resultType: "rejected" as const,
      opened: null,
      closed: null,
      actions: [
        { type: "entry_rejected", reason: "target_or_stop_not_executable" },
      ],
    };
  if (
    plan.protectiveStop !== undefined &&
    (side === "long"
      ? plan.protectiveStop < plan.stopPrice ||
        plan.protectiveStop >= execution.price
      : plan.protectiveStop > plan.stopPrice ||
        plan.protectiveStop <= execution.price)
  ) {
    return {
      next,
      resultType: "no_signal" as const,
      opened: null,
      closed: null,
      actions: [
        { type: "entry_blocked", reason: "initial_protective_stop_invalid" },
      ],
    };
  }
  const position: Position = {
    managementVersion: "checkpoint_v1",
    positionId: aiPositionId(plan.symbol, side, source.sourceEventId),
    protectionLine: plan.protectiveStop ?? null,
    knowledgeIds: plan.knowledgeIds ?? [],
    consumedManagementPlanIds: [],
    side,
    entrySourceEventId: source.sourceEventId,
    signalTime: next.touched.time,
    entryTime: c.candleTime,
    entryPrice: execution.price,
    targetPrice: plan.firstTarget,
    stretchTarget: plan.stretchTarget,
    stopPrice: plan.stopPrice,
    initialRiskPerShare: Math.abs(execution.price - plan.stopPrice),
    shares: execution.shares,
    sourceBoardAgeMs: execution.boardAge,
    deliveryBoardAgeMs: execution.delivery,
    planSnapshotId: plan.sourceSnapshotId,
    forceExitTime: plan.forceExitTime,
    firstTargetDecisionEnabled: true,
    successorWaitEnabled: true,
    revalidationObservationEnabled: true,
    profitProtectionArmed: false,
    firstTargetReachedAt: null,
    adverseSma20Consecutive: 0,
    lastSma20:
      recentCloses.length === 20
        ? recentCloses.reduce((sum, value) => sum + value, 0) / 20
        : null,
    awaitingSuccessorPlan: null,
  };
  // 成功entry後は同じimmutable decision/plan IDを再実行しない。
  // 次のAI revisionが別IDを発行した場合だけ、決済後の再entryを許可する。
  next = {
    ...next,
    position,
    touched: null,
    executedPlanIds: Array.from(
      new Set([...next.executedPlanIds, plan.sourceSnapshotId])
    ),
  };
  return {
    next,
    resultType: "entry" as const,
    opened: position,
    closed: null,
    actions: [
      {
        type: "entry",
        side,
        sourceBoardAgeMs: execution.boardAge,
        deliveryBoardAgeMs: execution.delivery,
        boardAgeBasis: "board_observed_to_relay_assembled_same_clock",
      },
      {
        type: "entry_revalidation_observed",
        status: "observation_only",
        thresholdPolicy: "not_fixed_pending_holdout_validation",
        planAgeMinutes: Math.max(
          0,
          minute(c.candleTime) - minute(plan.checkpoint)
        ),
        close: c.close,
        sma20: position.lastSma20,
        closeVsConfirmPrice: c.close - plan.confirmPrice,
        automaticEntryVetoApplied: false,
      },
    ],
  };
}

async function ensureVersion(symbol: AiDailyForecastSymbol) {
  const version = AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol];
  if (ensured.has(version)) return;
  const identity = getRuntimeIdentity();
  const config = {
    family: "ai_daily_forecast_shadow",
    symbol,
    forecastSnapshot:
      "immutable_preopen_plus_morning15_afternoon30_intraday_v6",
    d1OnlyAtOpen: true,
    intradayDataCutoff: "checkpoint_minus_one_minute",
    intradayCheckpoints: [
      "09:15",
      "09:30",
      "09:45",
      "10:00",
      "10:15",
      "10:30",
      "10:45",
      "11:00",
      "11:15",
      "11:30",
      "12:35",
      "13:00",
      "13:30",
      "14:00",
      "14:30",
      "15:00",
    ],
    learningInput:
      "closed_prior_trades_plus_checkpoint_causal_session_trades_and_positions_no_automatic_parameter_mutation",
    entry:
      "new_immutable_ai_plan_id_once_zone_touch_then_separate_confirmation_then_causal_directional_depth_vwap",
    boardMaximumAgeMs: 5_000,
    shares: { signal_quality: 100, capital_constrained: "portfolio_proxy" },
    exits: {
      firstTarget: "new_positions_record_only_checkpoint_decision_full_exit",
      stretchTarget: "new_positions_information_only",
      stop: "new_positions_independent_hard_and_explicit_protective_stop_never_loosen",
      directionChange: "explicit_exit_next_event_policy_only",
      sameDirectionContinuation:
        "tighten_only_next_candle_prices_successor_checkpoint_valid_until",
      successorPlanMissing:
        "keep_hard_stop_exit_after_successor_checkpoint_valid_until",
      lunchCheckpoint: "position_management_only_no_new_entry",
      revalidation:
        "fixed_20_close_observation_only_no_entry_veto_no_automatic_exit",
      sameCandlePriority:
        "reserved_open_exit_then_hard_stop_then_target_no_stretch_on_arm",
      dayEnd: "active_plan_force_exit_not_later_than_15:20",
    },
    evaluation: "monitoring_only",
    eligibleForAdoption: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: version,
    strategyId: `${symbol.toLowerCase()}-ai-adaptive-v6`,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: AI_DAILY_FORECAST_LEARNING_CUTOFF_DATE,
    evaluationStartDate: AI_DAILY_FORECAST_COLLECTION_START_DATE,
    evaluationPurpose: "causality_audit",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason:
      "ai_adaptive_forecast_v6_morning15_afternoon30_reentry_by_new_plan_id_manual_review_only",
  });
  ensured.add(version);
}

/** 起動時の明示登録。source eventや仮想tradeを作らず、10版をmonitoringで冪等登録する。 */
export async function registerAiDailyForecastShadowLifecycle() {
  for (const versionId of [
    ...Object.values(RETIRED_AI_DAILY_FORECAST_V1_VERSIONS),
    ...Object.values(RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS),
  ]) {
    const existing = await getRtStrategyVersion(versionId);
    if (existing && existing.status !== "stopped")
      await updateRtStrategyVersionStatus({
        versionId,
        status: "stopped",
        statusReason:
          "retired_replaced_by_ai_forecast_v6_morning15_afternoon30_2026_10_15",
      });
  }
  for (const versionId of Object.values(
    RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS
  )) {
    const existing = await getRtStrategyVersion(versionId);
    if (!existing) continue;
    const savedStates = await Promise.all(
      MODES.map(mode =>
        getRtForwardShadowState({
          strategyVersion: versionId,
          evaluationMode: mode,
        })
      )
    );
    const openStateDates = savedStates.flatMap(row => {
      const state = object(row?.stateJson);
      return hasOpenPosition(state) && typeof state.tradeDate === "string"
        ? [state.tradeDate]
        : [];
    });
    const today = currentJstDate();
    const hasSameDayPendingPosition = openStateDates.includes(today);
    const hasHistoricalPendingPosition = openStateDates.some(
      tradeDate => tradeDate !== today
    );
    await updateRtStrategyVersionStatus({
      versionId,
      status: hasHistoricalPendingPosition
        ? "insufficient"
        : hasSameDayPendingPosition
          ? "monitoring"
          : "stopped",
      statusReason: hasHistoricalPendingPosition
        ? `retirement_blocked_historical_open_position_requires_reconciliation:${openStateDates.join(",")}`
        : hasSameDayPendingPosition
          ? "retirement_pending_position_only_drain"
          : "retired_replaced_by_ai_forecast_am15_v6_2026_10_15",
    });
  }
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) await ensureVersion(symbol);
}

async function processMode(
  source: ForwardSourceEventInput,
  symbol: AiDailyForecastSymbol,
  mode: ForwardEvaluationMode,
  selection: PlanSelection,
  options: { strategyVersion?: string; positionOnly?: boolean } = {}
) {
  const version =
    options.strategyVersion ?? AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol];
  const initial = normalizeState(
    (
      await getRtForwardShadowState({
        strategyVersion: version,
        evaluationMode: mode,
      })
    )?.stateJson,
    source.candle.tradeDate
  );
  if (options.positionOnly && !initial.position)
    return {
      mode,
      strategyVersion: version,
      status: "no_same_day_open_position_to_drain" as const,
    };
  const hash = sha256Stable(initial);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: version,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      tradeDate: source.candle.tradeDate,
      symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: {
        status: "claimed",
        candidateVariant: options.positionOnly
          ? "ai_adaptive_forecast_retired_position_drain"
          : "ai_adaptive_forecast",
        eligibleForAdoption: false,
      },
      stateHashBefore: hash,
      stateHashAfter: hash,
    },
  });
  if (claim !== "claimed")
    return { mode, strategyVersion: version, status: claim };
  let owner: string | null = null;
  try {
    owner = createForwardShadowLockOwnerToken({
      strategyVersion: version,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
    });
    if (
      !(await acquireRtForwardShadowStateLock({
        strategyVersion: version,
        evaluationMode: mode,
        ownerToken: owner,
        leaseMs: 30_000,
      }))
    )
      return { mode, strategyVersion: version, status: "lock_unavailable" };
    const latest = normalizeState(
      (
        await getRtForwardShadowState({
          strategyVersion: version,
          evaluationMode: mode,
        })
      )?.stateJson,
      source.candle.tradeDate
    );
    const result =
      options.positionOnly && !latest.position
        ? {
            next: latest,
            resultType: "no_signal" as const,
            opened: null,
            closed: null,
            actions: [
              {
                type: "no_trade",
                reason: "retired_version_position_only_drain_complete",
              },
            ],
          }
        : transition(latest, source, selection, mode);
    const after = sha256Stable(result.next);
    await upsertRtForwardShadowState({
      strategyVersion: version,
      evaluationMode: mode,
      stateJson: result.next,
      stateHash: after,
      lastSourceEventId: source.sourceEventId,
    });
    if (result.opened) {
      const p = result.opened;
      await insertRtForwardShadowTrade({
        strategyVersion: version,
        evaluationMode: mode,
        symbol,
        side: p.side,
        entrySourceEventId: p.entrySourceEventId,
        entryTradeDate: source.candle.tradeDate,
        signalCandleTime: p.signalTime,
        entryCandleTime: p.entryTime,
        theoreticalSignalPrice: String(source.candle.close),
        entryPrice: String(p.entryPrice),
        shares: p.shares,
        slPct: String(
          Math.abs(((p.entryPrice - p.stopPrice) / p.entryPrice) * 100)
        ),
        tpPct: String(
          Math.abs(((p.targetPrice - p.entryPrice) / p.entryPrice) * 100)
        ),
      });
    }
    if (result.closed)
      await closeRtForwardShadowTrade({
        strategyVersion: version,
        evaluationMode: mode,
        entrySourceEventId: result.closed.position.entrySourceEventId,
        exitSourceEventId: source.sourceEventId,
        exitTradeDate: source.candle.tradeDate,
        exitCandleTime: source.candle.candleTime,
        exitPrice: String(result.closed.price),
        exitReason: result.closed.reason,
        pnl: result.closed.pnl,
        pnlAfterAdverseExit: result.closed.pnl,
        realizedR: String(result.closed.realizedR),
      });
    await updateRtForwardShadowEvent({
      strategyVersion: version,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      resultType: result.resultType,
      decisionJson: {
        managementPosition:
          result.next.position?.managementVersion === "checkpoint_v1"
            ? { ...result.next.position, evaluationMode: mode, symbol }
            : null,
        actions: result.actions,
        activePlanId: selection.activePlanId,
        disabledReason: selection.disabledReason,
        plan: selection.plan,
        eligibleForAdoption: false,
        automaticAdoption: false,
        orderInstructionCreated: false,
        normalTradeTableWritten: false,
      },
      stateHashAfter: after,
    });
    return { mode, strategyVersion: version, resultType: result.resultType };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion: version,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      errorDetail: String(error),
      stateHashBefore: hash,
    });
    throw error;
  } finally {
    if (owner)
      await releaseRtForwardShadowStateLock({
        strategyVersion: version,
        evaluationMode: mode,
        ownerToken: owner,
      });
  }
}

export async function processAiDailyForecastShadowSourceEvent(
  source: ForwardSourceEventInput
) {
  if (!symbols.has(source.candle.symbol))
    return { skipped: "non_ai_forecast_symbol" as const };
  const symbol = source.candle.symbol as AiDailyForecastSymbol;
  const legacyVersionId = RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS[symbol];
  const legacyVersion = await getRtStrategyVersion(legacyVersionId);
  const drainLegacyPosition = Boolean(
    legacyVersion &&
      legacyVersion.status !== "stopped" &&
      legacyVersion.status !== "insufficient"
  );
  const currentVersionEligible =
    source.candle.tradeDate >= AI_DAILY_FORECAST_COLLECTION_START_DATE;
  let currentVersionActive = false;
  if (currentVersionEligible) {
    await ensureVersion(symbol);
    const currentVersion = await getRtStrategyVersion(
      AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol]
    );
    currentVersionActive = Boolean(
      currentVersion &&
        currentVersion.status !== "stopped" &&
        currentVersion.status !== "insufficient"
    );
  }
  if (!drainLegacyPosition && !currentVersionEligible)
    return { skipped: "before_collection_start" as const };
  if (!drainLegacyPosition && !currentVersionActive)
    return { skipped: "strategy_not_active" as const };
  const { dashboard, intradaySnapshot } = await getPlanData(
    source.candle.tradeDate,
    source.candle.candleTime,
    source.currentAudit?.engineSequence ?? null
  );
  const dailyPlan = planFromSnapshot(
    dashboard.snapshot,
    symbol,
    dashboard.revisions.some(
      revision => revision.revisionStatus === "market_context_invalidated"
    )
  );
  const selection = planFromIntradaySnapshot(intradaySnapshot, symbol) ?? {
    activePlanId: dailyPlan?.sourceSnapshotId ?? null,
    plan: dailyPlan,
    disabledReason: dailyPlan
      ? null
      : "morning_plan_missing_invalid_or_non_directional",
    openPositionAction: "keep" as const,
  };
  const evaluations = [];
  for (const mode of MODES) {
    if (drainLegacyPosition) {
      try {
        evaluations.push(
          await processMode(source, symbol, mode, selection, {
            strategyVersion: legacyVersionId,
            positionOnly: true,
          })
        );
      } catch (error) {
        evaluations.push({
          mode,
          strategyVersion: legacyVersionId,
          skipped: "isolated_legacy_position_drain_error",
          error: String(error),
        });
      }
    }
    if (!currentVersionActive) continue;
    try {
      evaluations.push(await processMode(source, symbol, mode, selection));
    } catch (error) {
      evaluations.push({
        mode,
        skipped: "isolated_mode_error",
        error: String(error),
      });
    }
  }
  if (drainLegacyPosition) {
    const stillOpen = (
      await Promise.all(
        MODES.map(mode =>
          getRtForwardShadowState({
            strategyVersion: legacyVersionId,
            evaluationMode: mode,
          })
        )
      )
    ).some(row => hasOpenPosition(row?.stateJson));
    if (!stillOpen)
      await updateRtStrategyVersionStatus({
        versionId: legacyVersionId,
        status: "stopped",
        statusReason: "retired_position_only_drain_complete",
      });
  }
  return { skipped: false as const, symbol, evaluations };
}
export function applyAiDailyForecastTransitionForTest(
  state: State,
  source: ForwardSourceEventInput,
  plan: Plan | null,
  mode: ForwardEvaluationMode
) {
  return transition(
    state,
    source,
    {
      activePlanId: plan?.sourceSnapshotId ?? null,
      plan,
      disabledReason: plan ? null : "test_plan_missing",
      openPositionAction: plan?.openPositionAction ?? "keep",
    },
    mode
  );
}
export function applyAiDailyForecastSelectionTransitionForTest(
  state: State,
  source: ForwardSourceEventInput,
  selection: PlanSelection,
  mode: ForwardEvaluationMode
) {
  return transition(state, source, selection, mode);
}
