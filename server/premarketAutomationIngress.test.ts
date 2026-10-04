import { describe, expect, it } from "vitest";
import {
  authorizePremarketAutomation,
  PREMARKET_AUTOMATION_COLLECTOR_VERSION,
  premarketAutomationEnvelopeViolation,
} from "./premarketAutomationIngress";

const submission = {
  sourceSnapshotId: "premarket:2026-10-05:scheduled:0123456789abcdef",
  tradeDate: "2026-10-05",
  capturedAtMs: Date.parse("2026-10-05T08:30:00+09:00"),
  collectorVersion: PREMARKET_AUTOMATION_COLLECTOR_VERSION,
  sourceMode: "scheduled_research" as const,
  dow: null,
  cme: null,
  usdJpy: null,
};

describe("premarket automation ingress guard", () => {
  it("accepts only the configured key without exposing it to persistence", () => {
    const key = "a".repeat(64);
    expect(authorizePremarketAutomation(key, key)).toBe(true);
    expect(authorizePremarketAutomation("b".repeat(64), key)).toBe(false);
    expect(authorizePremarketAutomation("short", key)).toBe(false);
    expect(authorizePremarketAutomation(key, "")).toBe(false);
  });

  it("accepts only the fixed scheduled collector envelope", () => {
    expect(premarketAutomationEnvelopeViolation(submission)).toBeNull();
    expect(premarketAutomationEnvelopeViolation({ ...submission, sourceMode: "manual_review" }))
      .toBe("premarket_automation_source_mode_invalid");
    expect(premarketAutomationEnvelopeViolation({ ...submission, collectorVersion: "other" }))
      .toBe("premarket_automation_collector_version_invalid");
    expect(premarketAutomationEnvelopeViolation({ ...submission, sourceSnapshotId: undefined }))
      .toBe("premarket_automation_source_snapshot_id_required");
    expect(premarketAutomationEnvelopeViolation({ ...submission, sourceSnapshotId: "wrong" }))
      .toBe("premarket_automation_source_snapshot_id_invalid");
  });
});
