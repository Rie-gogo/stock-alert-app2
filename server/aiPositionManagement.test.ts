import { describe, expect, it } from "vitest";
import {
  selectAiIntradayPlanForTest,
  applyAiDailyForecastSelectionTransitionForTest as step,
  type AiDailyForecastPlan,
} from "./aiDailyForecastShadowEngine";
import {
  aiPositionManagementPlanSchema,
  type AiPositionManagementPlan,
} from "./aiPositionManagement";
import { aiDecisionKnowledgeSchema } from "./aiDecisionKnowledge";
import type { ForwardSourceEventInput } from "./forwardShadow";

const plan: AiDailyForecastPlan = {
  sourceSnapshotId: "entry-plan",
  qualityStatus: "verified",
  symbol: "8035",
  direction: "up",
  forecastLow: 80,
  forecastHigh: 140,
  zoneLow: 95,
  zoneHigh: 100,
  confirmPrice: 101,
  firstTarget: 110,
  stretchTarget: 120,
  atr5: 2,
  stopPrice: 90,
  entryBlockedByRevision: false,
  checkpoint: "10:00",
  entryWindowStart: "10:00",
  entryWindowEnd: "10:14",
  forceExitTime: "10:15",
  openPositionAction: "keep",
};
function state(short = false, legacy = false) {
  return {
    tradeDate: "2026-10-16",
    activePlanId: plan.sourceSnapshotId,
    plan,
    touched: null,
    executedPlanIds: [plan.sourceSnapshotId],
    lastSourceEventId: "prior",
    lastActions: [],
    position: {
      managementVersion: legacy ? undefined : ("checkpoint_v1" as const),
      positionId: "position-1",
      side: short ? ("short" as const) : ("long" as const),
      entrySourceEventId: "entry",
      signalTime: "09:59",
      entryTime: "10:00",
      entryPrice: 100,
      targetPrice: short ? 90 : 110,
      stretchTarget: short ? 80 : 120,
      stopPrice: short ? 130 : 70,
      initialRiskPerShare: 30,
      shares: 100,
      sourceBoardAgeMs: 1,
      deliveryBoardAgeMs: 1,
      planSnapshotId: plan.sourceSnapshotId,
      forceExitTime: "10:15",
      protectionLine: short ? 125 : 75,
    },
  };
}
function event(time = "10:01", open = 100, low = 99, high = 101) {
  return {
    sourceEventId: time,
    board: {
      bids: [{ price: open, qty: 10000 }],
      asks: [{ price: open, qty: 10000 }],
    },
    currentAudit: { boardObservedAtMs: 1000, relayAssembledAtMs: 1100 },
    candle: {
      symbol: "8035",
      tradeDate: "2026-10-16",
      candleTime: time,
      open,
      low,
      high,
      close: open,
      volume: 1000,
    },
  } as ForwardSourceEventInput;
}
function command(
  short = false,
  overrides: Partial<AiPositionManagementPlan> = {}
): AiPositionManagementPlan {
  return {
    planId: "manage-1",
    positionId: "position-1",
    symbol: "8035",
    side: short ? "short" : "long",
    basedOnEventId: "prior",
    action: "hold",
    protectiveStop: short ? 110 : 90,
    validUntil: "10:30",
    reason: "checkpoint decision",
    knowledgeIds: ["knowledge-1"],
    ...overrides,
  };
}
function run(
  s: ReturnType<typeof state>,
  e = event(),
  commands: AiPositionManagementPlan[] = []
) {
  return step(
    s,
    e,
    {
      activePlanId: plan.sourceSnapshotId,
      plan,
      disabledReason: null,
      openPositionAction: "keep",
      managementPlans: commands,
    },
    "signal_quality"
  );
}

describe("explicit checkpoint position management", () => {
  it.each([false, true])(
    "applies on first new event and keeps hard stop separate, short=%s",
    short => {
      const s = state(short);
      s.lastSourceEventId = "10:01";
      const duplicate = run(s, event(), [command(short)]);
      expect(duplicate.next.position?.protectionLine).toBe(short ? 125 : 75);
      const applied = run(duplicate.next, event("10:02"), [command(short)]);
      expect(applied.next.position?.protectionLine).toBe(short ? 110 : 90);
      expect(applied.next.position?.stopPrice).toBe(short ? 130 : 70);
      expect(applied.next.position?.knowledgeIds).toEqual(["knowledge-1"]);
    }
  );
  it.each([false, true])(
    "rejects protective or hard stop relaxation without extending expiry, short=%s",
    short => {
      const s = state(short);
      for (const c of [
        command(short, { protectiveStop: short ? 126 : 74 }),
        command(short, { hardStop: short ? 131 : 69 }),
      ]) {
        const result = run(s, event(), [c]);
        expect(result.next.position?.forceExitTime).toBe("10:15");
        expect(result.next.position?.managementPlan).toBeUndefined();
        expect(result.actions[0].type).toBe("management_plan_rejected");
      }
    }
  );
  it.each([false, true])(
    "exits at executable event open when new protection is already broken, short=%s",
    short => {
      const result = run(state(short), event("10:01", 100, 99, 101), [
        command(short, { protectiveStop: short ? 95 : 105 }),
      ]);
      expect(result.closed).toMatchObject({
        reason: "ai_protective_stop_broken_on_arrival",
        price: 100,
      });
      expect(result.closed?.position.shares).toBe(100);
    }
  );
  it("does not apply a new line to earlier extremes of its activation event", () => {
    const result = run(state(), event("10:01", 100, 80, 101), [command()]);
    expect(result.closed).toBeNull();
    const next = run(result.next, event("10:02", 100, 89, 101), [command()]);
    expect(next.closed).toMatchObject({
      reason: "ai_protective_stop",
      price: 100,
    });
  });
  it.each(["take_profit", "exit"] as const)(
    "executes %s once for all shares",
    action => {
      const result = run(state(), event(), [command(false, { action })]);
      expect(result.closed?.reason).toBe(`ai_management_${action}`);
      expect(result.closed?.position.shares).toBe(100);
      const again = run(result.next, event(), [command(false, { action })]);
      expect(again.closed).toBeNull();
      expect(again.opened).toBeNull();
    }
  );
  it("does not reapply consumed commands or use one based on the execution event", () => {
    const a = run(state(), event(), [command()]);
    const b = run(a.next, event("10:02"), [
      command(false, { protectiveStop: 99 }),
    ]);
    expect(b.next.position?.protectionLine).toBe(90);
    const c = run(state(), event(), [
      command(false, { basedOnEventId: "10:01" }),
    ]);
    expect(c.next.position?.managementPlan).toBeUndefined();
  });
  it("waits through the successor checkpoint validity window then rejects late revival", () => {
    const waiting = run(state(), event("10:15"));
    expect(waiting.next.position?.awaitingSuccessorPlan?.validUntil).toBe(
      "10:29"
    );
    expect(run(waiting.next, event("10:28")).closed).toBeNull();
    const expired = run(waiting.next, event("10:29"), [command()]);
    expect(expired.closed?.reason).toBe("ai_management_successor_missing_exit");
    expect(expired.next.position).toBeNull();
  });
  it("accepts a valid successor before validUntil and keeps old protection while waiting", () => {
    const waiting = run(state(), event("10:15"));
    const successor = run(waiting.next, event("10:28"), [command()]);
    expect(successor.next.position?.forceExitTime).toBe("10:30");
    expect(successor.next.position?.awaitingSuccessorPlan).toBeNull();
    const stopped = run(waiting.next, event("10:20", 74, 73, 75));
    expect(stopped.closed?.reason).toBe("ai_protective_stop");
  });
  it("rejects an expired successor and retains original expiry", () => {
    const result = run(state(), event(), [
      command(false, { validUntil: "10:01" }),
    ]);
    expect(result.next.position?.forceExitTime).toBe("10:15");
  });
  it("ignores instructions for another position or side", () => {
    for (const c of [command(false, { positionId: "another" }), command(true)])
      expect(
        run(state(), event(), [c]).next.position?.managementPlan
      ).toBeUndefined();
  });
  it("records target arrival without automatic target exits or ratchet", () => {
    const a = run(state(), event("10:01", 111, 109, 121));
    expect(a.closed).toBeNull();
    expect(a.next.position?.firstTargetReachedAt).toBe("10:01");
    const b = run(a.next, event("10:02", 115, 100, 130));
    expect(b.closed).toBeNull();
    expect(b.next.position?.protectionLine).toBe(75);
  });
  it("leaves existing positions on legacy target rules", () => {
    const result = run(state(false, true), event("10:01", 111, 109, 121), [
      command(),
    ]);
    expect(result.closed?.reason).toBe("first_target");
  });
  it("disallows partial quantity and malformed times in schema", () => {
    expect(
      aiPositionManagementPlanSchema.safeParse({ ...command(), shares: 50 })
        .success
    ).toBe(false);
    expect(
      aiPositionManagementPlanSchema.safeParse(
        command(false, { validUntil: "10:99" })
      ).success
    ).toBe(false);
  });
});

describe("decision knowledge evidence separation", () => {
  const knowledge = {
    knowledgeId: "k",
    symbol: "8035",
    side: "long",
    status: "candidate",
    decisionFacts: {
      asOf: "2026-10-16T10:00:00+09:00",
      eventIds: ["decision"],
      facts: ["target reached"],
    },
    decisionReason: "hold with explicit protection",
    actualOutcome: {
      observedAt: "2026-10-16T10:20:00+09:00",
      eventIds: ["exit"],
      result: "protection triggered",
    },
    lessonCandidate: "consider context",
    counterexamples: [],
    uncertainty: ["single observation"],
  };
  it("persists facts and later outcomes as separate objects", () => {
    const parsed = aiDecisionKnowledgeSchema.parse(knowledge);
    expect(parsed.decisionFacts.eventIds).toEqual(["decision"]);
    expect(parsed.actualOutcome.eventIds).toEqual(["exit"]);
    expect(
      aiDecisionKnowledgeSchema.safeParse({
        ...knowledge,
        decisionFacts: { ...knowledge.decisionFacts, result: "future outcome" },
      }).success
    ).toBe(false);
  });
  it("rejects an outcome timestamp before the decision and missing uncertainty", () => {
    expect(
      aiDecisionKnowledgeSchema.safeParse({
        ...knowledge,
        actualOutcome: {
          ...knowledge.actualOutcome,
          observedAt: "2026-10-16T09:59:00+09:00",
        },
      }).success
    ).toBe(false);
    expect(
      aiDecisionKnowledgeSchema.safeParse({ ...knowledge, uncertainty: [] })
        .success
    ).toBe(false);
  });
});

describe("management execution availability", () => {
  it("latches expiry on a stale event and cannot be revived at the next tradable event", () => {
    const stale = event("10:29");
    stale.currentAudit = { ...stale.currentAudit!, relayAssembledAtMs: 10000 };
    const a = run(state(), stale, [command()]);
    expect(a.closed).toBeNull();
    expect(a.next.position?.managementExpired).toBe(true);
    const b = run(a.next, event("10:30", 98), [command()]);
    expect(b.closed).toMatchObject({
      reason: "ai_management_successor_missing_exit",
      price: 98,
    });
  });
  it("defers an instruction until a fresh event with sufficient full-position depth", () => {
    const thin = event();
    thin.board = {
      bids: [{ price: 100, qty: 50 }],
      asks: [{ price: 100, qty: 50 }],
    };
    const a = run(state(), thin, [command(false, { action: "take_profit" })]);
    expect(a.closed).toBeNull();
    expect(a.next.position?.managementPlan).toBeUndefined();
    const b = run(a.next, event("10:02", 102), [
      command(false, { action: "take_profit" }),
    ]);
    expect(b.closed).toMatchObject({
      reason: "ai_management_take_profit",
      price: 102,
    });
  });
});

it("keeps management commands when the separate entry forecast is disabled", () => {
  const management = command();
  const selected = selectAiIntradayPlanForTest(
    {
      sourceRevisionId: "revision",
      qualityStatus: "verified",
      checkpoint: "10:00",
      forecastJson: {
        aiFinalForecast: {
          forecast: { forecasts: [{ symbol: "8035", direction: "range" }] },
          controls: [{ symbol: "8035", planDecision: "disabled" }],
          managementPlans: [management],
        },
      },
      inputJson: {},
      validationJson: {},
    },
    "8035"
  );
  expect(selected?.plan).toBeNull();
  expect(selected?.managementPlans).toEqual([management]);
});

it("rejects a plan received after the successor deadline even if the next source candle is delayed", () => {
  const result = step(
    state(),
    event("10:16"),
    {
      activePlanId: plan.sourceSnapshotId,
      plan,
      disabledReason: null,
      openPositionAction: "keep",
      managementPlans: [command()],
      managementReceivedAtMs: Date.parse("2026-10-16T10:29:00+09:00"),
    },
    "signal_quality"
  );
  expect(result.closed?.reason).toBe("ai_management_successor_missing_exit");
});
