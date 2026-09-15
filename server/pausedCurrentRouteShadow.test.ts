import { describe, expect, it } from "vitest";
import {
  PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
  PAUSED_CURRENT_ROUTE_SPECS,
  encodePausedCurrentRouteReason,
  encodePausedCurrentRouteRepeatReason,
  isPausedCurrentRouteControlReason,
  isPausedCurrentRouteReason,
  pausedCurrentRouteOriginalReason,
  resolvePausedCurrentRoute,
} from "./pausedCurrentRouteShadow";

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
});
