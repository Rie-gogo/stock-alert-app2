import { describe, expect, it } from "vitest";
import {
  P0_FORMAL_EVALUATION_ACTIVATED,
  P0_FORMAL_EVALUATION_EARLIEST_START_DATE,
  P0_PRODUCTION_VALIDATION_DATE,
  resolveForwardFormalEvaluationGate,
} from "./forwardFormalEvaluationGate";

describe("P0修正後の正式未見評価Gate", () => {
  it("9月7日を確認日、9月8日を最短開始日とし、確認前は正式評価を有効化しない", () => {
    expect(P0_PRODUCTION_VALIDATION_DATE).toBe("2026-09-07");
    expect(P0_FORMAL_EVALUATION_EARLIEST_START_DATE).toBe("2026-09-08");
    expect(P0_FORMAL_EVALUATION_ACTIVATED).toBe(false);
    expect(resolveForwardFormalEvaluationGate("2026-09-06")).toMatchObject({
      status: "pending_validation_day",
      activated: false,
      excludesPreFixData: true,
    });
  });

  it("確認日以後も自動開始せず、別checkpointによる手動有効化を要求する", () => {
    expect(resolveForwardFormalEvaluationGate("2026-09-07")).toMatchObject({
      status: "pending_manual_activation",
      formalStartDate: "2026-09-08",
      activated: false,
    });
  });
});
