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
