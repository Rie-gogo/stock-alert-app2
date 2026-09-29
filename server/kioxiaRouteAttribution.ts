/**
 * 285A 安全CB SHORTの経路帰属は監査表示・比較用の派生情報である。
 * 現行売買の状態遷移、価格、損益、通常rt_tradesを変更しない。
 */
export const KIOXIA_SAFE_CB_SHORT_ROUTE_ID = "kioxiaSafeCbShort";
export const KIOXIA_SAFE_CB_ROUTE_MAPPING_VERSION = "candidate-route-attribution-v2";
export const KIOXIA_SAFE_CB_ROUTE_BACKFILL_CANDIDATE_IDS = Object.freeze([
  570001,
  630001,
  690008,
  750002,
] as const);

export interface RouteAttributionAudit {
  mappingVersion: string;
  previousRouteId: string | null;
  originalAuditRouteId: string | null;
  originalReason: string | null;
  canonicalRouteId: string;
  candidateRouteIds: readonly string[];
  status: "resolved" | "unresolved";
  reason: string;
  classifiedAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 未分類routeかどうかを表示層・backfill層で同じ基準に固定する。 */
export function isUnclassifiedCandidateRoute(routeId: string | null | undefined): boolean {
  return !routeId || routeId.endsWith(":unclassified");
}

/**
 * 新規監査eventと既存candidate backfillの双方で保存する、非破壊の派生帰属証跡。
 * previousRouteIdとoriginalReasonは一度保存された値を優先し、再適用しても変化しない。
 */
export function buildRouteAttributionAudit(input: {
  previousRouteId: string | null | undefined;
  originalAuditRouteId?: string | null | undefined;
  originalReason?: string | null | undefined;
  canonicalRouteId: string;
  candidateRouteIds?: readonly string[];
  reason: string;
  existing?: unknown;
  classifiedAt?: string;
}): RouteAttributionAudit {
  const existing = record(input.existing);
  const existingPreviousRouteId = text(existing.previousRouteId);
  const existingAuditRouteId = text(existing.originalAuditRouteId);
  const existingReason = text(existing.originalReason);
  const existingClassifiedAt = text(existing.classifiedAt);
  const candidateRouteIds = input.candidateRouteIds ?? [input.canonicalRouteId];
  return {
    mappingVersion: KIOXIA_SAFE_CB_ROUTE_MAPPING_VERSION,
    previousRouteId: existingPreviousRouteId ?? text(input.previousRouteId),
    originalAuditRouteId: existingAuditRouteId ?? text(input.originalAuditRouteId),
    originalReason: existingReason ?? text(input.originalReason),
    canonicalRouteId: input.canonicalRouteId,
    candidateRouteIds: Array.from(new Set(candidateRouteIds)),
    status: isUnclassifiedCandidateRoute(input.canonicalRouteId) ? "unresolved" : "resolved",
    reason: input.reason,
    classifiedAt: existingClassifiedAt ?? input.classifiedAt ?? new Date().toISOString(),
  };
}

/** JSON列に既存情報を残したまま、派生帰属証跡だけを追加・更新する。 */
export function attachRouteAttributionAudit(value: unknown, audit: RouteAttributionAudit): Record<string, unknown> {
  return {
    ...record(value),
    routeAttribution: audit,
  };
}

/** 保存済みsnapshotに含まれる帰属mappingの版を監査可能な形で返す。 */
export function collectRouteAttributionMappingVersions(
  records: ReadonlyArray<{ inputJson?: unknown }>,
): string[] {
  return Array.from(new Set(records.map(item => {
    const inputJson = record(item.inputJson);
    return text(record(inputJson.routeAttribution).mappingVersion);
  }).filter((value): value is string => value !== null))).sort();
}
