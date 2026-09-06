import { describe, expect, it } from "vitest";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
} from "./runtimeIdentity";
import { applyForwardRouteParityGate, resolveForwardRouteParityGate } from "./forwardRouteParityGate";

describe("候補経路別parity Gate", () => {
  it("9984 A/Bは現行softbankBreakoutLong経路のparity証拠を必須にする", () => {
    for (const version of [SOFTBANK_DEPTH_CONFIRM_VERSION, SOFTBANK_RR2_PROTECT_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "required",
        requiredRoutes: ["softbankBreakoutLong"],
        evidence: { kind: "missing_route_parity" },
      });
    }
  });

  it("6976 A/Bは現行taiyoCandidateBLong経路のparity証拠を必須にする", () => {
    for (const version of [TAIYO_BOARD_DEMAND_VERSION, TAIYO_RR2_PROTECT_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "required",
        requiredRoutes: ["taiyoCandidateBLong"],
        evidence: { kind: "missing_route_parity" },
      });
    }
  });

  it("6976後場SHORT A/Bは現行taiyoAfternoonReversalShort経路のparity証拠を必須にする", () => {
    for (const version of [TAIYO_AFTERNOON_RR2_VERSION, TAIYO_AFTERNOON_DEPTH_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "required",
        requiredRoutes: ["taiyoAfternoonReversalShort"],
        evidence: { kind: "missing_route_parity" },
      });
    }
  });

  it("6526 A/Bは現行socionextConfirmedLong経路のparity証拠を必須にする", () => {
    for (const version of [SOCIONEXT_INITIAL_STRENGTH_VERSION, SOCIONEXT_CONFIRM_STRENGTH_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "required",
        requiredRoutes: ["socionextConfirmedLong"],
        evidence: { kind: "missing_route_parity" },
      });
    }
  });

  it("3436 A/Bは現行sumcoBreakdownShort経路のparity証拠を必須にする", () => {
    for (const version of [SUMCO_VOLUME_110_VERSION, SUMCO_TIME_15_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "required",
        requiredRoutes: ["sumcoBreakdownShort"],
        evidence: { kind: "missing_route_parity" },
      });
    }
  });

  it("8035候補は保存KABU48日・現行35取引完全一致を証拠として通過する", () => {
    for (const version of [FORWARD_STRATEGY_VERSION, TEL_EXECUTABLE_DEPTH_VERSION]) {
      expect(resolveForwardRouteParityGate(version)).toMatchObject({
        status: "passed",
        evidence: {
          kind: "saved_kabu_source_audit",
          replayedTradingDays: 48,
          matchedTrades: 35,
          mismatches: 0,
        },
      });
    }
  });

  it("5803・285A候補は属する現行経路のparity証拠が追加されるまでrequiredとする", () => {
    expect(resolveForwardRouteParityGate(FUJIKURA_FORWARD_STRATEGY_VERSION)).toMatchObject({
      status: "required",
      requiredRoutes: ["lowReversalBreakLong"],
    });
    expect(resolveForwardRouteParityGate(KIOXIA_FORWARD_STRATEGY_VERSION)).toMatchObject({
      status: "required",
      requiredRoutes: ["kioxiaConfirmedMorningLong"],
    });
    expect(resolveForwardRouteParityGate(KIOXIA_ATR_FORWARD_STRATEGY_VERSION)).toMatchObject({
      status: "required",
      requiredRoutes: ["confirmed_morning_long", "reversal_long", "reversal_short", "trend_short", "safe_cb_short"],
    });
  });

  it("4週間10件を満たしても経路parity未通過なら手動採用候補へ進めない", () => {
    const decision = { status: "eligible", reason: "four_weeks_and_ten_signals_manual_review_required", days: 28 };
    expect(applyForwardRouteParityGate(decision, resolveForwardRouteParityGate(FUJIKURA_FORWARD_STRATEGY_VERSION))).toMatchObject({
      status: "interim_continue",
      reason: "route_parity_required_before_manual_review",
      days: 28,
    });
    expect(applyForwardRouteParityGate(decision, resolveForwardRouteParityGate(TEL_EXECUTABLE_DEPTH_VERSION))).toEqual(decision);
  });
});
