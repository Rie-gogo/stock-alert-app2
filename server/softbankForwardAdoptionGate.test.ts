import { describe, expect, it } from "vitest";
import {
  applySoftbankAdoptionGate,
  resolveSoftbankAdoptionGate,
} from "./softbankForwardAdoptionGate";
import {
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";

describe("9984追加採用Gate", () => {
  it("完了取引から実現平均利益損失比とTP到達率を分離表示する", () => {
    const gate = resolveSoftbankAdoptionGate({
      strategyVersion: SOFTBANK_RR2_PROTECT_VERSION,
      realizedPayoffRatio: 1.2,
      trades: [
        { pnl: 100, exitReason: "take_profit" },
        { pnl: 5, exitReason: "profit_protection" },
        { pnl: -50, exitReason: "stop_loss" },
        { pnl: null, exitReason: null },
      ],
    });
    expect(gate).toMatchObject({
      applicable: true,
      payoffStatus: "passed",
      takeProfitExits: 1,
      completedTrades: 3,
      portfolioGate: { status: "manual_comparison_required", automaticAdoption: false },
    });
    expect(gate.takeProfitReachRatePct).toBeCloseTo(100 / 3, 10);
  });

  it("4週10件の通常基準を満たしても平均利益損失比0.8未満なら停止する", () => {
    const gate = resolveSoftbankAdoptionGate({
      strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION,
      realizedPayoffRatio: 0.79,
      trades: [{ pnl: 100, exitReason: "take_profit" }, { pnl: -100, exitReason: "stop_loss" }],
    });
    expect(applySoftbankAdoptionGate({ status: "eligible", reason: "core_passed", days: 28 }, gate))
      .toMatchObject({ status: "stopped", reason: "softbank_realized_payoff_ratio_below_080" });
  });

  it("平均利益損失比を満たしても891万円比較完了まではeligibleにしない", () => {
    const gate = resolveSoftbankAdoptionGate({
      strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION,
      realizedPayoffRatio: 1.1,
      trades: [{ pnl: 100, exitReason: "take_profit" }, { pnl: -50, exitReason: "stop_loss" }],
    });
    expect(applySoftbankAdoptionGate({ status: "eligible", reason: "core_passed", days: 28 }, gate))
      .toMatchObject({ status: "interim_continue", reason: "softbank_891m_manual_comparison_required" });
  });
});
