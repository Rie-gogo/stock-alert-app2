import type { RtForwardEvaluationControl } from "../drizzle/schema";
import { getRtForwardEvaluationControl } from "./db";

export const P0_PRODUCTION_VALIDATION_DATE = "2026-09-07";
export const P0_FORMAL_EVALUATION_EARLIEST_START_DATE = "2026-09-08";
export const FORWARD_FORMAL_CONTROL_NAME = "forward-shadow-formal-v1";

/** 9月7日の実受信確認後に別checkpointでtrueへ固定する。自動有効化は禁止。 */
export const P0_FORMAL_EVALUATION_ACTIVATED = false;

export type ForwardFormalEvaluationGate = {
  status: "pending_validation_day" | "pending_manual_activation" | "active";
  validationDate: string;
  earliestFormalStartDate: string;
  formalStartDate: string | null;
  activated: boolean;
  activationCheckpointId: string | null;
  activatedAtUtc: string | null;
  excludedTradeDates: string[];
  reason: string;
  excludesPreFixData: true;
};

function parseExcludedDates(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === "string") as string[]
    : [P0_PRODUCTION_VALIDATION_DATE];
}

export function resolveForwardFormalEvaluationGate(
  asOfDate: string,
  control: RtForwardEvaluationControl | null = null,
): ForwardFormalEvaluationGate {
  const structurallyActivated = Boolean(
    control?.activated
    && control.activationCheckpointId
    && control.activatedAtUtc
    && control.formalStartTradeDate
    && control.formalStartTradeDate >= P0_FORMAL_EVALUATION_EARLIEST_START_DATE,
  );
  const status = structurallyActivated && asOfDate >= control!.formalStartTradeDate!
    ? "active"
    : asOfDate < P0_PRODUCTION_VALIDATION_DATE
      ? "pending_validation_day"
      : "pending_manual_activation";
  return {
    status,
    validationDate: P0_PRODUCTION_VALIDATION_DATE,
    earliestFormalStartDate: P0_FORMAL_EVALUATION_EARLIEST_START_DATE,
    formalStartDate: structurallyActivated ? control!.formalStartTradeDate : null,
    activated: structurallyActivated,
    activationCheckpointId: structurallyActivated ? control!.activationCheckpointId : null,
    activatedAtUtc: structurallyActivated ? control!.activatedAtUtc!.toISOString() : null,
    excludedTradeDates: parseExcludedDates(control?.excludedTradeDatesJson),
    reason: control?.reason ?? "manual_activation_control_missing",
    excludesPreFixData: true,
  };
}

export async function loadForwardFormalEvaluationGate(asOfDate: string): Promise<ForwardFormalEvaluationGate> {
  const control = await getRtForwardEvaluationControl(FORWARD_FORMAL_CONTROL_NAME);
  return resolveForwardFormalEvaluationGate(asOfDate, control);
}
