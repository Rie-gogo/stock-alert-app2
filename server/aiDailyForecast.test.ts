import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  buildQuantBaseline,
  validateAiDailyForecastOutput,
  type AiDailyForecastInput,
} from "./aiDailyForecastService";
import {
  applyAiDailyForecastSelectionTransitionForTest,
  applyAiDailyForecastTransitionForTest,
  selectAiDailyPlanForTest,
  selectAiIntradayPlanForTest,
  type AiDailyForecastPlan,
} from "./aiDailyForecastShadowEngine";
import type { ForwardSourceEventInput } from "./forwardShadow";

const bars = Array.from({ length: 6 }, (_, index) => ({
  tradeDate: `2026-10-0${index + 1}`,
  open: 100 + index,
  high: 103 + index,
  low: 99 + index,
  close: 102 + index,
  volume: 1_000,
  barCount: 300,
  distinctMinuteCount: 300,
  firstTime: "09:00",
  lastTime: "15:29",
  duplicateMinuteCount: 0,
  maxGapMinutes: 0,
  usable: true,
  qualityReasons: [],
}));
const baseline = buildQuantBaseline("8035", bars);
const forecast = (symbol: string) => ({
  symbol,
  direction: "up",
  forecastLow: 98,
  forecastHigh: 108,
  zoneType: "pullback",
  zoneLow: 99,
  zoneHigh: 102,
  confirmPrice: 102,
  firstTarget: 105,
  stretchTarget: 108,
  baselineDecision: "maintained",
  aiAdjustment: { reason: "quant baseline retained", exceptionReason: null },
  rationale: "D-1 deterministic baseline retained",
  evidenceUsed: ["D-1 daily bars"],
  macroAgreement: "aligned",
  confidenceBasis: ["five usable daily sessions"],
});
const input: AiDailyForecastInput = {
  tradeDate: "2026-10-09",
  dataCutoffDate: "2026-10-08",
  capturedAtMs: 1,
  macroSnapshot: null,
  macroSnapshotId: null,
  learningApplicationAudit: {
    schemaVersion: "ai-forecast-learning-application-v4",
    checkpoint: "08:30",
    learningMode: "cold_start",
    learningApplied: false,
    learningExampleCount: 0,
    coldStartReason: "verified_learning_snapshot_before_trade_date_missing",
    sourceLearningSnapshot: null,
    frozenQuantBaseline: { id: "test", hash: "test" },
    automaticRuleMutation: false,
    symbols: [],
    priorPlanDifference: { status: "not_applicable" },
  },
  inputQuality: "verified",
  qualityReasonCodes: [],
  symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
    symbol,
    dailyBars: bars,
    baseline: buildQuantBaseline(symbol, bars),
  })),
};
const source = (
  id: string,
  candleTime: string,
  open: number,
  high: number,
  low: number,
  close: number,
  board = {
    asks: [{ price: 103, qty: 10_000 }],
    bids: [{ price: 101, qty: 10_000 }],
  }
): ForwardSourceEventInput => ({
  sourceEventId: id,
  candle: {
    symbol: "8035",
    tradeDate: "2026-10-09",
    candleTime,
    open,
    high,
    low,
    close,
    volume: 1000,
  },
  board,
  currentAudit: {
    engineSequence: 1,
    resultType: "no_trade",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "a",
    stateHashAfter: "a",
    causalityStatus: "verified",
    causalityReason: "test",
    boardObservedAtMs: 1_000,
    relayAssembledAtMs: 1_100,
    relaySentAtMs: 1_110,
    cloudReceivedAtMs: 2_000,
    decisionStartedAtMs: 2_001,
    decisionCompletedAtMs: 2_002,
  },
});
const plan: AiDailyForecastPlan = {
  sourceSnapshotId: "ai:test",
  qualityStatus: "verified",
  symbol: "8035",
  direction: "up",
  forecastLow: 98,
  forecastHigh: 108,
  zoneLow: 99,
  zoneHigh: 102,
  confirmPrice: 102,
  firstTarget: 105,
  stretchTarget: 108,
  atr5: 2,
  stopPrice: 98,
  entryBlockedByRevision: false,
  checkpoint: "08:30",
  entryWindowStart: "09:00",
  entryWindowEnd: "15:19",
  forceExitTime: "15:20",
  openPositionAction: "keep",
};

describe("AI daily forecast deterministic contract", () => {
  it("keeps the app as an external-Codex ingest consumer and never invokes an in-server LLM", () => {
    const source = readFileSync(
      new URL("./aiDailyForecastService.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("invokeLLM");
    expect(source).not.toContain("generateAiDailyForecast");
    expect(source).toContain("ingestAiDailyForecastSubmission");
  });
  it("uses exactly D-1 daily inputs and produces an ordered quant baseline", () => {
    expect(baseline.usableDates).toEqual(bars.map(bar => bar.tradeDate));
    expect(baseline.direction).not.toBe("insufficient");
    expect(baseline.forecastLow).toBeLessThan(baseline.zoneLow!);
    expect(baseline.zoneHigh).toBeLessThan(baseline.forecastHigh!);
    expect(baseline.originalUnroundedPrices.forecastLow).not.toBeNull();
  });
  it("rejects duplicate or missing symbols and invalid directional price ordering", () => {
    const output = {
      forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
      marketSummary: "test",
      globalReasonCodes: ["test"],
    };
    expect(validateAiDailyForecastOutput(output, input).valid).toBe(true);
    output.forecasts[1] = forecast("8035");
    const result = validateAiDailyForecastOutput(output, input);
    expect(result.valid).toBe(false);
    expect(
      result.reasonCodes.some(reason => reason.startsWith("duplicate_symbol"))
    ).toBe(true);
  });
  it("requires a separate confirmation event and causal fresh directional depth before entry", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: null,
      position: null,
      executedPlanIds: [],
      lastSourceEventId: null,
      lastActions: [],
    };
    const touched = applyAiDailyForecastTransitionForTest(
      initial,
      source("touch", "09:30", 101, 102, 99.5, 100),
      plan,
      "signal_quality"
    );
    expect(touched.resultType).toBe("pending");
    const entered = applyAiDailyForecastTransitionForTest(
      touched.next,
      source("confirm", "09:31", 102, 103, 101, 102.5),
      plan,
      "signal_quality"
    );
    expect(entered.resultType).toBe("entry");
    const stale = source("stale", "09:31", 102, 103, 101, 102.5);
    stale.currentAudit!.relayAssembledAtMs = 6_001;
    const rejected = applyAiDailyForecastTransitionForTest(
      touched.next,
      stale,
      plan,
      "signal_quality"
    );
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({ reason: "board_stale" });
  });
  it("applies stop-first before arming first-target profit protection", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: { sourceEventId: "touch", time: "09:30", side: "long" as const },
      position: null,
      executedPlanIds: [],
      lastSourceEventId: "touch",
      lastActions: [],
    };
    const entered = applyAiDailyForecastTransitionForTest(
      initial,
      source("confirm", "09:31", 102, 103, 101, 102.5),
      plan,
      "signal_quality"
    );
    const exited = applyAiDailyForecastTransitionForTest(
      entered.next,
      source("both", "09:32", 102.5, 106, 97, 102),
      plan,
      "signal_quality"
    );
    expect(exited.resultType).toBe("exit");
    expect(exited.closed?.reason).toBe("stop_loss");
    expect(entered.opened?.targetPrice).toBe(105);
  });
  it("blocks only unentered signals after a market-context invalidation revision", () => {
    const blockedPlan = { ...plan, entryBlockedByRevision: true };
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: blockedPlan.sourceSnapshotId,
      plan: blockedPlan,
      touched: null,
      position: null,
      executedPlanIds: [],
      lastSourceEventId: null,
      lastActions: [],
    };
    const result = applyAiDailyForecastTransitionForTest(
      initial,
      source("after-revision", "10:00", 101, 103, 99, 102.5),
      blockedPlan,
      "signal_quality"
    );
    expect(result.resultType).toBe("no_signal");
    expect(result.actions[0]).toMatchObject({
      reason: "market_context_revision_invalidated_unentered_signals",
    });
  });
  it("blocks a late plan after its target was reached before activation", () => {
    const blockedPlan = {
      ...plan,
      sourceSnapshotId: "ai:late-plan",
      checkpoint: "10:00",
      entryWindowStart: "10:00",
      entryWindowEnd: "10:14",
      entryBlockedByRevision: true,
      entryBlockReason: "missed_move_no_entry",
    };
    const result = applyAiDailyForecastTransitionForTest(
      {
        tradeDate: "2026-10-09",
        activePlanId: blockedPlan.sourceSnapshotId,
        plan: blockedPlan,
        touched: null,
        position: null,
        executedPlanIds: [],
        lastSourceEventId: null,
        lastActions: [],
      },
      source("after-plan-arrival", "10:08", 102, 103, 101, 102),
      blockedPlan,
      "signal_quality"
    );
    expect(result.resultType).toBe("no_signal");
    expect(result.actions[0]).toMatchObject({ reason: "missed_move_no_entry" });
  });
  it("carries the persisted activation audit into intraday plan selection", () => {
    const selected = selectAiIntradayPlanForTest(
      {
        sourceRevisionId: "ai-intraday-forecast:2026-10-09:1000:codex-v1",
        qualityStatus: "verified",
        checkpoint: "10:00",
        forecastJson: {
          aiFinalForecast: {
            forecast: { forecasts: [forecast("8035")] },
            controls: [
              {
                symbol: "8035",
                planDecision: "maintained",
                entryWindowStart: "10:00",
                entryWindowEnd: "10:14",
                forceExitTime: "10:15",
                openPositionAction: "keep",
              },
            ],
          },
        },
        inputJson: {
          priorData: { symbols: [{ symbol: "8035", baseline: { atr5: 2 } }] },
        },
        validationJson: {
          activationAudit: {
            symbols: [
              { symbol: "8035", entryDisposition: "missed_move_no_entry" },
            ],
          },
        },
      },
      "8035"
    );
    expect(selected).toMatchObject({
      disabledReason: "missed_move_no_entry",
      openPositionAction: "keep",
      plan: {
        entryBlockedByRevision: true,
        entryBlockReason: "missed_move_no_entry",
      },
    });
  });
  it("resets an unentered touch when a newer checkpoint replaces the plan", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: {
        sourceEventId: "old-touch",
        time: "09:29",
        side: "long" as const,
      },
      position: null,
      executedPlanIds: [],
      lastSourceEventId: "old-touch",
      lastActions: [],
    };
    const revised = {
      ...plan,
      sourceSnapshotId: "ai:1000",
      checkpoint: "10:00",
      entryWindowStart: "10:00",
      entryWindowEnd: "10:29",
    };
    const result = applyAiDailyForecastSelectionTransitionForTest(
      initial,
      source("new-plan", "10:00", 104, 104.5, 103.5, 104),
      {
        activePlanId: revised.sourceSnapshotId,
        plan: revised,
        disabledReason: null,
        openPositionAction: "keep",
      },
      "signal_quality"
    );
    expect(result.next.touched).toBeNull();
    expect(result.actions[0]).toMatchObject({ reason: "zone_not_touched" });
  });
  it("can close an open position on the next event only when the AI explicitly changes direction", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry",
      signalTime: "09:30",
      entryTime: "09:31",
      entryPrice: 102,
      targetPrice: 108,
      stopPrice: 98,
      initialRiskPerShare: 4,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "15:20",
    };
    const state = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: null,
      position,
      executedPlanIds: [],
      lastSourceEventId: "entry",
      lastActions: [],
    };
    const shortPlan = {
      ...plan,
      sourceSnapshotId: "ai:1000-short",
      direction: "down",
      firstTarget: 99,
      stretchTarget: 98,
      stopPrice: 108,
      openPositionAction: "exit_next_event_if_direction_changed" as const,
    };
    const result = applyAiDailyForecastSelectionTransitionForTest(
      state,
      source("revision", "10:01", 103, 104, 102, 103),
      {
        activePlanId: shortPlan.sourceSnapshotId,
        plan: shortPlan,
        disabledReason: null,
        openPositionAction: "exit_next_event_if_direction_changed",
      },
      "signal_quality"
    );
    expect(result.resultType).toBe("exit");
    expect(result.closed?.reason).toBe("ai_direction_revision_exit");
  });

  it("permits reentry only after a later AI plan ID, never because of a daily reset", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: {
        sourceEventId: "touch-one",
        time: "09:30",
        side: "long" as const,
      },
      position: null,
      executedPlanIds: [],
      lastSourceEventId: "touch-one",
      lastActions: [],
    };
    const firstEntry = applyAiDailyForecastTransitionForTest(
      initial,
      source("confirm-one", "09:31", 102, 103, 101, 102.5),
      plan,
      "signal_quality"
    );
    const firstExit = applyAiDailyForecastTransitionForTest(
      firstEntry.next,
      source("target-one", "09:32", 102.5, 105.5, 102, 105),
      plan,
      "signal_quality"
    );
    expect(firstExit.resultType).toBe("hold");
    expect(firstExit.actions[0]).toMatchObject({
      type: "first_target_reached",
      automaticExitApplied: false,
      automaticLineUpdate: false,
    });
    const stretchExit = applyAiDailyForecastTransitionForTest(
      firstExit.next,
      source("stop-one", "09:33", 99, 100, 97, 98),
      plan,
      "signal_quality"
    );
    expect(stretchExit.resultType).toBe("exit");
    expect(stretchExit.closed?.reason).toBe("stop_loss");
    expect(stretchExit.next.executedPlanIds).toEqual([plan.sourceSnapshotId]);

    const samePlan = applyAiDailyForecastTransitionForTest(
      stretchExit.next,
      source("same-plan-later", "09:40", 101, 102, 99.5, 100),
      plan,
      "signal_quality"
    );
    expect(samePlan.resultType).toBe("no_signal");
    expect(samePlan.actions[0]).toMatchObject({
      reason: "ai_plan_entry_already_executed",
      planSnapshotId: plan.sourceSnapshotId,
    });

    const revised = {
      ...plan,
      sourceSnapshotId: "ai:1000:reentry",
      checkpoint: "10:00",
      entryWindowStart: "10:00",
      entryWindowEnd: "10:29",
    };
    const selected = applyAiDailyForecastSelectionTransitionForTest(
      stretchExit.next,
      source("revision", "10:00", 101, 102, 99.5, 100),
      {
        activePlanId: revised.sourceSnapshotId,
        plan: revised,
        disabledReason: null,
        openPositionAction: "keep",
      },
      "signal_quality"
    );
    const touch = applyAiDailyForecastTransitionForTest(
      selected.next,
      source("touch-two", "10:01", 101, 102, 99.5, 100),
      revised,
      "signal_quality"
    );
    const secondEntry = applyAiDailyForecastTransitionForTest(
      touch.next,
      source("confirm-two", "10:02", 102, 103, 101, 102.5),
      revised,
      "signal_quality"
    );
    expect(secondEntry.resultType).toBe("entry");
    expect(secondEntry.next.executedPlanIds).toEqual([
      plan.sourceSnapshotId,
      revised.sourceSnapshotId,
    ]);
  });

  it("never opens a second position or reenters on the exit source event", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry",
      signalTime: "09:30",
      entryTime: "09:31",
      entryPrice: 102,
      targetPrice: 105,
      stopPrice: 98,
      initialRiskPerShare: 4,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "15:20",
    };
    const state = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: null,
      position,
      executedPlanIds: [plan.sourceSnapshotId],
      lastSourceEventId: "entry",
      lastActions: [],
    };
    const closed = applyAiDailyForecastTransitionForTest(
      state,
      source("exit-event", "09:32", 102, 105.5, 101, 105),
      plan,
      "signal_quality"
    );
    expect(closed.resultType).toBe("exit");
    const sameEvent = applyAiDailyForecastTransitionForTest(
      closed.next,
      source("exit-event", "09:32", 101, 102, 99.5, 100),
      { ...plan, sourceSnapshotId: "ai:new-after-exit" },
      "signal_quality"
    );
    expect(sameEvent.resultType).toBe("no_signal");
    expect(sameEvent.actions[0]).toMatchObject({
      reason: "same_source_event_reentry_blocked",
    });
  });

  it("fails closed without a valid plan or after its window expires, while allowing an AI-planned opening entry", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: null,
      plan: null,
      touched: null,
      position: null,
      executedPlanIds: [],
      lastSourceEventId: null,
      lastActions: [],
    };
    const missing = applyAiDailyForecastTransitionForTest(
      initial,
      source("missing", "09:00", 101, 102, 99.5, 100),
      null,
      "signal_quality"
    );
    expect(missing.resultType).toBe("no_signal");
    expect(missing.actions[0]).toMatchObject({
      reason: "ai_snapshot_missing_invalid_or_non_directional",
    });
    const expired = applyAiDailyForecastTransitionForTest(
      { ...initial, activePlanId: plan.sourceSnapshotId, plan },
      source("expired", "15:19", 101, 102, 99.5, 100),
      { ...plan, entryWindowEnd: "15:00" },
      "signal_quality"
    );
    expect(expired.resultType).toBe("no_signal");
    expect(expired.actions[0]).toMatchObject({
      reason: "outside_active_ai_entry_window",
    });
    const openingTouch = applyAiDailyForecastTransitionForTest(
      { ...initial, activePlanId: plan.sourceSnapshotId, plan },
      source("opening-touch", "09:00", 101, 102, 99.5, 100),
      plan,
      "signal_quality"
    );
    const openingEntry = applyAiDailyForecastTransitionForTest(
      openingTouch.next,
      source("opening-confirm", "09:01", 102, 103, 101, 102.5),
      plan,
      "signal_quality"
    );
    expect(openingEntry.resultType).toBe("entry");
  });

  it("keeps an open position without opening another before a valid exit", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry",
      signalTime: "09:30",
      entryTime: "09:31",
      entryPrice: 102,
      targetPrice: 105,
      stopPrice: 98,
      initialRiskPerShare: 4,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "15:20",
    };
    const result = applyAiDailyForecastTransitionForTest(
      {
        tradeDate: "2026-10-09",
        activePlanId: plan.sourceSnapshotId,
        plan,
        touched: null,
        position,
        executedPlanIds: [plan.sourceSnapshotId],
        lastSourceEventId: "entry",
        lastActions: [],
      },
      source("hold", "09:32", 102, 104, 100, 102.5),
      plan,
      "signal_quality"
    );
    expect(result.resultType).toBe("hold");
    expect(result.opened).toBeNull();
    expect(result.next.position).toMatchObject({ entrySourceEventId: "entry" });
  });

  it("applies a causal same-direction tightening plan before the old force-exit deadline", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry-before-lunch",
      signalTime: "11:15",
      entryTime: "11:16",
      entryPrice: 102,
      targetPrice: 110,
      stopPrice: 98,
      initialRiskPerShare: 4,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "11:30",
      successorWaitEnabled: true,
    };
    const state = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: null,
      position,
      executedPlanIds: [plan.sourceSnapshotId],
      lastSourceEventId: "entry-before-lunch",
      lastActions: [],
    };
    const lunchPlan = {
      ...plan,
      sourceSnapshotId: "ai:1130:continue",
      checkpoint: "11:30",
      entryWindowStart: "12:30",
      entryWindowEnd: "12:34",
      firstTarget: 108,
      stopPrice: 101,
      forceExitTime: "13:00",
      openPositionAction: "tighten_only" as const,
    };
    const held = applyAiDailyForecastSelectionTransitionForTest(
      state,
      source("afternoon-open", "11:30", 104, 105, 103, 104),
      {
        activePlanId: lunchPlan.sourceSnapshotId,
        plan: lunchPlan,
        disabledReason: null,
        openPositionAction: "tighten_only",
      },
      "signal_quality"
    );
    expect(held.resultType).toBe("hold");
    expect(held.next.position).toMatchObject({
      stopPrice: 98,
      targetPrice: 110,
      pendingTightening: { stopPrice: 101, targetPrice: 108 },
      forceExitTime: "13:00",
      planSnapshotId: lunchPlan.sourceSnapshotId,
    });
    expect(held.actions[0]).toMatchObject({
      type: "position_plan_tightened",
      oldForceExitTime: "11:30",
      newForceExitTime: "13:00",
    });

    const awaiting = applyAiDailyForecastSelectionTransitionForTest(
      held.next,
      source("new-deadline", "13:00", 104, 105, 103, 104),
      {
        activePlanId: lunchPlan.sourceSnapshotId,
        plan: lunchPlan,
        disabledReason: null,
        openPositionAction: "tighten_only",
      },
      "signal_quality"
    );
    expect(awaiting.resultType).toBe("hold");
    expect(awaiting.actions[0]).toMatchObject({
      type: "awaiting_successor_plan",
      checkpoint: "13:00",
      validUntil: "13:29",
      stopRemainsActive: true,
      newEntriesAllowed: false,
    });
    const successorPlan = {
      ...lunchPlan,
      sourceSnapshotId: "ai:1300:continue",
      checkpoint: "13:00",
      entryWindowStart: "13:00",
      entryWindowEnd: "13:29",
      firstTarget: 107,
      stopPrice: 102,
      forceExitTime: "13:30",
    };
    const continued = applyAiDailyForecastSelectionTransitionForTest(
      awaiting.next,
      source("successor-arrived", "13:28", 104, 105, 103, 104),
      {
        activePlanId: successorPlan.sourceSnapshotId,
        plan: successorPlan,
        disabledReason: null,
        openPositionAction: "tighten_only",
      },
      "signal_quality"
    );
    expect(continued.resultType).toBe("hold");
    expect(continued.next.position).toMatchObject({
      stopPrice: 101,
      targetPrice: 108,
      pendingTightening: { stopPrice: 102, targetPrice: 107 },
      forceExitTime: "13:30",
      planSnapshotId: successorPlan.sourceSnapshotId,
      awaitingSuccessorPlan: null,
    });
    expect(continued.actions[0]).toMatchObject({
      type: "position_plan_tightened",
      revisedBy: successorPlan.sourceSnapshotId,
    });
    const exited = applyAiDailyForecastSelectionTransitionForTest(
      awaiting.next,
      source("successor-timeout", "13:29", 104, 105, 103, 104),
      {
        activePlanId: lunchPlan.sourceSnapshotId,
        plan: lunchPlan,
        disabledReason: null,
        openPositionAction: "tighten_only",
      },
      "signal_quality"
    );
    expect(exited.resultType).toBe("exit");
    expect(exited.closed?.reason).toBe("ai_successor_plan_missing_exit");
  });

  it("records firstTarget for a new position without automatically changing its protection", () => {
    const initial = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: { sourceEventId: "touch", time: "10:49", side: "long" as const },
      position: null,
      executedPlanIds: [],
      recentCloses: Array.from({ length: 19 }, (_, index) => 101 + index / 100),
      lastSourceEventId: "touch",
      lastActions: [],
    };
    const entered = applyAiDailyForecastTransitionForTest(
      initial,
      source("entry", "10:50", 102, 103, 101, 102.5),
      plan,
      "signal_quality"
    );
    expect(entered.resultType).toBe("entry");
    expect(entered.actions[1]).toMatchObject({
      type: "entry_revalidation_observed",
      status: "observation_only",
      automaticEntryVetoApplied: false,
    });

    const protectionArmed = applyAiDailyForecastTransitionForTest(
      entered.next,
      source("first-target", "10:51", 103, 105.5, 102.8, 105),
      plan,
      "signal_quality"
    );
    expect(protectionArmed.resultType).toBe("hold");
    expect(protectionArmed.next.position).toMatchObject({
      shares: 100,
      stopPrice: 98,
      targetPrice: 105,
      profitProtectionArmed: false,
      firstTargetReachedAt: "10:51",
    });
    expect(protectionArmed.actions[0]).toMatchObject({
      type: "first_target_reached",
      automaticLineUpdate: false,
    });

    const protectedExit = applyAiDailyForecastTransitionForTest(
      protectionArmed.next,
      source("momentum-protection-break", "10:52", 105, 105.5, 104.5, 104.8),
      plan,
      "signal_quality"
    );
    expect(protectedExit.resultType).toBe("hold");
    expect(protectedExit.next.position?.stopPrice).toBe(98);
  });

  it("records two-minute SMA20 adversity without turning it into an automatic exit", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry-observe",
      signalTime: "09:40",
      entryTime: "09:41",
      entryPrice: 102,
      targetPrice: 105,
      stretchTarget: 108,
      stopPrice: 90,
      initialRiskPerShare: 12,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "15:20",
      firstTargetDecisionEnabled: true,
      revalidationObservationEnabled: true,
      adverseSma20Consecutive: 0,
    };
    const state = {
      tradeDate: "2026-10-09",
      activePlanId: plan.sourceSnapshotId,
      plan,
      touched: null,
      position,
      executedPlanIds: [plan.sourceSnapshotId],
      recentCloses: Array.from({ length: 19 }, () => 103),
      lastSourceEventId: "entry-observe",
      lastActions: [],
    };
    const first = applyAiDailyForecastTransitionForTest(
      state,
      source("adverse-one", "09:42", 102, 102.5, 100.5, 101),
      plan,
      "signal_quality"
    );
    const second = applyAiDailyForecastTransitionForTest(
      first.next,
      source("adverse-two", "09:43", 101, 101.5, 99.5, 100),
      plan,
      "signal_quality"
    );
    expect(second.resultType).toBe("hold");
    expect(second.next.position?.adverseSma20Consecutive).toBe(2);
    expect(second.actions.at(-1)).toMatchObject({
      type: "position_revalidation_observed",
      adverseSma20Consecutive: 2,
      automaticExitApplied: false,
    });
    expect(second.next.recentCloses).toHaveLength(20);
  });

  it("never revives a position with a plan fixed after its old deadline", () => {
    const position = {
      side: "long" as const,
      entrySourceEventId: "entry-before-deadline",
      signalTime: "11:15",
      entryTime: "11:16",
      entryPrice: 102,
      targetPrice: 110,
      stopPrice: 98,
      initialRiskPerShare: 4,
      shares: 100,
      sourceBoardAgeMs: 100,
      deliveryBoardAgeMs: 10,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "11:30",
    };
    const latePlan = {
      ...plan,
      sourceSnapshotId: "ai:1235:too-late",
      checkpoint: "12:35",
      entryWindowStart: "12:35",
      entryWindowEnd: "12:59",
      stopPrice: 101,
      forceExitTime: "13:00",
      openPositionAction: "tighten_only" as const,
    };
    const result = applyAiDailyForecastSelectionTransitionForTest(
      {
        tradeDate: "2026-10-09",
        activePlanId: plan.sourceSnapshotId,
        plan,
        touched: null,
        position,
        executedPlanIds: [plan.sourceSnapshotId],
        lastSourceEventId: "entry-before-deadline",
        lastActions: [],
      },
      source("late-revision", "12:35", 104, 105, 103, 104),
      {
        activePlanId: latePlan.sourceSnapshotId,
        plan: latePlan,
        disabledReason: null,
        openPositionAction: "tighten_only",
      },
      "signal_quality"
    );
    expect(result.resultType).toBe("exit");
    expect(result.closed?.reason).toBe("ai_force_exit_time");
    expect(result.closed?.position.planSnapshotId).toBe(plan.sourceSnapshotId);
  });

  it("never opens a new position from the 11:30 management-only plan", () => {
    const lunchPlan = {
      ...plan,
      sourceSnapshotId: "ai:1130:flat",
      checkpoint: "11:30",
      entryWindowStart: "12:30",
      entryWindowEnd: "12:34",
    };
    const result = applyAiDailyForecastTransitionForTest(
      {
        tradeDate: "2026-10-09",
        activePlanId: lunchPlan.sourceSnapshotId,
        plan: lunchPlan,
        touched: null,
        position: null,
        executedPlanIds: [],
        lastSourceEventId: null,
        lastActions: [],
      },
      source("lunch-flat", "12:30", 101, 103, 99, 102),
      lunchPlan,
      "signal_quality"
    );
    expect(result.resultType).toBe("no_signal");
    expect(result.actions[0]).toMatchObject({
      reason: "lunch_position_management_only",
    });
  });

  it("学習実績0件でもcold-start監査がある不変snapshotは計画を作れる", () => {
    const snapshot = {
      sourceSnapshotId: "ai-daily-forecast:2026-10-14:test",
      qualityStatus: "verified",
      inputJson: { learningApplicationAudit: input.learningApplicationAudit },
      forecastJson: {
        quantBaseline: [{ symbol: "285A", atr5: 2 }],
        aiFinalForecast: { forecasts: [forecast("285A")] },
      },
    };
    expect(selectAiDailyPlanForTest(snapshot, "285A")).toMatchObject({
      symbol: "285A",
      checkpoint: "08:30",
    });
  });
});

it("sets explicit protection from entry and does not migrate an existing position", () => {
  const initial = {
    tradeDate: "2026-10-09",
    activePlanId: plan.sourceSnapshotId,
    plan,
    touched: {
      sourceEventId: "touch-protect",
      time: "10:49",
      side: "long" as const,
    },
    position: null,
    executedPlanIds: [],
    lastSourceEventId: "touch-protect",
    lastActions: [],
  };
  const entry = applyAiDailyForecastTransitionForTest(
    initial,
    source("entry-protect", "10:50", 102, 103, 101, 102.5),
    { ...plan, protectiveStop: 100 },
    "signal_quality"
  );
  expect(entry.opened).toMatchObject({
    managementVersion: "checkpoint_v1",
    stopPrice: 98,
    protectionLine: 100,
    positionId: "8035:long:entry-protect",
  });
  const invalid = applyAiDailyForecastTransitionForTest(
    initial,
    source("entry-invalid", "10:50", 102, 103, 101, 102.5),
    { ...plan, protectiveStop: 97 },
    "signal_quality"
  );
  expect(invalid.opened).toBeNull();
  expect(invalid.actions[0]).toMatchObject({
    reason: "initial_protective_stop_invalid",
  });
});
