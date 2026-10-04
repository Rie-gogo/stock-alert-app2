import { timingSafeEqual } from "node:crypto";
import type { PremarketContextSubmission } from "./premarketContextIngestion";

export const PREMARKET_AUTOMATION_COLLECTOR_VERSION = "codex-premarket-context-v1";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** The key is transport authentication only and is never persisted or logged. */
export function authorizePremarketAutomation(
  providedKey: string,
  configuredKey = process.env.PREMARKET_CONTEXT_INGEST_KEY ?? "",
): boolean {
  return providedKey.length >= 32
    && configuredKey.length >= 32
    && safeEqual(providedKey, configuredKey);
}

export function premarketAutomationEnvelopeViolation(
  input: PremarketContextSubmission,
): string | null {
  if (input.sourceMode !== "scheduled_research") return "premarket_automation_source_mode_invalid";
  if (input.collectorVersion !== PREMARKET_AUTOMATION_COLLECTOR_VERSION) {
    return "premarket_automation_collector_version_invalid";
  }
  if (!input.sourceSnapshotId) return "premarket_automation_source_snapshot_id_required";
  const expectedPrefix = `premarket:${input.tradeDate}:scheduled:`;
  if (!input.sourceSnapshotId.startsWith(expectedPrefix)) {
    return "premarket_automation_source_snapshot_id_invalid";
  }
  return null;
}
