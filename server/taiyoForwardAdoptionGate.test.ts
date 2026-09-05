import { describe, expect, it } from "vitest";
import { TAIYO_BOARD_DEMAND_VERSION, TAIYO_RR2_PROTECT_VERSION } from "./runtimeIdentity";
import {
  applyTaiyoAdoptionGate,
  resolveTaiyoAdoptionGate,
} from "./taiyoForwardAdoptionGate";

const eligible = {
  status: "eligible",
  reason: "four_weeks_and_ten_signals_manual_review_required",
  days: 28,
};

describe("6976 A/B追加採用Gate", () => {
  it("板需給案には平均利益損失比0.8を誤適用せず891万円手動比較だけを要求する", () => {
    const gate = resolveTaiyoAdoptionGate({
      strategyVersion: TAIYO_BOARD_DEMAND_VERSION,
      realizedPayoffRatio: 0.2,
      trades: [{ pnl: 100, exitReason: "take_profit" }, { pnl: -500, exitReason: "stop_loss" }],
    });
    expect(gate).toMatchObject({
      applicable: true,
      strategyVariant: "board_demand",
      realizedPayoffRatioRequired: false,
      minimumRealizedPayoffRatio: null,
      payoffStatus: "not_required",
      portfolioGate: { status: "manual_comparison_required", automaticAdoption: false },
    });
    expect(applyTaiyoAdoptionGate(eligible, gate)).toMatchObject({
      status: "interim_continue",
      reason: "taiyo_891m_manual_comparison_required",
    });
  });

  it("RR2利益保護案は実現平均利益÷平均損失0.8未満なら採用候補化を停止する", () => {
    const gate = resolveTaiyoAdoptionGate({
      strategyVersion: TAIYO_RR2_PROTECT_VERSION,
      realizedPayoffRatio: 0.79,
      trades: [{ pnl: 79, exitReason: "profit_protection" }, { pnl: -100, exitReason: "stop_loss" }],
    });
    expect(gate).toMatchObject({
      strategyVariant: "rr2_protect",
      realizedPayoffRatioRequired: true,
      minimumRealizedPayoffRatio: 0.8,
      payoffStatus: "failed",
    });
    expect(applyTaiyoAdoptionGate(eligible, gate)).toMatchObject({
      status: "stopped",
      reason: "taiyo_rr2_realized_payoff_ratio_below_080",
    });
  });

  it("RR2利益保護案が0.8以上でも自動採用せず891万円手動比較を要求する", () => {
    const gate = resolveTaiyoAdoptionGate({
      strategyVersion: TAIYO_RR2_PROTECT_VERSION,
      realizedPayoffRatio: 0.8,
      trades: [{ pnl: 80, exitReason: "take_profit" }, { pnl: -100, exitReason: "stop_loss" }],
    });
    expect(gate.payoffStatus).toBe("passed");
    expect(applyTaiyoAdoptionGate(eligible, gate)).toMatchObject({
      status: "interim_continue",
      reason: "taiyo_891m_manual_comparison_required",
    });
  });

  it("6976以外には適用しない", () => {
    const gate = resolveTaiyoAdoptionGate({ strategyVersion: "other", realizedPayoffRatio: 0, trades: [] });
    expect(gate.applicable).toBe(false);
    expect(applyTaiyoAdoptionGate(eligible, gate)).toEqual(eligible);
  });
});
