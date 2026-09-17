import { describe, expect, it, vi } from "vitest";

const summaryMock = vi.hoisted(() => vi.fn(async (_asOfDate: string, strategyVersion: string) => ([{
  mode: "signal_quality",
  strategyVersion,
}])));
const auditDbMock = vi.hoisted(() => ({
  getRtRealtimeDecisionEventsForDate: vi.fn(async () => []),
  getRtReplayComparisonsForDate: vi.fn(async () => []),
  getRtPortfolioAuditEventsForDate: vi.fn(async () => []),
  getRtDailyAuditMaterialization: vi.fn(async () => ({
    status: "complete",
    resultJson: { scenarios: { paused_current: { actualReceipt: { complete: true } } } },
  })),
  getRtOutcomeLabelsForDate: vi.fn(async () => []),
  getRtDivergenceHypotheses: vi.fn(async () => []),
}));

vi.mock("./forwardShadow", () => ({ getForwardShadowSummary: summaryMock }));
vi.mock("./db", async importOriginal => ({
  ...await importOriginal<typeof import("./db")>(),
  ...auditDbMock,
}));

import { tradingRouter } from "./routers/trading";
import {
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_LEGACY_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  FUJIKURA_MORNING_SHORT_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_LEGACY_VERSION,
} from "./runtimeIdentity";
import { TEL_CURRENT_PARITY_VERSION, TEL_CAUSALITY_AUDIT_VERSION } from "./telCurrentParity";
import { TEL_EXECUTABLE_CONFIRM_VERSION } from "./telExecutableConfirm";
import { TEL_EXECUTABLE_DEPTH_VERSION } from "./telExecutableConfirmDepth";

describe("trading.getForwardShadowSummary", () => {
  it("既存順序を保ち、比較基盤修正前の履歴と修正後の8035・6146候補を分離する", async () => {
    const caller = tradingRouter.createCaller({} as never);
    const result = await caller.getForwardShadowSummary({ asOfDate: "2026-09-17" });

    const expected = [
      [FORWARD_STRATEGY_VERSION, "8035"],
      [FUJIKURA_FORWARD_STRATEGY_VERSION, "5803"],
      [FUJIKURA_MORNING_SHORT_VERSION, "5803"],
      [KIOXIA_FORWARD_STRATEGY_VERSION, "285A"],
      [KIOXIA_ATR_FORWARD_STRATEGY_VERSION, "285A"],
      [TEL_EXECUTABLE_CONFIRM_VERSION, "8035"],
      [TEL_EXECUTABLE_DEPTH_LEGACY_VERSION, "8035"],
      [TEL_EXECUTABLE_DEPTH_VERSION, "8035"],
      [SOFTBANK_DEPTH_CONFIRM_VERSION, "9984"],
      [SOFTBANK_RR2_PROTECT_VERSION, "9984"],
      [TAIYO_BOARD_DEMAND_VERSION, "6976"],
      [TAIYO_RR2_PROTECT_VERSION, "6976"],
      [TAIYO_AFTERNOON_RR2_VERSION, "6976"],
      [TAIYO_AFTERNOON_DEPTH_VERSION, "6976"],
      [TAIYO_AFTERNOON_LONG_RR2_VERSION, "6976"],
      [TAIYO_AFTERNOON_LONG_WINRATE_VERSION, "6976"],
      [SOCIONEXT_INITIAL_STRENGTH_VERSION, "6526"],
      [SOCIONEXT_CONFIRM_STRENGTH_VERSION, "6526"],
      [SUMCO_VOLUME_110_VERSION, "3436"],
      [SUMCO_TIME_15_VERSION, "3436"],
      [DISCO_SHORT_BASELINE_VERSION, "6146"],
      [DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION, "6146"],
      [DISCO_SHORT_RETEST_B_LEGACY_VERSION, "6146"],
      [DISCO_SHORT_EXECUTABLE_A_VERSION, "6146"],
      [DISCO_SHORT_RETEST_B_VERSION, "6146"],
      [DISCO_LONG_PROFIT_PROTECTION_A_VERSION, "6146"],
      [DISCO_LONG_PRIOR_THREE_B_VERSION, "6146"],
    ] as const;
    expect(result.strategies.map(item => [item.strategyVersion, item.symbol])).toEqual(expected);

    const byVersion = new Map(result.strategies.map(item => [item.strategyVersion, item]));
    expect(byVersion.get(FUJIKURA_MORNING_SHORT_VERSION)).toMatchObject({
      eligibleForAdoption: false,
      purpose: "diagnostic_candidate",
      automaticAdoption: false,
      orderInstructionConnection: false,
      collectionStartDate: "2026-09-17",
      evaluationStartDate: "2026-09-17",
    });
    expect(byVersion.get(TEL_EXECUTABLE_CONFIRM_VERSION)).toMatchObject({ eligibleForAdoption: false, purpose: "superseded_stopped_audit_only" });
    expect(byVersion.get(TEL_EXECUTABLE_DEPTH_LEGACY_VERSION)).toMatchObject({ eligibleForAdoption: false, purpose: "superseded_stopped_audit_only" });
    expect(byVersion.get(TEL_EXECUTABLE_DEPTH_VERSION)).toMatchObject({
      eligibleForAdoption: true,
      purpose: "candidate",
      collectionStartDate: "2026-09-18",
      evaluationStartDate: "2026-09-18",
    });
    expect(byVersion.get(TAIYO_AFTERNOON_LONG_RR2_VERSION)).toMatchObject({ eligibleForAdoption: false, purpose: "diagnostic_candidate" });
    expect(byVersion.get(DISCO_SHORT_BASELINE_VERSION)).toMatchObject({ eligibleForAdoption: false, purpose: "paused_current_route_comparison_only" });
    for (const version of [DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION, DISCO_SHORT_RETEST_B_LEGACY_VERSION]) {
      expect(byVersion.get(version)).toMatchObject({ eligibleForAdoption: false, purpose: "superseded_stopped_audit_only" });
    }
    for (const version of [DISCO_SHORT_EXECUTABLE_A_VERSION, DISCO_SHORT_RETEST_B_VERSION]) {
      expect(byVersion.get(version)).toMatchObject({
        eligibleForAdoption: true,
        purpose: "candidate",
        collectionStartDate: "2026-09-18",
        evaluationStartDate: "2026-09-18",
      });
    }
    for (const version of [DISCO_LONG_PROFIT_PROTECTION_A_VERSION, DISCO_LONG_PRIOR_THREE_B_VERSION]) {
      expect(byVersion.get(version)).toMatchObject({
        eligibleForAdoption: true,
        purpose: "candidate",
        collectionStartDate: "2026-09-18",
        evaluationStartDate: "2026-09-18",
      });
    }

    expect(result.auditStrategies).toEqual([
      expect.objectContaining({ strategyVersion: TEL_CURRENT_PARITY_VERSION, purpose: "parity_only", eligibleForAdoption: false }),
      expect.objectContaining({ strategyVersion: TEL_CAUSALITY_AUDIT_VERSION, purpose: "causality_audit", eligibleForAdoption: false }),
    ]);
    expect(result.audit.semantics).toMatchObject({
      officialReplayOrder: "rt_realtime_decision_events.id_engine_sequence",
      brokerExecutionPrice: "unavailable_in_dry_run",
      automaticAdoption: false,
    });
    expect(result.audit.discoShortPortfolioComparison).toMatchObject({ scenarios: { paused_current: { actualReceipt: { complete: true } } } });
    expect(result.pausedCurrentRoutes).toHaveLength(11);
    expect(result.pausedCurrentRoutes.map(item => `${item.symbol}:${item.logicName}`)).toContain("6146:寄り付き10本安値更新SHORT");
    expect(summaryMock).toHaveBeenCalledTimes(expected.length);
    for (const [version] of expected) {
      expect(summaryMock).toHaveBeenCalledWith("2026-09-17", version);
    }
  });
});
