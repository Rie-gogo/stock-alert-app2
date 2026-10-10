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
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import { calculateDepthVwap } from "./telExecutableConfirmDepth";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  getAiDailyForecastDashboard,
  type AiDailyForecastSymbol,
} from "./aiDailyForecastService";
import { getEffectiveAiIntradayForecastSnapshot } from "./aiIntradayForecastService";

export const AI_DAILY_FORECAST_LEARNING_CUTOFF_DATE = "2026-10-10";
export const AI_DAILY_FORECAST_COLLECTION_START_DATE = "2026-10-13";
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
  firstTarget: number;
  stretchTarget: number;
  atr5: number;
  stopPrice: number;
  entryBlockedByRevision: boolean;
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
  activePlanId: string | null;
  plan: Plan | null;
  disabledReason: string | null;
  openPositionAction:
    | "keep"
    | "tighten_only"
    | "exit_next_event_if_direction_changed";
};
type Position = {
  side: Side;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  initialRiskPerShare: number;
  shares: number;
  sourceBoardAgeMs: number;
  deliveryBoardAgeMs: number | null;
  planSnapshotId: string;
  forceExitTime: string;
};
type State = {
  tradeDate: string;
  activePlanId: string | null;
  plan: Plan | null;
  touched: { sourceEventId: string; time: string; side: Side } | null;
  position: Position | null;
  /** 成功entry済みのimmutable AI plan/revision ID。日次回数制限ではない。 */
  executedPlanIds: string[];
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
function minute(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
function emptyState(tradeDate: string): State {
  return {
    tradeDate,
    activePlanId: null,
    plan: null,
    touched: null,
    position: null,
    executedPlanIds: [],
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
    firstTarget,
    stretchTarget,
    atr5,
    stopPrice,
    entryBlockedByRevision,
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
  if (control.planDecision === "disabled" || !directional)
    return {
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
      activePlanId: snapshot.sourceRevisionId,
      plan: null,
      disabledReason: "ai_intraday_price_order_invalid",
      openPositionAction: action,
    };
  return {
    activePlanId: snapshot.sourceRevisionId,
    disabledReason: null,
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
      firstTarget,
      stretchTarget,
      atr5,
      stopPrice,
      entryBlockedByRevision: false,
      checkpoint: snapshot.checkpoint,
      entryWindowStart: String(control.entryWindowStart ?? snapshot.checkpoint),
      entryWindowEnd: String(control.entryWindowEnd ?? "15:19"),
      forceExitTime: String(control.forceExitTime ?? "15:20"),
      openPositionAction: action,
    },
  };
}
function sideForPlan(plan: Plan): Side {
  return plan.direction === "strong_up" || plan.direction === "up"
    ? "long"
    : "short";
}
function getPlanData(tradeDate: string, candleTime: string) {
  const key = `${tradeDate}:${candleTime}`;
  const existing = planDataCache.get(key);
  if (existing) return existing;
  const created = Promise.all([
    getAiDailyForecastDashboard(tradeDate),
    getEffectiveAiIntradayForecastSnapshot(tradeDate, candleTime),
  ]).then(([dashboard, intradaySnapshot]) => ({ dashboard, intradaySnapshot }));
  planDataCache.set(key, created);
  while (planDataCache.size > 8)
    planDataCache.delete(planDataCache.keys().next().value!);
  return created;
}
function boardExecution(
  source: ForwardSourceEventInput,
  side: Side,
  mode: ForwardEvaluationMode
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
    mode === "signal_quality"
      ? 100
      : Math.max(
          100,
          Math.floor(2_700_000 / Math.max(1, source.candle.close) / 100) * 100
        );
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
function transition(
  state: State,
  source: ForwardSourceEventInput,
  selection: PlanSelection,
  mode: ForwardEvaluationMode
) {
  const planChanged = state.activePlanId !== selection.activePlanId;
  const sameSourceEvent = state.lastSourceEventId === source.sourceEventId;
  let next = {
    ...state,
    activePlanId: selection.activePlanId,
    plan: selection.plan,
    touched: planChanged && !state.position ? null : state.touched,
    lastSourceEventId: source.sourceEventId,
    lastActions: [] as Array<Record<string, unknown>>,
  };
  const c = source.candle;
  const plan = selection.plan;
  if (next.position) {
    const p = next.position;
    let exit: { price: number; reason: string } | null = null;
    if (p.side === "long" && c.low <= p.stopPrice)
      exit = { price: Math.min(c.open, p.stopPrice), reason: "stop_loss" };
    else if (p.side === "short" && c.high >= p.stopPrice)
      exit = { price: Math.max(c.open, p.stopPrice), reason: "stop_loss" };
    else if (p.side === "long" && c.high >= p.targetPrice)
      exit = { price: p.targetPrice, reason: "first_target" };
    else if (p.side === "short" && c.low <= p.targetPrice)
      exit = { price: p.targetPrice, reason: "first_target" };
    else if (c.candleTime >= p.forceExitTime)
      exit = { price: c.close, reason: "ai_force_exit_time" };
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
          { type: "exit", ...exit, stopFirst: exit.reason === "stop_loss" },
        ],
      };
    }
    if (planChanged && p.planSnapshotId !== selection.activePlanId) {
      const revisedSide = plan ? sideForPlan(plan) : null;
      if (
        (!plan || revisedSide !== p.side) &&
        selection.openPositionAction === "exit_next_event_if_direction_changed"
      ) {
        const pnl = Math.round(
          (p.side === "long"
            ? c.close - p.entryPrice
            : p.entryPrice - c.close) * p.shares
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
      if (
        plan &&
        revisedSide === p.side &&
        plan.openPositionAction === "tighten_only"
      ) {
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
        const executableTarget =
          (p.side === "long" &&
            plan.firstTarget > c.close &&
            plan.firstTarget <= p.targetPrice) ||
          (p.side === "short" &&
            plan.firstTarget < c.close &&
            plan.firstTarget >= p.targetPrice)
            ? plan.firstTarget
            : p.targetPrice;
        next = {
          ...next,
          position: {
            ...p,
            stopPrice: tighterStop,
            targetPrice: executableTarget,
            forceExitTime: plan.forceExitTime,
            planSnapshotId: plan.sourceSnapshotId,
          },
        };
        return {
          next,
          resultType: "hold" as const,
          opened: null,
          closed: null,
          actions: [
            {
              type: "position_plan_tightened",
              oldStop: p.stopPrice,
              newStop: tighterStop,
              oldTarget: p.targetPrice,
              newTarget: executableTarget,
              revisedBy: plan.sourceSnapshotId,
            },
          ],
        };
      }
    }
    return {
      next,
      resultType: "hold" as const,
      opened: null,
      closed: null,
      actions: [{ type: "hold" }],
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
          reason: "market_context_revision_invalidated_unentered_signals",
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
  const position: Position = {
    side,
    entrySourceEventId: source.sourceEventId,
    signalTime: next.touched.time,
    entryTime: c.candleTime,
    entryPrice: execution.price,
    targetPrice: plan.firstTarget,
    stopPrice: plan.stopPrice,
    initialRiskPerShare: Math.abs(execution.price - plan.stopPrice),
    shares: execution.shares,
    sourceBoardAgeMs: execution.boardAge,
    deliveryBoardAgeMs: execution.delivery,
    planSnapshotId: plan.sourceSnapshotId,
    forceExitTime: plan.forceExitTime,
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
    forecastSnapshot: "immutable_preopen_plus_30min_intraday_v1",
    d1OnlyAtOpen: true,
    intradayDataCutoff: "checkpoint_minus_one_minute",
    intradayCheckpoints: [
      "09:30",
      "10:00",
      "10:30",
      "11:00",
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
      target: "active_plan_with_same_direction_tighten_only",
      stop: "never_loosen_after_entry",
      directionChange: "explicit_exit_next_event_policy_only",
      sameCandlePriority: "stop_first",
      dayEnd: "active_plan_force_exit_not_later_than_15:20",
    },
    evaluation: "monitoring_only",
    eligibleForAdoption: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: version,
    strategyId: `${symbol.toLowerCase()}-ai-adaptive-v5`,
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
      "ai_adaptive_forecast_reentry_by_new_plan_id_manual_review_only",
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
  ]) {
    const existing = await getRtStrategyVersion(versionId);
    if (existing && existing.status !== "stopped")
      await updateRtStrategyVersionStatus({
        versionId,
        status: "stopped",
        statusReason: "retired_replaced_by_ai_forecast_reentry_v5_2026_10_10",
      });
  }
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) await ensureVersion(symbol);
}

async function processMode(
  source: ForwardSourceEventInput,
  symbol: AiDailyForecastSymbol,
  mode: ForwardEvaluationMode,
  selection: PlanSelection
) {
  const version = AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol];
  const initial = normalizeState(
    (
      await getRtForwardShadowState({
        strategyVersion: version,
        evaluationMode: mode,
      })
    )?.stateJson,
    source.candle.tradeDate
  );
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
        candidateVariant: "ai_adaptive_forecast",
        eligibleForAdoption: false,
      },
      stateHashBefore: hash,
      stateHashAfter: hash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };
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
      return { mode, status: "lock_unavailable" };
    const latest = normalizeState(
      (
        await getRtForwardShadowState({
          strategyVersion: version,
          evaluationMode: mode,
        })
      )?.stateJson,
      source.candle.tradeDate
    );
    const result = transition(latest, source, selection, mode);
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
    return { mode, resultType: result.resultType };
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
  if (source.candle.tradeDate < AI_DAILY_FORECAST_COLLECTION_START_DATE)
    return { skipped: "before_collection_start" as const };
  const symbol = source.candle.symbol as AiDailyForecastSymbol;
  await ensureVersion(symbol);
  const version = await getRtStrategyVersion(
    AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol]
  );
  if (version?.status === "stopped" || version?.status === "insufficient")
    return { skipped: `strategy_${version.status}` as const };
  const { dashboard, intradaySnapshot } = await getPlanData(
    source.candle.tradeDate,
    source.candle.candleTime
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
