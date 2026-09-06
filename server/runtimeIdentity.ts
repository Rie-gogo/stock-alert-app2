import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_ENTRY_SYMBOLS, TARGET_STOCKS } from "../shared/stocks";
import { GENERATED_BUILD_IDENTITY } from "./generatedBuildIdentity";

export const BASELINE_STRATEGY_GIT_SHA = "f6878060c61ef5c2b8e3267b52756d019bb8bfe7";
export const BASELINE_TRADING_SOURCE_TREE_HASH = "42006f0ef757255a1b1eda86fa7c37dd28a4b42f7d23503867b9fefdf24dfeda";
export const FORWARD_STRATEGY_VERSION = "forward-shadow-8035-causal-current-price-v2";
export const FUJIKURA_FORWARD_STRATEGY_VERSION = "forward-shadow-5803-low-reversal-ab-v2-day-baseline-session-gap-fix";
export const KIOXIA_FORWARD_STRATEGY_VERSION = "forward-shadow-285a-confirmed-long-momentum-protect-v1";
export const KIOXIA_ATR_FORWARD_STRATEGY_VERSION = "forward-shadow-285a-five-routes-atr036-route-daily-end-v1";
export const TEL_CURRENT_PARITY_VERSION = "baseline-8035-current-parity-v1";
export const TEL_CAUSALITY_AUDIT_VERSION = "baseline-8035-causality-audit-v1";
export const TEL_EXECUTABLE_CONFIRM_VERSION = "candidate-8035-executable-confirm-v1";
export const TEL_EXECUTABLE_DEPTH_VERSION = "candidate-8035-executable-depth-v2";
export const SOFTBANK_DEPTH_CONFIRM_VERSION = "forward-shadow-9984-breakout-depth-confirm-v1";
export const SOFTBANK_RR2_PROTECT_VERSION = "forward-shadow-9984-breakout-rr2-protect-v1";
export const TAIYO_BOARD_DEMAND_VERSION = "candidate-6976-board-demand-bpr130-v1";
export const TAIYO_RR2_PROTECT_VERSION = "candidate-6976-rr2-protect-v1";
export const SOCIONEXT_INITIAL_STRENGTH_VERSION = "candidate-6526-initial-strength-daily-stop-v1";
export const SOCIONEXT_CONFIRM_STRENGTH_VERSION = "candidate-6526-confirm-strength-daily-stop-v1";
export const SUMCO_VOLUME_110_VERSION = "candidate-3436-volume110-time15-v1";
export const SUMCO_TIME_15_VERSION = "candidate-3436-current-entry-time15-v1";
export const FORWARD_STRATEGY_VERSIONS = Object.freeze([
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SUMCO_VOLUME_110_VERSION,
  SUMCO_TIME_15_VERSION,
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
    runtimeBuildIdentifier: exactBuildGitSha ?? deploymentRevision ?? deploymentVersion ?? "unavailable",
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
