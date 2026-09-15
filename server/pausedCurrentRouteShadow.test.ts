import { describe, expect, it } from "vitest";
import {
  PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
  PAUSED_CURRENT_ROUTE_SPECS,
  encodePausedCurrentRouteReason,
  encodePausedCurrentRouteRepeatReason,
  isPausedCurrentRouteControlReason,
  isPausedCurrentRouteReason,
  pausedCurrentRouteCaptureKey,
  pausedCurrentRouteOriginalReason,
  resolvePausedCurrentRoute,
  resolveStoredPausedCurrentRoute,
} from "./pausedCurrentRouteShadow";
import { resolveSpecializedFiredStateKeys } from "./realtimeSimEngine";
import { resolveCurrentRouteSpec } from "./currentSignalCandidateRegistry";

describe("paused current route shadow policy", () => {
  it("添付指定の11経路を重複なく固定する", () => {
    expect(PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE).toBe("2026-09-16");
    expect(PAUSED_CURRENT_ROUTE_SPECS).toHaveLength(11);
    expect(new Set(PAUSED_CURRENT_ROUTE_SPECS.map(spec => `${spec.symbol}:${spec.side}:${spec.label}`)).size).toBe(11);
    expect(PAUSED_CURRENT_ROUTE_SPECS.filter(spec => spec.captureViaGenericCandidateLedger)).toHaveLength(10);
    expect(PAUSED_CURRENT_ROUTE_SPECS.find(spec => spec.symbol === "6146")).toMatchObject({
      captureViaGenericCandidateLedger: false,
      label: "寄り付き10本安値更新SHORT",
    });
  });

  it("有効日前は止めず、有効日から銘柄・方向・理由が一致する経路だけを止める", () => {
    const input = {
      symbol: "285A", side: "long" as const,
      reason: "キオクシア確認型前場LONG: テスト",
    };
    expect(resolvePausedCurrentRoute({ ...input, tradeDate: "2026-09-15" })).toBeNull();
    expect(resolvePausedCurrentRoute({ ...input, tradeDate: "2026-09-16" })?.stateKey).toBe("trendLong");
    expect(resolvePausedCurrentRoute({ ...input, side: "short", tradeDate: "2026-09-16" })).toBeNull();
    expect(resolvePausedCurrentRoute({ ...input, symbol: "9984", tradeDate: "2026-09-16" })).toBeNull();
  });

  it("6976後場反転はLONGだけを止め、SHORTは維持する", () => {
    expect(resolvePausedCurrentRoute({
      symbol: "6976", side: "long", reason: "太陽誘電後場反転LONG: テスト", tradeDate: "2026-09-16",
    })?.stateKey).toBe("taiyoAfternoonReversal");
    expect(resolvePausedCurrentRoute({
      symbol: "6976", side: "short", reason: "太陽誘電後場反転SHORT: テスト", tradeDate: "2026-09-16",
    })).toBeNull();
  });

  it("監査理由へ元理由を可逆に格納する", () => {
    const spec = PAUSED_CURRENT_ROUTE_SPECS[0]!;
    const original = "キオクシア確認型前場LONG: 出来高1.20倍";
    const encoded = encodePausedCurrentRouteReason(spec, original);
    expect(isPausedCurrentRouteReason(encoded)).toBe(true);
    expect(isPausedCurrentRouteControlReason(encoded)).toBe(true);
    expect(pausedCurrentRouteOriginalReason(encoded)).toBe(original);
    const repeat = encodePausedCurrentRouteRepeatReason(spec);
    expect(isPausedCurrentRouteReason(repeat)).toBe(false);
    expect(isPausedCurrentRouteControlReason(repeat)).toBe(true);
    expect(pausedCurrentRouteOriginalReason(repeat)).toBeNull();
  });

  it("5803後場SHORTを実際の理由文字列から仮想損益の経路へ分類する", () => {
    const reason = "後場安値更新SHORT: 始値比-1.5%、5本安値更新";
    expect(resolveSpecializedFiredStateKeys("5803", "short", reason)).toEqual(["afternoonLowBreakShort"]);
    expect(resolveCurrentRouteSpec({
      symbol: "5803", side: "short", reason, entryCandleTime: "13:45",
    }).routeId).toBe("afternoonLowBreakShort");
  });

  it("停止する10経路すべてを同じrouteIdの仮想取引として追跡できる", () => {
    for (const spec of PAUSED_CURRENT_ROUTE_SPECS.filter(item => item.captureViaGenericCandidateLedger)) {
      const reason = `${spec.reasonPrefixes[0]}: テスト候補`;
      expect(resolvePausedCurrentRoute({
        symbol: spec.symbol, side: spec.side, reason, tradeDate: "2026-09-16",
      })?.stateKey).toBe(spec.stateKey);
      expect(resolveCurrentRouteSpec({
        symbol: spec.symbol, side: spec.side, reason, entryCandleTime: "10:00",
      }).routeId).toBe(spec.stateKey);
    }
  });

  it("再起動後も保存済み監査イベント・仮想候補から日次枠を復元できる", () => {
    const spec = PAUSED_CURRENT_ROUTE_SPECS.find(item => item.symbol === "6526")!;
    const encodedReason = encodePausedCurrentRouteReason(spec, "ソシオネクスト確認型LONG: テスト");
    expect(resolveStoredPausedCurrentRoute({ symbol: "6526", encodedReason })).toBe(spec);
    expect(resolveStoredPausedCurrentRoute({
      symbol: "6526", routeId: "socionextConfirmedLong", realtimeDecision: "shadow_only",
    })).toBe(spec);
    expect(resolveStoredPausedCurrentRoute({
      symbol: "6526", routeId: "socionextConfirmedLong", realtimeDecision: "accepted",
    })).toBeNull();
    expect(pausedCurrentRouteCaptureKey(spec, "2026-09-16")).toBe("2026-09-16:6526:socionext_confirmed_long");
  });
});
