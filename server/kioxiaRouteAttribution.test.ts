import { describe, expect, it } from "vitest";
import {
  attachRouteAttributionAudit,
  buildRouteAttributionAudit,
  collectRouteAttributionMappingVersions,
  KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
  KIOXIA_SAFE_CB_ROUTE_MAPPING_VERSION,
} from "./kioxiaRouteAttribution";

describe("285A安全CB SHORT route attribution", () => {
  it("未分類の元route・完全reasonを残しつつ安全CB SHORTへ解決する", () => {
    const audit = buildRouteAttributionAudit({
      previousRouteId: "285A:short:unclassified",
      originalAuditRouteId: null,
      originalReason: "大台確認(2本維持): 大台割れ (54900円割り込み)",
      canonicalRouteId: KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
      reason: "285A_safe_cb_short_route_backfill",
      classifiedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(audit).toMatchObject({
      mappingVersion: KIOXIA_SAFE_CB_ROUTE_MAPPING_VERSION,
      previousRouteId: "285A:short:unclassified",
      canonicalRouteId: KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
      status: "resolved",
    });
    expect(attachRouteAttributionAudit({ preserved: true }, audit)).toMatchObject({
      preserved: true,
      routeAttribution: audit,
    });
  });

  it("同じbackfillを再適用しても元routeと初回分類時刻を変えない", () => {
    const first = buildRouteAttributionAudit({
      previousRouteId: "285A:short:unclassified",
      canonicalRouteId: KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
      reason: "285A_safe_cb_short_route_backfill",
      classifiedAt: "2026-09-29T10:00:00.000Z",
    });
    const second = buildRouteAttributionAudit({
      previousRouteId: KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
      canonicalRouteId: KIOXIA_SAFE_CB_SHORT_ROUTE_ID,
      reason: "285A_safe_cb_short_route_backfill",
      existing: first,
      classifiedAt: "2026-09-29T11:00:00.000Z",
    });
    expect(second.previousRouteId).toBe("285A:short:unclassified");
    expect(second.classifiedAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("snapshotへ保存するmapping versionを重複なく安定順で集める", () => {
    expect(collectRouteAttributionMappingVersions([
      { inputJson: { routeAttribution: { mappingVersion: "candidate-route-attribution-v2" } } },
      { inputJson: { routeAttribution: { mappingVersion: "candidate-route-attribution-v2" } } },
      { inputJson: { routeAttribution: { mappingVersion: "other-v1" } } },
    ])).toEqual(["candidate-route-attribution-v2", "other-v1"]);
  });
});
