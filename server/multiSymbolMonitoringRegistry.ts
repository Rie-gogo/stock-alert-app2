import { ACTIVE_ENTRY_SYMBOLS, NAME_BY_SYMBOL } from "../shared/stocks";
import {
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  FUJIKURA_MORNING_SHORT_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
} from "./runtimeIdentity";

export type MonitoringPlanPurpose = "current" | "candidate" | "diagnostic" | "paused_baseline";

export interface MonitoringPlanDefinition {
  planId: string;
  symbol: string;
  symbolName: string;
  label: string;
  origin: "current" | "forward_shadow";
  strategyVersion: string;
  purpose: MonitoringPlanPurpose;
  eligibleForAdoption: boolean;
}

export const TEN_MONITORED_SYMBOLS = Object.freeze(
  Array.from(ACTIVE_ENTRY_SYMBOLS ?? []).sort(),
);

const SHADOW_PLANS: ReadonlyArray<Omit<MonitoringPlanDefinition, "planId" | "origin" | "symbolName">> = [
  { strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, symbol: "285A", label: "A案：確認型前場LONG・MA8失速保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, symbol: "285A", label: "B案：現行5経路・ATR0.36%", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SUMCO_VOLUME_110_VERSION, symbol: "3436", label: "A案：出来高1.10倍", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SUMCO_TIME_15_VERSION, symbol: "3436", label: "B案：15分時間決済", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, symbol: "5803", label: "安値反転LONG A/B", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FUJIKURA_MORNING_SHORT_VERSION, symbol: "5803", label: "前場20本安値更新SHORT", purpose: "diagnostic", eligibleForAdoption: false },
  { strategyVersion: DISCO_SHORT_BASELINE_VERSION, symbol: "6146", label: "停止中・寄り付きSHORT基準", purpose: "paused_baseline", eligibleForAdoption: false },
  { strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION, symbol: "6146", label: "SHORT A案：実行可能価格確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_SHORT_RETEST_B_VERSION, symbol: "6146", label: "SHORT B案：再安値更新", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_LONG_PROFIT_PROTECTION_A_VERSION, symbol: "6146", label: "LONG A案：利益保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: DISCO_LONG_PRIOR_THREE_B_VERSION, symbol: "6146", label: "LONG B案：直前3本確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOCIONEXT_INITIAL_STRENGTH_VERSION, symbol: "6526", label: "A案：初動強度確認", purpose: "diagnostic", eligibleForAdoption: false },
  { strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION, symbol: "6526", label: "B案：確認足強度", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_BOARD_DEMAND_VERSION, symbol: "6976", label: "候補B A案：板需要確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_RR2_PROTECT_VERSION, symbol: "6976", label: "候補B B案：2R利益保護", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_AFTERNOON_RR2_VERSION, symbol: "6976", label: "後場SHORT A案：2R/45分", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_AFTERNOON_DEPTH_VERSION, symbol: "6976", label: "後場SHORT B案：次イベント板", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TAIYO_AFTERNOON_LONG_RR2_VERSION, symbol: "6976", label: "後場LONG A案：2R/10分", purpose: "diagnostic", eligibleForAdoption: false },
  { strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION, symbol: "6976", label: "後場LONG B案：回復勝率型", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: FORWARD_STRATEGY_VERSION, symbol: "8035", label: "短期ブレイク既存シャドー", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, symbol: "8035", label: "実行価格・板確認B", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION, symbol: "9984", label: "A案：次イベント板確認", purpose: "candidate", eligibleForAdoption: true },
  { strategyVersion: SOFTBANK_RR2_PROTECT_VERSION, symbol: "9984", label: "B案：2R利益保護", purpose: "candidate", eligibleForAdoption: true },
];

export const MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS: ReadonlyArray<MonitoringPlanDefinition> = Object.freeze([
  ...TEN_MONITORED_SYMBOLS.map(symbol => ({
    planId: `current:${symbol}`,
    symbol,
    symbolName: NAME_BY_SYMBOL[symbol] ?? symbol,
    label: "現行（証拠金ブロック含む）",
    origin: "current" as const,
    strategyVersion: "current-candidate-by-trade-date",
    purpose: "current" as const,
    eligibleForAdoption: false,
  })),
  ...SHADOW_PLANS.map(plan => ({
    ...plan,
    planId: `shadow:${plan.strategyVersion}`,
    symbolName: NAME_BY_SYMBOL[plan.symbol] ?? plan.symbol,
    origin: "forward_shadow" as const,
  })),
]);

export const MULTI_SYMBOL_MONITORING_PLAN_BY_VERSION = new Map(
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS
    .filter(plan => plan.origin === "forward_shadow")
    .map(plan => [plan.strategyVersion, plan]),
);
