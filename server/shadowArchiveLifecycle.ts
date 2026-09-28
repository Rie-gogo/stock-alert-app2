/**
 * `rt_strategy_versions` に既にある stopped enum を、未発火shadowの非破壊アーカイブに使う。
 * 監査履歴・config・過去event/tradeは削除せず、reason codeで停止理由を区別する。
 */
export const ARCHIVED_NO_SIGNAL_STATUS_REASON =
  "archived_no_signal:full_saved_history_zero_candidate_signal_and_trade";

export type ShadowStrategyLifecycle = {
  status: string | null | undefined;
  statusReason: string | null | undefined;
};

export function isArchivedNoSignalStrategyVersion(
  strategy: ShadowStrategyLifecycle | null | undefined,
): boolean {
  return strategy?.status === "stopped"
    && strategy.statusReason === ARCHIVED_NO_SIGNAL_STATUS_REASON;
}
