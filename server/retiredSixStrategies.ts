import { updateRtStrategyVersionStatus } from "./db";

/**
 * Explicitly retired on 2026-10-08. These identifiers remain only to preserve
 * immutable historical rows and to enforce their terminal lifecycle state.
 * They are intentionally excluded from every active dispatcher, registry,
 * replay definition, selector, summary, and public card.
 */
export const RETIRED_TEL_EXECUTABLE_DEPTH_VERSION =
  "candidate-8035-executable-depth-v3-parity-reset";
export const RETIRED_TAIYO_AFTERNOON_RR2_VERSION =
  "candidate-6976-afternoon-short-rr2-45-v1";
export const RETIRED_TAIYO_AFTERNOON_DEPTH_VERSION =
  "candidate-6976-afternoon-short-depth-v1";
export const RETIRED_TAIYO_AFTERNOON_LONG_RR2_VERSION =
  "candidate-6976-afternoon-long-rr2-10-v1";

export const RETIRED_SIX_SHADOW_VERSIONS = Object.freeze([
  RETIRED_TEL_EXECUTABLE_DEPTH_VERSION,
  RETIRED_TAIYO_AFTERNOON_RR2_VERSION,
  RETIRED_TAIYO_AFTERNOON_DEPTH_VERSION,
  RETIRED_TAIYO_AFTERNOON_LONG_RR2_VERSION,
] as const);

export const RETIRED_STOPPED_CURRENT_CANONICAL_LOGICS = Object.freeze([
  "current-5803-afternoon-low-break-short",
  "current-6981-opening-break-short",
] as const);

export const RETIRED_STOPPED_CURRENT_ROUTE_GROUPS = Object.freeze([
  "afternoon_low_break_short",
  "opening_break_short",
] as const);

export const RETIRED_SIX_SHADOW_STATUS_REASON =
  "retired_by_explicit_six_logic_retirement_2026_10_08";

let retirementApplied = false;

/**
 * Updates only lifecycle metadata for pre-existing rows. It never writes events,
 * trades, states, snapshots, source data, or current-engine records.
 */
export async function retireSixShadowStrategyVersions(): Promise<void> {
  if (retirementApplied) return;
  for (const versionId of RETIRED_SIX_SHADOW_VERSIONS) {
    await updateRtStrategyVersionStatus({
      versionId,
      status: "stopped",
      statusReason: RETIRED_SIX_SHADOW_STATUS_REASON,
    });
  }
  retirementApplied = true;
}

export function resetSixShadowRetirementForTest(): void {
  retirementApplied = false;
}

type RetiredSelectorCandidate = {
  strategyVersion?: unknown;
  canonicalLogic?: unknown;
  routeGroupId?: unknown;
  symbol?: unknown;
};

const retiredVersions = new Set<string>(RETIRED_SIX_SHADOW_VERSIONS);
const retiredCurrentLogics = new Set<string>(RETIRED_STOPPED_CURRENT_CANONICAL_LOGICS);
const retiredCurrentRouteGroups = new Set<string>(RETIRED_STOPPED_CURRENT_ROUTE_GROUPS);

/** Read-time only: immutable historical rows are never rewritten or deleted. */
export function isExplicitlyRetiredSelectorCandidate(value: RetiredSelectorCandidate): boolean {
  return retiredVersions.has(String(value.strategyVersion ?? ""))
    || retiredCurrentLogics.has(String(value.canonicalLogic ?? ""))
    || isExplicitlyRetiredSelectorRouteGroup(value.symbol, value.routeGroupId);
}

export function isExplicitlyRetiredSelectorRouteGroup(symbol: unknown, routeGroupId: unknown): boolean {
  const normalizedSymbol = String(symbol ?? "");
  const normalizedGroup = String(routeGroupId ?? "");
  return retiredCurrentRouteGroups.has(normalizedGroup)
    && (normalizedSymbol === "5803" || normalizedSymbol === "6981");
}

export function isExplicitlyRetiredSelectorPlanId(planId: unknown): boolean {
  const normalized = String(planId ?? "");
  return RETIRED_SIX_SHADOW_VERSIONS.some(version => normalized === `shadow:${version}` || normalized.includes(version));
}

/** Prevent retired identifiers from leaking via diagnostic arrays in historical payloads. */
export function containsExplicitlyRetiredSelectorIdentifier(value: unknown): boolean {
  const text = String(value ?? "");
  return RETIRED_SIX_SHADOW_VERSIONS.some(version => text.includes(version))
    || RETIRED_STOPPED_CURRENT_CANONICAL_LOGICS.some(logic => text.includes(logic))
    || RETIRED_STOPPED_CURRENT_ROUTE_GROUPS.some(group => text.includes(group));
}
