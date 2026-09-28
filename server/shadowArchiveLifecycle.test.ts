import { describe, expect, it } from "vitest";
import {
  ARCHIVED_NO_SIGNAL_STATUS_REASON,
  isArchivedNoSignalStrategyVersion,
} from "./shadowArchiveLifecycle";

describe("未発火shadowの非破壊アーカイブ識別", () => {
  it("stoppedと専用reasonの組だけをarchived_no_signalとして扱う", () => {
    expect(isArchivedNoSignalStrategyVersion({
      status: "stopped",
      statusReason: ARCHIVED_NO_SIGNAL_STATUS_REASON,
    })).toBe(true);
    expect(isArchivedNoSignalStrategyVersion({
      status: "stopped",
      statusReason: "superseded_stopped_audit_only",
    })).toBe(false);
    expect(isArchivedNoSignalStrategyVersion({
      status: "monitoring",
      statusReason: ARCHIVED_NO_SIGNAL_STATUS_REASON,
    })).toBe(false);
  });
});
