import { createHash } from "node:crypto";
import { ACTIVE_ENTRY_SYMBOLS, TARGET_STOCKS } from "../shared/stocks";
import { GENERATED_BUILD_IDENTITY } from "./generatedBuildIdentity";

export const BASELINE_STRATEGY_GIT_SHA = "f6878060c61ef5c2b8e3267b52756d019bb8bfe7";
export const BASELINE_TRADING_SOURCE_TREE_HASH = "42006f0ef757255a1b1eda86fa7c37dd28a4b42f7d23503867b9fefdf24dfeda";
export const FORWARD_STRATEGY_VERSION = "forward-shadow-8035-v1";
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

export function getRuntimeIdentity() {
  const activeEntrySymbols = ACTIVE_ENTRY_SYMBOLS ? Array.from(ACTIVE_ENTRY_SYMBOLS).sort() : [];
  const receivedSymbols = TARGET_STOCKS.map(stock => stock.symbol).sort();
  const configHash = sha256Stable({
    sourceTreeHash: GENERATED_BUILD_IDENTITY.sourceTreeHash,
    activeEntrySymbols,
    receivedSymbols,
    policy: FORWARD_EVALUATION_POLICY,
    strategyVersion: FORWARD_STRATEGY_VERSION,
  });
  return {
    buildGitSha: GENERATED_BUILD_IDENTITY.gitSha,
    baselineStrategyGitSha: BASELINE_STRATEGY_GIT_SHA,
    baselineTradingSourceTreeHash: BASELINE_TRADING_SOURCE_TREE_HASH,
    tradingLogicMatchesBaseline: GENERATED_BUILD_IDENTITY.sourceTreeHash === BASELINE_TRADING_SOURCE_TREE_HASH,
    sourceTreeHash: GENERATED_BUILD_IDENTITY.sourceTreeHash,
    configHash,
    strategyVersion: FORWARD_STRATEGY_VERSION,
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
