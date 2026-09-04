export const P0_PRODUCTION_VALIDATION_DATE = "2026-09-07";
export const P0_FORMAL_EVALUATION_EARLIEST_START_DATE = "2026-09-08";

/** 9月7日の実受信確認後に別checkpointでtrueへ固定する。自動有効化は禁止。 */
export const P0_FORMAL_EVALUATION_ACTIVATED = false;

export type ForwardFormalEvaluationGate = {
  status: "pending_validation_day" | "pending_manual_activation" | "active";
  validationDate: string;
  formalStartDate: string;
  activated: boolean;
  excludesPreFixData: true;
};

export function resolveForwardFormalEvaluationGate(asOfDate: string): ForwardFormalEvaluationGate {
  const status = P0_FORMAL_EVALUATION_ACTIVATED
    ? "active"
    : asOfDate < P0_PRODUCTION_VALIDATION_DATE
      ? "pending_validation_day"
      : "pending_manual_activation";
  return {
    status,
    validationDate: P0_PRODUCTION_VALIDATION_DATE,
    formalStartDate: P0_FORMAL_EVALUATION_EARLIEST_START_DATE,
    activated: P0_FORMAL_EVALUATION_ACTIVATED,
    excludesPreFixData: true,
  };
}
