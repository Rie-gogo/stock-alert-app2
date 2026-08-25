import { describe, expect, it } from "vitest";

import {
  getOpenPositions,
  getSymbolConfig,
  resolveRestoredRiskOverrides,
  restoreOpenPositions,
} from "./realtimeSimEngine";

describe("7銘柄の専用ポジション再起動復元", () => {
  const cases = [
    ["285A", "long", "反転LONG: 高値から下落後の反転", 0.6, 0.8],
    ["285A", "short", "反転SHORT: 高値から反落", 0.8, 1.2],
    ["285A", "short", "大台割れ (50000円割り込み)", 0.6, 1.5],
    ["285A", "long", "順張りLONG: 20本高値更新", 0.6, 0.8],
    ["285A", "short", "順張りSHORT: 10本安値更新", 0.8, 1.2],
    ["8035", "long", "順張りLONG: 20本高値更新", 0.7, 1.0],
    ["8035", "short", "順張りSHORT: 5本安値更新", 0.6, 1.8],
    ["8035", "short", "高値反転SHORT: 高値から反落", 0.6, 1.8],
    ["5803", "short", "フジクラ後場安値更新SHORT: 5本安値更新", 0.6, 1.5],
    ["5803", "long", "安値反転ブレイクLONG: 1本確認", 0.5, 0.5],
    ["5803", "short", "高値失速ブレイクSHORT: 1本確認", 0.6, 1.5],
    ["6981", "long", "安値反転ブレイクLONG: 1本確認", 1.0, 1.5],
    ["6981", "short", "寄り付きブレイクSHORT: 1本確認", 0.6, 1.5],
    ["6976", "short", "太陽誘電朝初動SHORT: 1本確認", 1.0, 1.5],
    ["6976", "long", "太陽誘電後場反転LONG: 1本確認", 1.0, 1.2],
    ["6976", "short", "太陽誘電後場反転SHORT: 1本確認", 1.0, 1.2],
    ["6857", "short", "アドバンテスト高値失速SHORT: 5本安値更新", 1.0, 1.2],
    ["6857", "long", "アドバンテスト確認型LONG: 20本高値更新", 0.5, 1.0],
    ["6146", "long", "ディスコ確認型10本高値更新LONG: VWAP上", 0.5, 1.8],
    ["6146", "short", "ディスコ寄り付き10本安値更新SHORT: 始値比-1%", 0.5, 2.0],
  ] as const;

  it.each(cases)("%s %s の理由別SL/TPを復元する", (symbol, side, reason, slPct, tpPct) => {
    expect(resolveRestoredRiskOverrides(symbol, side, reason)).toEqual({ slPct, tpPct });
  });

  it("6976朝初動SHORTは手動DB復元経路でもTP1.5%を維持する", () => {
    restoreOpenPositions([{
      symbol: "6976",
      side: "short",
      price: 3000,
      shares: 100,
      tradeTime: "09:31",
      reason: "太陽誘電朝初動SHORT: 1本確認",
    }]);
    const restored = getOpenPositions().find(position => position.symbol === "6976");
    expect(restored?.slPctOverride).toBe(1.0);
    expect(restored?.tpPctOverride).toBe(1.5);
  });

  it("8035の最大保有22分設定は再起動後も銘柄設定から解決される", () => {
    expect(getSymbolConfig("8035").telMaxHoldingMinutes).toBe(22);
  });
});
