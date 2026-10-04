import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_ENTRY_SYMBOLS, TARGET_STOCKS } from "../shared/stocks";
import { GENERATED_BUILD_IDENTITY } from "./generatedBuildIdentity";

export const BASELINE_STRATEGY_GIT_SHA = "7291737d6ee3fdd798a6b090d2a3d3bda3e96bcc";
/** Plan Dの11経路停止を含む固定版。旧基準hashは監査履歴として保持する。 */
export const PRE_PLAN_D_TRADING_SOURCE_TREE_HASH = "de9d06e6bf9199a16c91a5593ff7bbb37f3776171c0f9f9eb7b9249de826afea";
/** Plan D公開版。6976因果執行・共通板鮮度補正前の監査基準として保持する。 */
export const PRE_CAUSAL_EXECUTION_TRADING_SOURCE_TREE_HASH = "a7843f9529e92f41abc0c34c8203d69747ab064c6d75feadcfe5fb9be239dce8";
/** 比較基盤の約定価格統一・自動materialization・候補世代reset前の監査基準。 */
export const PRE_COMPARISON_PLATFORM_FIX_SOURCE_TREE_HASH = "98a1d09d76c0d27d1a3026704b777c5e9449bca727ed376434932e77d8f7a9fc";
export const BASELINE_TRADING_SOURCE_TREE_HASH = "7fb4bcd9d63018f6abec18218aad47b0581da1a6cab1ec1ebd1dd2b5aed8d5d1";
export const FORWARD_STRATEGY_VERSION = "forward-shadow-8035-causal-current-price-v2";
export const FUJIKURA_FORWARD_STRATEGY_VERSION = "forward-shadow-5803-low-reversal-ab-v2-day-baseline-session-gap-fix";
export const FUJIKURA_MORNING_SHORT_VERSION = "candidate-5803-morning-20bar-breakdown-short-depth-v1";
export const KIOXIA_FORWARD_STRATEGY_VERSION = "forward-shadow-285a-confirmed-long-momentum-protect-v1";
export const KIOXIA_ATR_FORWARD_STRATEGY_VERSION = "forward-shadow-285a-five-routes-atr036-route-daily-end-v1";
export const TEL_CURRENT_PARITY_VERSION = "baseline-8035-current-parity-v1";
export const TEL_CAUSALITY_AUDIT_VERSION = "baseline-8035-causality-audit-v1";
export const TEL_EXECUTABLE_CONFIRM_VERSION = "candidate-8035-executable-confirm-v1";
/** 比較基盤修正前の履歴。新規イベントはv3へ収集する。 */
export const TEL_EXECUTABLE_DEPTH_LEGACY_VERSION = "candidate-8035-executable-depth-v2";
export const TEL_EXECUTABLE_DEPTH_VERSION = "candidate-8035-executable-depth-v3-parity-reset";
export const SOFTBANK_DEPTH_CONFIRM_VERSION = "forward-shadow-9984-breakout-depth-confirm-v1";
export const SOFTBANK_RR2_PROTECT_VERSION = "forward-shadow-9984-breakout-rr2-protect-v1";
/** 6857の現行経路とは独立した、手動審査専用の前向きshadow 2案。 */
export const ADVANTEST_SHORT_BODY008_DEPTH_VERSION = "candidate-6857-short-body008-depth-v1";
export const ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION = "candidate-6857-confirmed-continuation-depth-v1";
export const TAIYO_BOARD_DEMAND_VERSION = "candidate-6976-board-demand-bpr130-v1";
export const TAIYO_RR2_PROTECT_VERSION = "candidate-6976-rr2-protect-v1";
export const SOCIONEXT_INITIAL_STRENGTH_VERSION = "candidate-6526-initial-strength-daily-stop-v1";
export const SOCIONEXT_CONFIRM_STRENGTH_VERSION = "candidate-6526-confirm-strength-daily-stop-v1";
/** Invalid mapping retained only for historical audit; it is not dispatched or selectable. */
export const SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION = "candidate-6526-initial-strength-monitoring-reopen-v1";
/** Invalid mapping retained only for historical audit; it is not dispatched or selectable. */
export const KIOXIA_REVERSAL_LONG_REOPEN_VERSION = "candidate-285a-reversal-long-monitoring-reopen-v1";
/** Exact copy of old current 6526 confirmed-long, isolated from stopped/current state. */
export const SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION = "candidate-6526-confirmed-long-exact-monitoring-reopen-v2";
/** Exact copy of old current 285A reversal-long, isolated from Plan-B composite state. */
export const KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION = "candidate-285a-reversal-long-exact-monitoring-reopen-v2";
export const SUMCO_VOLUME_110_VERSION = "candidate-3436-volume110-time15-v1";
export const SUMCO_TIME_15_VERSION = "candidate-3436-current-entry-time15-v1";
export const TAIYO_AFTERNOON_RR2_VERSION = "candidate-6976-afternoon-short-rr2-45-v1";
export const TAIYO_AFTERNOON_DEPTH_VERSION = "candidate-6976-afternoon-short-depth-v1";
export const TAIYO_AFTERNOON_LONG_RR2_VERSION = "candidate-6976-afternoon-long-rr2-10-v1";
export const TAIYO_AFTERNOON_LONG_WINRATE_VERSION = "candidate-6976-afternoon-long-recovery-winrate-v1";
export const DISCO_SHORT_BASELINE_VERSION = "baseline-6146-opening-short-paused-v1";
/** 比較基盤修正前の履歴。新規イベントはv3へ収集する。 */
export const DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION = "candidate-6146-opening-short-executable-a-v2";
export const DISCO_SHORT_RETEST_B_LEGACY_VERSION = "candidate-6146-opening-short-retest-b-v2";
export const DISCO_SHORT_EXECUTABLE_A_VERSION = "candidate-6146-opening-short-executable-a-v3-parity-reset";
export const DISCO_SHORT_RETEST_B_VERSION = "candidate-6146-opening-short-retest-b-v3-parity-reset";
export const DISCO_LONG_PROFIT_PROTECTION_A_VERSION = "candidate-6146-confirmed-long-profit-protection-a-v1";
export const DISCO_LONG_PRIOR_THREE_B_VERSION = "candidate-6146-confirmed-long-prior-three-b-v1";
/** 6981の現行経路とは独立した、手動審査専用の前向きshadow 2案。 */
export const MURATA_DEEP_REVERSAL_LONG_VERSION = "candidate-6981-deep-reversal-long-v1";
export const MURATA_MORNING_BREAKDOWN_SHORT_VERSION = "candidate-6981-morning-20bar-breakdown-short-v1";
/** 旧簡易版。v2公開時に履歴専用へ移し、新規eventを追加しない。 */
export const TECHNICAL_REGIME_SHADOW_A_LEGACY_VERSIONS = Object.freeze({
  "285A": "candidate-285a-technical-regime-a-v1",
  "3436": "candidate-3436-technical-regime-a-v1",
  "5803": "candidate-5803-technical-regime-a-v1",
  "6146": "candidate-6146-technical-regime-a-v1",
  "6526": "candidate-6526-technical-regime-a-v1",
  "6857": "candidate-6857-technical-regime-a-v1",
  "6976": "candidate-6976-technical-regime-a-v1",
  "6981": "candidate-6981-technical-regime-a-v1",
  "8035": "candidate-8035-technical-regime-a-v1",
  "9984": "candidate-9984-technical-regime-a-v1",
} as const);
/** D-1日足＋当日確定5分/1分足の完全テクニカル仕様を評価する10銘柄共通shadow A v2。 */
export const TECHNICAL_REGIME_SHADOW_A_VERSIONS = Object.freeze({
  "285A": "candidate-285a-technical-regime-a-v2-complete-technical",
  "3436": "candidate-3436-technical-regime-a-v2-complete-technical",
  "5803": "candidate-5803-technical-regime-a-v2-complete-technical",
  "6146": "candidate-6146-technical-regime-a-v2-complete-technical",
  "6526": "candidate-6526-technical-regime-a-v2-complete-technical",
  "6857": "candidate-6857-technical-regime-a-v2-complete-technical",
  "6976": "candidate-6976-technical-regime-a-v2-complete-technical",
  "6981": "candidate-6981-technical-regime-a-v2-complete-technical",
  "8035": "candidate-8035-technical-regime-a-v2-complete-technical",
  "9984": "candidate-9984-technical-regime-a-v2-complete-technical",
} as const);
export const FORWARD_STRATEGY_VERSIONS = Object.freeze([
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  FUJIKURA_MORNING_SHORT_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
  TEL_EXECUTABLE_DEPTH_LEGACY_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
  ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION,
  KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
  SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION,
  KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
  SUMCO_VOLUME_110_VERSION,
  SUMCO_TIME_15_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_LEGACY_VERSION,
  DISCO_SHORT_RETEST_B_LEGACY_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  ...Object.values(TECHNICAL_REGIME_SHADOW_A_VERSIONS),
]);
export const FORWARD_AUDIT_STRATEGY_VERSIONS = Object.freeze([
  TEL_CURRENT_PARITY_VERSION,
  TEL_CAUSALITY_AUDIT_VERSION,
]);
export const FORWARD_EVALUATION_POLICY = Object.freeze({
  dryRunOnly: true,
  liveOrderApproved: false,
  interimCalendarDays: 14,
  minimumCalendarDaysForSignalCountDecision: 14,
  minimumSignalsForEarlyDecision: 20,
  calendarDaysForTimeDecision: 28,
  minimumSignalsForTimeDecision: 10,
  maximumCalendarDays: 56,
  minimumObservedWinRatePct: 70,
  minimumProfitFactor: 1.5,
  minimumExpectedR: 0.15,
  maximumConsecutiveLosses: 5,
  maximumCumulativeLossR: 6,
  adverseExitPct: 0.1,
  evaluationModes: ["signal_quality", "capital_constrained"] as const,
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readDeploymentVersion(): string | null {
  const candidates = [
    resolve(process.cwd(), "dist/public/__manus__/version.json"),
    resolve(process.cwd(), "client/public/__manus__/version.json"),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // 次の候補を確認する。
    }
  }
  return null;
}

export function getRuntimeIdentity() {
  const activeEntrySymbols = ACTIVE_ENTRY_SYMBOLS ? Array.from(ACTIVE_ENTRY_SYMBOLS).sort() : [];
  const receivedSymbols = TARGET_STOCKS.map(stock => stock.symbol).sort();
  const configHash = sha256Stable({
    sourceTreeHash: GENERATED_BUILD_IDENTITY.sourceTreeHash,
    activeEntrySymbols,
    receivedSymbols,
    policy: FORWARD_EVALUATION_POLICY,
    strategyVersions: FORWARD_STRATEGY_VERSIONS,
    auditStrategyVersions: FORWARD_AUDIT_STRATEGY_VERSIONS,
  });
  const generatedGitSha: string = GENERATED_BUILD_IDENTITY.gitSha;
  const exactBuildGitSha = generatedGitSha === "unavailable"
    ? null
    : generatedGitSha;
  const deploymentVersion = readDeploymentVersion();
  const deploymentRevision = process.env.K_REVISION ?? null;
  return {
    buildGitSha: exactBuildGitSha,
    gitShaVerification: exactBuildGitSha ? "available" as const : "platform_not_exposed_source_hash_used" as const,
    deploymentVersion,
    deploymentRevision,
    runtimeBuildIdentifier: exactBuildGitSha ?? deploymentRevision ?? deploymentVersion ?? GENERATED_BUILD_IDENTITY.sourceTreeHash,
    baselineStrategyGitSha: BASELINE_STRATEGY_GIT_SHA,
    baselineTradingSourceTreeHash: BASELINE_TRADING_SOURCE_TREE_HASH,
    tradingLogicMatchesBaseline: GENERATED_BUILD_IDENTITY.sourceTreeHash === BASELINE_TRADING_SOURCE_TREE_HASH,
    sourceTreeHash: GENERATED_BUILD_IDENTITY.sourceTreeHash,
    configHash,
    strategyVersion: FORWARD_STRATEGY_VERSION,
    strategyVersions: FORWARD_STRATEGY_VERSIONS,
    auditStrategyVersions: FORWARD_AUDIT_STRATEGY_VERSIONS,
    activeEntrySymbols,
    receivedSymbols,
    dryRunRequired: true as const,
    liveOrderApproved: false as const,
    generatedAt: GENERATED_BUILD_IDENTITY.generatedAt,
  };
}

export function formatRuntimeIdentityForLog(): string {
  const identity = getRuntimeIdentity();
  return JSON.stringify(identity);
}
