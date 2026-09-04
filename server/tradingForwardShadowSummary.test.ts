import { describe, expect, it, vi } from "vitest";

const summaryMock = vi.hoisted(() => vi.fn(async (_asOfDate: string, strategyVersion: string) => ([{
  mode: "signal_quality",
  strategyVersion,
}])));
const auditDbMock = vi.hoisted(() => ({
  getRtRealtimeDecisionEventsForDate: vi.fn(async () => []),
  getRtReplayComparisonsForDate: vi.fn(async () => []),
  getRtPortfolioAuditEventsForDate: vi.fn(async () => []),
  getRtOutcomeLabelsForDate: vi.fn(async () => []),
  getRtDivergenceHypotheses: vi.fn(async () => []),
}));

vi.mock("./forwardShadow", () => ({
  getForwardShadowSummary: summaryMock,
}));
vi.mock("./db", async importOriginal => ({
  ...await importOriginal<typeof import("./db")>(),
  ...auditDbMock,
}));

import { tradingRouter } from "./routers/trading";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import { TEL_CURRENT_PARITY_VERSION, TEL_CAUSALITY_AUDIT_VERSION } from "./telCurrentParity";
import { TEL_EXECUTABLE_CONFIRM_VERSION } from "./telExecutableConfirm";
import { TEL_EXECUTABLE_DEPTH_VERSION } from "./telExecutableConfirmDepth";

describe("trading.getForwardShadowSummary", () => {
  it("既存4戦略の順序を保ち、8035旧A停止版・depth新版・parity・因果性監査を独立追加する", async () => {
    const caller = tradingRouter.createCaller({} as never);
    const result = await caller.getForwardShadowSummary({ asOfDate: "2026-09-04" });

    expect(result.strategies.map(item => ({
      strategyVersion: item.strategyVersion,
      symbol: item.symbol,
    }))).toEqual([
      { strategyVersion: FORWARD_STRATEGY_VERSION, symbol: "8035" },
      { strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, symbol: "5803" },
      { strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, symbol: "285A" },
      { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, symbol: "285A" },
      { strategyVersion: TEL_EXECUTABLE_CONFIRM_VERSION, symbol: "8035" },
      { strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, symbol: "8035" },
    ]);
    expect(result.strategies[4]).toMatchObject({ eligibleForAdoption: false, purpose: "superseded_stopped_audit_only" });
    expect(result.strategies[5]).toMatchObject({ eligibleForAdoption: true, purpose: "candidate" });
    expect(result.auditStrategies).toEqual([
      expect.objectContaining({ strategyVersion: TEL_CURRENT_PARITY_VERSION, purpose: "parity_only", eligibleForAdoption: false }),
      expect.objectContaining({ strategyVersion: TEL_CAUSALITY_AUDIT_VERSION, purpose: "causality_audit", eligibleForAdoption: false }),
    ]);
    expect(result.audit.semantics).toMatchObject({
      officialReplayOrder: "rt_realtime_decision_events.id_engine_sequence",
      brokerExecutionPrice: "unavailable_in_dry_run",
      automaticAdoption: false,
    });
    expect(summaryMock).toHaveBeenCalledTimes(6);
    expect(summaryMock).toHaveBeenNthCalledWith(3, "2026-09-04", KIOXIA_FORWARD_STRATEGY_VERSION);
    expect(summaryMock).toHaveBeenNthCalledWith(4, "2026-09-04", KIOXIA_ATR_FORWARD_STRATEGY_VERSION);
    expect(summaryMock).toHaveBeenNthCalledWith(5, "2026-09-04", TEL_EXECUTABLE_CONFIRM_VERSION);
    expect(summaryMock).toHaveBeenNthCalledWith(6, "2026-09-04", TEL_EXECUTABLE_DEPTH_VERSION);
  });
});
